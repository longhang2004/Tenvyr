import { readdirSync, readFileSync } from "fs";
import { dirname, join, relative, resolve, sep } from "path";
import { load } from "js-yaml";
import * as ts from "typescript";

const repositoryRoot = resolve(__dirname, "../../..");
const readRepositoryFile = (path: string) =>
  readFileSync(resolve(repositoryRoot, path), "utf8");

const listFiles = (root: string): string[] =>
  readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? listFiles(path) : path;
  });

const parseTypeScript = (source: string) =>
  ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true);

const collectTypeScriptValues = (
  source: string,
  read: (node: ts.Node) => string | undefined,
): string[] => {
  const values: string[] = [];
  const visit = (node: ts.Node) => {
    const value = read(node);
    if (value !== undefined) values.push(value);
    ts.forEachChild(node, visit);
  };
  visit(parseTypeScript(source));
  return values;
};

const propertyStringValues = (source: string, property: string) =>
  collectTypeScriptValues(source, (node) => {
    if (
      !ts.isPropertyAssignment(node) ||
      !ts.isIdentifier(node.name) ||
      node.name.text !== property ||
      !ts.isStringLiteralLike(node.initializer)
    )
      return undefined;
    return node.initializer.text;
  });

const variableStringValues = (source: string, variable: string) =>
  collectTypeScriptValues(source, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      node.name.text !== variable ||
      !node.initializer ||
      !ts.isStringLiteralLike(node.initializer)
    )
      return undefined;
    return node.initializer.text;
  });

const environmentFallbackValues = (source: string, variable: string) =>
  collectTypeScriptValues(source, (node) => {
    if (
      !ts.isBinaryExpression(node) ||
      node.operatorToken.kind !== ts.SyntaxKind.BarBarToken ||
      !ts.isPropertyAccessExpression(node.left) ||
      node.left.name.text !== variable ||
      !ts.isPropertyAccessExpression(node.left.expression) ||
      !ts.isIdentifier(node.left.expression.expression) ||
      node.left.expression.expression.text !== "process" ||
      node.left.expression.name.text !== "env" ||
      !ts.isStringLiteralLike(node.right)
    )
      return undefined;
    return node.right.text;
  });

const callStringArgumentValues = (
  source: string,
  method: string,
  argumentIndex: number,
) =>
  collectTypeScriptValues(source, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== method
    )
      return undefined;
    const argument = node.arguments[argumentIndex];
    return argument && ts.isStringLiteralLike(argument)
      ? argument.text
      : undefined;
  });

const decoratorStringArgumentValues = (source: string, decorator: string) =>
  collectTypeScriptValues(source, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isDecorator(node.parent) ||
      !ts.isIdentifier(node.expression) ||
      node.expression.text !== decorator
    )
      return undefined;
    const argument = node.arguments[0];
    return argument && ts.isStringLiteralLike(argument)
      ? argument.text
      : undefined;
  });

type ComposeService = {
  container_name?: string;
  environment?: Record<string, string> | string[];
  networks?: string[];
  volumes?: string[];
};

type ComposeConfiguration = {
  services: Record<string, ComposeService>;
  networks: Record<string, { name?: string }>;
  volumes: Record<string, unknown>;
};

describe("legacy compatibility identifiers", () => {
  it("keeps the database and Docker deployment identities stable", () => {
    const databaseProvider = readRepositoryFile(
      "services/orchestrator/src/database/database.provider.ts",
    );
    const environmentExample = readRepositoryFile(".env.example");
    const compose = load(
      readRepositoryFile("docker-compose.yml"),
    ) as ComposeConfiguration;

    expect(databaseProvider).toContain(
      "database: process.env.POSTGRES_DB || 'agentweave'",
    );
    expect(
      environmentExample
        .split(/\r?\n/)
        .filter((line) => line.startsWith("POSTGRES_DB=")),
    ).toEqual(["POSTGRES_DB=agentweave"]);
    expect(
      Object.fromEntries(
        Object.entries(compose.services).map(([name, service]) => [
          name,
          service.container_name,
        ]),
      ),
    ).toEqual({
      postgres: "agentweave-postgres",
      redis: "agentweave-redis",
      zookeeper: "agentweave-zookeeper",
      kafka: "agentweave-kafka",
      "kafka-ui": "agentweave-kafka-ui",
      gateway: "agentweave-gateway",
      orchestrator: "agentweave-orchestrator",
      "agent-runner": "agentweave-agent-runner",
      "agent-code-reviewer": "agentweave-agent-code-reviewer",
      "agent-observability": "agentweave-agent-observability",
      frontend: "agentweave-frontend",
    });
    expect(
      Object.fromEntries(
        Object.entries(compose.services).map(([name, service]) => [
          name,
          service.volumes ?? [],
        ]),
      ),
    ).toEqual({
      postgres: ["postgres_data:/var/lib/postgresql/data"],
      redis: ["redis_data:/data"],
      zookeeper: [],
      kafka: [],
      "kafka-ui": [],
      gateway: [],
      orchestrator: [],
      "agent-runner": [],
      "agent-code-reviewer": [],
      "agent-observability": [],
      frontend: [],
    });
    expect(compose.services.postgres.environment).toMatchObject({
      POSTGRES_DB: "agentweave",
    });
    expect(compose.services.gateway.environment).toContain(
      "POSTGRES_DB=agentweave",
    );
    expect(compose.services.orchestrator.environment).toContain(
      "POSTGRES_DB=agentweave",
    );
    expect(compose.networks).toEqual({
      "agentweave-net": {
        name: "agentweave-net",
        driver: "bridge",
      },
    });
    expect(Object.keys(compose.volumes).sort()).toEqual([
      "postgres_data",
      "redis_data",
    ]);
    expect(
      Object.values(compose.services).every((service) =>
        service.networks?.includes("agentweave-net"),
      ),
    ).toBe(true);
  });

  it("keeps Kafka client, group, topic, and Java namespace identities stable", () => {
    const orchestratorKafka = readRepositoryFile(
      "services/orchestrator/src/services/kafka.service.ts",
    );
    const reviewerKafka = readRepositoryFile(
      "services/agent-code-reviewer/src/kafka.service.ts",
    );
    const observabilityKafka = readRepositoryFile(
      "services/agent-observability/src/kafka.service.ts",
    );
    const runnerPom = readRepositoryFile("services/agent-runner/pom.xml");
    const runnerConfiguration = load(
      readRepositoryFile(
        "services/agent-runner/src/main/resources/application.yml",
      ),
    ) as {
      spring: { kafka: { consumer: { "group-id": string } } };
    };
    const javaRoot = resolve(
      repositoryRoot,
      "services/agent-runner/src/main/java",
    );
    const javaFiles = listFiles(javaRoot).filter((path) =>
      path.endsWith(".java"),
    );
    const runnerController = readRepositoryFile(
      "services/agent-runner/src/main/java/com/agentweave/runner/controller/RunnerController.java",
    );

    expect(
      environmentFallbackValues(orchestratorKafka, "KAFKA_CLIENT_ID"),
    ).toEqual(["agentweave-orchestrator"]);
    expect(propertyStringValues(orchestratorKafka, "groupId")).toEqual([
      "agentweave-orchestrator-group",
    ]);
    expect(propertyStringValues(reviewerKafka, "clientId")).toEqual([
      "agent-code-reviewer",
    ]);
    expect(propertyStringValues(reviewerKafka, "groupId")).toEqual([
      "agentweave-reviewer-group",
    ]);
    expect([
      ...variableStringValues(reviewerKafka, "topic"),
      ...propertyStringValues(reviewerKafka, "topic"),
    ]).toEqual([
      "agentweave.agent.code-reviewer.task",
      "agentweave.agent.code-reviewer.result",
    ]);
    expect(propertyStringValues(observabilityKafka, "clientId")).toEqual([
      "agent-observability",
    ]);
    expect(propertyStringValues(observabilityKafka, "groupId")).toEqual([
      "agentweave-observability-group",
    ]);
    expect([
      ...variableStringValues(observabilityKafka, "topic"),
      ...propertyStringValues(observabilityKafka, "topic"),
    ]).toEqual([
      "agentweave.agent.observability.task",
      "agentweave.agent.observability.result",
    ]);
    expect(runnerConfiguration.spring.kafka.consumer["group-id"]).toBe(
      "agentweave-runner-group",
    );
    expect(callStringArgumentValues(runnerController, "send", 0)).toEqual([
      "agentweave.analytics.token_usage",
    ]);
    expect(runnerPom).toContain("<groupId>com.agentweave</groupId>");
    expect(javaFiles.length).toBeGreaterThan(0);
    for (const javaFile of javaFiles) {
      const expectedPackage = relative(javaRoot, dirname(javaFile))
        .split(sep)
        .join(".");
      expect(expectedPackage).toMatch(/^com\.agentweave(?:\.|$)/);
      expect(readFileSync(javaFile, "utf8")).toMatch(
        new RegExp(`^package ${expectedPackage.replaceAll(".", "\\.")};`, "m"),
      );
    }
  });

  it("accepts only the four AgentWeave HMAC v1 callback headers", () => {
    const callbackController = readRepositoryFile(
      "services/orchestrator/src/agent-adapters/http-agent-callback.controller.ts",
    );
    const acceptedHeaders = decoratorStringArgumentValues(
      callbackController,
      "Headers",
    );

    expect(acceptedHeaders).toEqual([
      "x-agentweave-key-id",
      "x-agentweave-timestamp",
      "x-agentweave-delivery-id",
      "x-agentweave-signature",
    ]);
    expect(acceptedHeaders.some((header) => /^x-tenvyr-/i.test(header))).toBe(
      false,
    );
  });
});
