import { DataSource, type DataSourceOptions } from "typeorm";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import type { AddressInfo } from "net";
import { createTenvyrWorker, defineAgent, type TenvyrWorker } from "@tenvyr/worker";
import { databaseOptions } from "./database/database.provider";
import { ExecutionEntity } from "./entities/execution.entity";
import { PipelineEntity } from "./entities/pipeline.entity";
import { LogicalStepEntity } from "./entities/step-execution.entity";
import { StepAttemptEntity } from "./entities/step-attempt.entity";
import { ExecutionPlanRevisionEntity } from "./entities/execution-plan-revision.entity";
import { DispatchOutboxEntity } from "./entities/dispatch-outbox.entity";
import { BudgetReservationEntity } from "./entities/budget-reservation.entity";
import { ExecutionService } from "./services/execution.service";
import { EngineService } from "./services/engine.service";
import { DispatchOutboxService } from "./services/dispatch-outbox.service";
import { ResultInboxService } from "./services/result-inbox.service";
import { ExecutionCapsuleService } from "./services/execution-capsule.service";
import { DelegationService } from "./services/delegation.service";
import { PipelineService } from "./services/pipeline.service";
import { PipelineValidationService } from "./services/pipeline-validation.service";
import { ConditionEvaluatorService } from "./services/condition-evaluator.service";
import { AgentTransportConfigService, parseAgentTransportConfiguration } from "./agent-adapters/agent-transport-config.service";
import { HttpAgentAdapter } from "./agent-adapters/http-agent.adapter";
import { HttpAgentCallbackController } from "./agent-adapters/http-agent-callback.controller";
import { WorkbenchProjectionService } from "./services/workbench-projection.service";
import { sha256Json } from "./domain/canonical-json";
import { jsonValueUtf8Size } from "./domain/execution-state";
import { parseEfficiencyEvidence } from "./domain/context-bundle";

/**
 * P3 deterministic dogfood — Invocation Efficiency / Context Projection
 * baseline, NO paid provider, NO live runtime:
 *
 *   real PostgreSQL + real engine claim/dispatch + real in-process
 *   deterministic HTTP worker (@tenvyr/worker) + real policy/budget/deadline
 *   authority, over a pipeline step with an immutable context projection.
 *
 * Expected: run 1 ContextBundle cache MISS → run 2 (identical canonical
 * projection inputs) HIT with byte-identical envelope + identical hash →
 * ONE mutated load-bearing context input gives MISS + a new fingerprint.
 * Authority stays LIVE after cache population: a policy DENY still blocks
 * (durable FAILED attempt, no outbox) even on a cache HIT, an expired
 * deadline still blocks, and the Capsule + Workbench projection reconstruct
 * the recorded bundle identity and efficiency evidence from frozen rows.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;

const configuredDatabaseName = String(databaseOptions().database);

const assertDisposableTarget = (url: string | undefined): void => {
  if (!url) return;
  const database = decodeURIComponent(
    new URL(url).pathname.replace(/^\/+/, "").replace(/\/+$/, ""),
  );
  if (!database || database.toLowerCase() === configuredDatabaseName.toLowerCase()) {
    throw new Error(
      "TEST_DATABASE_URL must name a disposable database, never the configured one",
    );
  }
};

const availablePort = (): Promise<number> =>
  new Promise((resolve) => {
    const server = require("node:net").createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });

const httpAgent = (host: string, port: number) => ({
  kind: "http",
  submitUrl: `http://${host}:${port}/v1/runs`,
  outboundAuthentication: { type: "bearer", tokenEnv: "TEAM_WORKER_TOKEN" },
  callbackAuthentication: { keyId: "team-v1", secretEnv: "TEAM_CALLBACK_SECRET" },
  requestTimeoutMs: 5000,
  maxResponseBytes: 64 * 1024,
  delegationModes: ["opaque"],
});

const ALLOW_POLICY_V1 = JSON.stringify({
  version: 1,
  rules: [{ id: "allow-dispatch", actionType: "dispatch", effect: "ALLOW" }],
});

const DENY_POLICY_V2 = JSON.stringify({
  version: 2,
  rules: [
    { id: "deny-team-worker", actionType: "dispatch", effect: "DENY", agents: ["team-worker"] },
  ],
});

describeWithPostgres("P3 invocation-efficiency dogfood (ContextBundle MISS -> HIT -> mutation -> MISS)", () => {
  jest.setTimeout(240_000);

  let dataSource: DataSource;
  let workers: TenvyrWorker[];
  let app: INestApplication;
  let adapter: HttpAgentAdapter;
  let inbox: ResultInboxService;
  let executionService: ExecutionService;
  let engine: EngineService;
  let outboxService: DispatchOutboxService;
  let capsules: ExecutionCapsuleService;
  let projection: WorkbenchProjectionService;

  const pipelineSteps = [
    {
      id: "work",
      agent: "team-worker",
      contextProjection: { stateKeys: ["brief"] },
      budget: { tokens: 1000 },
    },
  ];
  const pipelineBudget = { tokens: 1000 };

  /** Real deterministic in-process worker; reports usage exactly like a
   *  runtime that observed provider cache evidence. */
  const workerDefinition = {
    name: "team-worker",
    execute: async (context: any) =>
      context.success({
        output: { done: true, observedModelId: "deepseek-v4-flash" },
        usage: { inputTokens: 28_402, cachedInputTokens: 17_931, outputTokens: 3_124 },
      }),
  };

  beforeAll(async () => {
    assertDisposableTarget(TEST_DATABASE_URL);
    dataSource = new DataSource({
      ...databaseOptions(),
      type: "postgres" as const,
      url: TEST_DATABASE_URL,
    } as DataSourceOptions);
    await dataSource.initialize();
    await dataSource.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await dataSource.runMigrations();

    const callbackPort = await availablePort();
    const callbackOrigin = `http://127.0.0.1:${callbackPort}`;

    const roleWorker = createTenvyrWorker({
      agent: defineAgent(workerDefinition as any) as any,
      authentication: { bearerToken: "team-worker-token" },
      callbackAuthentication: { keys: { "team-v1": "team-callback-secret" } },
      callbackPolicy: {
        allowedOrigins: [callbackOrigin],
        allowInsecureHttp: true,
      },
      callbackDelivery: {
        maxAttempts: 2,
        initialDelayMs: 1,
        maxDelayMs: 2,
        jitterRatio: 0,
        requestTimeoutMs: 1000,
      },
    });
    const address = await roleWorker.start({ host: "127.0.0.1", port: 0 });
    workers = [roleWorker];

    const agentsEnv: Record<string, unknown> = {
      "team-worker": httpAgent("127.0.0.1", address.port),
    };
    const config = new AgentTransportConfigService(
      parseAgentTransportConfiguration({
        AGENT_TRANSPORT_CONFIG: JSON.stringify(agentsEnv),
        HTTP_AGENT_CALLBACK_BASE_URL: callbackOrigin,
        HTTP_AGENT_ALLOW_INSECURE: "true",
        TEAM_WORKER_TOKEN: "team-worker-token",
        TEAM_CALLBACK_SECRET: "team-callback-secret",
      }),
    );
    (config as any).configuration.callbackAllowedOrigins = [callbackOrigin];

    const module = await Test.createTestingModule({
      controllers: [HttpAgentCallbackController],
      providers: [
        { provide: AgentTransportConfigService, useValue: config },
        HttpAgentAdapter,
      ],
    }).compile();
    app = module.createNestApplication({ rawBody: true });
    await app.listen(callbackPort, "127.0.0.1");
    adapter = module.get(HttpAgentAdapter);

    inbox = new ResultInboxService(dataSource);
    await adapter.start({
      result: async ({ result, transport }) => {
        await inbox.apply(result, transport);
      },
      event: async () => undefined,
    });

    executionService = new ExecutionService(
      dataSource.getRepository(ExecutionEntity),
      dataSource.getRepository(LogicalStepEntity),
      dataSource.getRepository(StepAttemptEntity),
      dataSource.getRepository(ExecutionPlanRevisionEntity),
      dataSource,
      undefined,
      config,
    );
    outboxService = new DispatchOutboxService(dataSource as any, adapter, config);
    engine = new EngineService(
      new PipelineService(
        dataSource as any,
        new PipelineValidationService(new ConditionEvaluatorService()),
      ) as any,
      executionService,
      adapter,
      outboxService,
    );
    capsules = new ExecutionCapsuleService(
      dataSource as any,
      new DelegationService(dataSource as any, executionService),
      executionService,
    );
    projection = new WorkbenchProjectionService(dataSource as any);
    process.env.TENVYR_POLICY = ALLOW_POLICY_V1;
  });

  afterAll(async () => {
    delete process.env.TENVYR_POLICY;
    await adapter?.stop();
    await app?.close();
    for (const roleWorker of workers ?? []) {
      await roleWorker.stop();
    }
    await dataSource?.destroy();
  });

  /** Creates a fresh pipeline (kept across the whole suite: the SAME
   *  immutable workspace/context + projection configuration for every
   *  run; runs only vary the seeded state or the authority). */
  const pipeline = async () => {
    const repository = dataSource.getRepository(PipelineEntity);
    const existing = await repository.findOne({ where: { name: "p3-dogfood" } });
    if (existing) return existing;
    return repository.save(
      repository.create({
        name: "p3-dogfood",
        version: "1.0",
        steps: pipelineSteps as any[],
        budget: pipelineBudget as any,
      }),
    );
  };

  /** Pipeline WITHOUT a contextProjection: the runtime invocation still
   *  carries the immutable efficiency evidence, but its ContextBundle is
   *  the legitimate `null` variant. */
  const plainPipeline = async () => {
    const repository = dataSource.getRepository(PipelineEntity);
    const existing = await repository.findOne({ where: { name: "p3-plain" } });
    if (existing) return existing;
    return repository.save(
      repository.create({
        name: "p3-plain",
        version: "1.0",
        steps: [{ id: "plain", agent: "team-worker" }] as any[],
      }),
    );
  };

  /** Seeds a fresh execution with the given projected state. */
  const seedExecution = async (state: Record<string, unknown>) => {
    const definition = await pipeline();
    const execution = await executionService.createExecution(definition, { goal: "bounded" });
    await dataSource
      .getRepository(ExecutionEntity)
      .update(execution.id, { executionState: state });
    return execution.id;
  };

  /** Seeds a fresh NO-PROJECTION execution (plain pipeline). */
  const seedPlainExecution = async () => {
    const definition = await plainPipeline();
    const execution = await executionService.createExecution(definition, { goal: "plain" });
    return execution.id;
  };

  /** Drives the REAL engine claim + dispatch + callback loop to a terminal
   *  step outcome. */
  const runToTerminal = async (executionId: string) => {
    const terminal = async () => {
      const execution = await dataSource
        .getRepository(ExecutionEntity)
        .findOne({ where: { id: executionId } });
      return execution ? ["COMPLETED", "FAILED", "CANCELLED"].includes(execution.status) : true;
    };
    for (let pass = 0; pass < 60 && !(await terminal()); pass += 1) {
      await engine.reconcileExecution(executionId);
      await outboxService.dispatchNext();
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
    await engine.reconcileExecution(executionId);
  };

  const attemptFor = async (executionId: string) => {
    const attempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { executionId }, order: { createdAt: "ASC" } });
    if (!attempt) throw new Error(`no attempt for ${executionId}`);
    return attempt;
  };

  it("run 1 MISS -> run 2 HIT (identical envelope + hash) -> mutation MISS -> authority stays live -> capsule/projection reconstruct", async () => {
    // ---- Run 1: canonical context, policy ALLOW v1 → cache MISS.
    const run1 = await seedExecution({ brief: { plan: "A", version: 1 } });
    await runToTerminal(run1);
    const attempt1 = await attemptFor(run1);
    expect(attempt1.status).toBe("SUCCESS");
    const evidence1 = parseEfficiencyEvidence(attempt1.efficiency);
    expect(evidence1.contextBundle).not.toBeNull();
    expect(evidence1.contextBundle!.reused).toBe(false);
    expect(evidence1.contextBundle!.hash).toMatch(/^[0-9a-f]{64}$/);
    const hash1 = evidence1.contextBundle!.hash;
    // Bounded metrics + truthful session + observed usage.
    expect(evidence1.context).not.toBeNull();
    expect(evidence1.context!.projectedBytes).toBeGreaterThan(0);
    expect(evidence1.context!.selectedContextItemCount).toBe(1);
    expect(evidence1.session.mode).toBe("fresh");
    expect(evidence1.usage).toEqual({
      reported: true,
      inputTokens: 28_402,
      cachedInputTokens: 17_931,
      outputTokens: 3_124,
    });
    expect(evidence1.timing.completedAt).not.toBeNull();
    expect(evidence1.timing.durationMs).toBeGreaterThanOrEqual(0);
    const envelope1 = attempt1.contextSnapshot as Record<string, unknown>;
    const statsAfterRun1 = executionService.bundleCache.stats();
    expect(statsAfterRun1.misses).toBeGreaterThanOrEqual(1);

    // ---- Run 2: SAME canonical projection inputs → HIT + same hash +
    // byte-identical semantic envelope.
    const run2 = await seedExecution({ brief: { plan: "A", version: 1 } });
    await runToTerminal(run2);
    const attempt2 = await attemptFor(run2);
    expect(attempt2.status).toBe("SUCCESS");
    const evidence2 = parseEfficiencyEvidence(attempt2.efficiency);
    expect(evidence2.contextBundle!.hash).toBe(hash1);
    expect(evidence2.contextBundle!.reused).toBe(true);
    expect(attempt2.contextSnapshot).toEqual(envelope1);
    expect(sha256Json(attempt2.contextSnapshot)).toBe(sha256Json(envelope1));
    const statsAfterRun2 = executionService.bundleCache.stats();
    expect(statsAfterRun2.hits).toBeGreaterThanOrEqual(1);

    // Budget authority still executes on the HIT claim: the reservation
    // was minted for run 2 exactly like run 1 (keyed by the attempt).
    const reservations2 = await dataSource
      .getRepository(BudgetReservationEntity)
      .count({ where: { actionRef: attempt2.invocationId } });
    expect(reservations2).toBe(1);

    // ---- Mutation: ONE load-bearing context input changes → cache MISS +
    // NEW fingerprint.
    const run3 = await seedExecution({ brief: { plan: "A", version: 2 } });
    await runToTerminal(run3);
    const attempt3 = await attemptFor(run3);
    expect(attempt3.status).toBe("SUCCESS");
    const evidence3 = parseEfficiencyEvidence(attempt3.efficiency);
    expect(evidence3.contextBundle!.hash).not.toBe(hash1);
    expect(evidence3.contextBundle!.reused).toBe(false);

    // ---- Authority independence: after cache population, a policy DENY
    // still blocks execution even though the projection cache HITS.
    const run4 = await seedExecution({ brief: { plan: "A", version: 1 } });
    process.env.TENVYR_POLICY = DENY_POLICY_V2;
    await runToTerminal(run4);
    process.env.TENVYR_POLICY = ALLOW_POLICY_V1;
    const attempt4 = await attemptFor(run4);
    expect(attempt4.status).toBe("FAILED");
    expect(attempt4.error).toContain("Policy DENY");
    const evidence4 = parseEfficiencyEvidence(attempt4.efficiency);
    // The deterministic inputs are identical to run 1/2 → the cache HIT;
    // the denied attempt records the SAME bundle identity WITH reuse, and
    // NO outbox was created (no dispatch authority granted).
    expect(evidence4.contextBundle!.hash).toBe(hash1);
    expect(evidence4.contextBundle!.reused).toBe(true);
    expect(evidence4.session.mode).toBe("unknown");
    const outbox4 = await dataSource
      .getRepository(DispatchOutboxEntity)
      .count({ where: { stepAttemptId: attempt4.id } });
    expect(outbox4).toBe(0);

    // ---- Deadline authority stays live after cache population.
    const run5 = await seedExecution({ brief: { plan: "A", version: 1 } });
    await dataSource
      .getRepository(ExecutionEntity)
      .update(run5, { authorityDeadlineAt: new Date(Date.now() - 60_000) });
    await runToTerminal(run5);
    const execution5 = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: run5 } });
    expect(execution5?.status).toBe("FAILED");
    expect(execution5?.terminationReason).toBe("AUTHORITY_DEADLINE_EXCEEDED");

    // ---- Capsule: historical execution reconstructs the EXACT recorded
    // bundle identity + efficiency evidence from frozen rows.
    const capsule = await capsules.build(run2);
    const capsuleAttempt = capsule.attempts[0];
    expect(capsuleAttempt.contextSnapshotHash).toBe(sha256Json(envelope1));
    const capsuleEvidence = parseEfficiencyEvidence(capsuleAttempt.efficiency);
    expect(capsuleEvidence.contextBundle!.hash).toBe(hash1);
    expect(capsuleEvidence.contextBundle!.reused).toBe(true);
    expect(capsuleEvidence.usage.inputTokens).toBe(28_402);
    expect(capsuleEvidence.usage.cachedInputTokens).toBe(17_931);

    // ---- Workbench projection: per-attempt + aggregate efficiency with
    // real data only (never fabricated usage).
    const projected = await projection.executionProjection(run2);
    const attemptSummary = projected.attempts.find(
      (entry) => entry.attemptNumber === 1,
    );
    expect(attemptSummary?.efficiency?.contextBundleHash).toBe(hash1);
    expect(attemptSummary?.efficiency?.contextBundleReused).toBe(true);
    expect(attemptSummary?.efficiency?.sessionMode).toBe("fresh");
    expect(attemptSummary?.efficiency?.cachedInputTokens).toBe(17_931);
    expect(attemptSummary?.efficiency?.usageReported).toBe(true);
    expect(attemptSummary?.efficiency?.cachedInputTokens).toBe(17_931);
    // Aggregates are per-execution: run 1 BUILT the bundle (MISS), run 2
    // REUSED it (HIT).
    const projectedRun1 = await projection.executionProjection(run1);
    expect(projectedRun1.efficiency.bundlesBuilt).toBe(1);
    expect(projectedRun1.efficiency.bundlesReused).toBe(0);
    expect(projected.efficiency.bundlesReused).toBe(1);
    expect(projected.efficiency.bundlesBuilt).toBe(0);
    expect(projected.efficiency.projectedTotalBytes).toBe(
      evidence2.context!.projectedBytes,
    );
    expect(projected.efficiency.providerCacheEvidenceAttempts).toBe(1);
    expect(projected.efficiency.providerCacheHitAttempts).toBe(1);
    expect(projected.efficiency.runtimeDurationMs).toBeGreaterThanOrEqual(0);

    // ---- Missing usage is never zero: a later plain attempt (no usage
    // reported) must render absent, not 0. The denied attempt has no
    // usage; its projection must not fabricate numbers.
    const projectedDenied = await projection.executionProjection(run4);
    const deniedSummary = projectedDenied.attempts[0];
    expect(deniedSummary?.efficiency?.usageReported).toBe(false);
    expect(deniedSummary?.efficiency?.cachedInputTokens).toBeUndefined();
    expect(deniedSummary?.efficiency?.inputTokens).toBeUndefined();
  }, 240_000);

  it("no-context runtime attempt: null ContextBundle round-trips claim -> acceptance -> Workbench -> Capsule", async () => {
    // A dispatchable invocation WITHOUT a contextProjection records the
    // legitimate `contextBundle: null` / `context: null` evidence; result
    // acceptance must still complete usage + timing, and every projection
    // surface must parse and render the record (regression: the parser
    // threw on null, hiding these attempts from efficiency projections).
    const plain = await seedPlainExecution();
    await runToTerminal(plain);
    const attempt = await attemptFor(plain);
    expect(attempt.status).toBe("SUCCESS");

    const evidence = parseEfficiencyEvidence(attempt.efficiency);
    expect(evidence.contextBundle).toBeNull();
    expect(evidence.context).toBeNull();
    expect(evidence.session.mode).toBe("fresh");
    expect(evidence.usage).toEqual({
      reported: true,
      inputTokens: 28_402,
      cachedInputTokens: 17_931,
      outputTokens: 3_124,
    });
    expect(evidence.timing.completedAt).not.toBeNull();
    expect(evidence.timing.durationMs).toBeGreaterThanOrEqual(0);

    // Workbench: the attempt is visible with null bundle semantics and its
    // real usage; the aggregate counts it as evidence without inventing a
    // bundle.
    const projected = await projection.executionProjection(plain);
    const summary = projected.attempts.find(
      (entry) => entry.attemptNumber === 1,
    );
    expect(summary?.efficiency).toBeDefined();
    expect(summary?.efficiency?.contextBundleHash).toBeNull();
    expect(summary?.efficiency?.contextBundleReused).toBeNull();
    expect(summary?.efficiency?.sessionMode).toBe("fresh");
    expect(summary?.efficiency?.usageReported).toBe(true);
    expect(summary?.efficiency?.cachedInputTokens).toBe(17_931);
    expect(projected.efficiency.attemptCount).toBe(1);
    expect(projected.efficiency.bundleAttempts).toBe(0);
    expect(projected.efficiency.bundlesBuilt).toBe(0);
    expect(projected.efficiency.bundlesReused).toBe(0);
    expect(projected.efficiency.providerCacheEvidenceAttempts).toBe(1);
    expect(projected.efficiency.providerCacheHitAttempts).toBe(1);

    // Capsule preserves and parses the null-bundle record.
    const capsule = await capsules.build(plain);
    const capsuleEvidence = parseEfficiencyEvidence(capsule.attempts[0].efficiency);
    expect(capsuleEvidence.contextBundle).toBeNull();
    expect(capsuleEvidence.usage.inputTokens).toBe(28_402);
    expect(capsuleEvidence.timing.durationMs).toBeGreaterThanOrEqual(0);
  }, 240_000);

  it("pre-dispatch blocked attempt without projection records null ContextBundle truthfully", async () => {
    // A policy-DENIED attempt never establishes a runtime session: session
    // mode is `unknown`, usage stays not-reported (never zero), and the
    // null ContextBundle variant parses and renders.
    const blocked = await seedPlainExecution();
    process.env.TENVYR_POLICY = DENY_POLICY_V2;
    await runToTerminal(blocked);
    process.env.TENVYR_POLICY = ALLOW_POLICY_V1;

    const attempt = await attemptFor(blocked);
    expect(attempt.status).toBe("FAILED");
    expect(attempt.error).toContain("Policy DENY");
    const evidence = parseEfficiencyEvidence(attempt.efficiency);
    expect(evidence.contextBundle).toBeNull();
    expect(evidence.context).toBeNull();
    expect(evidence.session.mode).toBe("unknown");
    expect(evidence.usage).toEqual({ reported: false });
    expect(evidence.timing.completedAt).toBeNull();
    expect(evidence.timing.durationMs).toBeNull();

    const projected = await projection.executionProjection(blocked);
    const summary = projected.attempts[0];
    expect(summary?.efficiency?.contextBundleHash).toBeNull();
    expect(summary?.efficiency?.sessionMode).toBe("unknown");
    expect(summary?.efficiency?.usageReported).toBe(false);
    expect(summary?.efficiency?.cachedInputTokens).toBeUndefined();
  }, 240_000);

  it("cross-execution HIT with different unselected state: same hash, identical envelopes, each attempt records its OWN executionStateBytes", async () => {
    // The ContextBundle identity covers only the SELECTED projection +
    // version. Two executions with identical selected values but different
    // UNSELECTED state sizes legitimately share a hash and a cache HIT —
    // but `executionStateBytes` measures the FULL current state and must be
    // recomputed per claim, never inherited from the cached bundle.
    const selected = { brief: { task: "metric", n: 1 } };
    const smallTail = { "unselected.small": "tiny" };
    const largeTail = { "unselected.large": "x".repeat(4000) };

    const runA = await seedExecution({ ...selected, ...smallTail });
    await runToTerminal(runA);
    const attemptA = await attemptFor(runA);
    expect(attemptA.status).toBe("SUCCESS");
    const evidenceA = parseEfficiencyEvidence(attemptA.efficiency);
    expect(evidenceA.contextBundle!.reused).toBe(false);
    const hashA = evidenceA.contextBundle!.hash;

    const runB = await seedExecution({ ...selected, ...largeTail });
    await runToTerminal(runB);
    const attemptB = await attemptFor(runB);
    expect(attemptB.status).toBe("SUCCESS");
    const evidenceB = parseEfficiencyEvidence(attemptB.efficiency);

    // Same identity, cache HIT, byte-identical envelopes.
    expect(evidenceB.contextBundle!.hash).toBe(hashA);
    expect(evidenceB.contextBundle!.reused).toBe(true);
    expect(attemptB.contextSnapshot).toEqual(attemptA.contextSnapshot);
    expect(sha256Json(attemptB.contextSnapshot)).toBe(
      sha256Json(attemptA.contextSnapshot),
    );

    // Envelope-derived metrics are identical (functions of the envelope).
    expect(evidenceB.context!.projectedBytes).toBe(
      evidenceA.context!.projectedBytes,
    );
    expect(evidenceB.context!.projectedCharacters).toBe(
      evidenceA.context!.projectedCharacters,
    );
    expect(evidenceB.context!.selectedContextItemCount).toBe(
      evidenceA.context!.selectedContextItemCount,
    );
    expect(evidenceB.context!.selectedArtifactCount).toBe(
      evidenceA.context!.selectedArtifactCount,
    );

    // Each attempt records ITS OWN full-state size — the cached bundle
    // must never leak execution A's unselected-state size into execution B.
    expect(evidenceA.context!.executionStateBytes).toBe(
      jsonValueUtf8Size({ ...selected, ...smallTail } as any),
    );
    expect(evidenceB.context!.executionStateBytes).toBe(
      jsonValueUtf8Size({ ...selected, ...largeTail } as any),
    );
    expect(evidenceB.context!.executionStateBytes).not.toBe(
      evidenceA.context!.executionStateBytes,
    );

    // Workbench aggregates carry each attempt's own metric.
    const projectedA = await projection.executionProjection(runA);
    const projectedB = await projection.executionProjection(runB);
    expect(
      projectedA.attempts[0].efficiency?.projectedBytes,
    ).toBeGreaterThan(0);
    expect(
      projectedB.attempts[0].efficiency?.projectedBytes,
    ).toBeGreaterThan(0);
    expect(projectedB.attempts[0].efficiency?.contextBundleReused).toBe(true);
  }, 240_000);
});