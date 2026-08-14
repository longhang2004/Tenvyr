import { RuntimeConnectionService } from "./runtime-connection.service";
import { RuntimeConnectionEntity } from "../entities/runtime-connection.entity";
import { ConnectionRevisionEntity } from "../entities/connection-revision.entity";
import { freezeConnectionRevision, type ConnectionProfileV1 } from "../executors/runtime-connection";

const profile = (): ConnectionProfileV1 => ({
  name: "Codex local",
  runtimeKind: "codex",
  executorId: "local-host",
  version: "0.147.0",
  credentialRefs: [{ kind: "env", name: "CODEX_API_KEY" }],
  declaredCapabilities: {
    invocation: { supported: true, source: "configured" },
  },
});

type Row = {
  connectionId: string;
  currentRevisionNumber: number;
  statusState: string;
  statusReasonCode: string;
  statusTestedAt?: Date | null;
  statusTestedVersion?: string | null;
};
class MockManager {
  connections = new Map<string, Row>();
  revisions: Array<{
    connectionId: string;
    revisionNumber: number;
    profile: unknown;
    configHash: string;
    capabilities: unknown;
    createdAt: Date;
  }> = [];

  constructor(rows: Row[] = []) {
    for (const row of rows) this.connections.set(row.connectionId, { ...row });
  }

  transaction = async <T>(callback: (manager: MockManager) => Promise<T>): Promise<T> =>
    callback(this);

  getRepository(entity: unknown) {
    const isConnection = entity === RuntimeConnectionEntity;
    return {
      create: (values: Record<string, unknown>) => values,
      findOne: async ({ where }: { where: Record<string, unknown> }) => {
        if (isConnection) {
          const row = this.connections.get(String(where.connectionId));
          return row ? { ...row } : null;
        }
        return (
          this.revisions.find(
            (revision) =>
              revision.connectionId === where.connectionId &&
              revision.revisionNumber === where.revisionNumber,
          ) ?? null
        );
      },
      save: async (value: Row) => {
        if (isConnection) {
          this.connections.set(value.connectionId, { ...value });
          return value;
        }
        const stored = {
          ...(value as unknown as {
            connectionId: string;
            revisionNumber: number;
            profile: unknown;
            configHash: string;
            capabilities: unknown;
          }),
          createdAt: new Date(),
        };
        this.revisions.push(stored);
        return stored;
      },
      createQueryBuilder: () => {
        let whereArg: Record<string, unknown> = {};
        const queryBuilder = {
          setLock: () => queryBuilder,
          where: (arg: unknown, params?: Record<string, unknown>) => {
            // lockConnection calls where(sql, { connectionId }); plain
            // mocks call where({ ... }). Prefer the parameter object.
            whereArg = (params ?? (arg as Record<string, unknown>)) || {};
            return queryBuilder;
          },
          getOne: async () => {
            const id =
              whereArg?.connectionId !== undefined
                ? String(whereArg.connectionId)
                : currentLockId;
            const row = this.connections.get(id);
            return row ? { ...row } : null;
          },
        };
        return queryBuilder;
      },
    };
  }
}

let currentLockId = "conn:codex-local";

const makeService = (
  manager: MockManager,
  lockId = "conn:codex-local",
): RuntimeConnectionService => {
  currentLockId = lockId;
  return new RuntimeConnectionService({
    transaction: manager.transaction,
    getRepository: (entity: unknown) => manager.getRepository(entity),
  } as never);
};

const expectRejected = (fail: () => Promise<unknown>, code: string): Promise<void> =>
  fail().then(
    () => {
      throw new Error("expected rejection");
    },
    (error) => {
      expect(error).toMatchObject({ code });
    },
  );

describe("RuntimeConnectionService.createConnection", () => {
  it("creates a DRAFT connection with immutable revision 1", async () => {
    const manager = new MockManager();
    const service = makeService(manager);

    const revision = await service.createConnection("conn:codex-local", profile());

    expect(revision.revisionNumber).toBe(1);
    expect(revision.configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manager.connections.get("conn:codex-local")).toMatchObject({
      statusState: "DRAFT",
      statusReasonCode: "none",
      currentRevisionNumber: 1,
    });
    expect(manager.revisions).toHaveLength(1);
    // Secret-free render: no credential values, only env reference names.
    expect(JSON.stringify(revision)).not.toContain("sk-");
    expect(JSON.stringify(revision)).toContain("CODEX_API_KEY");
  });

  it("rejects a duplicate connection id", async () => {
    const manager = new MockManager();
    const service = makeService(manager);
    await service.createConnection("conn:codex-local", profile());

    await expectRejected(
      () => service.createConnection("conn:codex-local", profile()),
      "CONNECTION_ALREADY_EXISTS",
    );
  });
});

describe("RuntimeConnectionService.reviseConnection", () => {
  it("appends revision N+1 and advances the current revision atomically", async () => {
    const manager = new MockManager();
    const service = makeService(manager);
    await service.createConnection("conn:codex-local", profile());

    const revised = await service.reviseConnection("conn:codex-local", profile());

    expect(revised.revisionNumber).toBe(2);
    expect(manager.connections.get("conn:codex-local")?.currentRevisionNumber).toBe(2);
    expect(manager.revisions.map((revision) => revision.revisionNumber)).toEqual([1, 2]);
  });

  it("denies revision of a REVOKED connection", async () => {
    const manager = new MockManager();
    const service = makeService(manager);
    await service.createConnection("conn:codex-local", profile());
    await service.revokeConnection("conn:codex-local");

    await expectRejected(
      () => service.reviseConnection("conn:codex-local", profile()),
      "CONNECTION_REVOKED",
    );
  });

  it("rejects revision of a missing connection", async () => {
    const service = makeService(new MockManager());
    await expectRejected(
      () => service.reviseConnection("conn:missing", profile()),
      "CONNECTION_NOT_FOUND",
    );
  });
});

describe("RuntimeConnectionService.revokeConnection", () => {
  it("is terminal and idempotent in the status projection", async () => {
    const manager = new MockManager();
    const service = makeService(manager);
    await service.createConnection("conn:codex-local", profile());

    const status = await service.revokeConnection("conn:codex-local");
    expect(status).toEqual({ state: "REVOKED", reasonCode: "revoked" });

    const again = await service.revokeConnection("conn:codex-local");
    expect(again).toEqual({ state: "REVOKED", reasonCode: "revoked" });
  });
});

describe("RuntimeConnectionService.claimRevision", () => {
  it("returns the current immutable revision (retry/replay re-resolve)", async () => {
    const manager = new MockManager();
    const service = makeService(manager);
    await service.createConnection("conn:codex-local", profile());
    const first = await service.claimRevision("conn:codex-local");

    const revised = await service.reviseConnection("conn:codex-local", profile());
    const second = await service.claimRevision("conn:codex-local");

    expect(first.revisionNumber).toBe(1);
    expect(second.revisionNumber).toBe(2);
    expect(revised.configHash).toBe(second.configHash);
  });

  it("denies claims of a revoked connection immediately", async () => {
    const manager = new MockManager();
    const service = makeService(manager);
    await service.createConnection("conn:codex-local", profile());
    await service.revokeConnection("conn:codex-local");

    await expectRejected(
      () => service.claimRevision("conn:codex-local"),
      "CONNECTION_REVOKED",
    );
  });

  it("rejects claims of a missing connection", async () => {
    const service = makeService(new MockManager());
    await expectRejected(
      () => service.claimRevision("conn:missing"),
      "CONNECTION_NOT_FOUND",
    );
  });
});

describe("RuntimeConnectionService.connectionStatus", () => {
  it("projects the bounded status without secrets or output", async () => {
    const manager = new MockManager();
    const service = makeService(manager);
    await service.createConnection("conn:codex-local", profile());

    const status = await service.connectionStatus("conn:codex-local");
    expect(status).toEqual({ state: "DRAFT", reasonCode: "none" });
    expect(JSON.stringify(status)).not.toContain("CODEX_API_KEY");
  });
});

describe("RuntimeConnectionService.testConnection", () => {
  const genericCli = (script: string): ConnectionProfileV1 => ({
    name: "Generic CLI",
    runtimeKind: "generic-cli",
    executorId: "local-host",
    credentialRefs: [],
    cli: {
      command: process.execPath,
      args: [],
      probe: { args: ["-e", script], expectsVersion: true },
    },
    declaredCapabilities: {
      invocation: { supported: true, source: "configured" },
    },
  });

  it("projects a successful probe into AVAILABLE with the tested version", async () => {
    const manager = new MockManager();
    const service = makeService(manager);
    await service.createConnection("conn:generic", genericCli("console.log('3.2.1')"));

    const receipt = await service.testConnection("conn:generic");

    expect(receipt).toMatchObject({
      connectionId: "conn:generic",
      revisionNumber: 1,
      state: "AVAILABLE",
      reasonCode: "none",
      testedVersion: "3.2.1",
    });
    expect(manager.connections.get("conn:generic")).toMatchObject({
      statusState: "AVAILABLE",
      statusReasonCode: "none",
      statusTestedVersion: "3.2.1",
    });
    // Receipts are bounded: no command output beyond the version.
    expect(JSON.stringify(receipt)).not.toContain("stdout");
  });

  it("degrades to unsupported-version when the detected version differs from the pinned one", async () => {
    const manager = new MockManager();
    const service = makeService(manager);
    const profile = genericCli("console.log('9.9.9')");
    profile.version = "0.147.0";
    await service.createConnection("conn:generic", profile);

    const receipt = await service.testConnection("conn:generic");
    expect(receipt).toMatchObject({
      state: "DEGRADED",
      reasonCode: "unsupported-version",
    });
  });

  it("projects auth-required and command failures without touching attempts", async () => {
    const manager = new MockManager();
    const service = makeService(manager);
    const profile = genericCli("process.exit(2)");
    profile.cli!.probe.authExitCodes = [2];
    await service.createConnection("conn:generic", profile);
    const receipt = await service.testConnection("conn:generic");
    expect(receipt).toMatchObject({ state: "AUTH_REQUIRED", reasonCode: "auth-required" });
    // Attempts never exist in this path: only the connection status moved.
    expect(manager.revisions).toHaveLength(1);
  });

  it("denies tests of a revoked connection", async () => {
    const manager = new MockManager();
    const service = makeService(manager, "conn:generic");
    await service.createConnection("conn:generic", genericCli("console.log('1')"));
    await service.revokeConnection("conn:generic");
    await expectRejected(
      () => service.testConnection("conn:generic"),
      "CONNECTION_REVOKED",
    );
  });

  it("rate-limits repeated tests and deduplicates concurrent ones", async () => {
    const manager = new MockManager();
    const service = makeService(manager);
    await service.createConnection("conn:generic", genericCli("console.log('1')"));

    const [first, second] = await Promise.all([
      service.testConnection("conn:generic"),
      service.testConnection("conn:generic"),
    ]);
    // Concurrency limit 1 per connection: the second call joins the first.
    expect(first.testedAt).toBe(second.testedAt);

    await expectRejected(
      () => service.testConnection("conn:generic"),
      "CONNECTION_TEST_RATE_LIMITED",
    );
  });

  it("rejects tests for connections without a cli profile", async () => {
    const manager = new MockManager();
    const service = makeService(manager);
    await service.createConnection("conn:codex-local", profile());
    await expectRejected(
      () => service.testConnection("conn:codex-local"),
      "CONNECTION_PROBE_UNSUPPORTED",
    );
  });

  it("M8-S6: revision changes clear the card's tested metadata (DRAFT until re-tested)", async () => {
    const manager = new MockManager();
    const service = makeService(manager);
    await service.createConnection("conn:generic", genericCli("console.log('3.2.1')"));
    await service.testConnection("conn:generic");
    expect(manager.connections.get("conn:generic")).toMatchObject({
      statusState: "AVAILABLE",
      statusTestedVersion: "3.2.1",
    });

    const revised = await service.reviseConnection("conn:generic", genericCli("console.log('4.0.0')"));
    expect(revised.revisionNumber).toBe(2);
    // The previous revision's probe facts are evidence of the OLD
    // configuration: the card returns to DRAFT with no tested metadata.
    expect(manager.connections.get("conn:generic")).toMatchObject({
      statusState: "DRAFT",
      statusReasonCode: "none",
      currentRevisionNumber: 2,
      statusTestedAt: null,
      statusTestedVersion: null,
    });
  });

  it("M8-S6: a probe that outlives a revise is superseded — the newer revision keeps the card", async () => {
    const manager = new MockManager();
    const service = makeService(manager);
    const slow = genericCli(
      "setTimeout(() => console.log('3.2.1'), 250)",
    );
    await service.createConnection("conn:generic", slow);
    await service.testConnection("conn:generic"); // warm: revision 1 AVAILABLE
    // Bypass the probe rate limit (mock row manipulation).
    const row = manager.connections.get("conn:generic")!;
    row.statusTestedAt = new Date(Date.now() - 60_000);

    const inFlight = service.testConnection("conn:generic");
    // The probe for revision 2 is in flight; revise to revision 3 while
    // it runs (the probe takes 250ms).
    await new Promise((resolve) => setTimeout(resolve, 60));
    await service.reviseConnection("conn:generic", slow);

    const receipt = await inFlight;
    expect(receipt.superseded).toBe(true);
    // The card belongs to revision 2 now: DRAFT, never touched by the
    // stale probe of revision 1.
    expect(manager.connections.get("conn:generic")).toMatchObject({
      statusState: "DRAFT",
      statusReasonCode: "none",
      currentRevisionNumber: 2,
      statusTestedAt: null,
      statusTestedVersion: null,
    });
  });

  it("M8-S6: a revoke that lands while the probe runs stays terminal", async () => {
    const manager = new MockManager();
    const service = makeService(manager);
    const slow = genericCli(
      "setTimeout(() => console.log('3.2.1'), 250)",
    );
    await service.createConnection("conn:generic", slow);
    await service.testConnection("conn:generic");
    // Bypass the probe rate limit (mock row manipulation).
    const row = manager.connections.get("conn:generic")!;
    row.statusTestedAt = new Date(Date.now() - 60_000);

    const inFlight = service.testConnection("conn:generic");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const revoked = await service.revokeConnection("conn:generic");
    expect(revoked.state).toBe("REVOKED");

    // The probe result can never resurrect a revoked card.
    await expectRejected(
      () => inFlight,
      "CONNECTION_REVOKED",
    );
    expect(manager.connections.get("conn:generic")).toMatchObject({
      statusState: "REVOKED",
      statusReasonCode: "revoked",
    });
  });
});

describe("RuntimeConnectionService frozen identity", () => {
  it("freezes the exact revision the claim resolved (coherent identity)", async () => {
    const manager = new MockManager();
    const service = makeService(manager);
    await service.createConnection("conn:codex-local", profile());
    const claimed = await service.claimRevision("conn:codex-local");

    const frozen = freezeConnectionRevision({
      connectionId: claimed.connectionId,
      revisionNumber: claimed.revisionNumber,
      createdAt: new Date().toISOString(),
      profile: claimed.profile,
    });
    expect(frozen.configHash).toBe(claimed.configHash);
    expect(frozen.capabilities).toEqual(claimed.capabilities);
  });
});
