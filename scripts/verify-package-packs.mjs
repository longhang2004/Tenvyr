import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync, spawnSync } from "child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "tenvyr-package-smoke-"));
const packDirectory = join(temporaryRoot, "packs");
const consumerDirectory = join(temporaryRoot, "consumer");
const packages = ["contracts", "worker"];
const packageNames = {
  contracts: "@tenvyr/contracts",
  worker: "@tenvyr/worker",
};
const legacyHeaders = [
  "X-AgentWeave-Delivery-Id",
  "X-AgentWeave-Key-Id",
  "X-AgentWeave-Signature",
  "X-AgentWeave-Timestamp",
];
const sourceManifests = Object.fromEntries(
  packages.map((name) => [
    name,
    JSON.parse(
      readFileSync(join(root, "packages", name, "package.json"), "utf8"),
    ),
  ]),
);

try {
  assertLegacyScanner();

  for (const name of packages) {
    assertManifest(name, sourceManifests[name], false);
    run("pnpm", ["--filter", packageNames[name], "build"], root);
    run(
      "pnpm",
      [
        "--dir",
        `packages/${name}`,
        "pack",
        "--pack-destination",
        packDirectory,
      ],
      root,
    );
  }

  const archives = Object.fromEntries(
    packages.map((name) => [
      name,
      join(
        packDirectory,
        `tenvyr-${name}-${sourceManifests[name].version}.tgz`,
      ),
    ]),
  );
  const packedText = Object.fromEntries(
    packages.map((name) => [name, assertTarball(name, archives[name])]),
  );

  const contractsManifest = packedManifest(archives.contracts);
  const workerManifest = packedManifest(archives.worker);
  assertManifest("contracts", contractsManifest, true);
  assertManifest("worker", workerManifest, true);
  assert(
    workerManifest.dependencies["@tenvyr/contracts"] ===
      contractsManifest.version,
    "pnpm pack must rewrite workspace:* to the matching contracts version",
  );
  assert(
    !("@agentweave/contracts" in workerManifest.dependencies),
    "packed worker manifest still contains the old contracts scope",
  );
  assertLegacyIdentitySurface(packedText);

  mkdirSync(consumerDirectory);
  writeFileSync(
    join(consumerDirectory, "package.json"),
    JSON.stringify(
      {
        name: "tenvyr-packed-consumer",
        version: "1.0.0",
        private: true,
        dependencies: {
          "@tenvyr/contracts": `file:${archives.contracts}`,
          "@tenvyr/worker": `file:${archives.worker}`,
        },
        pnpm: {
          overrides: {
            "@tenvyr/contracts": `file:${archives.contracts}`,
          },
        },
      },
      null,
      2,
    ),
  );
  run("pnpm", ["install", "--ignore-scripts"], consumerDirectory);

  for (const name of packages) {
    const installed = realpathSync(
      join(consumerDirectory, "node_modules", "@tenvyr", name),
    );
    assert(
      !installed.startsWith(join(root, "packages")),
      `${name} resolved through a workspace symlink`,
    );
  }

  writeFileSync(
    join(consumerDirectory, "consumer.ts"),
    `import { createTenvyrWorker, defineAgent } from "@tenvyr/worker";

async function main(): Promise<void> {
  const worker = createTenvyrWorker({
    agent: defineAgent({
      name: "packed-agent",
      async execute(_context, input) {
        return input;
      },
    }),
    authentication: { bearerToken: "packed-token" },
    callbackAuthentication: { keys: { "callback-v1": "packed-secret" } },
    callbackPolicy: { allowedOrigins: ["https://orchestrator.example"] },
  });
  try {
    const address = await worker.start({ host: "127.0.0.1", port: 0 });
    const response = await fetch(
      \`http://\${address.host}:\${address.port}/health/live\`,
    );
    const body = await response.json();
    console.log(JSON.stringify({ status: response.status, body }));
  } finally {
    await worker.stop();
  }
}

void main();
`,
  );
  writeFileSync(
    join(consumerDirectory, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "Node16",
          moduleResolution: "Node16",
          target: "ES2021",
          outDir: "dist",
          strict: true,
          skipLibCheck: true,
        },
        include: ["consumer.ts"],
      },
      null,
      2,
    ),
  );
  const tsc = join(root, "packages", "worker", "node_modules", ".bin", "tsc");
  run(tsc, ["-p", "tsconfig.json"], consumerDirectory);

  writeFileSync(
    join(consumerDirectory, "deep-import.ts"),
    `import { InMemoryIdempotencyStore } from "@tenvyr/worker/dist/invocation/idempotency-store";
void InMemoryIdempotencyStore;
`,
  );
  compileMustFail(
    tsc,
    consumerDirectory,
    "deep-import.ts",
    /TS2307/,
    "internal deep import",
  );
  writeFileSync(
    join(consumerDirectory, "old-api-import.ts"),
    `import { createAgentWeaveWorker } from "@tenvyr/worker";
void createAgentWeaveWorker;
`,
  );
  compileMustFail(
    tsc,
    consumerDirectory,
    "old-api-import.ts",
    /TS(?:2305|2724)/,
    "old Worker API import",
  );
  writeFileSync(
    join(consumerDirectory, "old-package-import.ts"),
    `import { createAgentWeaveWorker } from "@agentweave/worker";
void createAgentWeaveWorker;
`,
  );
  compileMustFail(
    tsc,
    consumerDirectory,
    "old-package-import.ts",
    /TS2307/,
    "old Worker package resolution",
  );

  const smoke = JSON.parse(
    execFileSync(process.execPath, ["dist/consumer.js"], {
      cwd: consumerDirectory,
      encoding: "utf8",
      timeout: 15_000,
    }),
  );
  assert(
    smoke.status === 200,
    "packed Worker health endpoint did not return 200",
  );
  assert(smoke.body.status === "ok", "packed Worker health body was invalid");

  console.log(
    JSON.stringify(
      {
        contractsTarballBytes: statSync(archives.contracts).size,
        workerTarballBytes: statSync(archives.worker).size,
        dependencyRewrite: workerManifest.dependencies["@tenvyr/contracts"],
        externalCompile: "passed",
        healthStatus: smoke.status,
        deepImport: "blocked",
        oldApiImport: "blocked",
        oldPackageResolution: "blocked",
        legacyHmacHeaders: "preserved",
        oldPackageApiAndUserAgent: "absent",
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function assertTarball(name, archive) {
  const actual = execFileSync("tar", ["-tzf", archive], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .sort();
  const packageDirectory = join(root, "packages", name);
  const expected = [
    "package/package.json",
    "package/README.md",
    ...filesUnder(join(packageDirectory, "dist")).map(
      (file) =>
        `package/dist/${relative(join(packageDirectory, "dist"), file)}`,
    ),
  ].sort();
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${name} tarball content differs from the dist/README/package.json allowlist`,
  );
  const manifest = packedManifest(archive);
  assert(
    JSON.stringify(Object.keys(manifest.exports)) === JSON.stringify(["."]),
    `${name} exports must expose only the package root`,
  );
  assert(
    JSON.stringify(manifest.files) === JSON.stringify(["dist", "README.md"]),
    `${name} files allowlist is invalid`,
  );
  if (name === "contracts") {
    for (const schema of readdirSync(join(root, "contracts", "schemas"))) {
      const packed = execFileSync("tar", [
        "-xOzf",
        archive,
        `package/dist/schema-json/${schema}`,
      ]);
      const canonical = readFileSync(
        join(root, "contracts", "schemas", schema),
      );
      assert(
        packed.equals(canonical),
        `packed schema ${schema} differs from the repository fixture`,
      );
    }
  }
  return Object.fromEntries(
    actual.map((entry) => [
      entry,
      execFileSync("tar", ["-xOzf", archive, entry], {
        encoding: "utf8",
      }),
    ]),
  );
}

function packedManifest(archive) {
  return JSON.parse(
    execFileSync("tar", ["-xOzf", archive, "package/package.json"], {
      encoding: "utf8",
    }),
  );
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function assertManifest(name, manifest, packed) {
  assert(
    manifest.name === packageNames[name],
    `${packed ? "packed" : "source"} ${name} manifest name must be ${packageNames[name]}`,
  );
  assert(
    manifest.private === true,
    `${packed ? "packed" : "source"} ${name} must remain private`,
  );
  assert(
    manifest.license === "UNLICENSED",
    `${packed ? "packed" : "source"} ${name} license must remain UNLICENSED`,
  );
  assert(
    !("publishConfig" in manifest),
    `${packed ? "packed" : "source"} ${name} must not define publishConfig`,
  );
  assert(
    !("repository" in manifest),
    `${packed ? "packed" : "source"} ${name} must not define repository metadata`,
  );
}

function assertLegacyIdentitySurface(packedText) {
  const foundHeaders = new Set();

  for (const [packageName, entries] of Object.entries(packedText)) {
    for (const [entry, content] of Object.entries(entries)) {
      for (const occurrence of legacyOccurrences(content)) {
        assert(
          occurrence.header !== undefined,
          `${packageName} tarball ${entry} contains unapproved legacy identity at offset ${occurrence.offset}`,
        );
        foundHeaders.add(occurrence.header);
      }
    }
  }

  assert(
    JSON.stringify([...foundHeaders].sort()) === JSON.stringify(legacyHeaders),
    "packed Worker must preserve exactly the four HTTP HMAC v1 headers",
  );
}

function legacyOccurrences(content) {
  const occurrences = [];
  const oldName = ["agent", "weave"].join("");
  const pattern = new RegExp(oldName, "gi");

  for (const match of content.matchAll(pattern)) {
    const offset = match.index;
    occurrences.push({
      offset,
      header: legacyHeaders.find((header) =>
        isWholeHeaderAt(content, offset - 2, header),
      ),
    });
  }
  return occurrences;
}

function isWholeHeaderAt(content, start, header) {
  if (start < 0 || content.slice(start, start + header.length) !== header) {
    return false;
  }
  const tokenCharacter = /[!#$%&'*+\-.^_`|~0-9A-Za-z]/;
  return (
    !tokenCharacter.test(content[start - 1] ?? "") &&
    !tokenCharacter.test(content[start + header.length] ?? "")
  );
}

function assertLegacyScanner() {
  assert(
    legacyOccurrences(legacyHeaders.join("\n")).every(
      (occurrence) => occurrence.header !== undefined,
    ),
    "legacy scanner rejected an approved HTTP HMAC v1 header",
  );

  const oldName = ["Agent", "Weave"].join("");
  const rejected = [
    oldName,
    oldName.toLowerCase(),
    `X-${oldName}-Extra`,
    `x-${oldName.toLowerCase()}-Key-Id`,
    `${legacyHeaders[0]}-Extra`,
    `Prefix${legacyHeaders[0]}`,
  ];
  const specialTokenCharacters = "!#$%&'*+-.^_`|~";
  for (const character of specialTokenCharacters) {
    rejected.push(
      `${character}${legacyHeaders[0]}`,
      `${legacyHeaders[0]}${character}`,
    );
  }
  for (const value of rejected) {
    assert(
      legacyOccurrences(value).some(
        (occurrence) => occurrence.header === undefined,
      ),
      `legacy scanner accepted adversarial input: ${value}`,
    );
  }
}

function compileMustFail(tsc, cwd, file, diagnostic, label) {
  const result = spawnSync(
    tsc,
    [
      "--noEmit",
      "--module",
      "Node16",
      "--moduleResolution",
      "Node16",
      "--target",
      "ES2021",
      "--skipLibCheck",
      file,
    ],
    { cwd, encoding: "utf8", timeout: 30_000 },
  );
  const output = `${result.stdout}${result.stderr}`;
  assert(result.status !== 0, `${label} unexpectedly compiled`);
  assert(
    diagnostic.test(output),
    `${label} failed without the expected TypeScript resolution diagnostic:\n${output}`,
  );
}

function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    timeout: 120_000,
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
