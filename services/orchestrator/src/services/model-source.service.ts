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
    const parsed = parseModelSource(input);
    const repository = this.dataSource.getRepository(ModelSourceEntity);
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
    const current = await this.requireSourceRow(sourceId);
    const merged = parseModelSource({
      sourceId: current.sourceId,
      kind: current.kind,
      displayName: current.displayName,
      baseUrl: current.baseUrl,
      credentialEnvRef: current.credentialEnvRef,
      ...(patch as Record<string, unknown>),
    });
    const row = await this.dataSource.getRepository(ModelSourceEntity).save({
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
    });
    return toProjection(row);
  }

  async delete(sourceId: string): Promise<void> {
    const current = await this.requireSourceRow(sourceId);
    await this.dataSource
      .getRepository(ModelSourceEntity)
      .delete({ id: current.id });
  }

  /** Bounded source test: endpoint reachable, auth accepted, catalog
   *  retrievable. Never proves inference. */
  async test(sourceId: string): Promise<ModelSourceV1> {
    const current = await this.requireSourceRow(sourceId);
    try {
      const result =
        current.kind === "opencode"
          ? await this.testOpenCode()
          : await this.discovery.testOpenAiCompatibleSource({
              sourceId,
              baseUrl: current.baseUrl ?? "",
              credentialEnvRef: current.credentialEnvRef ?? undefined,
            });
      const now = new Date();
      const row = await this.dataSource.getRepository(ModelSourceEntity).save({
        id: current.id,
        statusState: result.status,
        statusReasonCode: result.reasonCode,
        statusTestedAt: now,
        modelCount: result.modelCount ?? current.modelCount,
      });
      return toProjection(row);
    } catch (error) {
      const reason = toReasonCode(error);
      const now = new Date();
      const row = await this.dataSource.getRepository(ModelSourceEntity).save({
        id: current.id,
        statusState:
          reason === "auth-required" ? "AUTH_REQUIRED" : "UNAVAILABLE",
        statusReasonCode: reason,
        statusTestedAt: now,
      });
      return toProjection(row);
    }
  }

  /** Catalog refresh: bounded on-demand discovery; the snapshot is
   *  returned to the caller and NEVER persisted. */
  async refresh(sourceId: string): Promise<{
    source: ModelSourceV1;
    catalog: ModelCatalogSnapshotV1;
  }> {
    const current = await this.requireSourceRow(sourceId);
    try {
      const snapshot = await this.discoverCatalog(current);
      const now = new Date();
      const row = await this.dataSource.getRepository(ModelSourceEntity).save({
        id: current.id,
        statusState: "AVAILABLE",
        statusReasonCode: "none",
        statusTestedAt: now,
        lastCatalogRefreshAt: now,
        modelCount: snapshot.models.length,
      });
      return { source: toProjection(row), catalog: snapshot };
    } catch (error) {
      const reason = toReasonCode(error);
      const now = new Date();
      const row = await this.dataSource.getRepository(ModelSourceEntity).save({
        id: current.id,
        statusState:
          reason === "auth-required" ? "AUTH_REQUIRED" : "UNAVAILABLE",
        statusReasonCode: reason,
        statusTestedAt: now,
      });
      return {
        source: toProjection(row),
        catalog: { sourceId, discoveredAt: now.toISOString(), models: [] },
      };
    }
  }

  /** Runtime-owned catalog discovery (no source row required): OpenCode
   *  first-class; Codex experimental best-effort. */
  async discoverRuntimeCatalog(runtimeKind: string): Promise<{
    runtimeKind: string;
    providers: string[];
    catalog: ModelCatalogSnapshotV1;
  }> {
    if (runtimeKind === "opencode") {
      const executable = resolveExecutableOnPath("opencode");
      if (!executable) {
        return {
          runtimeKind,
          providers: [],
          catalog: {
            sourceId: "runtime:opencode",
            discoveredAt: new Date().toISOString(),
            models: [],
          },
        };
      }
      const [providers, models] = await Promise.all([
        this.discovery.discoverOpenCodeProviders(executable),
        this.discovery.discoverOpenCodeModels(executable),
      ]);
      return {
        runtimeKind,
        providers,
        catalog: {
          sourceId: "runtime:opencode",
          discoveredAt: new Date().toISOString(),
          models,
        },
      };
    }
    if (runtimeKind === "codex") {
      const executable = resolveExecutableOnPath("codex");
      const models = executable
        ? await this.discovery.discoverCodexModels(executable)
        : [];
      return {
        runtimeKind,
        providers: [],
        catalog: {
          sourceId: "runtime:codex",
          discoveredAt: new Date().toISOString(),
          models,
        },
      };
    }
    throw new ModelSourceDomainError(
      "SOURCE_NOT_SUPPORTED",
      `runtime catalog discovery supports codex/opencode, got "${runtimeKind}"`,
    );
  }

  private async discoverCatalog(current: {
    sourceId: string;
    kind: ModelSourceV1["kind"];
    baseUrl: string | null;
    credentialEnvRef: string | null;
  }): Promise<ModelCatalogSnapshotV1> {
    if (current.kind === "opencode") {
      const executable = resolveExecutableOnPath("opencode");
      if (!executable) {
        throw new ModelSourceDomainError(
          "SOURCE_UNAVAILABLE",
          "opencode executable not found on PATH",
        );
      }
      const models = await this.discovery.discoverOpenCodeModels(executable);
      return {
        sourceId: current.sourceId,
        discoveredAt: new Date().toISOString(),
        models,
      };
    }
    return this.discovery.fetchOpenAiCompatibleCatalog({
      sourceId: current.sourceId,
      baseUrl: normalizeModelSourceBaseUrl(current.baseUrl ?? ""),
      credentialEnvRef: current.credentialEnvRef ?? undefined,
    });
  }

  private async testOpenCode(): Promise<{
    status: ModelSourceStatusState;
    reasonCode: ModelSourceReasonCode;
    modelCount?: number;
  }> {
    const executable = resolveExecutableOnPath("opencode");
    if (!executable) {
      return { status: "UNAVAILABLE", reasonCode: "missing-executable" };
    }
    const models = await this.discovery.discoverOpenCodeModels(executable);
    return {
      status: "AVAILABLE",
      reasonCode: "none",
      modelCount: models.length,
    };
  }

  private async requireSourceRow(sourceId: string): Promise<ModelSourceEntity> {
    const row = await this.dataSource
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
