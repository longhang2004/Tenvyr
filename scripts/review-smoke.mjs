#!/usr/bin/env node

/**
 * T07 Review Smoke Client.
 *
 * Drives end-to-end HTTP review workflow:
 * 1. Reads generated private credentials from TENVYR_REVIEW_RUNTIME_DIR.
 * 2. Authenticates Submitter A via form login with session cookies and CSRF.
 * 3. Submits code review with Idempotency-Key; verifies 202, Location, and SubmissionDTO.
 * 4. Verifies idempotency replay convergence.
 * 5. Polls report until ready; asserts typed ReviewReport evidence.mode is "MOCK".
 * 6. Authenticates Reviewer; submits APPROVE decision with Idempotency-Key; verifies 201 and replay 200.
 * 7. Verifies audit entries for SUBMIT and DECIDE with stable actor UUIDs.
 * 8. Authenticates Submitter B (foreign user) and verifies 404 access denial on Submitter A's review.
 * 9. Exports safe identities proof for multi-cycle verification without printing passwords/tokens.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

const BASE_URL = process.env.TENVYR_REVIEW_BASE_URL || "http://127.0.0.1:8080";
let RUNTIME_DIR = process.env.TENVYR_REVIEW_RUNTIME_DIR;
if (!RUNTIME_DIR || RUNTIME_DIR.trim() === "") {
  const home = homedir() || process.env.HOME || process.env.USERPROFILE || "/tmp";
  RUNTIME_DIR = join(home, ".tenvyr", "review-runtime");
}
const BOOTSTRAP_FILE = join(RUNTIME_DIR, "bootstrap.json");

if (!existsSync(BOOTSTRAP_FILE)) {
  process.stderr.write("Smoke test error: missing bootstrap file at " + BOOTSTRAP_FILE + "\n");
  process.exit(1);
}

const bootstrapUsers = JSON.parse(readFileSync(BOOTSTRAP_FILE, "utf8"));
const submitterA = bootstrapUsers.find((u) => u.username === "submitter_a" || u.role === "SUBMITTER");
const reviewer = bootstrapUsers.find((u) => u.role === "REVIEWER");
const submitterB = bootstrapUsers.find((u) => u.username !== submitterA.username && u.role === "SUBMITTER");

assert.ok(submitterA, "Submitter A must exist in bootstrap manifest");
assert.ok(reviewer, "Reviewer must exist in bootstrap manifest");
assert.ok(submitterB, "Submitter B must exist in bootstrap manifest");

class TestHttpClient {
  constructor() {
    this.cookies = new Map();
  }

  getCookieHeader() {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  saveCookies(response) {
    const setCookies = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")] : []);

    for (const raw of setCookies) {
      if (!raw) continue;
      const cookiePair = raw.split(";")[0];
      const eqIdx = cookiePair.indexOf("=");
      if (eqIdx !== -1) {
        const name = cookiePair.slice(0, eqIdx).trim();
        const val = cookiePair.slice(eqIdx + 1).trim();
        this.cookies.set(name, val);
      }
    }
  }

  async fetch(url, options = {}) {
    const headers = { ...options.headers };
    const cookieHeader = this.getCookieHeader();
    if (cookieHeader) {
      headers["Cookie"] = cookieHeader;
    }

    const signal = options.signal || AbortSignal.timeout(options.timeout || 10000);
    const fetchOptions = {
      ...options,
      headers,
      signal,
      redirect: "manual",
    };

    let res = await fetch(url, fetchOptions);
    this.saveCookies(res);

    // Handle same-origin redirects securely
    let hops = 0;
    while (res.status >= 300 && res.status < 400 && hops < 5) {
      const loc = res.headers.get("location");
      if (!loc) break;
      const currentOrigin = new URL(url).origin;
      const nextUrl = new URL(loc, url);
      assert.equal(
        nextUrl.origin,
        currentOrigin,
        `Untrusted redirect origin rejected: ${nextUrl.origin} vs ${currentOrigin}`
      );

      hops++;
      const nextHeaders = { ...headers };
      const nextCookies = this.getCookieHeader();
      if (nextCookies) {
        nextHeaders["Cookie"] = nextCookies;
      }
      res = await fetch(nextUrl.href, {
        method: "GET",
        headers: nextHeaders,
        signal: AbortSignal.timeout(options.timeout || 10000),
        redirect: "manual",
      });
      this.saveCookies(res);
    }

    return res;
  }
}

async function getCsrf(client) {
  const res = await client.fetch(`${BASE_URL}/api/v1/auth/csrf`);
  assert.equal(res.status, 200, "CSRF endpoint must return 200");
  const data = await res.json();
  assert.ok(data.headerName && data.parameterName && data.token, "Invalid CSRF response format");
  return data;
}

async function login(client, user) {
  const preCsrf = await getCsrf(client);
  const body = new URLSearchParams();
  body.append("username", user.username);
  body.append("password", user.password);
  body.append(preCsrf.parameterName, preCsrf.token);

  const loginRes = await client.fetch(`${BASE_URL}/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      [preCsrf.headerName]: preCsrf.token,
    },
    body: body.toString(),
  });

  assert.equal(loginRes.status, 204, "Form login must return 204 No Content");
  const postCsrf = await getCsrf(client);
  return postCsrf;
}

async function main() {
  process.stdout.write("[Smoke] Connecting to " + BASE_URL + "...\n");

  // 1. Authenticate Submitter A
  const clientA = new TestHttpClient();
  let csrfA = await login(clientA, submitterA);

  const meResA = await clientA.fetch(`${BASE_URL}/api/v1/me`);
  assert.equal(meResA.status, 200);
  const meA = await meResA.json();
  assert.equal(meA.username, submitterA.username);
  assert.equal(meA.role, "SUBMITTER");
  assert.ok(meA.id, "Submitter A must have a non-null UUID");

  // 2. Submit review and verify 202, Location header, and SubmissionDTO
  const submitKey = randomUUID();
  const reviewPayload = {
    title: "Smoke Showcase Review",
    language: "java",
    code: "public class SmokeFixture { public static void main(String[] args) { System.out.println(\"smoke\"); } }",
  };

  const submitRes1 = await clientA.fetch(`${BASE_URL}/api/v1/reviews`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": submitKey,
      [csrfA.headerName]: csrfA.token,
    },
    body: JSON.stringify(reviewPayload),
  });
  assert.equal(submitRes1.status, 202, "Review submission must return 202 Accepted");

  const locationHeader = submitRes1.headers.get("location");
  assert.ok(locationHeader, "Review submission must return Location header");

  const submitData1 = await submitRes1.json();
  const requestId = submitData1.id;
  assert.ok(requestId, "Submission DTO must contain id");
  assert.ok(submitData1.status, "Submission DTO must contain status");
  assert.ok(submitData1.createdAt, "Submission DTO must contain createdAt");
  assert.ok(submitData1.executionId, "Submission DTO must contain executionId");
  assert.ok(
    locationHeader.endsWith("/api/v1/reviews/" + requestId),
    `Location header ${locationHeader} must match review id ${requestId}`
  );

  // Idempotency replay
  const submitResReplay = await clientA.fetch(`${BASE_URL}/api/v1/reviews`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": submitKey,
      [csrfA.headerName]: csrfA.token,
    },
    body: JSON.stringify(reviewPayload),
  });
  assert.equal(submitResReplay.status, 202);
  const submitDataReplay = await submitResReplay.json();
  assert.equal(submitDataReplay.id, requestId, "Replay must return identical request ID");

  // 3. Poll review report until completed and assert typed ReviewReport
  let reportData = null;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const reportRes = await clientA.fetch(`${BASE_URL}/api/v1/reviews/${requestId}/report`);
    if (reportRes.status === 200) {
      reportData = await reportRes.json();
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  assert.ok(reportData, "Report must be ready within deadline");
  assert.equal(typeof reportData.score, "number");
  assert.ok(Array.isArray(reportData.findings));
  assert.ok(reportData.evidence, "Report must contain evidence metadata");
  assert.equal(reportData.evidence.mode, "MOCK", "Smoke review report must declare mode MOCK");
  assert.equal(reportData.evidence.provider, "mock");
  assert.equal(reportData.evidence.model, "demo-fixture");

  // 4. Authenticate Reviewer and submit decision
  const clientRev = new TestHttpClient();
  const csrfRev = await login(clientRev, reviewer);

  const meResRev = await clientRev.fetch(`${BASE_URL}/api/v1/me`);
  assert.equal(meResRev.status, 200);
  const meRev = await meResRev.json();
  assert.equal(meRev.role, "REVIEWER");
  assert.notEqual(meRev.id, meA.id, "Reviewer must have a distinct user ID from Submitter");

  const decideKey = randomUUID();
  const decidePayload = {
    action: "APPROVE",
    comment: "Smoke test approved",
  };

  const decideRes1 = await clientRev.fetch(`${BASE_URL}/api/v1/reviews/${requestId}/decisions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": decideKey,
      [csrfRev.headerName]: csrfRev.token,
    },
    body: JSON.stringify(decidePayload),
  });
  assert.equal(decideRes1.status, 201, "Decision must return 201 Created");
  const decisionLocation = decideRes1.headers.get("location");
  assert.ok(decisionLocation, "Decision response must contain Location header");

  const decisionData = await decideRes1.json();
  assert.equal(decisionData.action, "APPROVE");
  assert.equal(decisionData.requestId, requestId);
  assert.equal(decisionData.actorId, meRev.id);
  const decisionId = decisionData.id;
  assert.ok(
    decisionLocation.endsWith("/decisions/" + decisionId),
    `Location header ${decisionLocation} must point to decision id ${decisionId}`
  );

  // Decision replay
  const decideResReplay = await clientRev.fetch(`${BASE_URL}/api/v1/reviews/${requestId}/decisions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": decideKey,
      [csrfRev.headerName]: csrfRev.token,
    },
    body: JSON.stringify(decidePayload),
  });
  assert.equal(decideResReplay.status, 200);
  const decideReplayData = await decideResReplay.json();
  assert.equal(decideReplayData.id, decisionId, "Decision replay must return identical decision ID");

  // 5. Verify audit log contains SUBMIT and DECIDE entries with correct actor IDs
  const auditRes = await clientRev.fetch(`${BASE_URL}/api/v1/reviews/${requestId}/audit`);
  assert.equal(auditRes.status, 200);
  const auditData = await auditRes.json();
  assert.ok(auditData.items && auditData.items.length >= 2, "Audit log must contain SUBMIT and DECIDE entries");
  assert.ok(
    auditData.items.some((e) => e.action === "SUBMIT" && e.actorId === meA.id),
    "Audit log must contain SUBMIT entry by Submitter A"
  );
  assert.ok(
    auditData.items.some((e) => e.action === "DECIDE" && e.actorId === meRev.id),
    "Audit log must contain DECIDE entry by Reviewer"
  );

  // 6. Authenticate Submitter B and verify 404 access denial on Submitter A's review
  const clientB = new TestHttpClient();
  await login(clientB, submitterB);

  const meResB = await clientB.fetch(`${BASE_URL}/api/v1/me`);
  assert.equal(meResB.status, 200);
  const meB = await meResB.json();
  assert.notEqual(meB.id, meA.id);
  assert.notEqual(meB.id, meRev.id);

  const foreignRes = await clientB.fetch(`${BASE_URL}/api/v1/reviews/${requestId}`);
  assert.equal(foreignRes.status, 404, "Foreign user reading review must receive 404 Not Found");

  // 7. Output safe identities proof without printing passwords or tokens
  process.stdout.write(`[Smoke] Submitter A ID: ${meA.id}\n`);
  process.stdout.write(`[Smoke] Submitter B ID: ${meB.id}\n`);
  process.stdout.write(`[Smoke] Reviewer ID: ${meRev.id}\n`);
  process.stdout.write(`[Smoke] Review Request ID: ${requestId}\n`);
  process.stdout.write(`[Smoke] Review Decision ID: ${decisionId}\n`);
  process.stdout.write(`[Smoke] Evidence Mode: ${reportData.evidence.mode}\n`);
  process.stdout.write("[Smoke] All review showcase smoke gates passed successfully.\n");
}

main().catch((err) => {
  process.stderr.write(`[Smoke] Failure: ${err.message}\n`);
  process.exit(1);
});
