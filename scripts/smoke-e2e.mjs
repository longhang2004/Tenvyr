#!/usr/bin/env node
// AgentWeave smoke / end-to-end verification (Requirement 6).
//
// Runs against the local Docker stack and performs a true black-box check that
// drives only the public Gateway API:
//   1. Health-check every backend service and both frontend routes.
//   2. If all healthy, create a sample two-step pipeline.
//   3. Trigger an execution of that pipeline.
//   4. Poll the execution until it reaches a terminal state or a bounded timeout.
//
// Exit codes (each failure mode prints a distinct, descriptive message):
//   0  pipeline execution reached COMPLETED
//   1  one or more health checks failed (no pipeline was created)
//   2  pipeline creation failed
//   3  execution trigger failed
//   4  execution reached FAILED
//   5  bounded timeout elapsed before a terminal state
//   6  execution monitoring (polling) failed
//   7  runtime prerequisite missing (no global fetch)
//
// Requires Node 18+ for the built-in global fetch.

const EXIT_OK = 0;
const EXIT_HEALTH = 1;
const EXIT_CREATE = 2;
const EXIT_TRIGGER = 3;
const EXIT_FAILED = 4;
const EXIT_TIMEOUT = 5;
const EXIT_POLL = 6;
const EXIT_PREREQ = 7;

// Base URLs default to the documented local ports but may be overridden via env
// for flexibility; defaults match the running Docker stack exactly.
const GATEWAY = process.env.SMOKE_GATEWAY_URL || 'http://localhost:3000';
const ORCHESTRATOR = process.env.SMOKE_ORCHESTRATOR_URL || 'http://localhost:3001';
const CODE_REVIEWER = process.env.SMOKE_CODE_REVIEWER_URL || 'http://localhost:3002';
const OBSERVABILITY = process.env.SMOKE_OBSERVABILITY_URL || 'http://localhost:3003';
const RUNNER = process.env.SMOKE_RUNNER_URL || 'http://localhost:8085';
const FRONTEND = process.env.SMOKE_FRONTEND_URL || 'http://localhost:4000';

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 120000;

// Backend services expose the standard health envelope.
const BACKEND_HEALTH_TARGETS = [
  { name: 'gateway', url: `${GATEWAY}/health` },
  { name: 'orchestrator', url: `${ORCHESTRATOR}/health` },
  { name: 'code-reviewer', url: `${CODE_REVIEWER}/health` },
  { name: 'observability', url: `${OBSERVABILITY}/health` },
  { name: 'agent-runner', url: `${RUNNER}/health` },
];

// Frontend routes are plain pages: assert HTTP 200 only.
const FRONTEND_HEALTH_TARGETS = [
  { name: 'frontend /', url: `${FRONTEND}/` },
  { name: 'frontend /dashboard', url: `${FRONTEND}/dashboard` },
];

// Sample two-step pipeline (design C5). With placeholder credentials the Agent
// Runner returns its Local_Fallback heuristic JSON, so both steps complete and
// the execution reaches COMPLETED. The observe step consumes the review step's
// findings via the {{ steps.<id>.result.<field> }} template.
const SAMPLE_PIPELINE = {
  name: 'smoke-pipeline',
  version: '1.0',
  steps: [
    {
      id: 'review',
      agent: 'code-reviewer',
      input: {
        code: "const q = 'SELECT * FROM users WHERE id=' + id;",
        language: 'typescript',
      },
    },
    {
      id: 'observe',
      agent: 'observability',
      dependsOn: ['review'],
      input: {
        logs: 'request completed in 1s',
        findings: '{{ steps.review.result.findings }}',
      },
    },
  ],
};

function getErrorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function log(message) {
  console.log(`[smoke-e2e] ${message}`);
}

function fail(code, message) {
  console.error(`[smoke-e2e] FAILURE: ${message}`);
  process.exit(code);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Performs a fetch and returns a normalized result, never throwing. The caller
// inspects the discriminated fields (networkError / jsonError / ok / status).
async function httpRequestJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (err) {
    return { networkError: getErrorMessage(err) };
  }

  let raw;
  try {
    raw = await response.text();
  } catch (err) {
    return { ok: response.ok, status: response.status, jsonError: `failed to read body: ${getErrorMessage(err)}` };
  }

  if (!raw || raw.trim().length === 0) {
    return { ok: response.ok, status: response.status, jsonError: 'empty response body', raw };
  }

  try {
    return { ok: response.ok, status: response.status, json: JSON.parse(raw), raw };
  } catch (err) {
    return { ok: response.ok, status: response.status, jsonError: getErrorMessage(err), raw };
  }
}

// Lightweight status-only fetch for the frontend routes; never throws.
async function httpRequestStatus(url) {
  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    return { networkError: getErrorMessage(err) };
  }
  // Drain the body so the connection can be reused/closed cleanly.
  await response.text().catch(() => undefined);
  return { ok: response.ok, status: response.status };
}

// Returns null when healthy, otherwise a descriptive failure string.
async function checkBackendHealth(target) {
  const result = await httpRequestJson(target.url);
  if (result.networkError) {
    return `${target.name} (${target.url}): network error - ${result.networkError}`;
  }
  if (!result.ok) {
    return `${target.name} (${target.url}): expected HTTP 2xx, got HTTP ${result.status}`;
  }
  if (result.jsonError) {
    return `${target.name} (${target.url}): malformed JSON response - ${result.jsonError}`;
  }
  const body = result.json;
  if (body.success !== true || !body.data || body.data.status !== 'UP') {
    return `${target.name} (${target.url}): unexpected health payload - ${JSON.stringify(body)}`;
  }
  return null;
}

// Returns null when the route returns HTTP 200, otherwise a failure string.
async function checkFrontendRoute(target) {
  const result = await httpRequestStatus(target.url);
  if (result.networkError) {
    return `${target.name} (${target.url}): network error - ${result.networkError}`;
  }
  if (result.status !== 200) {
    return `${target.name} (${target.url}): expected HTTP 200, got HTTP ${result.status}`;
  }
  return null;
}

async function runHealthChecks() {
  log('Checking service health endpoints...');
  const failures = [];

  for (const target of BACKEND_HEALTH_TARGETS) {
    const failure = await checkBackendHealth(target);
    if (failure) {
      failures.push(failure);
    } else {
      log(`OK  ${target.name} (${target.url})`);
    }
  }

  for (const target of FRONTEND_HEALTH_TARGETS) {
    const failure = await checkFrontendRoute(target);
    if (failure) {
      failures.push(failure);
    } else {
      log(`OK  ${target.name} (${target.url})`);
    }
  }

  if (failures.length > 0) {
    fail(
      EXIT_HEALTH,
      `Health checks failed; no pipeline was created. Failing checks:\n  - ${failures.join('\n  - ')}`,
    );
  }
  log('All health checks passed.');
}

async function createPipeline() {
  log('Creating sample pipeline...');
  const result = await httpRequestJson(`${GATEWAY}/api/pipelines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SAMPLE_PIPELINE),
  });

  if (result.networkError) {
    fail(EXIT_CREATE, `Pipeline creation failed: network error contacting ${GATEWAY}/api/pipelines - ${result.networkError}`);
  }
  if (!result.ok) {
    fail(EXIT_CREATE, `Pipeline creation failed: gateway returned HTTP ${result.status} - ${result.raw ?? ''}`);
  }
  if (result.jsonError) {
    fail(EXIT_CREATE, `Pipeline creation failed: malformed JSON response - ${result.jsonError}`);
  }
  if (result.json.success !== true) {
    fail(EXIT_CREATE, `Pipeline creation failed: ${result.json.error || JSON.stringify(result.json)}`);
  }
  const pipelineId = result.json.data && result.json.data.id;
  if (!pipelineId) {
    fail(EXIT_CREATE, `Pipeline creation failed: response did not include a pipeline id - ${JSON.stringify(result.json)}`);
  }

  log(`Created pipeline id=${pipelineId}`);
  return pipelineId;
}

async function triggerExecution(pipelineId) {
  log(`Triggering execution for pipeline ${pipelineId}...`);
  const result = await httpRequestJson(`${GATEWAY}/api/executions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pipelineId, input: {} }),
  });

  if (result.networkError) {
    fail(EXIT_TRIGGER, `Execution trigger failed: network error contacting ${GATEWAY}/api/executions - ${result.networkError}`);
  }
  if (!result.ok) {
    fail(EXIT_TRIGGER, `Execution trigger failed: gateway returned HTTP ${result.status} - ${result.raw ?? ''}`);
  }
  if (result.jsonError) {
    fail(EXIT_TRIGGER, `Execution trigger failed: malformed JSON response - ${result.jsonError}`);
  }
  if (result.json.success !== true) {
    fail(EXIT_TRIGGER, `Execution trigger failed: ${result.json.error || JSON.stringify(result.json)}`);
  }
  const executionId = result.json.data && result.json.data.id;
  if (!executionId) {
    fail(EXIT_TRIGGER, `Execution trigger failed: response did not include an execution id - ${JSON.stringify(result.json)}`);
  }

  log(`Started execution id=${executionId}`);
  return executionId;
}

async function pollExecution(executionId) {
  log(`Polling execution ${executionId} every ${POLL_INTERVAL_MS / 1000}s (timeout ${POLL_TIMEOUT_MS / 1000}s)...`);
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const result = await httpRequestJson(`${GATEWAY}/api/executions/${executionId}`);

    if (result.networkError) {
      fail(EXIT_POLL, `Execution monitoring failed: network error contacting ${GATEWAY}/api/executions/${executionId} - ${result.networkError}`);
    }
    if (!result.ok) {
      fail(EXIT_POLL, `Execution monitoring failed: gateway returned HTTP ${result.status} - ${result.raw ?? ''}`);
    }
    if (result.jsonError) {
      fail(EXIT_POLL, `Execution monitoring failed: malformed JSON response - ${result.jsonError}`);
    }
    if (result.json.success !== true || !result.json.data) {
      fail(EXIT_POLL, `Execution monitoring failed: ${result.json.error || JSON.stringify(result.json)}`);
    }

    const status = result.json.data.status;
    log(`status=${status}`);

    if (status === 'COMPLETED') {
      log(`Execution ${executionId} reached COMPLETED.`);
      log('SUCCESS: end-to-end pipeline completed.');
      process.exit(EXIT_OK);
    }
    if (status === 'FAILED') {
      fail(
        EXIT_FAILED,
        `Execution ${executionId} reached FAILED terminal state - ${JSON.stringify(result.json.data.output ?? null)}`,
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }

  fail(
    EXIT_TIMEOUT,
    `Execution ${executionId} did not reach a terminal state within ${POLL_TIMEOUT_MS / 1000}s timeout.`,
  );
}

async function main() {
  if (typeof fetch !== 'function') {
    fail(EXIT_PREREQ, 'global fetch is unavailable; this script requires Node 18 or newer.');
  }

  await runHealthChecks();
  const pipelineId = await createPipeline();
  const executionId = await triggerExecution(pipelineId);
  await pollExecution(executionId);
}

main().catch((err) => {
  fail(EXIT_POLL, `Unexpected error during smoke verification: ${getErrorMessage(err)}`);
});
