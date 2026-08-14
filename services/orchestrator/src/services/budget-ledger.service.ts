import { Inject, Injectable } from "@nestjs/common";
import { DataSource, type EntityManager } from "typeorm";
import { BudgetAccountEntity } from "../entities/budget-account.entity";
import { BudgetReservationEntity } from "../entities/budget-reservation.entity";
import { BudgetLedgerEntryEntity } from "../entities/budget-ledger-entry.entity";
import {
  BUDGET_BOUNDS,
  BudgetError,
  projectAll,
  type BudgetAmounts,
  type BudgetDimension,
  type BudgetEntryFact,
  type BudgetSource,
  type ReservationStatus,
  type UsageObservation,
  reservationKeyForAttempt,
  validateAmount,
  validateCeilings,
  validateConfidence,
  validateDelta,
  validateDimension,
  validateEvidence,
  validateSource,
} from "../domain/budget";

/**
 * M4-S1: append-only budget ledger service.
 *
 * Ownership: every transition runs in ONE transaction that (a) locks the
 * account chain (child → root, ordered by id to avoid deadlocks) with
 * `SELECT ... FOR UPDATE`, (b) validates availability against the locked
 * projection, and (c) inserts the reservation and one ledger entry per
 * account. A concurrent branch can therefore never collectively exceed a
 * hard ceiling, and a failure rolls account, reservation, entries, and
 * state back together.
 *
 * Availability per account/dimension is a pure projection of ledger truth
 * (ceiling + adjusts + releases − reserves); commits are actual-usage
 * evidence and do not move availability. Unknown usage is never zero: the
 * reserved maximum stays consumed unless an explicit release/adjust policy
 * credits it back.
 */
@Injectable()
export class BudgetLedgerService {
  constructor(@Inject("DATA_SOURCE") private readonly dataSource: DataSource) {}

  /**
   * Runs ledger work inside the caller's transaction when a manager is
   * provided (enforcement transactions: claim, result application, cancel,
   * dispatch failure), otherwise in a standalone transaction. This is what
   * makes "reservation commits with the outbox/attempt" and "usage
   * reconciliation commits with the terminal result" atomic.
   */
  private tx<T>(
    manager: EntityManager | undefined,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return manager ? work(manager) : this.dataSource.transaction(work);
  }

  async createAccount(
    input: {
      scopeType: string;
      scopeId: string;
      parentAccountId?: string | null;
      ceilings: unknown;
      softCeilings?: unknown;
    },
    manager?: EntityManager,
  ): Promise<BudgetAccountEntity> {
    const scopeType = this.boundedString(
      input.scopeType,
      "scopeType",
      BUDGET_BOUNDS.scopeTypeMaxLength,
    );
    const scopeId = this.boundedString(
      input.scopeId,
      "scopeId",
      BUDGET_BOUNDS.scopeIdMaxLength,
    );
    const ceilings = validateCeilings(input.ceilings);
    const softCeilings =
      input.softCeilings === undefined || input.softCeilings === null
        ? null
        : validateCeilings(input.softCeilings);

    return this.tx(manager, async (manager) => {
      if (input.parentAccountId) {
        const chain = await this.lockChain(manager, input.parentAccountId);
        // The chain is returned in id-sorted order for stable lock
        // acquisition; the DIRECT parent is the chain member whose id
        // matches — the subset rule is child <= direct parent grant.
        const directParent =
          chain.find((account) => account.id === input.parentAccountId) ??
          chain[0];
        this.assertChildCeilingSubset(ceilings, directParent, "ceilings");
        if (softCeilings) {
          this.assertChildCeilingSubset(
            softCeilings,
            directParent,
            "softCeilings",
          );
        }
      }
      const repository = manager.getRepository(BudgetAccountEntity);
      try {
        return await repository.save(
          repository.create({
            scopeType,
            scopeId,
            parentAccountId: input.parentAccountId ?? null,
            ceilings,
            softCeilings,
          }),
        );
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new BudgetError(
            "SCOPE_ALREADY_EXISTS",
            `Budget account for ${scopeType}/${scopeId} already exists`,
          );
        }
        throw error;
      }
    });
  }

  /**
   * Atomically reserves `amount` on the account AND every ancestor,
   * exactly once per idempotency key. Returns the existing reservation when
   * the same key repeats the same request; a repeated key with a different
   * request is rejected (conflict retained — the first reservation stays
   * authoritative).
   */
  async reserve(
    input: {
      accountId: string;
      dimension: string;
      amount: unknown;
      idempotencyKey: string;
      actionRef?: string | null;
      source?: unknown;
      confidence?: unknown;
      evidence?: unknown;
    },
    manager?: EntityManager,
  ): Promise<BudgetReservationEntity> {
    const dimension = validateDimension(input.dimension);
    const amount = validateAmount(input.dimension, input.amount);
    const idempotencyKey = this.boundedString(
      input.idempotencyKey,
      "idempotencyKey",
      BUDGET_BOUNDS.idempotencyKeyMaxLength,
    );
    const actionRef = this.optionalBoundedString(
      input.actionRef,
      "actionRef",
      BUDGET_BOUNDS.actionRefMaxLength,
    );
    const source = validateSource(input.source ?? "unknown");
    const confidence = validateConfidence(input.confidence);
    const evidence = validateEvidence(input.evidence);

    try {
      return await this.tx(manager, async (manager) => {
        const chain = await this.lockChain(manager, input.accountId);
        for (const account of chain) {
          const available = await this.projectAvailableLocked(manager, account, dimension);
          if (available < amount) {
            throw new BudgetError(
              "INSUFFICIENT_BUDGET",
              `Budget ${dimension} insufficient on ${account.scopeType}/${account.scopeId}: need ${amount}, available ${available}`,
            );
          }
        }
        const reservationRepository = manager.getRepository(BudgetReservationEntity);
        const entryRepository = manager.getRepository(BudgetLedgerEntryEntity);
        const reservation = await reservationRepository.save(
          reservationRepository.create({
            accountId: input.accountId,
            idempotencyKey,
            dimension,
            amount: String(amount),
            status: "ACTIVE",
            actionRef,
          }),
        );
        await this.writeChainEntries(manager, chain, {
          reservationId: reservation.id,
          operation: "reserve",
          dimension,
          amount,
          source,
          confidence,
          idempotencyKey,
          evidence,
        });
        return reservation;
      });
    } catch (error) {
      if (
        (error as { code?: string }).code === "23505" &&
        (error as { constraint?: string }).constraint === "UQ_budget_reservation_key"
      ) {
        if (manager) {
          // Inside an owner transaction the failed INSERT has already
          // aborted it, so no replay can run there — surface the conflict;
          // the owner's transaction rolls back and its retry replays.
          throw error;
        }
        // Standalone: the failed transaction is aborted in PostgreSQL;
        // replay the idempotency decision in a FRESH transaction. Only the
        // reservation key collision is a replay candidate — an entry-level
        // unique violation (e.g. a crafted key colliding with
        // `${key}:commit`) is a real conflict and surfaces as-is.
        return this.dataSource.transaction(async (manager) =>
          this.replayReservation(manager, idempotencyKey, {
            accountId: input.accountId,
            dimension,
            amount,
          }),
        );
      }
      throw error;
    }
  }

  /**
   * Settles an ACTIVE reservation with actual/estimated usage evidence.
   * `amount` must not exceed the reserved maximum. Evidence only: the
   * reserve debit persists; release credits the unused part back.
   */
  async commit(
    input: {
      reservationId: string;
      amount: unknown;
      source?: unknown;
      confidence?: unknown;
      evidence?: unknown;
    },
    manager?: EntityManager,
  ): Promise<BudgetReservationEntity> {
    return this.settleReservation(manager, input.reservationId, "COMMITTED", ["ACTIVE"], (manager, reservation) => {
      const dimension = validateDimension(reservation.dimension);
      const reserved = Number(reservation.amount);
      const commitAmount = validateAmount(reservation.dimension, input.amount);
      if (commitAmount > reserved) {
        throw new BudgetError(
          "RESERVATION_AMOUNT_EXCEEDED",
          `Commit ${commitAmount} exceeds reserved ${reserved} on ${dimension}`,
        );
      }
      const source = validateSource(input.source ?? "unknown");
      const confidence = validateConfidence(input.confidence);
      const evidence = validateEvidence(input.evidence);
      return manager.getRepository(BudgetLedgerEntryEntity).save(
        manager.getRepository(BudgetLedgerEntryEntity).create({
          accountId: reservation.accountId,
          reservationId: reservation.id,
          operation: "commit",
          dimension,
          amount: String(commitAmount),
          source,
          confidence,
          idempotencyKey: `${reservation.idempotencyKey}:commit`,
          evidence,
        }),
      );
    });
  }

  /**
   * Releases UNUSED reservation back to the account chain. `amount` is the
   * unused portion and can never exceed `reserved − committed`: releasing
   * more would erase actual work by minting availability back out of
   * committed consumption. The reserve debit is reduced by exactly
   * `amount` on every account of the chain.
   */
  async release(
    input: {
      reservationId: string;
      amount: unknown;
      source?: unknown;
      confidence?: unknown;
      reason?: unknown;
    },
    manager?: EntityManager,
  ): Promise<BudgetReservationEntity> {
    return this.settleReservation(
      manager,
      input.reservationId,
      "RELEASED",
      ["ACTIVE", "COMMITTED"],
      async (manager, reservation) => {
        const dimension = validateDimension(reservation.dimension);
        const releaseAmount = validateAmount(reservation.dimension, input.amount);
        const reserved = Number(reservation.amount);
        const committed = await this.committedAmount(manager, reservation.id);
        const unused = reserved - committed;
        if (releaseAmount > unused) {
          throw new BudgetError(
            "RESERVATION_AMOUNT_EXCEEDED",
            `Release ${releaseAmount} exceeds the unused reservation ${unused} (reserved ${reserved}, committed ${committed}) on ${dimension}`,
          );
        }
        const source = validateSource(input.source ?? "unknown");
        const confidence = validateConfidence(input.confidence);
        const evidence =
          input.reason === undefined || input.reason === null
            ? undefined
            : validateEvidence({ reason: String(input.reason) });
        const chain = await this.lockChain(manager, reservation.accountId);
        await this.writeChainEntries(manager, chain, {
          reservationId: reservation.id,
          operation: "release",
          dimension,
          amount: releaseAmount,
          source,
          confidence,
          idempotencyKey: `${reservation.idempotencyKey}:release`,
          evidence,
        });
      },
    );
  }

  /** Sum of actual/estimated commit evidence for one reservation. */
  private async committedAmount(
    manager: EntityManager,
    reservationId: string,
  ): Promise<number> {
    const rows = await manager
      .getRepository(BudgetLedgerEntryEntity)
      .createQueryBuilder("entry")
      .select("COALESCE(SUM(entry.amount), 0)", "total")
      .where("entry.reservationId = :reservationId", { reservationId })
      .andWhere("entry.operation = 'commit'")
      .getRawOne<{ total: string }>();
    return Number(rows?.total ?? 0);
  }

  /**
   * Applies a signed ceiling correction to ONE account (operator/policy
   * evidence, not usage). The resulting availability must stay
   * non-negative.
   */
  async adjust(
    input: {
      accountId: string;
      dimension: string;
      delta: unknown;
      reason: unknown;
    },
    manager?: EntityManager,
  ): Promise<BudgetLedgerEntryEntity> {
    const dimension = validateDimension(input.dimension);
    const delta = validateDelta(input.dimension, input.delta);
    const reason = this.boundedString(
      input.reason,
      "reason",
      BUDGET_BOUNDS.actionRefMaxLength,
    );
    return this.tx(manager, async (manager) => {
      // M4-S5: adjust propagates to the WHOLE account chain (child and
      // every ancestor), so no budget path can mint availability across
      // the hierarchy: a top-up on a child debits its ancestors (rejected
      // when any ancestor lacks the room), and a reduction credits them
      // back. Adjusting the ROOT account (no ancestors) is the operator's
      // pure grant. Every account is validated BEFORE any entry is
      // written; the transaction is atomic.
      const chain = await this.lockChain(manager, input.accountId);
      const entryRepository = manager.getRepository(BudgetLedgerEntryEntity);
      // The TARGET account carries the signed delta; every ANCESTOR
      // carries the opposite sign: a child top-up debits its ancestors
      // (money comes out of the ancestor's remaining grant), and a child
      // reduction credits them back. No budget path can mint availability
      // across the hierarchy — the same signed amount drives the
      // availability validation.
      const accountDelta = (account: BudgetAccountEntity) =>
        account.id === input.accountId ? delta : -delta;
      for (const account of chain) {
        const current = await this.projectAvailableLocked(manager, account, dimension);
        if (current + accountDelta(account) < 0) {
          throw new BudgetError(
            "AVAILABILITY_NEGATIVE",
            `Adjust ${accountDelta(account)} would make ${dimension} availability negative on ${account.scopeType}/${account.scopeId} (${current})`,
          );
        }
      }
      const saved = await entryRepository.save(
        chain.map((account) =>
          entryRepository.create({
            accountId: account.id,
            operation: "adjust",
            dimension,
            amount: String(Math.abs(delta)),
            delta: String(accountDelta(account)),
            source: "actual",
            idempotencyKey: null,
            evidence: { reason },
          }),
        ),
      );
      return saved[0];
    });
  }

  /**
   * Pure projection of the CURRENT account state from ledger truth.
   * `pageSize` bounds the scan; the projection is exact for any account
   * whose entry count is below the bound (accounts are small — one per
   * execution plus ancestors).
   */
  async projection(accountId: string): Promise<{
    account: BudgetAccountEntity;
    available: BudgetAmounts;
  }> {
    return this.dataSource.transaction(async (manager) => {
      const account = await manager
        .getRepository(BudgetAccountEntity)
        .findOne({ where: { id: accountId } });
      if (!account) {
        throw new BudgetError("ACCOUNT_NOT_FOUND", `Budget account ${accountId} not found`);
      }
      const facts = await this.loadFacts(manager, accountId);
      return { account, available: projectAll(account.ceilings, facts) };
    });
  }

  async reservation(id: string): Promise<BudgetReservationEntity | null> {
    return this.dataSource.getRepository(BudgetReservationEntity).findOne({ where: { id } });
  }

  // ---- M4-S2 enforcement helpers (called INSIDE owner transactions) -------

  /**
   * Finds (or creates) the execution-level budget account. The account
   * ceiling is the pipeline budget grant, falling back to the step budget
   * when the pipeline declares none. Creation is idempotent under the
   * unique scope constraint.
   */
  async ensureExecutionAccount(
    manager: EntityManager,
    executionId: string,
    pipelineBudget:
      | {
          parent?: { scopeType: string; scopeId: string };
          ceilings: Record<string, number>;
        }
      | undefined,
    stepBudget: Record<string, number> | undefined,
  ): Promise<BudgetAccountEntity> {
    const repository = manager.getRepository(BudgetAccountEntity);
    const existing = await repository.findOne({
      where: { scopeType: "execution", scopeId: executionId },
    });
    if (existing) return existing;
    const ceilings =
      pipelineBudget && Object.keys(pipelineBudget.ceilings).length > 0
        ? pipelineBudget.ceilings
        : stepBudget ?? {};
    if (Object.keys(ceilings).length === 0) {
      throw new BudgetError(
        "DIMENSION_MISSING",
        `Execution ${executionId} declares a step budget but no grant`,
      );
    }
    // M4-S5: the plan may declare an operator-managed parent scope. The
    // parent account must ALREADY exist (the pipeline never defines
    // ancestor grants); the child subset rule is enforced by createAccount.
    let parentAccountId: string | null = null;
    if (pipelineBudget?.parent) {
      const parent = await repository.findOne({
        where: {
          scopeType: pipelineBudget.parent.scopeType,
          scopeId: pipelineBudget.parent.scopeId,
        },
      });
      if (!parent) {
        throw new BudgetError(
          "ACCOUNT_NOT_FOUND",
          `Parent budget account ${pipelineBudget.parent.scopeType}/${pipelineBudget.parent.scopeId} does not exist; the operator must create it first`,
        );
      }
      // M4-S5: the execution grant must be a subset of the parent grant —
      // the same rule createAccount enforces for every child.
      this.assertChildCeilingSubset(ceilings, parent, "ceilings");
      parentAccountId = parent.id;
    }
    // P1: INSERT ... ON CONFLICT DO NOTHING — catching a 23505 here would
    // abort the whole Postgres transaction; the concurrent winner's account
    // is authoritative and readable on the HEALTHY tx.
    await repository
      .createQueryBuilder()
      .insert()
      .into(BudgetAccountEntity)
      .values({
        scopeType: "execution",
        scopeId: executionId,
        parentAccountId,
        ceilings,
        softCeilings: null,
      })
      .orIgnore()
      .execute();
    const winner = await repository.findOne({
      where: { scopeType: "execution", scopeId: executionId },
    });
    if (winner) return winner;
    throw new Error("Budget account insert produced no row");
  }

  /**
   * Reserves every declared step dimension for ONE attempt, inside the
   * caller's transaction. Retries reserve independently (the attempt
   * number is part of the key). Throws INSUFFICIENT_BUDGET when any
   * dimension cannot be reserved — the caller then grants NO work
   * authority and follows the step's failure policy.
   */
  async reserveForAttempt(
    manager: EntityManager,
    input: {
      executionId: string;
      logicalStepId: string;
      attemptNumber: number;
      invocationId: string;
      accountId: string;
      budget: Record<string, number>;
    },
  ): Promise<void> {
    for (const [dimension, amount] of Object.entries(input.budget)) {
      await this.reserve(
        {
          accountId: input.accountId,
          dimension,
          amount,
          idempotencyKey: reservationKeyForAttempt(
            input.executionId,
            input.logicalStepId,
            input.attemptNumber,
            validateDimension(dimension),
          ),
          actionRef: input.invocationId,
          source: "unknown",
        },
        manager,
      );
    }
  }

  /**
   * Terminal reconciliation inside the result-application transaction:
   * commits reported usage per reserved dimension and releases the unused
   * remainder. Dimensions without a report stay consumed (unknown is never
   * zero; only explicit policy releases them).
   */
  async reconcileTerminal(
    manager: EntityManager,
    actionRef: string,
    usage: UsageObservation[],
  ): Promise<void> {
    const reservations = await manager
      .getRepository(BudgetReservationEntity)
      .find({ where: { actionRef } });
    for (const reservation of reservations) {
      const observation = usage.find(
        (candidate) => candidate.dimension === reservation.dimension,
      );
      if (!observation) continue; // unreported dimension stays consumed
      const reserved = Number(reservation.amount);
      const committed = Math.min(observation.amount, reserved);
      if (committed > 0) {
        await this.commit(
          {
            reservationId: reservation.id,
            amount: committed,
            source: observation.source,
            evidence: { actionRef },
          },
          manager,
        );
      }
      const unused = reserved - committed;
      if (unused > 0) {
        await this.release(
          {
            reservationId: reservation.id,
            amount: unused,
            source: "unknown",
            reason: "unused reservation after terminal result",
          },
          manager,
        );
      }
    }
  }

  /**
   * Releases the FULL reservation for an action that will never complete
   * (cancellation, non-retryable dispatch failure): no work authority was
   * granted beyond the reservation, so the whole reserved amount is
   * unused. Idempotent: repeated calls hit the status gate.
   */
  async releaseForAction(
    manager: EntityManager,
    actionRef: string,
    reason: string,
  ): Promise<void> {
    const reservations = await manager
      .getRepository(BudgetReservationEntity)
      .find({ where: { actionRef } });
    for (const reservation of reservations) {
      await this.release(
        {
          reservationId: reservation.id,
          amount: Number(reservation.amount),
          source: "unknown",
          reason,
        },
        manager,
      );
    }
  }

  // ---- internals ---------------------------------------------------------

  /**
   * Locks the account chain (child → root) FOR UPDATE in id order and
   * returns it child-first. Locking every ancestor makes concurrent
   * reservations on sibling accounts serialize on their shared ancestors,
   * so no ancestor can ever be overspent.
   */
  private async lockChain(
    manager: EntityManager,
    accountId: string,
  ): Promise<BudgetAccountEntity[]> {
    const repository = manager.getRepository(BudgetAccountEntity);
    const chain: BudgetAccountEntity[] = [];
    const seen = new Set<string>();
    let currentId = accountId;
    while (currentId) {
      if (seen.has(currentId)) {
        throw new BudgetError("CHAIN_TOO_DEEP", "Budget account chain contains a cycle");
      }
      seen.add(currentId);
      const account = await repository
        .createQueryBuilder("account")
        .setLock("pessimistic_write")
        .where("account.id = :id", { id: currentId })
        .getOne();
      if (!account) {
        throw new BudgetError(
          "ACCOUNT_NOT_FOUND",
          `Budget account ${currentId} not found while walking the chain`,
        );
      }
      chain.push(account);
      if (chain.length > BUDGET_BOUNDS.accountChainMaxDepth) {
        throw new BudgetError(
          "CHAIN_TOO_DEEP",
          `Budget account chain exceeds ${BUDGET_BOUNDS.accountChainMaxDepth} accounts`,
        );
      }
      currentId = account.parentAccountId ?? "";
    }
    // The bottom-up child→root walk is deadlock-free for a tree hierarchy
    // (every chain locks its own leaf before any shared ancestor, so two
    // sibling chains can never hold each other's locks). The id sort only
    // stabilizes the returned order; it does not change lock acquisition.
    return chain.sort((left, right) => (left.id < right.id ? -1 : 1));
  }

  private async projectAvailableLocked(
    manager: EntityManager,
    account: BudgetAccountEntity,
    dimension: BudgetDimension,
  ): Promise<number> {
    const facts = await this.loadFacts(manager, account.id);
    const projected = projectAll(account.ceilings, facts);
    return projected[dimension] ?? 0;
  }

  private async loadFacts(
    manager: EntityManager,
    accountId: string,
  ): Promise<BudgetEntryFact[]> {
    const rows = await manager
      .getRepository(BudgetLedgerEntryEntity)
      .createQueryBuilder("entry")
      .where("entry.accountId = :accountId", { accountId })
      .orderBy("entry.createdAt", "ASC")
      .addOrderBy("entry.id", "ASC")
      .take(BUDGET_BOUNDS.projectionPageSize + 1)
      .getMany();
    if (rows.length > BUDGET_BOUNDS.projectionPageSize) {
      throw new BudgetError(
        "PROJECTION_TOO_LARGE",
        `Budget account ${accountId} has more than ${BUDGET_BOUNDS.projectionPageSize} ledger entries; page the projection`,
      );
    }
    return rows.map((row) => ({
      operation: row.operation,
      dimension: validateDimension(row.dimension),
      amount: Number(row.amount),
      delta: row.delta === null ? undefined : Number(row.delta),
      source: row.source,
      confidence: row.confidence ?? undefined,
    }));
  }

  private async writeChainEntries(
    manager: EntityManager,
    chain: BudgetAccountEntity[],
    entry: {
      reservationId: string;
      operation: "reserve" | "release";
      dimension: BudgetDimension;
      amount: number;
      source: BudgetSource;
      confidence?: number;
      idempotencyKey: string;
      evidence?: Record<string, unknown>;
    },
  ): Promise<void> {
    const entryRepository = manager.getRepository(BudgetLedgerEntryEntity);
    await entryRepository.save(
      chain.map((account) =>
        entryRepository.create({
          accountId: account.id,
          reservationId: entry.reservationId,
          operation: entry.operation,
          dimension: entry.dimension,
          amount: String(entry.amount),
          source: entry.source,
          confidence: entry.confidence ?? null,
          idempotencyKey: `${entry.idempotencyKey}:${account.id}`,
          evidence: entry.evidence ?? null,
        }),
      ),
    );
  }

  /**
   * Idempotency replay: a unique-key conflict on the reservation key means
   * the key was already used. An identical request returns the existing
   * reservation (exactly once); any difference is an IDEMPOTENCY_CONFLICT
   * that retains the first reservation as authoritative.
   */
  private async replayReservation(
    manager: EntityManager,
    idempotencyKey: string,
    request: { accountId: string; dimension: BudgetDimension; amount: number },
  ): Promise<BudgetReservationEntity> {
    const existing = await manager
      .getRepository(BudgetReservationEntity)
      .findOne({ where: { idempotencyKey } });
    if (!existing) {
      // Race between the unique violation and the read: the committing
      // transaction is visible; retry the read once.
      const retried = await manager
        .getRepository(BudgetReservationEntity)
        .findOne({ where: { idempotencyKey } });
      if (!retried) throw new BudgetError("IDEMPOTENCY_CONFLICT", "Reservation key conflict");
      return this.assertReplayMatches(retried, request);
    }
    return this.assertReplayMatches(existing, request);
  }

  private assertReplayMatches(
    existing: BudgetReservationEntity,
    request: { accountId: string; dimension: BudgetDimension; amount: number },
  ): BudgetReservationEntity {
    if (
      existing.accountId === request.accountId &&
      existing.dimension === request.dimension &&
      Number(existing.amount) === request.amount
    ) {
      return existing;
    }
    throw new BudgetError(
      "IDEMPOTENCY_CONFLICT",
      `Reservation key already used with a different request (${existing.dimension}/${existing.amount} on ${existing.accountId})`,
    );
  }

  private async settleReservation(
    manager: EntityManager | undefined,
    reservationId: string,
    target: "COMMITTED" | "RELEASED",
    allowedFrom: ReservationStatus[],
    prepare: (
      manager: EntityManager,
      reservation: BudgetReservationEntity,
    ) => Promise<unknown>,
  ): Promise<BudgetReservationEntity> {
    return this.tx(manager, async (manager) => {
      const repository = manager.getRepository(BudgetReservationEntity);
      const reservation = await repository
        .createQueryBuilder("reservation")
        .setLock("pessimistic_write")
        .where("reservation.id = :id", { id: reservationId })
        .getOne();
      if (!reservation) {
        throw new BudgetError("RESERVATION_NOT_ACTIVE", `Reservation ${reservationId} not found`);
      }
      if (!allowedFrom.includes(reservation.status)) {
        throw new BudgetError(
          "RESERVATION_NOT_ACTIVE",
          `Reservation ${reservationId} is ${reservation.status}; allowed from ${allowedFrom.join("/")}`,
        );
      }
      await prepare(manager, reservation);
      reservation.status = target;
      return repository.save(reservation);
    });
  }

  private assertChildCeilingSubset(
    child: BudgetAmounts,
    parent: BudgetAccountEntity,
    what: string,
  ): void {
    for (const [dimension, amount] of Object.entries(child)) {
      const parentAmount = (parent.ceilings as Record<string, number>)[dimension];
      if (parentAmount === undefined || amount > parentAmount) {
        throw new BudgetError(
          "CHILD_CEILING_EXCEEDS_PARENT",
          `Child ${what} for ${dimension} (${amount}) exceeds the parent grant (${parentAmount ?? "none"})`,
        );
      }
    }
  }

  private boundedString(value: unknown, field: string, maxLength: number): string {
    if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
      throw new BudgetError(
        "INPUT_INVALID",
        `${field} must be a non-empty string of at most ${maxLength} characters`,
      );
    }
    return value;
  }

  private optionalBoundedString(
    value: unknown,
    field: string,
    maxLength: number,
  ): string | null {
    if (value === undefined || value === null) return null;
    return this.boundedString(value, field, maxLength);
  }
}
