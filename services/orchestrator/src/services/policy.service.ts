import { Inject, Injectable } from "@nestjs/common";
import { DataSource, type EntityManager } from "typeorm";
import { PolicySnapshotEntity } from "../entities/policy-snapshot.entity";
import { PolicyDecisionEntity } from "../entities/policy-decision.entity";
import {
  evaluateProposal,
  parsePolicySnapshot,
  PolicyError,
  type ActionProposal,
  type PolicyDecision,
  type PolicyRule,
  type PolicySnapshotData,
} from "../domain/policy";

/**
 * M4-S3: trusted policy evaluation service.
 *
 * The trusted configuration (`TENVYR_POLICY`) is a versioned rules document;
 * the FIRST use freezes it into `policy_snapshots` (one canonical hash per
 * version). Every interception stores an append-only `policy_decisions`
 * row in the SAME transaction as the intercepted action (manager-passed),
 * so "policy decision" and "action outcome" commit or roll back together.
 * A rotated configuration for an existing version is a deterministic safe
 * failure (the operator must bump the version).
 */
@Injectable()
export class PolicyService {
  constructor(@Inject("DATA_SOURCE") private readonly dataSource: DataSource) {}

  /** True when trusted policy configuration exists (evaluation is opt-in). */
  isConfigured(): boolean {
    const raw = process.env.TENVYR_POLICY;
    return Boolean(raw && raw.trim());
  }

  /** Parsed trusted configuration (env `TENVYR_POLICY`), frozen on first use. */
  configuredSnapshot(): PolicySnapshotData {
    const raw = process.env.TENVYR_POLICY;
    if (!raw || !raw.trim()) {
      // No policy configured: every proposal is ALLOW by default. The
      // dispatch boundary still records nothing (no policy evidence) —
      // decisions only exist when a policy is declared.
      throw new PolicyError(
        "SNAPSHOT_NOT_FOUND",
        "TENVYR_POLICY is not configured; no policy decisions are produced",
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new PolicyError("POLICY_CONFIG_INVALID", "TENVYR_POLICY must be valid JSON");
    }
    return parsePolicySnapshot(value);
  }

  /**
   * Loads (creating if needed) the frozen snapshot for the configured
   * policy inside the caller's transaction when a manager is provided.
   */
  async loadSnapshot(manager?: EntityManager): Promise<PolicySnapshotData> {
    const configured = this.configuredSnapshot();
    const run = async (m: EntityManager): Promise<PolicySnapshotData> => {
      const repository = m.getRepository(PolicySnapshotEntity);
      const existing = await repository.findOne({
        where: { version: configured.version },
      });
      if (existing) {
        if (existing.hash !== configured.hash) {
          throw new PolicyError(
            "POLICY_VERSION_CONFLICT",
            `Policy version ${configured.version} is frozen with a different rules hash; bump the version to rotate`,
          );
        }
        return { version: existing.version, hash: existing.hash, rules: existing.rules as PolicyRule[] };
      }
      // P1: INSERT ... ON CONFLICT DO NOTHING — catching a 23505 here would
      // abort the whole Postgres transaction. The concurrent winner is
      // authoritative; its hash is verified on the HEALTHY tx.
      const inserted = await repository
        .createQueryBuilder()
        .insert()
        .into(PolicySnapshotEntity)
        .values({
          version: configured.version,
          hash: configured.hash,
          rules: configured.rules,
        })
        .orIgnore()
        .execute();
      const winner = await repository.findOne({
        where: { version: configured.version },
      });
      if (winner && winner.hash === configured.hash) {
        return { version: winner.version, hash: winner.hash, rules: winner.rules as PolicyRule[] };
      }
      if (winner) {
        throw new PolicyError(
          "POLICY_VERSION_CONFLICT",
          `Policy version ${configured.version} was frozen concurrently with a different rules hash; bump the version to rotate`,
        );
      }
      throw new Error("Policy freeze insert produced no row");
    };
    return manager ? run(manager) : this.dataSource.transaction(run);
  }

  /**
   * Evaluates a proposal under the frozen snapshot and records the decision
   * as append-only evidence inside the caller's transaction (manager) or a
   * standalone one. The decision is returned so the boundary can act on it
   * (ALLOW → reserve budget → execute; DENY → durable terminal disposition;
   * REQUIRE_APPROVAL → S4 approval flow).
   */
  async evaluate(
    proposal: ActionProposal,
    manager?: EntityManager,
  ): Promise<PolicyDecision> {
    const snapshot = await this.loadSnapshot(manager);
    const decision = evaluateProposal(proposal, snapshot);
    const run = async (m: EntityManager): Promise<void> => {
      await m.getRepository(PolicyDecisionEntity).save(
        m.getRepository(PolicyDecisionEntity).create({
          proposalId: proposal.proposalId,
          actionType: proposal.actionType,
          executionId: proposal.scope.executionId,
          logicalStepId: proposal.scope.logicalStepId ?? null,
          attemptNumber: proposal.scope.attemptNumber ?? null,
          targetAgent: proposal.target?.agent ?? null,
          targetExecutor: proposal.target?.executor ?? null,
          proposalHash: proposal.hash,
          policyVersion: decision.policyVersion,
          policyHash: decision.policyHash,
          effect: decision.effect,
          reasons: decision.reasons,
        }),
      );
    };
    if (manager) await run(manager);
    else await this.dataSource.transaction(run);
    return decision;
  }
}
