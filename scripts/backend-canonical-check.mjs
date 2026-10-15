import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { canonicalJson, sha256Json } = require(
  join(root, "services/orchestrator/dist/domain/canonical-json.js"),
);
assert.equal(
  new Intl.Collator().resolvedOptions().locale,
  "en-US",
  "reference collation must match the retained v1 identity contract",
);
const count = Number(process.argv[2] || 20000);
assert.ok(Number.isSafeInteger(count) && count > 0 && count <= 1000000);
let seed = 0x73b4891ad7c259e1n;
function random() {
  seed ^= seed << 13n;
  seed ^= seed >> 7n;
  seed ^= seed << 17n;
  seed = BigInt.asUintN(64, seed);
  return seed;
}
const bytes = new DataView(new ArrayBuffer(8));
const vectors = [];
for (let index = 0; index < count; index++) {
  bytes.setBigUint64(0, random());
  let value = bytes.getFloat64(0);
  if (!Number.isFinite(value)) {
    index--;
    continue;
  }
  vectors.push({
    name: `binary64-${index}`,
    value,
    canonical: canonicalJson(value),
    hash: sha256Json(value),
  });
}
for (let index = 0; index < 1000; index++) {
  const value = Object.fromEntries(
    Array.from({ length: 12 }, () => [
      String.fromCharCode(
        Number(random() & 0xffffn),
        Number(random() & 0xffffn),
      ),
      index,
    ]),
  );
  vectors.push({
    name: `unicode-${index}`,
    value,
    canonical: canonicalJson(value),
    hash: sha256Json(value),
  });
}
const directory = mkdtempSync(join(tmpdir(), "tenvyr-canonical-"));
try {
  const path = join(directory, "vectors.json");
  writeFileSync(path, JSON.stringify(vectors));
  const result = spawnSync(
    process.env.TENVYR_JAVA_EXECUTABLE || "java",
    [
      "-ea",
      "-cp",
      "backend/platform/target/test-classes:backend/platform/target/classes:backend/platform/target/dependency/*",
      "io.tenvyr.platform.FoundationCheck",
      root,
      path,
    ],
    { cwd: root, encoding: "utf8", timeout: 120000 },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  console.log(
    `Canonical differential PASS: ${count} binary64 numbers and 1000 Unicode objects; original Node ICU ${process.versions.icu}; exact bytes and hashes`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
