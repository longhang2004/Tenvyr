import { Inject, Injectable } from "@nestjs/common";
import { DataSource, EntityManager, QueryFailedError } from "typeorm";
import { ConnectionRevisionEntity } from "../entities/connection-revision.entity";
import { RuntimeConnectionEntity } from "../entities/runtime-connection.entity";
import { runCliProbe } from "./cli-probe";
import {
  applyStatusTransition,
  freezeConnectionRevision,
  parseConnectionRevision,
  type ConnectionProfileV1,
  type ConnectionRevisionV1,
  type ConnectionStatus,
  type ConnectionStatusState,
  type StatusReasonCode,
} from "../executors/runtime-connection";

export type RuntimeConnectionErrorCode =
  | "CONNECTION_NOT_FOUND"
  | "CONNECTION_ALREADY_EXISTS"
  | "CONNECTION_REVOKED"
  | "CONNECTION_REVISION_CONFLICT"
  | "CONNECTION_PROBE_UNSUPPORTED"
  | "CONNECTION_TEST_RATE_LIMITED";

/**
 * Bounded test-connection receipt: identity + status projection only. It
 * never carries command output, tokens, prompts, or secret values, and it
 * never mutates attempt outcomes — a failed test only projects connection
 * status. `superseded` marks a receipt whose probe ran against a revision
 * that is no longer current (or was revoked) while the probe was in
 * flight: the card metadata was NOT updated, because a newer revision or
 * a terminal revoke owns the card.
 */
export type TestConnectionReceipt = {
  connectionId: string;
  revisionNumber: number;
  testedAt: string;
  testedVersion?: string;
  state: ConnectionStatusState;
  reasonCode: StatusReasonCode;
  durationMs: number;
  superseded?: boolean;
};

export class RuntimeConnectionError extends Error {
  readonly code: RuntimeConnectionErrorCode;
  readonly retryable: boolean;

  constructor(code: RuntimeConnectionErrorCode, message: string) {
    super(message);
    this.name = "RuntimeConnectionError";
    this.code = code;
    this.retryable = code === "CONNECTION_REVISION_CONFLICT";
  }
}

const UNIQUE_VIOLATION = "23505";

/** Minimum interval between operator-initiated connection tests: probes are
 *  explicit and rate-limited, never an unbounded polling loop. */
export const PROBE_MIN_INTERVAL_MS = 5_000;

/**
 * M8-S2: durable Runtime Connections with atomic claim resolution.
 *
 * - Revisions are immutable and append-only; the database trigger
 *   `TRG_connection_revision_immutable` blocks UPDATE/DELETE durably.
 * - `reviseConnection` serializes on the connection row (pessimistic write)
 *   and appends revision N+1; the UNIQUE (connectionId, revisionNumber)
 *   constraint backstops concurrent writers.
 * - `revokeConnection` is terminal: it flips the status projection to REVOKED
 *   and every later claim fails with a deterministic error. Claims that
 *   resolved a revision before the revoke commit keep that immutable
 *   revision; pending delivery of revoked connections fails at dispatch.
 * - `claimRevision` reads the CURRENT revision as one coherent identity: the
 *   revision is immutable, so a claim can never observe a torn revision.
 *   Retry (new attempt) and replay (new execution) re-claim the current
 *   revision — historical revisions are provenance, never current authority.
 */
@Injectable()
export class RuntimeConnectionService {
  constructor(@Inject("DATA_SOURCE") private readonly dataSource: DataSource) {}

  async createConnection(
    connectionId: string,
    profile: ConnectionProfileV1,
  ): Promise<ConnectionRevisionV1> {
    try {
      return await this.dataSource.transaction((manager) =>
        this.createConnectionWithManager(manager, connectionId, profile),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RuntimeConnectionError(
          "CONNECTION_ALREADY_EXISTS",
          `Runtime connection "${connectionId}" already exists`,
        );
      }
      throw error;
    }
  }

  /**
   * Manager-aware create for callers that already own a transaction
   * (M10-S2: Workbench audit + authority mutation commit together).
   * Enforces the same existence check and revision-freeze rules as the
   * standalone path. Unique violations surface raw (23505) so the caller
   * can map them — the authority transaction owns error translation.
   */
  async createConnectionWithManager(
    manager: EntityManager,
    connectionId: string,
    profile: ConnectionProfileV1,
  ): Promise<ConnectionRevisionV1> {
    const revision = freezeConnectionRevision({
      connectionId,
      revisionNumber: 1,
      createdAt: new Date().toISOString(),
      profile,
    });
    const connections = manager.getRepository(RuntimeConnectionEntity);
    const existing = await connections.findOne({ where: { connectionId } });
    if (existing) {
      throw new RuntimeConnectionError(
        "CONNECTION_ALREADY_EXISTS",
        `Runtime connection "${connectionId}" already exists`,
      );
    }
    await connections.save(
      connections.create({
        connectionId,
        name: profile.name,
        runtimeKind: profile.runtimeKind,
        executorId: profile.executorId,
        version: profile.version ?? null,
        currentRevisionNumber: 1,
        statusState: "DRAFT",
        statusReasonCode: "none",
      }),
    );
    await manager
      .getRepository(ConnectionRevisionEntity)
      .save(this.toRevisionEntity(revision));
    return revision;
  }

  /**
   * Appends a new immutable revision and advances the connection's current
   * revision number atomically. A REVOKED connection is terminal: revision is
   * denied (revocation survives edits; a new connection is a new identity).
   *
   * M8-S6: revision changes synchronize the connection card's probe
   * metadata — the previous revision's testedAt/testedVersion are evidence
   * of the OLD configuration and are cleared, and the card returns to
   * DRAFT until the operator re-tests the new revision.
   */
  async reviseConnection(
    connectionId: string,
    profile: ConnectionProfileV1,
  ): Promise<ConnectionRevisionV1> {
    try {
      return await this.dataSource.transaction((manager) =>
        this.reviseConnectionWithManager(manager, connectionId, profile),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RuntimeConnectionError(
          "CONNECTION_REVISION_CONFLICT",
          `Runtime connection "${connectionId}" revision raced with another writer; retry`,
        );
      }
      throw error;
    }
  }

  /**
   * Manager-aware revise for callers that already own a transaction
   * (M10-S2: Workbench audit + authority mutation commit together). Same
   * row lock, revocation gate, and immutable-revision append as the
   * standalone path.
   */
  async reviseConnectionWithManager(
    manager: EntityManager,
    connectionId: string,
    profile: ConnectionProfileV1,
  ): Promise<ConnectionRevisionV1> {
    const connections = manager.getRepository(RuntimeConnectionEntity);
    const connection = await lockConnection(manager, connectionId);
    assertNotRevoked(connection, connectionId);
    const next = connection.currentRevisionNumber + 1;
    const revision = freezeConnectionRevision({
      connectionId,
      revisionNumber: next,
      createdAt: new Date().toISOString(),
      profile,
    });
    await manager
      .getRepository(ConnectionRevisionEntity)
      .save(this.toRevisionEntity(revision));
    connection.currentRevisionNumber = next;
    // Card metadata belongs to the revision that produced it: a new
    // revision starts with no test evidence.
    connection.statusState = "DRAFT";
    connection.statusReasonCode = "none";
    connection.statusTestedAt = null;
    connection.statusTestedVersion = null;
    await connections.save(connection);
    return revision;
  }

  /** Terminal revocation: denies future claims and future revisions. */
  async revokeConnection(connectionId: string): Promise<ConnectionStatus> {
    return this.dataSource.transaction((manager) =>
      this.revokeConnectionWithManager(manager, connectionId),
    );
  }

  /**
   * Manager-aware terminal revocation for callers that already own a
   * transaction (M10-S2: Workbench audit + authority mutation commit
   * together). Same row lock and status transition as the standalone path.
   */
  async revokeConnectionWithManager(
    manager: EntityManager,
    connectionId: string,
  ): Promise<ConnectionStatus> {
    const connections = manager.getRepository(RuntimeConnectionEntity);
    const connection = await lockConnection(manager, connectionId);
    const status = applyStatusTransition(entityStatus(connection), {
      type: "revoke",
    });
    connection.statusState = status.state;
    connection.statusReasonCode = status.reasonCode;
    await connections.save(connection);
    return status;
  }

  /**
   * Atomic claim: resolves the connection's CURRENT immutable revision.
   * Linearization point is the authority-row lock: the claim transaction
   * locks the RuntimeConnection row (pessimistic write), re-verifies
   * existence and non-revocation under that lock, reads the authoritative
   * currentRevisionNumber, and loads the immutable revision row. A revoke
   * that commits BEFORE the claim acquires the lock denies the claim
   * (CONNECTION_REVOKED); a claim that locks first returns its frozen
   * revision and the later revoke applies at dispatch. Read-only — a
   * concurrent revise appends, never mutates. No unlocked reads.
   */
  async claimRevision(connectionId: string): Promise<ConnectionRevisionV1> {
    return this.dataSource.transaction((manager) =>
      this.claimRevisionWithManager(manager, connectionId),
    );
  }

  /**
   * Manager-aware claim for callers that already own a transaction
   * (claim/scheduling, batch admission, run creation). Enforces EXACTLY the
   * same validation and locking rules as the standalone claim path — the
   * shared authority-checked primitive, never a bypass.
   */
  async claimRevisionWithManager(
    manager: EntityManager,
    connectionId: string,
  ): Promise<ConnectionRevisionV1> {
    const connection = await lockConnection(manager, connectionId);
    assertNotRevoked(connection, connectionId);
    const revisionRow = await manager
      .getRepository(ConnectionRevisionEntity)
      .findOne({
        where: {
          connectionId,
          revisionNumber: connection.currentRevisionNumber,
        },
      });
    if (!revisionRow) {
      // Invariant violation: the connection's current revision is missing.
      throw new RuntimeConnectionError(
        "CONNECTION_NOT_FOUND",
        `Runtime connection "${connectionId}" current revision ${connection.currentRevisionNumber} is missing`,
      );
    }
    return this.toDomainRevision(revisionRow);
  }

  /** Bounded status projection of one connection. */
  async connectionStatus(connectionId: string): Promise<ConnectionStatus> {
    const connection = await this.dataSource
      .getRepository(RuntimeConnectionEntity)
      .findOne({ where: { connectionId } });
    if (!connection) {
      throw new RuntimeConnectionError(
        "CONNECTION_NOT_FOUND",
        `Runtime connection "${connectionId}" does not exist`,
      );
    }
    return entityStatus(connection);
  }

  /** M8-S5: bounded operator list for the local workbench surface. */
  async listConnections(): Promise<
    Array<{
      connectionId: string;
      name: string;
      runtimeKind: string;
      executorId: string;
      version: string | null;
      status: ConnectionStatus;
    }>
  > {
    const rows = await this.dataSource
      .getRepository(RuntimeConnectionEntity)
      .find({ order: { createdAt: "ASC" } });
    return rows.map((row) => ({
      connectionId: row.connectionId,
      name: row.name,
      runtimeKind: row.runtimeKind,
      executorId: row.executorId,
      version: row.version ?? null,
      status: entityStatus(row),
    }));
  }

  /**
   * M8-S3: operator-initiated connection test. Resolves the CURRENT revision
   * (a REVOKED connection is denied), runs the fixed bounded CLI probe, and
   * projects the outcome onto the connection status. Receipts are bounded
   * and secret-free; a failed test never mutates attempt outcomes. Probes
   * are rate-limited (no unbounded polling) and deduplicated per connection
   * (concurrency limit 1 per connection).
   */
  testConnection(
    connectionId: string,
    environment: NodeJS.ProcessEnv = process.env,
  ): Promise<TestConnectionReceipt> {
    const inFlight = this.inFlightTests.get(connectionId);
    if (inFlight) return inFlight;
    const promise = this.runTestConnection(connectionId, environment).finally(() => {
      this.inFlightTests.delete(connectionId);
    });
    this.inFlightTests.set(connectionId, promise);
    return promise;
  }

  private readonly inFlightTests = new Map<
    string,
    Promise<TestConnectionReceipt>
  >();

  private async runTestConnection(
    connectionId: string,
    environment: NodeJS.ProcessEnv,
  ): Promise<TestConnectionReceipt> {
    const revision = await this.claimRevision(connectionId);
    const cli = revision.profile.cli;
    if (!cli) {
      throw new RuntimeConnectionError(
        "CONNECTION_PROBE_UNSUPPORTED",
        `Runtime connection "${connectionId}" has no fixed cli profile to probe`,
      );
    }
    const current = await this.connectionStatus(connectionId);
    const now = new Date();
    if (
      current.testedAt &&
      now.getTime() - Date.parse(current.testedAt) < PROBE_MIN_INTERVAL_MS
    ) {
      throw new RuntimeConnectionError(
        "CONNECTION_TEST_RATE_LIMITED",
        `Runtime connection "${connectionId}" was tested less than ${PROBE_MIN_INTERVAL_MS}ms ago`,
      );
    }

    let outcome = await runCliProbe(cli, environment);
    // Documented auth-status probe (e.g. `claude auth status`): its failure
    // per its own declared exit mapping overrides the outcome.
    if (cli.authProbe && outcome.ok) {
      const authOutcome = await runCliProbe(
        { ...cli, probe: cli.authProbe },
        environment,
      );
      if (!authOutcome.ok) outcome = authOutcome;
    }
    // Pinned-version mismatch is a degradation, never an availability lie.
    const degraded =
      outcome.ok &&
      revision.profile.version !== undefined &&
      outcome.version !== undefined &&
      outcome.version !== revision.profile.version;
    const reasonCode: StatusReasonCode = degraded
      ? "unsupported-version"
      : outcome.reasonCode;
    const event = {
      type: "test" as const,
      outcome: (outcome.ok && !degraded
        ? "ok"
        : degraded
          ? "degraded"
          : outcome.reasonCode === "auth-required"
            ? "authRequired"
            : "failed") as "ok" | "authRequired" | "failed" | "degraded",
      reasonCode,
      testedAt: now.toISOString(),
      testedVersion: outcome.ok ? outcome.version : undefined,
    };
    const status = applyStatusTransition(current, event);

    // M8-S6: CONDITIONAL card persistence under the row lock. A revoke
    // that committed while the probe ran stays terminal (the probe can
    // never resurrect a revoked card), and a revision that advanced while
    // the probe ran keeps the card owned by the NEWER revision — the
    // stale probe's facts are returned in the receipt but never written.
    const persisted = await this.dataSource.transaction(async (manager) => {
      const row = await lockConnection(manager, connectionId);
      if (row.statusState === "REVOKED") {
        throw new RuntimeConnectionError(
          "CONNECTION_REVOKED",
          `Runtime connection "${connectionId}" was revoked while its probe was running`,
        );
      }
      if (row.currentRevisionNumber !== revision.revisionNumber) {
        return false;
      }
      row.statusState = status.state;
      row.statusReasonCode = status.reasonCode;
      row.statusTestedAt = now;
      row.statusTestedVersion = status.testedVersion ?? null;
      await manager.getRepository(RuntimeConnectionEntity).save(row);
      return true;
    });

    const receipt: TestConnectionReceipt = {
      connectionId,
      revisionNumber: revision.revisionNumber,
      testedAt: now.toISOString(),
      state: status.state,
      reasonCode: status.reasonCode,
      durationMs: outcome.durationMs,
    };
    if (status.testedVersion !== undefined) {
      receipt.testedVersion = status.testedVersion;
    }
    if (!persisted) {
      receipt.superseded = true;
    }
    return receipt;
  }

  private toRevisionEntity(
    revision: ConnectionRevisionV1,
  ): ConnectionRevisionEntity {
    const entity = new ConnectionRevisionEntity();
    entity.connectionId = revision.connectionId;
    entity.revisionNumber = revision.revisionNumber;
    entity.profile = revision.profile;
    entity.configHash = revision.configHash;
    entity.capabilities = revision.capabilities;
    return entity;
  }

  /** Strict parse on read: durable rows cross a trust boundary. */
  private toDomainRevision(row: ConnectionRevisionEntity): ConnectionRevisionV1 {
    return parseConnectionRevision({
      schemaVersion: "1",
      connectionId: row.connectionId,
      revisionNumber: row.revisionNumber,
      createdAt: row.createdAt.toISOString(),
      profile: row.profile,
      configHash: row.configHash,
      capabilities: row.capabilities,
    });
  }
}

async function lockConnection(
  manager: EntityManager,
  connectionId: string,
): Promise<RuntimeConnectionEntity> {
  const connection = await manager
    .getRepository(RuntimeConnectionEntity)
    .createQueryBuilder("connection")
    .setLock("pessimistic_write")
    .where('connection."connectionId" = :connectionId', { connectionId })
    .getOne();
  if (!connection) {
    throw new RuntimeConnectionError(
      "CONNECTION_NOT_FOUND",
      `Runtime connection "${connectionId}" does not exist`,
    );
  }
  return connection;
}

function assertNotRevoked(
  connection: RuntimeConnectionEntity,
  connectionId: string,
): void {
  if (connection.statusState === "REVOKED") {
    throw new RuntimeConnectionError(
      "CONNECTION_REVOKED",
      `Runtime connection "${connectionId}" is revoked`,
    );
  }
}

/** Bounded status projection from a connection row. */
function entityStatus(connection: RuntimeConnectionEntity): ConnectionStatus {
  const status: ConnectionStatus = {
    state: connection.statusState,
    reasonCode: connection.statusReasonCode,
  };
  if (connection.statusTestedAt) {
    status.testedAt = connection.statusTestedAt.toISOString();
  }
  if (connection.statusTestedVersion) {
    status.testedVersion = connection.statusTestedVersion;
  }
  return status;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error as { driverError?: { code?: string } }).driverError?.code ===
      UNIQUE_VIOLATION
  );
}
