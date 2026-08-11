import { ContextProjectionError } from "../domain/context-snapshot";
import { ArtifactEntity } from "../entities/artifact.entity";
import { ResultInboxEntity } from "../entities/result-inbox.entity";
import { LogicalStepEntity } from "../entities/step-execution.entity";
import { StepAttemptEntity } from "../entities/step-attempt.entity";
import { sha256Json } from "../domain/canonical-json";
import { ArtifactProjectionResolver } from "./artifact-projection.resolver";

type RowSet = {
  logicalSteps: any[];
  attempts: any[];
  inboxes: any[];
  artifacts: any[];
};

const makeManager = (rows: RowSet) => {
  const findOne = (entity: unknown, where: any) => {
    if (entity === LogicalStepEntity) {
      return (
        rows.logicalSteps.find(
          (step) =>
            step.executionId === where.executionId &&
            step.stepId === where.stepId,
        ) ?? null
      );
    }
    if (entity === ResultInboxEntity) {
      return (
        rows.inboxes.find(
          (inbox) =>
            inbox.stepAttemptId === where.stepAttemptId &&
            inbox.status === where.status,
        ) ?? null
      );
    }
    throw new Error("unexpected findOne");
  };
  return {
    getRepository: jest.fn((entity: unknown) => {
      if (entity === LogicalStepEntity) {
        return {
          findOne: jest.fn(async ({ where }: any) => findOne(entity, where)),
        };
      }
      if (entity === StepAttemptEntity) {
        return {
          createQueryBuilder: jest.fn(() => ({
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            getOne: jest.fn(async () => {
              const matches = rows.attempts.filter(
                (attempt) =>
                  attempt.logicalStepId === "logical-producer" &&
                  attempt.status === "SUCCESS",
              );
              matches.sort((a, b) => b.attemptNumber - a.attemptNumber);
              return matches[0] ?? null;
            }),
          })),
        };
      }
      if (entity === ResultInboxEntity) {
        return {
          findOne: jest.fn(async ({ where }: any) => findOne(entity, where)),
        };
      }
      if (entity === ArtifactEntity) {
        return {
          find: jest.fn(async ({ where }: any) =>
            rows.artifacts
              .filter(
                (artifact) => artifact.resultInboxId === where.resultInboxId,
              )
              .sort((a, b) => a.descriptorOrdinal - b.descriptorOrdinal),
          ),
        };
      }
      throw new Error("unexpected repository");
    }),
  };
};

const descriptor = (overrides: Record<string, unknown> = {}) => ({
  id: "worker-art-1",
  name: "report.json",
  mediaType: "application/json",
  uri: "s3://opaque/uri",
  ...overrides,
});

const rowSet = (overrides: Partial<RowSet> = {}): RowSet => {
  const inbox = {
    id: "inbox-1",
    stepAttemptId: "attempt-producer",
    status: "APPLIED",
    payload: { artifacts: [descriptor(), descriptor({ name: "second.json" })] },
  };
  return {
    logicalSteps: [
      {
        id: "logical-producer",
        executionId: "execution-1",
        stepId: "research",
      },
    ],
    attempts: [
      {
        id: "attempt-producer",
        executionId: "execution-1",
        logicalStepId: "logical-producer",
        status: "SUCCESS",
        attemptNumber: 1,
      },
    ],
    inboxes: [inbox],
    artifacts: [
      {
        id: "artifact-1",
        resultInboxId: inbox.id,
        descriptorOrdinal: 0,
        descriptorHash: sha256Json(inbox.payload.artifacts[0]),
      },
      {
        id: "artifact-2",
        resultInboxId: inbox.id,
        descriptorOrdinal: 1,
        descriptorHash: sha256Json(inbox.payload.artifacts[1]),
      },
    ],
    ...overrides,
  };
};

describe("ArtifactProjectionResolver", () => {
  it("resolves all eligible artifacts without filters, sorted deterministically", async () => {
    const resolver = new ArtifactProjectionResolver(
      makeManager(rowSet()) as any,
    );
    const result = await resolver.resolve("execution-1", [
      { fromStep: "research" },
    ]);
    expect(result.references).toHaveLength(2);
    expect(result.references[0]).toEqual({
      artifactId: "artifact-1",
      producerStepId: "research",
      producerAttemptId: "attempt-producer",
      descriptorOrdinal: 0,
      name: "report.json",
      mediaType: "application/json",
      uri: "s3://opaque/uri",
    });
    // Optional fields absent when absent; no metadata unless requested.
    expect(result.references[0]).not.toHaveProperty("metadata");
    expect(result.artifacts.map((artifact) => artifact.id)).toEqual([
      "artifact-1",
      "artifact-2",
    ]);
  });

  it("filters by exact name and by ordinal; metadata only when requested", async () => {
    const resolver = new ArtifactProjectionResolver(
      makeManager(rowSet()) as any,
    );
    const byName = await resolver.resolve("execution-1", [
      { fromStep: "research", name: "second.json" },
    ]);
    expect(byName.references).toHaveLength(1);
    expect(byName.references[0].descriptorOrdinal).toBe(1);

    const byOrdinal = await resolver.resolve("execution-1", [
      { fromStep: "research", ordinal: 0, includeMetadata: true },
    ]);
    expect(byOrdinal.references).toHaveLength(1);
    expect(byOrdinal.references[0].descriptorOrdinal).toBe(0);
    expect(byOrdinal.references[0].metadata).toEqual(
      rowSet().inboxes[0].payload.artifacts[0].metadata,
    );
  });

  it("resolves no artifacts when the producer has no eligible successful result", async () => {
    const rows = rowSet({ attempts: [] });
    const resolver = new ArtifactProjectionResolver(makeManager(rows) as any);
    const result = await resolver.resolve("execution-1", [
      { fromStep: "research" },
    ]);
    expect(result.references).toEqual([]);
    expect(result.artifacts).toEqual([]);
  });

  it("fails deterministically when a filter matches nothing", async () => {
    const resolver = new ArtifactProjectionResolver(
      makeManager(rowSet()) as any,
    );
    await expect(
      resolver.resolve("execution-1", [
        { fromStep: "research", name: "nope.json" },
      ]),
    ).rejects.toThrow("TENVYR_CTX_ARTIFACT_FILTER_NO_MATCH");
  });

  it("fails deterministically on overlapping selectors resolving the same artifact", async () => {
    const resolver = new ArtifactProjectionResolver(
      makeManager(rowSet()) as any,
    );
    await expect(
      resolver.resolve("execution-1", [
        { fromStep: "research" },
        { fromStep: "research", name: "report.json" },
      ]),
    ).rejects.toThrow("TENVYR_CTX_ARTIFACT_OVERLAP");
  });

  it("rejects a missing producer step deterministically", async () => {
    const resolver = new ArtifactProjectionResolver(
      makeManager(rowSet({ logicalSteps: [] })) as any,
    );
    await expect(
      resolver.resolve("execution-1", [{ fromStep: "research" }]),
    ).rejects.toThrow("TENVYR_CTX_ARTIFACT_PRODUCER_MISSING");
  });

  it("rejects a foreign-execution producer attempt", async () => {
    const rows = rowSet({
      attempts: [
        {
          id: "attempt-producer",
          executionId: "execution-OTHER",
          logicalStepId: "logical-producer",
          status: "SUCCESS",
          attemptNumber: 1,
        },
      ],
    });
    const resolver = new ArtifactProjectionResolver(makeManager(rows) as any);
    await expect(
      resolver.resolve("execution-1", [{ fromStep: "research" }]),
    ).rejects.toThrow("TENVYR_CTX_FOREIGN_ARTIFACT");
  });

  it("rejects a descriptor ordinal that no longer matches the canonical hash", async () => {
    const inbox = {
      id: "inbox-1",
      stepAttemptId: "attempt-producer",
      status: "APPLIED",
      payload: { artifacts: [descriptor()] },
    };
    const rows = rowSet({
      inboxes: [inbox],
      artifacts: [
        {
          id: "artifact-1",
          resultInboxId: inbox.id,
          descriptorOrdinal: 0,
          descriptorHash: "corrupted-hash",
        },
      ],
    });
    const resolver = new ArtifactProjectionResolver(makeManager(rows) as any);
    await expect(
      resolver.resolve("execution-1", [{ fromStep: "research" }]),
    ).rejects.toThrow("TENVYR_CTX_ARTIFACT_ORDINAL_MISMATCH");
  });

  it("enforces the 128-reference total bound", async () => {
    const payloadArtifacts = Array.from({ length: 129 }, (_, i) =>
      descriptor({ id: `worker-${i}`, name: `a${i}.json` }),
    );
    const inbox = {
      id: "inbox-1",
      stepAttemptId: "attempt-producer",
      status: "APPLIED",
      payload: { artifacts: payloadArtifacts },
    };
    const rows = rowSet({
      inboxes: [inbox],
      artifacts: payloadArtifacts.map((entry, index) => ({
        id: `artifact-${index}`,
        resultInboxId: inbox.id,
        descriptorOrdinal: index,
        descriptorHash: sha256Json(entry),
      })),
    });
    const resolver = new ArtifactProjectionResolver(makeManager(rows) as any);
    await expect(
      resolver.resolve("execution-1", [{ fromStep: "research" }]),
    ).rejects.toThrow("TENVYR_CTX_ARTIFACT_LIMIT");
  });

  it("rejects malformed selectors at resolution time as a bounded error", async () => {
    const resolver = new ArtifactProjectionResolver(
      makeManager(rowSet()) as any,
    );
    await expect(
      resolver.resolve("execution-1", [
        { fromStep: "research", glob: "*" },
      ] as never),
    ).rejects.toThrow(Error);
  });
});
