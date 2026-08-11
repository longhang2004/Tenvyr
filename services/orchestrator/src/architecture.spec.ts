import * as fs from "fs";
import * as path from "path";

describe("application transport boundary", () => {
  it.each([
    [
      "services/engine.service.ts",
      /kafkajs|KafkaService|KafkaAgentAdapter|HttpAgentAdapter|AgentAdapterRouter|AgentTransportConfigService/,
    ],
    [
      "services/agent-result.service.ts",
      /kafkajs|KafkaService|KafkaAgentAdapter|HttpAgentAdapter|HttpAgentCallbackController|\bfetch\b/,
    ],
  ])("%s stays transport-neutral", (relativePath, forbiddenDependency) => {
    const source = fs.readFileSync(
      path.resolve(__dirname, relativePath),
      "utf8",
    );

    expect(source).not.toMatch(forbiddenDependency);
  });

  it("binds the router at the composition root", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "app.module.ts"),
      "utf8",
    );

    expect(source).toMatch(
      /provide:\s*AGENT_ADAPTER,\s*useExisting:\s*AgentAdapterRouter/,
    );
    expect(source).toMatch(/KafkaAgentAdapter/);
    expect(source).toMatch(/HttpAgentAdapter/);
  });

  it.each([
    "services/kafka.service.ts",
    "agent-adapters/kafka-agent.adapter.ts",
    "agent-adapters/http-agent.adapter.ts",
    "agent-adapters/agent-adapter.router.ts",
  ])("%s does not own Nest lifecycle hooks", (relativePath) => {
    const source = fs.readFileSync(
      path.resolve(__dirname, relativePath),
      "utf8",
    );

    expect(source).not.toMatch(/OnModuleInit|OnModuleDestroy/);
  });

  it("captures raw body narrowly through Nest bootstrap", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "main.ts"), "utf8");

    expect(source).toMatch(
      /NestFactory\.create\(AppModule,\s*\{\s*rawBody:\s*true\s*\}\)/,
    );
  });

  // M2B–M2E boundary: ExecutionState is an internal durable primitive. No
  // business service may import it except the reviewed seams — the M2C claim
  // seam (execution.service.ts, domain type under the execution lock) and the
  // M2E canonical-result seam (result-inbox.service.ts, pure patch functions
  // under the already-locked execution entity). The primitive never reaches
  // for agent transports, contracts, or the result path.
  const ORCHESTRATOR_SERVICES = [
    "services/engine.service.ts",
    "services/condition-evaluator.service.ts",
    "services/dispatch-outbox.service.ts",
    "services/runtime-recovery.service.ts",
    "services/supervision.service.ts",
    "services/agent-event.service.ts",
    "services/agent-result.service.ts",
  ];
  it.each(ORCHESTRATOR_SERVICES)(
    "%s never imports the ExecutionState primitive",
    (relativePath) => {
      const source = fs.readFileSync(
        path.resolve(__dirname, relativePath),
        "utf8",
      );

      expect(source).not.toMatch(/execution-state/);
    },
  );

  it("the claim seam imports only the ExecutionState domain type, never the service", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "services/execution.service.ts"),
      "utf8",
    );
    expect(source).toMatch(/from "\.\.\/domain\/execution-state"/);
    expect(source).not.toMatch(/execution-state\.service/);
  });

  it("the result seam imports only the ExecutionState domain module, never the service", () => {
    // M2E: ResultInboxService reuses the pure M2B patch validation/application
    // under its own transaction and already-locked execution entity. It must
    // never call the standalone mutation service (no nested transaction).
    const source = fs.readFileSync(
      path.resolve(__dirname, "services/result-inbox.service.ts"),
      "utf8",
    );
    expect(source).toMatch(/from "\.\.\/domain\/execution-state"/);
    expect(source).not.toMatch(
      /execution-state\.service|ExecutionStateService/,
    );
  });

  it("no source invents an agent-controlled statePatch authority", () => {
    // M2E: Agent Protocol v1 keeps its closed root schema — state authority
    // comes only from pipeline-declared output mappings. No orchestrator,
    // contract, or worker source may define or use a result `statePatch`.
    const orchestratorSrc = path.resolve(__dirname, "..");
    const contractsRoot = path.resolve(
      __dirname,
      "../../../packages/contracts/src",
    );
    const sources = [orchestratorSrc, contractsRoot]
      .flatMap((root) =>
        (fs.readdirSync(root, { recursive: true }) as string[])
          .filter(
            (file) =>
              file.endsWith(".ts") &&
              !file.endsWith(".spec.ts") &&
              !file.includes("dist/") &&
              !file.includes("node_modules/"),
          )
          .map((file) => fs.readFileSync(path.join(root, file), "utf8")),
      )
      .join("\n");
    expect(sources).not.toMatch(/statePatch\s*[:=?]/);
  });

  it("ExecutionStateService stays transport- and contract-neutral", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "services/execution-state.service.ts"),
      "utf8",
    );

    expect(source).not.toMatch(
      /kafkajs|KafkaService|KafkaAgentAdapter|HttpAgentAdapter|AgentAdapterRouter|\bAgentResultV1\b|\bAgentInvocationV1\b|ResultInboxService|ExecutionService|EngineService/,
    );
    expect(source).toMatch(/pessimistic_write/);
    expect(source).toMatch(/executionStateVersion/);
    // The semantic version is never confused with the TypeORM row version:
    // the service never assigns or reads it.
    expect(source).not.toMatch(/rowVersion\s*[=:]/);
  });

  it("only the claim seam writes AgentInvocation.context, via the reviewed envelope builder", () => {
    const servicesDir = path.resolve(__dirname, "services");
    const serviceFiles = fs
      .readdirSync(servicesDir)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".spec.ts"))
      .sort();

    // M2C/M2D: AgentInvocationV1.context may carry exactly the durable Tenvyr
    // context envelope, written ONLY by claimRunnableStep from the same
    // transaction that persists StepAttempt.contextSnapshot. Dispatch
    // recovery and adapters must send the persisted outbox invocation
    // byte-for-byte; they never synthesize or recompute context.
    const executionSource = fs.readFileSync(
      path.join(servicesDir, "execution.service.ts"),
      "utf8",
    );
    expect(executionSource).toMatch(/materializeContextSnapshot/);
    expect(executionSource).not.toMatch(/["']tenvyr["']\s*:\s*\{/);

    for (const file of serviceFiles) {
      if (file === "execution.service.ts") continue;
      const source = fs.readFileSync(path.join(servicesDir, file), "utf8");
      expect(source).not.toMatch(
        /AgentInvocation[^;]*\.context\s*=|\.context\s*=\s*[^;]*AgentInvocation/,
      );
      // No adapter, dispatcher, supervisor, event, or result path may
      // construct the reserved tenvyr envelope.
      expect(source).not.toMatch(/["']tenvyr["']\s*:/);
    }
  });

  it("artifact URIs have no network, file, DNS, or path-execution sink in the Orchestrator", () => {
    // M2D/M2F URI-001: artifact `uri` values are opaque untrusted producer
    // data. The projection resolver and the claim seam only ever copy the
    // value into bounded references; no Orchestrator path may fetch, probe,
    // resolve, read, or execute it.
    const servicesDir = path.resolve(__dirname, "services");
    const guarded = [
      "artifact-projection.resolver.ts",
      "execution.service.ts",
      "dispatch-outbox.service.ts",
      "runtime-recovery.service.ts",
      "agent-result.service.ts",
      "result-inbox.service.ts",
    ];
    for (const file of guarded) {
      const source = fs.readFileSync(path.join(servicesDir, file), "utf8");
      expect(source).not.toMatch(
        /\b(fetch|dns|fs)\b|\bhttp[s]?\.(get|request|post)\b|\.uri\s*\)|open\(/,
      );
    }
  });

  it("the claim seam is the single exposure-edge authority", () => {
    // M2D: only the reviewed claim seam (through the focused resolver) may
    // insert ArtifactExposure rows; adapters, dispatch, supervision, events,
    // and result application never create exposure lineage.
    const servicesDir = path.resolve(__dirname, "services");
    const serviceFiles = fs
      .readdirSync(servicesDir)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".spec.ts"))
      .sort();
    const executionSource = fs.readFileSync(
      path.join(servicesDir, "execution.service.ts"),
      "utf8",
    );
    expect(executionSource).toMatch(/ArtifactProjectionResolver/);
    for (const file of serviceFiles) {
      if (
        file === "execution.service.ts" ||
        file === "artifact-projection.resolver.ts"
      ) {
        continue;
      }
      const source = fs.readFileSync(path.join(servicesDir, file), "utf8");
      expect(source).not.toMatch(/ArtifactExposureEntity|artifact_exposures/);
    }
  });
});
