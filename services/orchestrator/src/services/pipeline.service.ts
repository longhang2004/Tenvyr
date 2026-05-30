import { Injectable, Inject } from '@nestjs/common';
import { Repository } from 'typeorm';
import { PipelineEntity } from '../entities/pipeline.entity';

@Injectable()
export class PipelineService {
  constructor(
    @Inject('PIPELINE_REPOSITORY')
    private pipelineRepository: Repository<PipelineEntity>,
  ) {}

  async create(data: { name: string; version: string; description?: string; steps: any[] }): Promise<PipelineEntity> {
    const pipeline = this.pipelineRepository.create(data);
    return this.pipelineRepository.save(pipeline);
  }

  async findOne(id: string): Promise<PipelineEntity | null> {
    return this.pipelineRepository.findOne({ where: { id } });
  }

  async findAll(): Promise<PipelineEntity[]> {
    return this.pipelineRepository.find({ order: { createdAt: 'DESC' } });
  }
}
