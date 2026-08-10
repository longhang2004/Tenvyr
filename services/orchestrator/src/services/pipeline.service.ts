import { Injectable, Inject } from "@nestjs/common";
import { Repository } from "typeorm";
import { PipelineEntity } from "../entities/pipeline.entity";
import type { PipelineDefinition } from "../domain/pipeline-definition";
import { sha256Json } from "../domain/canonical-json";
import { PipelineValidationService } from "./pipeline-validation.service";

@Injectable()
export class PipelineService {
  constructor(
    @Inject("PIPELINE_REPOSITORY")
    private pipelineRepository: Repository<PipelineEntity>,
    private readonly validation: PipelineValidationService,
  ) {}

  async create(data: unknown): Promise<PipelineEntity> {
    const definition = this.validation.validate(data);
    const pipeline = this.pipelineRepository.create({
      ...definition,
      schemaVersion: 1,
      contentHash: sha256Json(definition),
    });
    return this.pipelineRepository.save(pipeline);
  }

  async findOne(id: string): Promise<PipelineEntity | null> {
    const pipeline = await this.pipelineRepository.findOne({ where: { id } });
    if (!pipeline) return null;
    const definition = this.validation.validate(
      pipeline as unknown as PipelineDefinition,
    );
    pipeline.steps = definition.steps;
    return pipeline;
  }

  async findAll(): Promise<PipelineEntity[]> {
    return this.pipelineRepository.find({ order: { createdAt: "DESC" } });
  }
}
