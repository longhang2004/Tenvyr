#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const allowedDocumentStatuses = new Set(["current", "planned", "historical"]);
const allowedCapabilityStatuses = new Set([
  "implemented",
  "partial",
  "planned",
  "blocked",
  "historical",
]);
const requiredCurrentFrontmatter = [
  "title",
  "status",
  "audience",
  "last_verified",
  "sources",
];
const oldMovedPaths = new Set([
  "docs/agent-memory.md",
  "docs/agent-rules.md",
  "docs/architecture/agent-adapter.md",
  "docs/architecture/agent-contracts-v1.md",
  "docs/architecture/http-agent-adapter.md",
  "docs/architecture/python-worker-sdk.md",
  "docs/architecture/typescript-worker-sdk.md",
  "docs/architecture/worker-sdk-parity.json",
  "docs/awesome-skills.md",
  "docs/codegraph.md",
  "docs/product/product-identity-decision.md",
  "docs/product/product-name-inventory.json",
  "docs/product/product-principles.md",
  "docs/product/product-rename-migration-plan.md",
  "docs/roadmap/observability-provenance-roadmap.md",
  "docs/rtk.md",
  "docs/superpowers/plans/2026-07-26-typescript-worker-sdk.md",
  "docs/superpowers/specs/2026-07-26-typescript-worker-sdk-design.md",
]);
const numericPolicyPath =
  "docs/architecture/contracts/json-interoperability.md";
const numericPolicyConsumers = [
  "docs/architecture/contracts/agent-protocol-v1.md",
  "docs/architecture/workers/typescript-worker-sdk.md",
  "docs/architecture/workers/python-worker-sdk.md",
];
const stalePackageApiPatterns = [
  /@agentweave\/(?:contracts|worker|example-typescript-http-worker)\b/gi,
  /\bcreateAgentWeaveWorker\b/g,
  /\bAgentWeave(?:Worker|WorkerConfig|WorkerRuntime|StructuredSuccess)\b/g,
];

function toRepositoryPath(root, absolute) {
  return relative(root, absolute).split(sep).join("/");
}

function walkMarkdown(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    if (entry.name === "_scratch") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkMarkdown(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) return { data: null, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { data: null, body: text };
  const data = {};
  let activeList = null;
  for (const line of text.slice(4, end).split("\n")) {
    const item = line.match(/^\s+-\s+(.+?)\s*$/);
    if (item && activeList) {
      data[activeList].push(unquote(item[1]));
      continue;
    }
    const property = line.match(/^([a-z_]+):(?:\s*(.*))?$/);
    if (!property) {
      activeList = null;
      continue;
    }
    const [, key, raw = ""] = property;
    if (raw === "") {
      data[key] = [];
      activeList = key;
    } else if (raw === "[]") {
      data[key] = [];
      activeList = null;
    } else {
      data[key] = unquote(raw.trim());
      activeList = null;
    }
  }
  return { data, body: text.slice(end + 5) };
}

function unquote(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeReference(value) {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function unescapeMarkdownDestination(value) {
  return value.replace(/\\([!"#$%&'()*+,./:;<=>?@[\]^_`{|}~-])/gu, "$1");
}

function destinationFrom(value) {
  const text = value.trimStart();
  if (text.startsWith("<")) {
    for (let index = 1; index < text.length; index += 1) {
      if (text[index] === "\\") index += 1;
      else if (text[index] === ">") {
        return unescapeMarkdownDestination(text.slice(1, index));
      }
    }
    return null;
  }

  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") {
      index += 1;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")" && depth > 0) {
      depth -= 1;
    } else if (/\s/u.test(character) && depth === 0) {
      return unescapeMarkdownDestination(text.slice(0, index));
    }
  }
  return unescapeMarkdownDestination(text);
}

function closingBracket(text, open, opening, closing) {
  let depth = 1;
  let angleDestination = false;
  let quote = null;
  for (let index = open + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (opening === "(") {
      if (angleDestination) {
        if (character === ">") angleDestination = false;
        continue;
      }
      if (quote) {
        if (character === quote) quote = null;
        continue;
      }
      if (character === "<" && depth === 1) {
        angleDestination = true;
        continue;
      }
      if ((character === '"' || character === "'") && depth === 1) {
        quote = character;
        continue;
      }
    }
    if (character === opening) depth += 1;
    else if (character === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function rangeEndAt(index, ranges) {
  for (const [start, end] of ranges) {
    if (index >= start && index < end) return end;
  }
  return null;
}

function fencedCodeRanges(text) {
  const ranges = [];
  let fence = null;
  for (const match of text.matchAll(/^.*(?:\n|$)/gmu)) {
    const line = match[0].replace(/\n$/u, "").replace(/\r$/u, "");
    if (!fence) {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
      if (opening && !(opening[1][0] === "`" && opening[2].includes("`"))) {
        fence = {
          character: opening[1][0],
          length: opening[1].length,
          start: match.index,
        };
      }
      continue;
    }

    const closing = line.match(/^ {0,3}(`+|~+)[ \t]*$/u);
    if (
      closing &&
      closing[1][0] === fence.character &&
      closing[1].length >= fence.length
    ) {
      ranges.push([fence.start, match.index + match[0].length]);
      fence = null;
    }
  }
  if (fence) ranges.push([fence.start, text.length]);
  return ranges;
}

function markdownCodeRanges(text) {
  const ranges = fencedCodeRanges(text);
  for (let index = 0; index < text.length; index += 1) {
    const fenceEnd = rangeEndAt(index, ranges);
    if (fenceEnd !== null) {
      index = fenceEnd - 1;
      continue;
    }
    if (text[index] !== "`" || text[index - 1] === "\\") continue;

    let length = 1;
    while (text[index + length] === "`") length += 1;
    for (let candidate = index + length; candidate < text.length; ) {
      const candidateFenceEnd = rangeEndAt(candidate, ranges);
      if (candidateFenceEnd !== null) {
        candidate = candidateFenceEnd;
        continue;
      }
      if (text[candidate] !== "`") {
        candidate += 1;
        continue;
      }
      let candidateLength = 1;
      while (text[candidate + candidateLength] === "`") candidateLength += 1;
      if (candidateLength === length) {
        ranges.push([index, candidate + candidateLength]);
        ranges.sort((left, right) => left[0] - right[0]);
        index = candidate + candidateLength - 1;
        break;
      }
      candidate += candidateLength;
    }
  }
  return ranges;
}

function referenceDefinitions(text, ignoredRanges) {
  const definitions = new Map();
  const ranges = [];
  const pattern = /^ {0,3}\[([^\]]+)\]:[ \t]*(.*)$/gmu;
  for (const match of text.matchAll(pattern)) {
    if (rangeEndAt(match.index, ignoredRanges) !== null) continue;
    const target = destinationFrom(match[2]);
    if (target !== null) {
      definitions.set(normalizeReference(match[1]), target);
    }
    ranges.push([match.index, match.index + match[0].length]);
  }
  return { definitions, ranges };
}

function markdownLinks(text) {
  const links = [];
  const codeRanges = markdownCodeRanges(text);
  const { definitions, ranges: definitionRanges } = referenceDefinitions(
    text,
    codeRanges,
  );
  const ignoredRanges = [...codeRanges, ...definitionRanges].sort(
    (left, right) => left[0] - right[0],
  );
  for (let index = 0; index < text.length; index += 1) {
    const ignoredEnd = rangeEndAt(index, ignoredRanges);
    if (ignoredEnd !== null) {
      index = ignoredEnd - 1;
      continue;
    }
    const image = text[index] === "!" && text[index + 1] === "[";
    const open = image ? index + 1 : index;
    if (text[open] !== "[" || text[open - 1] === "\\") continue;
    const labelEnd = closingBracket(text, open, "[", "]");
    if (labelEnd < 0) continue;
    const label = text.slice(open + 1, labelEnd);
    const next = labelEnd + 1;

    if (text[next] === "(") {
      const destinationEnd = closingBracket(text, next, "(", ")");
      if (destinationEnd >= 0) {
        links.push({
          target: destinationFrom(text.slice(next + 1, destinationEnd)),
          reference: null,
          line: lineNumber(text, index),
        });
        index = destinationEnd;
      }
      continue;
    }

    if (text[next] === "[") {
      const referenceEnd = closingBracket(text, next, "[", "]");
      if (referenceEnd >= 0) {
        const reference = normalizeReference(
          text.slice(next + 1, referenceEnd) || label,
        );
        links.push({
          target: definitions.get(reference) ?? null,
          reference,
          line: lineNumber(text, index),
        });
        index = referenceEnd;
      }
      continue;
    }

    const reference = normalizeReference(label);
    if (definitions.has(reference)) {
      links.push({
        target: definitions.get(reference),
        reference,
        line: lineNumber(text, index),
      });
      index = labelEnd;
    }
  }
  return links;
}

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}

function isExternalLink(target) {
  return (
    target === "" ||
    target.startsWith("#") ||
    target.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(target)
  );
}

function resolveLocalTarget(root, sourcePath, target) {
  const withoutFragment = target.split(/[?#]/u, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    decoded = withoutFragment;
  }
  return resolve(
    decoded.startsWith("/") ? root : dirname(resolve(root, sourcePath)),
    decoded.replace(/^\/+/, ""),
  );
}

function addDiagnostic(diagnostics, code, path, message, line = 1) {
  diagnostics.push({ code, path, line, message });
}

function repositoryEvidencePath(root, path) {
  if (typeof path !== "string" || path.length === 0) return null;
  const absolute = resolve(root, path);
  if (
    isAbsolute(path) ||
    (absolute !== root && !absolute.startsWith(`${root}${sep}`))
  ) {
    return null;
  }
  return absolute;
}

function validateLedger(root, diagnostics, documents) {
  const ledgerPath = "docs/reference/implementation-status.json";
  const absolute = resolve(root, ledgerPath);
  if (!existsSync(absolute)) {
    addDiagnostic(
      diagnostics,
      "implementation-status",
      ledgerPath,
      "implementation-status.json does not exist",
    );
    return 0;
  }

  let ledger;
  try {
    ledger = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    addDiagnostic(
      diagnostics,
      "implementation-status",
      ledgerPath,
      `invalid JSON: ${error.message}`,
    );
    return 0;
  }

  if (ledger.version !== 1 || !Array.isArray(ledger.capabilities)) {
    addDiagnostic(
      diagnostics,
      "implementation-status",
      ledgerPath,
      "ledger must have version 1 and a capabilities array",
    );
    return Array.isArray(ledger.capabilities) ? ledger.capabilities.length : 0;
  }

  const identifiers = new Set();
  for (const [index, capability] of ledger.capabilities.entries()) {
    const label = `capabilities[${index}]`;
    if (
      !capability ||
      typeof capability !== "object" ||
      Array.isArray(capability)
    ) {
      addDiagnostic(
        diagnostics,
        "implementation-status",
        ledgerPath,
        `${label} must be an object`,
      );
      continue;
    }
    if (typeof capability.id !== "string" || capability.id === "") {
      addDiagnostic(
        diagnostics,
        "implementation-status",
        ledgerPath,
        `${label}.id must be a non-empty string`,
      );
    } else if (identifiers.has(capability.id)) {
      addDiagnostic(
        diagnostics,
        "implementation-status",
        ledgerPath,
        `duplicate capability id: ${capability.id}`,
      );
    } else {
      identifiers.add(capability.id);
    }
    if (!allowedCapabilityStatuses.has(capability.status)) {
      addDiagnostic(
        diagnostics,
        "implementation-status",
        ledgerPath,
        `${label}.status is invalid: ${String(capability.status)}`,
      );
    }
    for (const field of ["sources", "tests", "docs", "limitations"]) {
      if (
        !Array.isArray(capability[field]) ||
        capability[field].some(
          (value) => typeof value !== "string" || value.length === 0,
        )
      ) {
        addDiagnostic(
          diagnostics,
          "implementation-status",
          ledgerPath,
          `${label}.${field} must be an array of non-empty strings`,
        );
      }
    }

    const strings = (field) =>
      Array.isArray(capability[field])
        ? capability[field].filter(
            (value) => typeof value === "string" && value.length > 0,
          )
        : [];
    const sources = strings("sources");
    const tests = strings("tests");
    const docs = strings("docs");
    if (
      capability.status === "implemented" &&
      (sources.length === 0 || tests.length === 0)
    ) {
      addDiagnostic(
        diagnostics,
        "implementation-status",
        ledgerPath,
        `${label} is implemented but has no source or test evidence`,
      );
    }
    if (
      capability.status === "planned" &&
      (sources.length > 0 || tests.length > 0)
    ) {
      addDiagnostic(
        diagnostics,
        "implementation-status",
        ledgerPath,
        `${label} is planned but claims source or test evidence`,
      );
    }
    if (docs.length === 0) {
      addDiagnostic(
        diagnostics,
        "implementation-status",
        ledgerPath,
        `${label} has no documentation path`,
      );
    }

    for (const [field, values] of [
      ["sources", sources],
      ["tests", tests],
      ["docs", docs],
    ]) {
      for (const path of values) {
        const absolute = repositoryEvidencePath(root, path);
        if (!absolute) {
          addDiagnostic(
            diagnostics,
            "source-path",
            ledgerPath,
            `${label}.${field} path is absolute or outside repository root: ${path}`,
          );
        } else if (!existsSync(absolute)) {
          addDiagnostic(
            diagnostics,
            "source-path",
            ledgerPath,
            `${label}.${field} path does not exist: ${path}`,
          );
        }
        if (field === "docs" && absolute) {
          const document = documents.get(path);
          if (!document || document.frontmatter?.status === "historical") {
            addDiagnostic(
              diagnostics,
              "implementation-status",
              ledgerPath,
              `${label}.docs is not current documentation: ${path}`,
            );
          }
        }
      }
    }
  }
  return ledger.capabilities.length;
}

export function verifyDocumentation(repositoryRoot = process.cwd()) {
  const root = resolve(repositoryRoot);
  const diagnostics = [];
  const documents = new Map();
  const markdownFiles = walkMarkdown(resolve(root, "docs"));

  for (const absolute of markdownFiles) {
    const path = toRepositoryPath(root, absolute);
    const text = readFileSync(absolute, "utf8");
    const { data: frontmatter, body } = parseFrontmatter(text);
    const links = markdownLinks(text);
    documents.set(path, { path, text, body, frontmatter, links });

    if (!frontmatter) {
      addDiagnostic(
        diagnostics,
        "frontmatter-required",
        path,
        "document is missing YAML frontmatter",
      );
      continue;
    }
    if (!allowedDocumentStatuses.has(frontmatter.status)) {
      addDiagnostic(
        diagnostics,
        "frontmatter-status",
        path,
        `invalid document status: ${String(frontmatter.status)}`,
      );
    }
    if (frontmatter.status !== "historical") {
      for (const field of requiredCurrentFrontmatter) {
        const value = frontmatter[field];
        if (
          value === undefined ||
          value === "" ||
          (Array.isArray(value) && value.length === 0)
        ) {
          addDiagnostic(
            diagnostics,
            "frontmatter-required",
            path,
            `current document is missing frontmatter field: ${field}`,
          );
        }
      }
    } else {
      for (const field of ["title", "last_verified", "superseded_by"]) {
        const value = frontmatter[field];
        if (
          value === undefined ||
          value === "" ||
          (Array.isArray(value) && value.length === 0)
        ) {
          addDiagnostic(
            diagnostics,
            "frontmatter-required",
            path,
            `historical document is missing frontmatter field: ${field}`,
          );
        }
      }
    }
    for (const source of Array.isArray(frontmatter.sources)
      ? frontmatter.sources
      : []) {
      const absolute = repositoryEvidencePath(root, source);
      if (!absolute) {
        addDiagnostic(
          diagnostics,
          "source-path",
          path,
          `frontmatter source path is absolute or outside repository root: ${source}`,
        );
      } else if (!existsSync(absolute)) {
        addDiagnostic(
          diagnostics,
          "source-path",
          path,
          `frontmatter source path does not exist: ${source}`,
        );
      }
    }
  }

  let linksChecked = 0;
  const linkGraph = new Map();
  for (const document of documents.values()) {
    const destinations = [];
    for (const link of document.links) {
      if (link.target === null) {
        linksChecked += 1;
        addDiagnostic(
          diagnostics,
          "local-link",
          document.path,
          `Markdown reference does not resolve: ${link.reference ?? "invalid destination"}`,
          link.line,
        );
        continue;
      }
      if (isExternalLink(link.target)) continue;
      linksChecked += 1;
      const target = resolveLocalTarget(root, document.path, link.target);
      const targetPath = toRepositoryPath(root, target);
      destinations.push(targetPath);
      const insideRoot = target.startsWith(`${root}${sep}`);
      const targetExists = insideRoot && existsSync(target);
      const targetStat = targetExists ? statSync(target) : null;
      if (!targetStat?.isFile() && !targetStat?.isDirectory()) {
        addDiagnostic(
          diagnostics,
          "local-link",
          document.path,
          `local link does not resolve: ${link.target}`,
          link.line,
        );
      }
      if (
        document.frontmatter?.status !== "historical" &&
        oldMovedPaths.has(targetPath)
      ) {
        addDiagnostic(
          diagnostics,
          "old-moved-path",
          document.path,
          `current document links to moved path: ${targetPath}`,
          link.line,
        );
      }
    }
    linkGraph.set(document.path, destinations);
  }

  for (const oldPath of [...oldMovedPaths].sort()) {
    if (existsSync(resolve(root, oldPath))) {
      addDiagnostic(
        diagnostics,
        "old-moved-path",
        oldPath,
        "old documentation path still exists after the move",
      );
    }
  }

  const indexed = new Set();
  const pending = ["docs/README.md"];
  while (pending.length > 0) {
    const path = pending.shift();
    if (indexed.has(path) || !documents.has(path)) continue;
    indexed.add(path);
    for (const destination of linkGraph.get(path) ?? []) {
      if (documents.has(destination) && !indexed.has(destination)) {
        pending.push(destination);
      }
    }
  }
  for (const document of documents.values()) {
    if (
      document.frontmatter?.status !== "historical" &&
      !indexed.has(document.path)
    ) {
      addDiagnostic(
        diagnostics,
        "current-doc-index",
        document.path,
        "current or planned document is not reachable from docs/README.md",
      );
    }
  }

  for (const document of documents.values()) {
    if (
      document.path.startsWith("docs/archive/") &&
      document.path !== "docs/archive/README.md"
    ) {
      if (document.frontmatter?.status !== "historical") {
        addDiagnostic(
          diagnostics,
          "archive-historical",
          document.path,
          "archived record must have status: historical",
        );
      }
      if (
        !Array.isArray(document.frontmatter?.superseded_by) ||
        document.frontmatter.superseded_by.length === 0
      ) {
        addDiagnostic(
          diagnostics,
          "archive-superseded-by",
          document.path,
          "archived record must identify superseded_by",
        );
      }
    }

    if (document.frontmatter?.status === "historical") continue;
    for (const pattern of stalePackageApiPatterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(document.body);
      if (match) {
        addDiagnostic(
          diagnostics,
          "stale-package-api",
          document.path,
          `active document contains stale package or API name: ${match[0]}`,
          lineNumber(document.text, document.text.indexOf(match[0])),
        );
      }
    }

    if (
      document.path === "docs/architecture/workers/typescript-worker-sdk.md"
    ) {
      const futurePython =
        /(?:python(?: worker)? sdk.{0,100}(?:future|planned|not implemented|will be (?:added|implemented)))|(?:(?:future|planned|not implemented).{0,100}python(?: worker)? sdk)/isu;
      if (futurePython.test(document.body)) {
        addDiagnostic(
          diagnostics,
          "python-sdk-future",
          document.path,
          "TypeScript Worker documentation describes the Python SDK as future work",
        );
      }
    }

    if (document.path.startsWith("docs/development/tooling/")) {
      const unsupportedClaim =
        /(?:is|are) (?:integrated|loaded|injected|enabled) (?:in|into|by) (?:the )?tenvyr (?:production )?runtime|tenvyr (?:production )?runtime (?:automatically )?(?:loads|uses|injects|integrates)/iu;
      if (unsupportedClaim.test(document.body)) {
        addDiagnostic(
          diagnostics,
          "tooling-runtime-claim",
          document.path,
          "developer-tool documentation claims an unimplemented runtime integration",
        );
      }
    }

    for (const line of document.text.split("\n")) {
      if (
        /(?:archive|archived)/iu.test(line) &&
        /(?:source of truth|authoritative (?:current )?(?:source|reference)|current (?:api )?reference)/iu.test(
          line,
        ) &&
        !/\b(?:not|never|cannot|does not|do not|must not)\b/iu.test(line)
      ) {
        addDiagnostic(
          diagnostics,
          "archive-source-of-truth",
          document.path,
          "current document treats an archive record as current authority",
          lineNumber(document.text, document.text.indexOf(line)),
        );
      }
    }
  }

  const capabilities = validateLedger(root, diagnostics, documents);
  const inventoryPath = "docs/reference/product-name-inventory.json";
  if (!existsSync(resolve(root, inventoryPath))) {
    addDiagnostic(
      diagnostics,
      "identity-inventory",
      inventoryPath,
      "product identity inventory does not exist at its canonical path",
    );
  }

  for (const path of numericPolicyConsumers) {
    const document = documents.get(path);
    const hasLink = document?.links.some(
      ({ target }) =>
        !isExternalLink(target) &&
        toRepositoryPath(root, resolveLocalTarget(root, path, target)) ===
          numericPolicyPath,
    );
    if (!hasLink) {
      addDiagnostic(
        diagnostics,
        "numeric-policy-link",
        path,
        `document must link to ${numericPolicyPath}`,
      );
    }
  }

  diagnostics.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.code.localeCompare(right.code) ||
      left.message.localeCompare(right.message),
  );
  const historicalDocuments = [...documents.values()].filter(
    ({ frontmatter }) => frontmatter?.status === "historical",
  ).length;
  return {
    ok: diagnostics.length === 0,
    diagnostics,
    counts: {
      markdownFiles: documents.size,
      linksChecked,
      currentDocuments: documents.size - historicalDocuments,
      historicalDocuments,
      capabilities,
    },
  };
}

export function formatVerification(result) {
  if (!result.ok) {
    return [
      ...result.diagnostics.map(
        ({ path, line, code, message }) =>
          `${path}:${line} [${code}] ${message}`,
      ),
      `Documentation verification failed with ${result.diagnostics.length} violation(s).`,
    ].join("\n");
  }
  const counts = result.counts;
  return `Documentation verification passed: ${counts.markdownFiles} Markdown files, ${counts.linksChecked} local links, ${counts.currentDocuments} current documents, ${counts.historicalDocuments} historical documents, ${counts.capabilities} capabilities.`;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = verifyDocumentation(process.cwd());
  console.log(formatVerification(result));
  if (!result.ok) process.exitCode = 1;
}
