import type { EntityManager } from "typeorm";
import { sha256Json } from "../domain/canonical-json";
import {
  CONTEXT_SNAPSHOT_BOUNDS,
  type ArtifactContextReference,
  type ArtifactSelector,
  ContextProjectionError,
  validateArtifactSelectors,
} from "../domain/context-snapshot";
import { ArtifactEntity } from "../entities/artifact.entity";
import { ResultInboxEntity } from "../entities/result-inbox.entity";
import { LogicalStepEntity } from "../entities/step-execution.entity";
import { StepAttemptEntity } from "../entities/step-attempt.entity";

type ResolvedProducer = {
  eligible: boolean;
  stepId: string;
  attemptId?: string;
  artifacts: Array<{
    artifact: ArtifactEntity;
    descriptor: Record<string, unknown>;
  }>;
};

export type ArtifactResolution = {
  references: ArtifactContextReference[];
  /** Authoritative Artifact entities for exposure-edge persistence. */
  artifacts: ArtifactEntity[];
};

/**
 * M2D authoritative artifact-resolution for one claim. Runs inside the claim
 * transaction with the execution row lock already held, so a producer result
 * commit racing the consumer claim yields one deterministic database truth:
 * either the committed eligible producer is visible, or the claim fails
 * according to the existing dependency policy — never an uncommitted
 * descriptor or a dangling edge.
 *
 * Only the canonical APPLIED successful result of the dependency's current
 * successful attempt is eligible. Descriptor fields are read by verified
 * ordinal from the canonical ResultInbox payload; the descriptor `id` is
 * never Tenvyr authority. All resolution is same-execution by construction
 * (queries are scoped to the consumer execution and defensively re-checked).
 */
export class ArtifactProjectionResolver {
  constructor(private readonly manager: EntityManager) {}

  async resolve(
    executionId: string,
    selectors: ArtifactSelector[],
  ): Promise<ArtifactResolution> {
    const validated = validateArtifactSelectors(selectors);

    const references: ArtifactContextReference[] = [];
    const artifacts: ArtifactEntity[] = [];
    const byProducer = new Map<string, ResolvedProducer>();

    for (const selector of validated) {
      let producer = byProducer.get(selector.fromStep);
      if (!producer) {
        producer = await this.resolveProducer(executionId, selector.fromStep);
        byProducer.set(selector.fromStep, producer);
      }
      // No eligible result (skipped/failed dependency, or no canonical APPLIED
      // success yet): the selector resolves no artifacts, per the spec.
      if (!producer.eligible) continue;

      const matched = producer.artifacts.filter(({ artifact, descriptor }) => {
        if (selector.name !== undefined) {
          return descriptor.name === selector.name;
        }
        if (selector.ordinal !== undefined) {
          return artifact.descriptorOrdinal === selector.ordinal;
        }
        return true;
      });
      if (matched.length === 0) {
        throw new ContextProjectionError("TENVYR_CTX_ARTIFACT_FILTER_NO_MATCH");
      }
      for (const { artifact, descriptor } of matched) {
        if (artifacts.some((existing) => existing.id === artifact.id)) {
          throw new ContextProjectionError("TENVYR_CTX_ARTIFACT_OVERLAP");
        }
        references.push(
          this.buildReference(producer, artifact, descriptor, selector),
        );
        artifacts.push(artifact);
      }
    }

    if (references.length > CONTEXT_SNAPSHOT_BOUNDS.maxArtifactReferences) {
      throw new ContextProjectionError("TENVYR_CTX_ARTIFACT_LIMIT");
    }

    // Deterministic order: producer step ID, producer attempt ID, descriptor
    // ordinal, then Artifact UUID.
    references.sort(
      (left, right) =>
        left.producerStepId.localeCompare(right.producerStepId) ||
        left.producerAttemptId.localeCompare(right.producerAttemptId) ||
        left.descriptorOrdinal - right.descriptorOrdinal ||
        left.artifactId.localeCompare(right.artifactId),
    );
    return { references, artifacts };
  }

  private async resolveProducer(
    executionId: string,
    fromStep: string,
  ): Promise<ResolvedProducer> {
    const logicalStep = await this.manager
      .getRepository(LogicalStepEntity)
      .findOne({ where: { executionId, stepId: fromStep } });
    if (!logicalStep) {
      throw new ContextProjectionError("TENVYR_CTX_ARTIFACT_PRODUCER_MISSING");
    }

    // The dependency's CURRENT successful attempt: attempts are immutable and
    // terminal, so the latest SUCCESS attempt is the authoritative producer.
    const attempt = await this.manager
      .getRepository(StepAttemptEntity)
      .createQueryBuilder("attempt")
      .where('attempt."logicalStepId" = :logicalStepId', {
        logicalStepId: logicalStep.id,
      })
      .andWhere('attempt."status" = :success', { success: "SUCCESS" })
      .orderBy('attempt."attemptNumber"', "DESC")
      .getOne();
    if (!attempt) {
      return { eligible: false, stepId: fromStep, artifacts: [] };
    }
    // Same-execution enforcement: a producer row from another execution can
    // never satisfy this selection (defense in depth; the query chain above
    // is already scoped to this execution).
    if (attempt.executionId !== executionId) {
      throw new ContextProjectionError("TENVYR_CTX_FOREIGN_ARTIFACT");
    }

    const inbox = await this.manager.getRepository(ResultInboxEntity).findOne({
      where: { stepAttemptId: attempt.id, status: "APPLIED" },
    });
    if (!inbox) {
      // No canonical APPLIED result yet: nothing is eligible to project.
      return { eligible: false, stepId: fromStep, artifacts: [] };
    }
    if (inbox.stepAttemptId !== attempt.id) {
      throw new ContextProjectionError("TENVYR_CTX_FOREIGN_ARTIFACT");
    }

    const rows = await this.manager.getRepository(ArtifactEntity).find({
      where: { resultInboxId: inbox.id },
      order: { descriptorOrdinal: "ASC" },
    });
    const payload = (inbox.payload ?? {}) as {
      artifacts?: Array<Record<string, unknown>>;
    };
    const descriptors = payload.artifacts ?? [];
    const artifacts: ResolvedProducer["artifacts"] = [];
    for (const artifact of rows) {
      const descriptor = descriptors[artifact.descriptorOrdinal];
      // Verified ordinal: the canonical descriptor must match the durable
      // descriptor hash registered with the Artifact row. A mismatch is
      // durable-data corruption and must terminate the claim deterministically.
      if (!descriptor || sha256Json(descriptor) !== artifact.descriptorHash) {
        throw new ContextProjectionError(
          "TENVYR_CTX_ARTIFACT_ORDINAL_MISMATCH",
        );
      }
      artifacts.push({ artifact, descriptor });
    }
    return {
      eligible: true,
      stepId: fromStep,
      attemptId: attempt.id,
      artifacts,
    };
  }

  private buildReference(
    producer: ResolvedProducer,
    artifact: ArtifactEntity,
    descriptor: Record<string, unknown>,
    selector: ArtifactSelector,
  ): ArtifactContextReference {
    const reference: ArtifactContextReference = {
      artifactId: artifact.id,
      producerStepId: producer.stepId,
      producerAttemptId: producer.attemptId!,
      descriptorOrdinal: artifact.descriptorOrdinal,
    };
    // Defensive type checks at the trust boundary: descriptor fields are
    // contract-validated strings, but a malformed row must never leak
    // non-string values into the consumer envelope.
    if (typeof descriptor.name === "string") {
      reference.name = descriptor.name;
    }
    if (typeof descriptor.mediaType === "string") {
      reference.mediaType = descriptor.mediaType;
    }
    if (typeof descriptor.uri === "string") {
      reference.uri = descriptor.uri;
    }
    if (selector.includeMetadata && isPlainObject(descriptor.metadata)) {
      reference.metadata = structuredClone(
        descriptor.metadata as Record<string, unknown>,
      ) as ArtifactContextReference["metadata"];
    }
    return reference;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  let proto: object | null;
  try {
    proto = Object.getPrototypeOf(value);
  } catch {
    return false;
  }
  if (proto === null) return true;
  try {
    return Object.getPrototypeOf(proto) === null;
  } catch {
    return false;
  }
}
