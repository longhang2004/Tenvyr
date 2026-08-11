import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  allowedCategories,
  auditEntries,
  collectRepositoryEntries,
  formatAudit,
  isExcludedPath,
  requiredLegacyIdentifiers,
} from "./verify-product-identity.mjs";

const oldName = ["Agent", "Weave"].join("");
const oldLower = oldName.toLowerCase();
const oldUpper = oldName.toUpperCase();

test("active branding, package, API, User-Agent, and environment names are violations", () => {
  const audit = auditEntries(
    [
      { path: "README.md", text: `# ${oldName}` },
      {
        path: "src/consumer.ts",
        text: [
          `import { create${oldName}Worker } from "@${oldLower}/worker";`,
          `const userAgent = "${oldName}-Worker/0.1.0";`,
          `const token = process.env.${oldUpper}_WORKER_TOKEN;`,
        ].join("\n"),
      },
    ],
    [],
  );

  assert.deepEqual(
    audit.findings.map(({ category }) => category),
    [null, null, null, null, null],
  );
  assert.equal(
    audit.findings.find(({ match }) => match.includes("/0.1.0"))?.match,
    `${oldName}-Worker/0.1.0`,
  );
});

test("each approved legacy-reference category is explicit", () => {
  const audit = auditEntries(
    [
      {
        path: "packages/worker/src/callback/callback-delivery.ts",
        text: `"X-${oldName}-Signature"`,
      },
      {
        path: "services/orchestrator/src/services/kafka.service.ts",
        text: `'${oldLower}-orchestrator-group'`,
      },
      {
        path: "docker-compose.yml",
        text: `container_name: ${oldLower}-postgres`,
      },
      {
        path: "docs/archive/decisions/2026-07-27-product-identity-evaluation.md",
        text: `${oldName} collides with existing uses of the same or a closely related name.`,
      },
      {
        path: "packages/worker/test/public-api.spec.ts",
        text: `expect(compiledPackage.create${oldName}Worker).toBeUndefined();`,
      },
      {
        path: "services/orchestrator/src/compatibility-identifiers.spec.ts",
        text: `expect(value).toBe("${oldLower}-postgres")`,
      },
      {
        path: "docs/reference/product-name-inventory.json",
        text: `{"value":"@${oldLower}/worker"}`,
      },
      {
        path: ".gitignore",
        text: `/${oldName}.zip`,
      },
    ],
    [],
  );

  assert.deepEqual(
    audit.findings.map(({ category }) => category).sort(),
    [...allowedCategories].sort(),
  );
});

test("README legacy identity references are violations", () => {
  const audit = auditEntries(
    [
      {
        path: "README.md",
        text: [
          `${oldName} is the former internal name for Tenvyr. That name is also used by the independent`,
          "[`arniesaha/" +
            oldLower +
            "`](https://github.com/arniesaha/" +
            oldLower +
            ") project; there",
          "is no affiliation, and the former name is not an active alias for Tenvyr.",
        ].join("\n"),
      },
    ],
    [],
  );
  assert(audit.findings.length >= 3);
  assert(audit.findings.every(({ category }) => category === null));
});

test("allowlists reject near misses, wrong paths, comments, and marker text", () => {
  const audit = auditEntries(
    [
      {
        path: "services/orchestrator/src/services/kafka.service.ts",
        text: `'${oldLower}.agent.unapproved.task'`,
      },
      {
        path: "src/copied-kafka.ts",
        text: `'${oldLower}-orchestrator-group'`,
      },
      {
        path: "notes.md",
        text: `Former internal name: ${oldName}`,
      },
      {
        path: "docker-compose.yml",
        text: [
          `# container_name: ${oldLower}-postgres`,
          `container_name: ${oldLower}-rogue`,
        ].join("\n"),
      },
      {
        path: "services/agent-code-reviewer/src/kafka.service.spec.ts",
        text: `rejected old ${oldName} branding`,
      },
      {
        path: "services/orchestrator/src/compatibility-identifiers.spec.ts",
        text: `const active = "${oldLower}-postgres";`,
      },
      {
        path: "services/orchestrator/src/compatibility-identifiers.spec.ts",
        text: `expect(value).toBe("@${oldLower}/worker");`,
      },
    ],
    [],
  );

  assert.equal(audit.findings.length, 8);
  assert(audit.findings.every(({ category }) => category === null));
});

test("showcase network attachment is exact deployment compatibility", () => {
  const audit = auditEntries(
    [
      {
        path: "docker-compose.showcase.yml",
        text: `      - ${oldLower}-net`,
      },
      {
        path: "docker-compose.showcase.yml",
        text: `      - ${oldLower}-net-extra`,
      },
      {
        path: "docker-compose.showcase.yml",
        text: `      # - ${oldLower}-net`,
      },
      {
        path: "docker-compose.copied.yml",
        text: `      - ${oldLower}-net`,
      },
    ],
    [],
  );

  assert.deepEqual(
    audit.findings.map(({ category }) => category),
    [null, "persistent-deployment", null, null],
  );
});

test("approved negative assertions do not allow nearby active legacy branding", () => {
  const audit = auditEntries(
    [
      {
        path: "packages/worker/test/public-api.spec.ts",
        text: [
          `expect(compiledPackage.create${oldName}Worker).toBeUndefined();`,
          `const activeProduct = "${oldName}";`,
        ].join("\n"),
      },
      {
        path: "scripts/verify-package-packs.mjs",
        text: [
          `!("@${oldLower}/contracts" in workerManifest.dependencies),`,
          `const activePackage = "@${oldLower}/contracts";`,
        ].join("\n"),
      },
    ],
    [],
  );

  assert.deepEqual(
    audit.findings.map(({ category }) => category),
    ["negative-test", null, "negative-test", null],
  );
});

test("only the four exact archive records allow historical identity", () => {
  const approvedPaths = [
    "docs/archive/decisions/2026-07-27-product-identity-evaluation.md",
    `docs/archive/migrations/2026-07-28-${oldLower}-to-tenvyr.md`,
    "docs/archive/plans/2026-07-26-typescript-worker-sdk.md",
    "docs/archive/specs/2026-07-26-typescript-worker-sdk-design.md",
  ];
  const audit = auditEntries(
    [
      ...approvedPaths.map((path) => ({ path, text: oldName })),
      { path: "docs/archive/notes.md", text: oldName },
      {
        path: "docs/archive/plans/2026-07-27-typescript-worker-sdk.md",
        text: oldName,
      },
      {
        path: "docs/history/2026-07-26-typescript-worker-sdk.md",
        text: oldName,
      },
    ],
    [],
  );

  assert.deepEqual(
    audit.findings.map(({ category }) => category),
    ["historical", "historical", null, "historical", null, "historical", null],
  );
});

test("current wire and Kafka documentation allow only exact compatibility values", () => {
  const audit = auditEntries(
    [
      {
        path: "docs/architecture/transports/http-agent-adapter-v1.md",
        text: [`X-${oldName}-Signature`, `X-${oldName}-Unexpected`].join("\n"),
      },
      {
        path: "docs/architecture/transports/kafka-runtime-v1.md",
        text: [
          `${oldLower}.agent.<agent>.task`,
          `${oldLower}-reviewer-group`,
          `${oldLower}.agent.unapproved.task`,
        ].join("\n"),
      },
      {
        path: "docs/architecture/transports/copied-http.md",
        text: `X-${oldName}-Signature`,
      },
    ],
    [],
  );

  assert.deepEqual(
    audit.findings.map(({ category }) => category),
    [
      null,
      "wire-protocol-v1",
      null,
      "kafka-runtime-v1",
      "kafka-runtime-v1",
      null,
    ],
  );
});

test("documentation-verifier stale-name patterns are exact negative checks", () => {
  const audit = auditEntries(
    [
      {
        path: "scripts/verify-docs.mjs",
        text: [
          `/@${oldLower}\\/(?:contracts|worker|example-typescript-http-worker)\\b/gi,`,
          `/\\bcreate${oldName}Worker\\b/g,`,
          `/\\b${oldName}(?:Worker|WorkerConfig|WorkerRuntime|StructuredSuccess)\\b/g,`,
          `const active = "@${oldLower}/worker";`,
        ].join("\n"),
      },
      {
        path: "scripts/copied-docs-verifier.mjs",
        text: `/@${oldLower}\\/(?:contracts|worker)\\b/gi,`,
      },
    ],
    [],
  );

  assert.deepEqual(
    audit.findings.map(({ category }) => category),
    [null, "negative-test", "negative-test", "negative-test", null],
  );
});

test("package-pack verifier allowlist is exact and keeps HMAC headers wire-only", () => {
  const audit = auditEntries(
    [
      {
        path: "scripts/verify-package-packs.mjs",
        text: [
          `"X-${oldName}-Delivery-Id",`,
          `"X-${oldName}-Key-Id",`,
          `"X-${oldName}-Signature",`,
          `"X-${oldName}-Timestamp",`,
          `\`import { create${oldName}Worker } from "@tenvyr/worker";`,
          `const active = create${oldName}Worker;`,
        ].join("\n"),
      },
    ],
    [],
  );

  assert.deepEqual(
    audit.findings.map(({ category }) => category),
    [
      "wire-protocol-v1",
      "wire-protocol-v1",
      "wire-protocol-v1",
      "wire-protocol-v1",
      "negative-test",
      null,
    ],
  );
});

test("callback tests may assert only the four exact v1 header names", () => {
  const audit = auditEntries(
    [
      {
        path: "packages/worker/test/callback.spec.ts",
        text: [
          `"x-${oldLower}-key-id",`,
          `"x-${oldLower}-timestamp",`,
          `"x-${oldLower}-delivery-id",`,
          `"x-${oldLower}-signature",`,
          `"x-${oldLower}-unexpected",`,
        ].join("\n"),
      },
    ],
    [],
  );

  assert.deepEqual(
    audit.findings.map(({ category }) => category),
    [
      "wire-protocol-v1",
      "wire-protocol-v1",
      "wire-protocol-v1",
      "wire-protocol-v1",
      null,
    ],
  );
});

test("Python Worker wire-header allowlist requires exact constants and path", () => {
  const path = "sdks/python-worker/src/tenvyr_worker/_callback/delivery.py";
  const audit = auditEntries(
    [
      {
        path,
        text: [
          `HEADER_KEY_ID = "X-${oldName}-Key-Id"`,
          `HEADER_TIMESTAMP = "X-${oldName}-Timestamp"`,
          `HEADER_DELIVERY_ID = "X-${oldName}-Delivery-Id"`,
          `HEADER_SIGNATURE = "X-${oldName}-Signature"`,
          `# HEADER_BAD = "X-${oldName}-Key-Id"`,
          `HEADER_BAD = "X-${oldName}-Unexpected"`,
        ].join("\n"),
      },
      {
        path: "sdks/python-worker/src/tenvyr_worker/_callback/copied.py",
        text: `HEADER_KEY_ID = "X-${oldName}-Key-Id"`,
      },
    ],
    [],
  );

  assert.deepEqual(
    audit.findings.map(({ category }) => category),
    [
      null,
      "wire-protocol-v1",
      "wire-protocol-v1",
      "wire-protocol-v1",
      "wire-protocol-v1",
      null,
      null,
    ],
  );
});

test("Python comments cannot satisfy required wire-header constants", () => {
  const rule = requiredLegacyIdentifiers.find(({ id }) =>
    id.startsWith("python-worker-sends-"),
  );
  assert(rule);
  assert.deepEqual(
    auditEntries([{ path: rule.path, text: `# ${rule.fixture}` }], [rule])
      .missing,
    [rule.id],
  );
});

test("Kafka v1 event-topic allowlist is exact: near misses, invented suffixes, and wrong paths fail", () => {
  const audit = auditEntries(
    [
      {
        path: "docs/architecture/transports/kafka-runtime-v1.md",
        text: `${oldLower}.agent.<agent>.event`,
      },
      {
        path: "docs/architecture/transports/kafka-runtime-v1.md",
        text: `${oldLower}.agent.<agent>.result`,
      },
      {
        path: "docs/architecture/transports/kafka-runtime-v1.md",
        text: `${oldLower}.agent.<agent>.events`,
      },
      {
        path: "docs/architecture/transports/kafka-runtime-v1.md",
        text: `${oldLower}.agent.<agent>.evnt`,
      },
      {
        path: "docs/architecture/transports/copied-kafka.md",
        text: `${oldLower}.agent.<agent>.event`,
      },
      {
        path: "services/orchestrator/src/agent-adapters/kafka-agent.adapter.ts",
        text: `\`${oldLower}.agent.\${agent}.event\``,
      },
      {
        path: "services/orchestrator/src/agent-adapters/kafka-agent.adapter.ts",
        text: `\`${oldLower}.agent.\${agent}.events\``,
      },
      {
        path: "services/orchestrator/src/agent-adapters/kafka-agent.adapter.spec.ts",
        text: `"${oldLower}.agent.code-reviewer.event"`,
      },
      {
        path: "services/orchestrator/src/agent-adapters/kafka-agent.adapter.spec.ts",
        text: `"${oldLower}.agent.code-reviewer.event."`,
      },
      {
        path: "services/orchestrator/src/agent-adapters/kafka-agent.adapter.spec.ts",
        text: `"${oldLower}.agent.code-reviewer.events"`,
      },
      {
        path: "services/orchestrator/src/agent-adapters/kafka-agent.adapter.spec.ts",
        text: `"${oldLower}.agent.other.event"`,
      },
      {
        path: "services/orchestrator/src/domain/transport-identity.spec.ts",
        text: `topic: "${oldLower}.agent.reader.event"`,
      },
      {
        path: "services/orchestrator/src/domain/transport-identity.spec.ts",
        text: `topic: "${oldLower}.agent.reader.other"`,
      },
      {
        path: "services/orchestrator/src/domain/transport-identity.spec.ts",
        text: `const longTopic = \`${oldLower}.agent.\${"t".repeat(260)}\`;`,
      },
      {
        path: "src/copied-identity.spec.ts",
        text: `topic: "${oldLower}.agent.reader.event"`,
      },
      {
        path: "src/copied-identity.spec.ts",
        text: `const longTopic = \`${oldLower}.agent.\${"t".repeat(260)}\`;`,
      },
    ],
    [],
  );

  assert.deepEqual(
    audit.findings.map(({ category }) => category),
    [
      null,
      "kafka-runtime-v1",
      "kafka-runtime-v1",
      null,
      null,
      "kafka-runtime-v1",
      null,
      null,
      null,
      "kafka-runtime-v1",
      null,
      "kafka-runtime-v1",
      null,
      "kafka-runtime-v1",
      null,
      null,
    ],
  );
});

test("postgres guard lines are exact deployment compatibility at the disposable-database spec", () => {
  const path =
    "services/orchestrator/src/database/postgres.integration.spec.ts";
  const audit = auditEntries(
    [
      {
        path,
        text: `const configured = process.env.POSTGRES_DB || "${oldLower}";`,
      },
      {
        path,
        text: `(process.env.POSTGRES_DB || "${oldLower}").toLowerCase() ===`,
      },
      {
        path,
        text: `const configured = process.env.POSTGRES_DB || "${oldLower}"; // trailing`,
      },
      {
        path,
        text: `const configured = process.env.POSTGRES_DB || "${oldLower} ";`,
      },
      {
        path: "src/copied-spec.ts",
        text: `const configured = process.env.POSTGRES_DB || "${oldLower}";`,
      },
    ],
    [],
  );

  assert.deepEqual(
    audit.findings.map(({ category }) => category),
    ["persistent-deployment", "persistent-deployment", null, null, null],
  );
});

test("required topic-template rules fail when the topic construction drifts", () => {
  for (const id of [
    "orchestrator-result-topic-template",
    "orchestrator-event-topic-template",
  ]) {
    const rule = requiredLegacyIdentifiers.find(
      (candidate) => candidate.id === id,
    );
    assert(rule, id);
    assert.deepEqual(
      auditEntries([{ path: rule.path, text: rule.fixture }], [rule]).missing,
      [],
      id,
    );
    const mutated = rule.fixture.replace(new RegExp(oldLower, "g"), "renamed");
    assert.deepEqual(
      auditEntries([{ path: rule.path, text: mutated }], [rule]).missing,
      [id],
      id,
    );
  }
});

test("Worker event-delivery tests allow only the four exact v1 header names", () => {
  const audit = auditEntries(
    [
      {
        path: "packages/worker/test/events.spec.ts",
        text: [
          `request.headers["x-${oldLower}-key-id"]`,
          `request.headers["x-${oldLower}-timestamp"]`,
          `request.headers["x-${oldLower}-delivery-id"]`,
          `request.headers["x-${oldLower}-signature"]`,
          `request.headers["x-${oldLower}-extra"]`,
          `header.startsWith("x-${oldLower}-")`,
        ].join("\n"),
      },
      {
        path: "sdks/python-worker/tests/test_events.py",
        text: [
          `headers["x-${oldLower}-key-id"]`,
          `headers["x-${oldLower}-timestamp"]`,
          `headers["x-${oldLower}-delivery-id"]`,
          `headers["x-${oldLower}-signature"]`,
          `key.startswith("x-${oldLower}-")`,
          `headers["x-${oldLower}-extra"]`,
        ].join("\n"),
      },
      {
        path: "sdks/python-worker/tests/copied_events.py",
        text: `headers["x-${oldLower}-key-id"]`,
      },
    ],
    [],
  );

  assert.deepEqual(
    audit.findings.map(({ category }) => category),
    [
      "wire-protocol-v1",
      "wire-protocol-v1",
      "wire-protocol-v1",
      "wire-protocol-v1",
      null,
      null,
      null,
      "wire-protocol-v1",
      "wire-protocol-v1",
      "wire-protocol-v1",
      "wire-protocol-v1",
      null,
      null,
    ],
  );
});

test("packaged Worker docs accept only the four exact wire headers at exact paths", () => {
  const audit = auditEntries(
    [
      {
        path: "packages/worker/README.md",
        text: [
          `X-${oldName}-Key-Id`,
          `X-${oldName}-Timestamp`,
          `X-${oldName}-Delivery-Id`,
          `X-${oldName}-Signature`,
          `X-${oldName}-Extra`,
          `\`X-${oldName}-*\``,
        ].join("\n"),
      },
      {
        path: "sdks/python-worker/README.md",
        text: [
          `X-${oldName}-Key-Id`,
          `X-${oldName}-Timestamp`,
          `X-${oldName}-Delivery-Id`,
          `X-${oldName}-Signature`,
        ].join("\n"),
      },
      {
        path: "sdks/python-worker/CONFORMANCE.md",
        text: `X-${oldName}-Key-Id`,
      },
      {
        path: "packages/worker/docs/README.md",
        text: `X-${oldName}-Key-Id`,
      },
    ],
    [],
  );

  assert.deepEqual(
    audit.findings.map(({ category }) => category),
    [
      "wire-protocol-v1",
      "wire-protocol-v1",
      "wire-protocol-v1",
      "wire-protocol-v1",
      null,
      null,
      null,
      "wire-protocol-v1",
      "wire-protocol-v1",
      "wire-protocol-v1",
      "wire-protocol-v1",
      "wire-protocol-v1",
    ],
  );
});

test("missing required identifiers fail independently of rename violations", () => {
  const required = [
    {
      id: "legacy-wire-header",
      path: "protocol.ts",
      pattern: /^\s*header-v1\s*$/m,
    },
  ];

  assert.deepEqual(auditEntries([], required).missing, ["legacy-wire-header"]);
  assert.deepEqual(
    auditEntries([{ path: "protocol.ts", text: "// header-v1" }], required)
      .missing,
    ["legacy-wire-header"],
  );
  assert.deepEqual(
    auditEntries([{ path: "protocol.ts", text: "header-v1" }], required)
      .missing,
    [],
  );

  const actualRule = requiredLegacyIdentifiers[0];
  assert.deepEqual(
    auditEntries(
      [
        {
          path: actualRule.path,
          text: `// ${actualRule.fixture}`,
        },
      ],
      [actualRule],
    ).missing,
    [actualRule.id],
  );
});

test("required deployment rules fail independently when mutated", () => {
  const deploymentRules = requiredLegacyIdentifiers.filter(
    ({ id }) =>
      id === "example-database" ||
      id === "compose-gateway-database" ||
      id === "compose-orchestrator-database" ||
      id.startsWith("docker-network-attachment-") ||
      id.endsWith("-volume-mount"),
  );
  assert.equal(deploymentRules.length, 16);

  for (const rule of deploymentRules) {
    assert.deepEqual(
      auditEntries([{ path: rule.path, text: rule.fixture }], [rule]).missing,
      [],
      rule.id,
    );
    const mutated = rule.fixture
      .replace(new RegExp(oldLower, "g"), "renamed")
      .replace(/(?:postgres|redis)_data/g, "renamed_data");
    assert.deepEqual(
      auditEntries([{ path: rule.path, text: mutated }], [rule]).missing,
      [rule.id],
      rule.id,
    );
  }
});

test("required TypeScript identifiers tolerate quote and multiline formatting", () => {
  const cases = [
    {
      id: `worker-sends-X-${oldName}-Key-Id`,
      text: `'X-${oldName}-Key-Id': input.keyId,`,
    },
    {
      id: "reviewer-client-id",
      text: `clientId: 'agent-code-reviewer',`,
    },
    {
      id: "reviewer-consumer-group",
      text: `groupId: "${oldLower}-reviewer-group",`,
    },
    {
      id: "reviewer-task-topic",
      text: `const topic = "${oldLower}.agent.code-reviewer.task";`,
    },
    {
      id: "reviewer-result-topic",
      text: `topic: "${oldLower}.agent.code-reviewer.result",`,
    },
    {
      id: `orchestrator-accepts-X-${oldName}-Key-Id`,
      text: `@Headers(\n  "x-${oldLower}-key-id"\n)\nkeyId: string | undefined,`,
    },
    {
      id: "orchestrator-result-topic-template",
      text: [
        "return Array.from(",
        "  new Set([",
        `    ...this.agentNames().map((agent) => \`${oldLower}.agent.\${agent}.result\`),`,
        "    ...explicitTopics,",
        "  ]),",
        ");",
      ].join("\n"),
    },
    {
      id: "orchestrator-event-topic-template",
      text: [
        "return [",
        `  ...this.agentNames().map((agent) => \`${oldLower}.agent.\${agent}.event\`),`,
        "  ...configured,",
        "];",
      ].join("\n"),
    },
  ];

  for (const { id, text } of cases) {
    const rule = requiredLegacyIdentifiers.find(
      (candidate) => candidate.id === id,
    );
    assert(rule, id);
    assert.deepEqual(
      auditEntries([{ path: rule.path, text }], [rule]).missing,
      [],
      id,
    );
  }
});

test("required TypeScript identifiers reject comment and string spoofs", () => {
  const cases = [
    {
      id: "reviewer-client-id",
      doubleQuoted: `clientId: "agent-code-reviewer",`,
      singleQuoted: `clientId: 'agent-code-reviewer',`,
    },
    {
      id: "reviewer-consumer-group",
      doubleQuoted: `groupId: "${oldLower}-reviewer-group",`,
      singleQuoted: `groupId: '${oldLower}-reviewer-group',`,
    },
    {
      id: "reviewer-task-topic",
      doubleQuoted: `const topic = "${oldLower}.agent.code-reviewer.task";`,
      singleQuoted: `const topic = '${oldLower}.agent.code-reviewer.task';`,
    },
    {
      id: "reviewer-result-topic",
      doubleQuoted: `topic: "${oldLower}.agent.code-reviewer.result",`,
      singleQuoted: `topic: '${oldLower}.agent.code-reviewer.result',`,
    },
    {
      id: `orchestrator-accepts-X-${oldName}-Key-Id`,
      doubleQuoted: `@Headers("x-${oldLower}-key-id") keyId: string | undefined,`,
      singleQuoted: `@Headers('x-${oldLower}-key-id') keyId: string | undefined,`,
    },
    {
      id: "orchestrator-database-fallback",
      doubleQuoted: `database: process.env.POSTGRES_DB || "${oldLower}",`,
      singleQuoted: `database: process.env.POSTGRES_DB || '${oldLower}',`,
    },
  ];

  for (const { id, doubleQuoted, singleQuoted } of cases) {
    const rule = requiredLegacyIdentifiers.find(
      (candidate) => candidate.id === id,
    );
    assert(rule, id);
    for (const text of [
      `// ${doubleQuoted}`,
      `/*\n${doubleQuoted}\n*/`,
      `const spoof = \`\n${doubleQuoted}\n\`;`,
      `const spoof = "ignored\\\n${singleQuoted}\\\n";`,
      `const spoof = 'ignored\\\n${doubleQuoted}\\\n';`,
    ]) {
      assert.deepEqual(
        auditEntries([{ path: rule.path, text }], [rule]).missing,
        [id],
        `${id}: ${text}`,
      );
    }
  }

  const resultTopicsRule = requiredLegacyIdentifiers.find(
    ({ id }) => id === "orchestrator-result-topic-template",
  );
  assert(resultTopicsRule);
  const resultTopics = [
    "return Array.from(",
    "  new Set([",
    `    ...this.agentNames().map((agent) => \`${oldLower}.agent.\${agent}.result\`),`,
    "    ...explicitTopics,",
    "  ]),",
    ");",
  ].join("\n");
  const eventTopicsRule = requiredLegacyIdentifiers.find(
    ({ id }) => id === "orchestrator-event-topic-template",
  );
  assert(eventTopicsRule);
  const eventTopics = [
    "return [",
    `  ...this.agentNames().map((agent) => \`${oldLower}.agent.\${agent}.event\`),`,
    "  ...configured,",
    "];",
  ].join("\n");
  for (const [rule, fixture] of [
    [resultTopicsRule, resultTopics],
    [eventTopicsRule, eventTopics],
  ]) {
    for (const text of [
      `/*\n${fixture}\n*/`,
      `const spoof = ${JSON.stringify(fixture)};`,
    ]) {
      assert.deepEqual(
        auditEntries([{ path: rule.path, text }], [rule]).missing,
        [rule.id],
        `${rule.id}: ${text}`,
      );
    }
  }
});

test("audit output is deterministic and includes file, line, match, and result", () => {
  const audit = auditEntries(
    [
      { path: "ä.ts", text: oldName },
      { path: "z.ts", text: oldName },
      { path: "a.ts", text: `\n@${oldLower}/worker` },
    ],
    [],
  );

  assert.equal(
    formatAudit(audit),
    [
      `a.ts:2 match="@${oldLower}/worker" VIOLATION`,
      `z.ts:1 match="${oldName}" VIOLATION`,
      `ä.ts:1 match="${oldName}" VIOLATION`,
      "identity verification: 3 violation(s), 0 required identifier(s) missing",
    ].join("\n"),
  );
});

test("only owner artifacts and normal cache directories receive path exclusions", () => {
  assert.equal(isExcludedPath(`${oldName}.zip`), true);
  assert.equal(isExcludedPath(`${oldName}.zip`, { tracked: true }), false);
  assert.equal(isExcludedPath("scripts/compress.sh"), true);
  assert.equal(isExcludedPath("scripts/compress.sh", { tracked: true }), false);
  assert.equal(isExcludedPath("packages/worker/node_modules/file.js"), true);
  assert.equal(isExcludedPath("packages/worker/dist/index.js"), false);
  assert.equal(isExcludedPath("renamed-product.zip"), false);
  assert.equal(isExcludedPath("scripts/other.sh"), false);
});

test("repository enumeration and CLI cover tracked, untracked, dist, and exit status", () => {
  const root = mkdtempSync(join(tmpdir(), "tenvyr-identity-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    write(root, ".gitignore", "ignored.txt\npackages/*/dist/\n");
    write(root, "tracked.txt", "Tenvyr\n");
    execFileSync("git", ["add", ".gitignore", "tracked.txt"], { cwd: root });

    write(root, "untracked.txt", `${oldName}\n`);
    write(root, "ignored.txt", `${oldName}\n`);
    write(root, "packages/demo/dist/index.js", `${oldName}\n`);
    write(root, "scripts/compress.sh", `${oldName}\n`);
    write(root, `${oldName}.zip`, `${oldName}\n`);

    const initialPaths = collectRepositoryEntries(root).map(({ path }) => path);
    assert(initialPaths.includes("tracked.txt"));
    assert(initialPaths.includes("untracked.txt"));
    assert(initialPaths.includes("packages/demo/dist/index.js"));
    assert(!initialPaths.includes("ignored.txt"));
    assert(!initialPaths.includes("scripts/compress.sh"));
    assert(!initialPaths.includes(`${oldName}.zip`));

    execFileSync("git", ["add", "-f", "scripts/compress.sh"], { cwd: root });
    assert(
      collectRepositoryEntries(root).some(
        ({ path }) => path === "scripts/compress.sh",
      ),
    );
    execFileSync("git", ["add", "-f", `${oldName}.zip`], { cwd: root });
    const trackedZip = collectRepositoryEntries(root).find(
      ({ path }) => path === `${oldName}.zip`,
    );
    assert(trackedZip);
    assert.equal(trackedZip.filename, `${oldName}.zip`);
    assert.deepEqual(
      auditEntries([trackedZip], []).findings.map(
        ({ match, location, category }) => ({
          match,
          location,
          category,
        }),
      ),
      [{ match: oldName, location: "filename", category: null }],
    );
    execFileSync("git", ["rm", "--cached", "--quiet", `${oldName}.zip`], {
      cwd: root,
    });

    write(root, "untracked.txt", "Tenvyr\n");
    write(root, "packages/demo/dist/index.js", "Tenvyr\n");
    write(root, "scripts/compress.sh", "Tenvyr\n");
    for (const rule of requiredLegacyIdentifiers) {
      append(root, rule.path, rule.fixture);
    }

    const script = fileURLToPath(
      new URL("./verify-product-identity.mjs", import.meta.url),
    );
    const clean = spawnSync(process.execPath, [script, "--root", root], {
      encoding: "utf8",
    });
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);

    write(root, "README.md", `# ${oldName}\n`);
    const violation = spawnSync(process.execPath, [script, "--root", root], {
      encoding: "utf8",
    });
    assert.equal(violation.status, 1);
    assert.match(
      violation.stdout,
      new RegExp(`README\\.md:1 match="${oldName}" VIOLATION`),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function write(root, path, text) {
  const absolutePath = join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, text);
}

function append(root, path, text) {
  const absolutePath = join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${readOrEmpty(absolutePath)}${text}\n`);
}

function readOrEmpty(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
