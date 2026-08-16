import { Injectable } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { DataSource } from "typeorm";
import {
  ModelDiscoveryError,
  ModelDiscoveryService,
} from "./model-discovery.service";
import { ModelSourceEntity } from "../entities/model-source.entity";
import {
  MODEL_SOURCE_KINDS,
  normalizeModelSourceBaseUrl,
  parseModelSource,
  type ModelCatalogSnapshotV1,
  type ModelSourceReasonCode,
  type ModelSourceStatusState,
  type ModelSourceV1,
  type RuntimeProviderV1,
} from "../executors/model-source";
import { resolveExecutableOnPath } from "./runtime-onboarding.service";

/**
 * P2: durable Model Source authority. Sources are operator configuration;
 * catalogs are bounded on-demand projections (never persisted). Credential
 * fields are environment REFERENCES only — values are resolved exclusively
 * inside ModelDiscoveryService at the network boundary and never stored,
 * returned, or logged.
 */
@Injectable()
export class ModelSourceService {
  private readonly discovery = new ModelDiscoveryService();

  constructor(@Inject("DATA_SOURCE") private readonly dataSource: DataSource) {}

  async list(): Promise<ModelSourceV1[]> {
    const rows = await this.dataSource
      .getRepository(ModelSourceEntity)
      .find({ order: { createdAt: "ASC" } });
    return rows.map(toProjection);
  }

  async create(input: unknown): Promise<ModelSourceV1> {
    return this.dataSource.transaction((manager) =>
      this.createWithManager(manager, input),
    );
  }

  /** P2 closure (M10 invariant): the audited Workbench command layer runs
   *  authority mutations through ITS EntityManager so the authority row,
   *  the OperatorAction evidence row, and the stored outcome commit (or
   *  roll back) atomically. */
  async createWithManager(
    manager: import("typeorm").EntityManager,
    input: unknown,
  ): Promise<ModelSourceV1> {
    const parsed = parseModelSource(input);
    const repository = manager.getRepository(ModelSourceEntity);
    const existing = await repository.findOne({
      where: { sourceId: parsed.sourceId },
    });
    if (existing) {
      throw new ModelSourceDomainError(
        "SOURCE_ALREADY_EXISTS",
        `Model source "${parsed.sourceId}" already exists`,
      );
    }
    const row = await repository.save(
      repository.create({
        sourceId: parsed.sourceId,
        kind: parsed.kind,
        displayName: parsed.displayName,
        baseUrl: parsed.baseUrl ?? null,
        credentialEnvRef: parsed.credentialEnvRef ?? null,
        statusState: "UNKNOWN",
        statusReasonCode: "none",
        modelCount: 0,
      }),
    );
    return toProjection(row);
  }

  async update(sourceId: string, patch: unknown): Promise<ModelSourceV1> {
    return this.dataSource.transaction((manager) =>
      this.updateWithManager(manager, sourceId, patch),
    );
  }

  async updateWithManager(
    manager: import("typeorm").EntityManager,
    sourceId: string,
    patch: unknown,
  ): Promise<ModelSourceV1> {
    const current = await this.requireSourceRow(manager, sourceId);
    const merged = parseModelSource({
      sourceId: current.sourceId,
      kind: current.kind,
      displayName: current.displayName,
      // Entity nulls (unset optional columns) must NOT reach the strict
      // parser — map them back to undefined before merging the patch.
      baseUrl: current.baseUrl ?? undefined,
      credentialEnvRef: current.credentialEnvRef ?? undefined,
      ...(patch as Record<string, unknown>),
    });
    const repository = manager.getRepository(ModelSourceEntity);
    await repository.save(
      repository.create({
        id: current.id,
        sourceId: merged.sourceId,
        kind: merged.kind,
        displayName: merged.displayName,
        baseUrl: merged.baseUrl ?? null,
        credentialEnvRef: merged.credentialEnvRef ?? null,
        // A configuration edit invalidates prior probe/catalog evidence.
        statusState: "UNKNOWN",
        statusReasonCode: "none",
        statusTestedAt: null,
        lastCatalogRefreshAt: null,
        modelCount: 0,
      }),
    );
    // save() does not reload CreateDateColumn values on update — re-read
    // the committed row so the projection is authoritative.
    const row = await repository.findOneOrFail({ where: { id: current.id } });
    return toProjection(row);
  }

  async delete(sourceId: string): Promise<void> {
    await this.dataSource.transaction((manager) =>
      this.deleteWithManager(manager, sourceId),
    );
  }

  async deleteWithManager(
    manager: import("typeorm").EntityManager,
    sourceId: string,
  ): Promise<void> {
    const current = await this.requireSourceRow(manager, sourceId);
    await manager.getRepository(ModelSourceEntity).delete({ id: current.id });
  }

  /** Bounded source test: endpoint reachable, auth accepted, catalog
   *  retrievable. Never proves inference. */
  async test(sourceId: string): Promise<ModelSourceV1> {
    return this.dataSource.transaction((manager) =>
      this.testWithManager(manager, sourceId),
    );
  }

  async testWithManager(
    manager: import("typeorm").EntityManager,
    sourceId: string,
  ): Promise<ModelSourceV1> {
    const current = await this.requireSourceRow(manager, sourceId);
    try {
      const result = await this.discovery.testOpenAiCompatibleSource({
        sourceId,
        baseUrl: current.baseUrl ?? "",
        credentialEnvRef: current.credentialEnvRef ?? undefined,
      });
      const now = new Date();
      const repository = manager.getRepository(ModelSourceEntity);
      await repository.save(
        repository.create({
          id: current.id,
          statusState: result.status,
          statusReasonCode: result.reasonCode,
          statusTestedAt: now,
          modelCount: result.modelCount ?? current.modelCount,
        }),
      );
      const row = await repository.findOneOrFail({ where: { id: current.id } });
      return toProjection(row);
    } catch (error) {
      const reason = toReasonCode(error);
      const now = new Date();
      const repository = manager.getRepository(ModelSourceEntity);
      await repository.save(
        repository.create({
          id: current.id,
          statusState:
            reason === "auth-required" ? "AUTH_REQUIRED" : "UNAVAILABLE",
          statusReasonCode: reason,
          statusTestedAt: now,
        }),
      );
      const row = await repository.findOneOrFail({ where: { id: current.id } });
      return toProjection(row);
    }
  }

  /** Catalog refresh: bounded on-demand discovery; the snapshot is
   *  returned to the caller and NEVER persisted. */
  async refresh(sourceId: string): Promise<{
    source: ModelSourceV1;
    catalog: ModelCatalogSnapshotV1;
  }> {
    return this.dataSource.transaction((manager) =>
      this.refreshWithManager(manager, sourceId),
    );
  }

  async refreshWithManager(
    manager: import("typeorm").EntityManager,
    sourceId: string,
  ): Promise<{
    source: ModelSourceV1;
    catalog: ModelCatalogSnapshotV1;
  }> {
    const current = await this.requireSourceRow(manager, sourceId);
    try {
      const snapshot = await this.discoverCatalog(current);
      const now = new Date();
      const repository = manager.getRepository(ModelSourceEntity);
      await repository.save(
        repository.create({
          id: current.id,
          statusState: "AVAILABLE",
          statusReasonCode: "none",
          statusTestedAt: now,
          lastCatalogRefreshAt: now,
          modelCount: snapshot.models.length,
        }),
      );
      const row = await repository.findOneOrFail({ where: { id: current.id } });
      return { source: toProjection(row), catalog: snapshot };
    } catch (error) {
      const reason = toReasonCode(error);
      const now = new Date();
      const repository = manager.getRepository(ModelSourceEntity);
      await repository.save(
        repository.create({
          id: current.id,
          statusState:
            reason === "auth-required" ? "AUTH_REQUIRED" : "UNAVAILABLE",
          statusReasonCode: reason,
          statusTestedAt: now,
        }),
      );
      const row = await repository.findOneOrFail({ where: { id: current.id } });
      return {
        source: toProjection(row),
        catalog: { sourceId, discoveredAt: now.toISOString(), models: [] },
      };
    }
  }

  private async discoverCatalog(current: {
    sourceId: string;
    kind: ModelSourceV1["kind"];
    baseUrl: string | null;
    credentialEnvRef: string | null;
  }): Promise<ModelCatalogSnapshotV1> {
    return this.discovery.fetchOpenAiCompatibleCatalog({
      sourceId: current.sourceId,
      baseUrl: normalizeModelSourceBaseUrl(current.baseUrl ?? ""),
      credentialEnvRef: current.credentialEnvRef ?? undefined,
    });
  }

  private async requireSourceRow(
    managerOrSourceId: import("typeorm").EntityManager | string,
    maybeSourceId?: string,
  ): Promise<ModelSourceEntity> {
    const manager =
      typeof managerOrSourceId === "string"
        ? this.dataSource.manager
        : managerOrSourceId;
    const sourceId =
      typeof managerOrSourceId === "string" ? managerOrSourceId : maybeSourceId!;
    const row = await manager
      .getRepository(ModelSourceEntity)
      .findOne({ where: { sourceId } });
    if (!row) {
      throw new ModelSourceDomainError(
        "SOURCE_NOT_FOUND",
        `Model source "${sourceId}" not found`,
      );
    }
    return row;
  }
}

export class ModelSourceDomainError extends Error {
  constructor(
    public readonly code:
      | "SOURCE_NOT_FOUND"
      | "SOURCE_ALREADY_EXISTS"
      | "SOURCE_UNAVAILABLE"
      | "SOURCE_NOT_SUPPORTED",
    message: string,
  ) {
    super(message);
    this.name = "ModelSourceDomainError";
  }
}

function toReasonCode(error: unknown): ModelSourceReasonCode {
  if (error instanceof ModelSourceDomainError) return "unreachable";
  if (error instanceof ModelDiscoveryError) return error.code;
  return "unreachable";
}

function toProjection(row: ModelSourceEntity): ModelSourceV1 {
  const projection: ModelSourceV1 = {
    sourceId: row.sourceId,
    kind: row.kind,
    displayName: row.displayName,
    status: row.statusState,
    reasonCode: row.statusReasonCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    modelCount: row.modelCount,
  };
  if (row.baseUrl) projection.baseUrl = row.baseUrl;
  if (row.credentialEnvRef) projection.credentialEnvRef = row.credentialEnvRef;
  if (row.statusTestedAt)
    projection.lastTestedAt = row.statusTestedAt.toISOString();
  if (row.lastCatalogRefreshAt) {
    projection.lastCatalogRefreshAt = row.lastCatalogRefreshAt.toISOString();
  }
  return projection;
}

export const MODEL_SOURCE_KINDS_EXPORT = MODEL_SOURCE_KINDS;
