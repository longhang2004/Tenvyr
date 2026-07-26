import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";

describe("Worker SDK architecture", () => {
  it("declares only the contracts package as a production dependency", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(__dirname, "../package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
    };

    expect(manifest.dependencies).toEqual({
      "@agentweave/contracts": "workspace:*",
    });
  });

  it("does not import orchestrator, gateway, specialized agents, Kafka, Nest, or model SDKs", () => {
    const sourceRoot = resolve(__dirname, "../src");
    const source = typescriptFiles(sourceRoot)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    expect(source).not.toMatch(
      /services\/(?:orchestrator|gateway|agent-code-reviewer|agent-observability)|kafkajs|@nestjs|openai|anthropic|gemini/i,
    );
    expect(source).not.toMatch(/@agentweave\/contracts\//);
  });

  it("keeps contracts independent from the Worker SDK", () => {
    const contractsManifest = readFileSync(
      resolve(__dirname, "../../contracts/package.json"),
      "utf8",
    );
    const contractSources = [
      "src/index.ts",
      "src/types.ts",
      "src/http-types.ts",
      "src/validation.ts",
    ]
      .map((file) =>
        readFileSync(resolve(__dirname, "../../contracts", file), "utf8"),
      )
      .join("\n");

    expect(contractsManifest).not.toContain("@agentweave/worker");
    expect(contractSources).not.toContain("@agentweave/worker");
  });

  it("keeps the contracts and Worker manifest graph acyclic", () => {
    const manifests = new Map(
      [
        resolve(__dirname, "../../contracts/package.json"),
        resolve(__dirname, "../package.json"),
      ].map((path) => {
        const manifest = JSON.parse(readFileSync(path, "utf8")) as {
          name: string;
          dependencies?: Record<string, string>;
        };
        return [manifest.name, manifest] as const;
      }),
    );

    const visit = (name: string, path: string[] = []): void => {
      expect(path).not.toContain(name);
      const manifest = manifests.get(name);
      if (!manifest) return;
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        visit(dependency, [...path, name]);
      }
    };

    for (const name of manifests.keys()) visit(name);
  });
});

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? typescriptFiles(path)
      : entry.name.endsWith(".ts")
        ? [path]
        : [];
  });
}
