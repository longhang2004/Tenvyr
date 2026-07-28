import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { verifyDocumentation } from "./verify-docs.mjs";

const current = (title, body, sources = ["package.json"]) => `---
title: ${title}
status: current
audience:
  - developer
last_verified: 2026-07-28
sources:
${sources.map((source) => `  - ${source}`).join("\n")}
---

# ${title}

${body}
`;

const historical = (title, body) => `---
title: ${title}
status: historical
completion: completed
historical_product_name: AgentWeave
superseded_by:
  - docs/architecture/overview.md
last_verified: 2026-07-28
---

# ${title}

${body}
`;

function write(root, path, text) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "tenvyr-docs-verifier-"));
  write(root, "package.json", '{"name":"fixture","private":true}\n');
  write(
    root,
    "docs/README.md",
    current(
      "Documentation",
      [
        "[Overview](architecture/overview.md)",
        "[Protocol](architecture/contracts/agent-protocol-v1.md)",
        "[Numeric policy](architecture/contracts/json-interoperability.md)",
        "[TypeScript Worker](architecture/workers/typescript-worker-sdk.md)",
        "[Python Worker](architecture/workers/python-worker-sdk.md)",
        "[Tooling](development/tooling/codegraph.md)",
        "[Status](reference/implementation-status.md)",
        "[Archive](archive/README.md)",
      ].join("\n"),
      ["package.json", "docs/reference/implementation-status.json"],
    ),
  );
  write(
    root,
    "docs/architecture/overview.md",
    current("Overview", "Current architecture."),
  );
  write(
    root,
    "docs/architecture/contracts/agent-protocol-v1.md",
    current(
      "Protocol",
      "See the [numeric policy](json-interoperability.md). The legacy `X-AgentWeave-Signature` header remains wire-compatible.",
    ),
  );
  write(
    root,
    "docs/architecture/contracts/json-interoperability.md",
    current(
      "JSON interoperability",
      "Integers use the cross-language safe range.",
    ),
  );
  write(
    root,
    "docs/architecture/workers/typescript-worker-sdk.md",
    current(
      "TypeScript Worker",
      "The Python SDK is implemented. See the [numeric policy](../contracts/json-interoperability.md).",
    ),
  );
  write(
    root,
    "docs/architecture/workers/python-worker-sdk.md",
    current(
      "Python Worker",
      "See the [numeric policy](../contracts/json-interoperability.md).",
    ),
  );
  write(
    root,
    "docs/development/tooling/codegraph.md",
    current(
      "CodeGraph",
      "CodeGraph is optional local developer tooling and is not a production runtime integration.",
    ),
  );
  write(
    root,
    "docs/reference/implementation-status.md",
    current("Implementation status", "The machine ledger is authoritative."),
  );
  write(
    root,
    "docs/archive/README.md",
    current(
      "Archive",
      "Historical context only: [completed plan](plans/completed.md).",
    ),
  );
  write(
    root,
    "docs/archive/plans/completed.md",
    historical("Completed plan", "AgentWeave was the historical product name."),
  );
  write(
    root,
    "docs/reference/implementation-status.json",
    JSON.stringify(
      {
        version: 1,
        capabilities: [
          {
            id: "implemented-capability",
            status: "implemented",
            sources: ["package.json"],
            tests: ["scripts/verify-docs.test.mjs"],
            docs: ["docs/architecture/overview.md"],
            limitations: ["Fixture only"],
          },
          {
            id: "planned-capability",
            status: "planned",
            sources: [],
            tests: [],
            docs: ["docs/architecture/overview.md"],
            limitations: ["Not implemented"],
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );
  write(root, "docs/reference/product-name-inventory.json", "{}\n");
  write(root, "scripts/verify-docs.test.mjs", "// fixture evidence\n");
  return root;
}

function withFixture(run) {
  const root = createFixture();
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function codes(result) {
  return result.diagnostics.map(({ code }) => code);
}

test("valid documentation fixture passes all fifteen checks deterministically", () => {
  withFixture((root) => {
    const first = verifyDocumentation(root);
    const second = verifyDocumentation(root);
    assert.equal(first.ok, true, JSON.stringify(first.diagnostics, null, 2));
    assert.deepEqual(first, second);
    assert.deepEqual(first.counts, {
      markdownFiles: 10,
      linksChecked: 12,
      currentDocuments: 9,
      historicalDocuments: 1,
      capabilities: 2,
    });
  });
});

test("reports broken local Markdown links", () => {
  withFixture((root) => {
    write(
      root,
      "docs/architecture/overview.md",
      current("Overview", "[Missing](missing.md)"),
    );
    assert(codes(verifyDocumentation(root)).includes("local-link"));
  });
});

test("reports a current document that is not reachable from the docs index", () => {
  withFixture((root) => {
    write(root, "docs/operations/orphan.md", current("Orphan", "Not indexed."));
    assert(codes(verifyDocumentation(root)).includes("current-doc-index"));
  });
});

test("reports missing frontmatter and invalid status", () => {
  withFixture((root) => {
    write(root, "docs/architecture/overview.md", "# Overview\n");
    write(
      root,
      "docs/development/tooling/codegraph.md",
      current("CodeGraph", "Optional local tooling.").replace(
        "status: current",
        "status: draft",
      ),
    );
    const resultCodes = codes(verifyDocumentation(root));
    assert(resultCodes.includes("frontmatter-required"));
    assert(resultCodes.includes("frontmatter-status"));
  });
});

test("reports missing frontmatter and ledger source paths", () => {
  withFixture((root) => {
    write(
      root,
      "docs/architecture/overview.md",
      current("Overview", "Current architecture.", ["missing/source.ts"]),
    );
    const ledger = {
      version: 1,
      capabilities: [
        {
          id: "implemented-capability",
          status: "implemented",
          sources: ["missing/ledger-source.ts"],
          tests: ["scripts/verify-docs.test.mjs"],
          docs: ["docs/architecture/overview.md"],
          limitations: ["Fixture only"],
        },
      ],
    };
    write(
      root,
      "docs/reference/implementation-status.json",
      JSON.stringify(ledger),
    );
    const resultCodes = codes(verifyDocumentation(root));
    assert(resultCodes.filter((code) => code === "source-path").length >= 2);
  });
});

test("archive plans require historical status and superseded_by", () => {
  withFixture((root) => {
    write(
      root,
      "docs/archive/plans/completed.md",
      historical("Completed plan", "Historical.")
        .replace("status: historical", "status: current")
        .replace(/superseded_by:\n  - docs\/architecture\/overview\.md\n/, ""),
    );
    const resultCodes = codes(verifyDocumentation(root));
    assert(resultCodes.includes("archive-historical"));
    assert(resultCodes.includes("archive-superseded-by"));
  });
});

test("active docs reject stale package and API names but protocol/history exceptions pass", () => {
  withFixture((root) => {
    let valid = verifyDocumentation(root);
    assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics, null, 2));
    write(
      root,
      "docs/architecture/overview.md",
      current(
        "Overview",
        "Install `@agentweave/worker` with `createAgentWeaveWorker`.",
      ),
    );
    assert(codes(verifyDocumentation(root)).includes("stale-package-api"));
  });
});

test("TypeScript Worker docs cannot describe the Python SDK as future work", () => {
  withFixture((root) => {
    write(
      root,
      "docs/architecture/workers/typescript-worker-sdk.md",
      current(
        "TypeScript Worker",
        "The Python Worker SDK is future work. See [numeric policy](../contracts/json-interoperability.md).",
      ),
    );
    assert(codes(verifyDocumentation(root)).includes("python-sdk-future"));
  });
});

test("developer tooling docs reject unsupported production integration claims", () => {
  withFixture((root) => {
    write(
      root,
      "docs/development/tooling/codegraph.md",
      current(
        "CodeGraph",
        "CodeGraph is integrated into the Tenvyr production runtime.",
      ),
    );
    assert(codes(verifyDocumentation(root)).includes("tooling-runtime-claim"));
  });
});

test("implementation ledger reports duplicate IDs and invalid capability records", () => {
  withFixture((root) => {
    const record = {
      id: "duplicate",
      status: "implemented",
      sources: [],
      tests: [],
      docs: ["docs/architecture/overview.md"],
      limitations: [],
    };
    write(
      root,
      "docs/reference/implementation-status.json",
      JSON.stringify({ version: 1, capabilities: [record, record] }),
    );
    assert(codes(verifyDocumentation(root)).includes("implementation-status"));
  });
});

test("requires the product identity inventory at its canonical path", () => {
  withFixture((root) => {
    rmSync(join(root, "docs/reference/product-name-inventory.json"));
    assert(codes(verifyDocumentation(root)).includes("identity-inventory"));
  });
});

test("current docs reject links to every old moved path", () => {
  withFixture((root) => {
    write(
      root,
      "docs/architecture/overview.md",
      current(
        "Overview",
        "[Old contracts](../architecture/agent-contracts-v1.md)",
      ),
    );
    assert(codes(verifyDocumentation(root)).includes("old-moved-path"));
  });
});

test("old and new documentation copies cannot coexist", () => {
  withFixture((root) => {
    write(
      root,
      "docs/agent-rules.md",
      current("Old agent rules", "Duplicate."),
    );
    assert(codes(verifyDocumentation(root)).includes("old-moved-path"));
  });
});

test("current docs cannot treat archive records as source of truth", () => {
  withFixture((root) => {
    write(
      root,
      "docs/architecture/overview.md",
      current(
        "Overview",
        "The [archived plan](../archive/plans/completed.md) is the current source of truth.",
      ),
    );
    assert(
      codes(verifyDocumentation(root)).includes("archive-source-of-truth"),
    );
  });
});

test("contracts and both Worker docs must link the numeric policy", () => {
  withFixture((root) => {
    write(
      root,
      "docs/architecture/workers/python-worker-sdk.md",
      current("Python Worker", "No numeric reference."),
    );
    assert(codes(verifyDocumentation(root)).includes("numeric-policy-link"));
  });
});

test("malformed ledger arrays produce deterministic diagnostics instead of throwing", () => {
  withFixture((root) => {
    write(
      root,
      "docs/reference/implementation-status.json",
      JSON.stringify({
        version: 1,
        capabilities: [
          {
            id: "malformed",
            status: "implemented",
            sources: [42],
            tests: [null],
            docs: [true],
            limitations: [{}],
          },
        ],
      }),
    );
    let first;
    assert.doesNotThrow(() => {
      first = verifyDocumentation(root);
    });
    const second = verifyDocumentation(root);
    assert.deepEqual(first, second);
    assert(codes(first).includes("implementation-status"));
  });
});

test("frontmatter and ledger evidence paths must stay relative to the repository root", () => {
  withFixture((root) => {
    write(
      root,
      "docs/architecture/overview.md",
      current("Overview", "Current architecture.", ["..", root]),
    );
    write(
      root,
      "docs/reference/implementation-status.json",
      JSON.stringify({
        version: 1,
        capabilities: [
          {
            id: "escaped-evidence",
            status: "partial",
            sources: [".."],
            tests: [root],
            docs: ["../outside.md"],
            limitations: ["Fixture only"],
          },
        ],
      }),
    );
    const escaped = verifyDocumentation(root).diagnostics.filter(
      ({ code, message }) =>
        code === "source-path" && message.includes("outside repository root"),
    );
    assert.equal(escaped.length, 5);
  });
});

test("resolves image, reference-style, and nested-parenthesis link destinations", () => {
  withFixture((root) => {
    write(root, "docs/assets/flow(1).svg", "<svg/>\n");
    write(root, "docs/assets/badge.svg", "<svg/>\n");
    write(root, "docs/reference/guide.txt", "guide\n");
    write(root, "docs/reference/function_(call).txt", "function\n");
    write(
      root,
      "docs/architecture/overview.md",
      current(
        "Overview",
        [
          "![Flow](../assets/flow(1).svg)",
          "[Guide][guide] and ![Badge][badge].",
          "[Function](../reference/function_(call).txt)",
          "",
          "[guide]: ../reference/guide.txt",
          "[badge]: ../assets/badge.svg",
        ].join("\n"),
      ),
    );
    const result = verifyDocumentation(root);
    assert.equal(
      result.diagnostics.filter(({ code }) => code === "local-link").length,
      0,
      JSON.stringify(result.diagnostics, null, 2),
    );
  });
});

test("reports broken image, reference-style, and nested-parenthesis destinations", () => {
  withFixture((root) => {
    write(
      root,
      "docs/architecture/overview.md",
      current(
        "Overview",
        [
          "![Missing image](missing(image).png)",
          "[Missing reference][missing-ref]",
          "[Missing nested](missing(file).md)",
          "",
          "[missing-ref]: missing(reference).md",
        ].join("\n"),
      ),
    );
    assert.equal(
      verifyDocumentation(root).diagnostics.filter(
        ({ code }) => code === "local-link",
      ).length,
      3,
    );
  });
});

test("ignores Markdown examples in code spans and fences while checking adjacent links", () => {
  withFixture((root) => {
    write(
      root,
      "docs/architecture/overview.md",
      current(
        "Overview",
        [
          "`[inline example](ignored-inline.md)`",
          "",
          "```markdown",
          "[fenced example](ignored-fenced.md)",
          "```",
          "",
          "~~~~md",
          "![fenced image](ignored-image.png)",
          "~~~~",
          "",
          "[real broken link](missing-real.md)",
        ].join("\n"),
      ),
    );
    const result = verifyDocumentation(root);
    assert.equal(
      result.diagnostics.filter(({ code }) => code === "local-link").length,
      1,
    );
    assert.equal(result.counts.linksChecked, 13);
  });
});
