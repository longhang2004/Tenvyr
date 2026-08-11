import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";

/**
 * M2D append-only attempt-to-artifact exposure edge. One row per
 * (consumer StepAttempt, projected Artifact) pair, committed atomically with
 * the attempt, its ContextSnapshot, and its DispatchOutbox invocation.
 *
 * The word `exposure` is authoritative: the row proves Tenvyr placed the
 * artifact reference in the attempt's committed context. It does not claim
 * dispatch succeeded, the Worker opened the URI, or the agent reasoned over
 * the artifact.
 *
 * Deletion behavior deliberately avoids silent cascade: neither the
 * referenced Artifact nor the consumer StepAttempt may be deleted through
 * this relation (no ON DELETE CASCADE). Historical cleanup policy is outside
 * M2; tests truncate with CASCADE only in disposable databases.
 */
@Entity("artifact_exposures")
@Unique("UQ_artifact_exposure_attempt_artifact", [
  "stepAttemptId",
  "artifactId",
])
@Index("IDX_artifact_exposure_artifact", ["artifactId"])
export class ArtifactExposureEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** Consumer StepAttempt that received the reference in its context. */
  @Column({ type: "uuid" })
  stepAttemptId: string;

  /** Tenvyr-owned Artifact identity that was projected. */
  @Column({ type: "uuid" })
  artifactId: string;

  @CreateDateColumn()
  createdAt: Date;
}
