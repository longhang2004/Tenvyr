import { Injectable } from "@nestjs/common";

export type HeartbeatExpectation = {
  expected: boolean;
  startupGraceMs: number;
  staleAfterMs: number;
};

export type SupervisionConfig = Record<string, HeartbeatExpectation>;

const MAX_DURATION_MS = 86_400_000; // 24h
const MIN_DURATION_MS = 1;

/**
 * Small control-plane supervision configuration, independent of transport:
 * third-party HTTP agents may implement only AgentResult, and current Kafka
 * agents do not heartbeat, so expectations are per-agent and default to
 * disabled. Configured via ORCHESTRATOR_SUPERVISION_CONFIG as JSON:
 *
 *   {"agent-name": {"heartbeat": {"expected": true,
 *                                 "startupGraceMs": 30000,
 *                                 "staleAfterMs": 30000}}}
 *
 * Durations are validated as bounded positive integers.
 */
@Injectable()
export class SupervisionConfigService {
  private readonly config: SupervisionConfig;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.config = this.parse(env.ORCHESTRATOR_SUPERVISION_CONFIG);
  }

  forAgent(agent: string): HeartbeatExpectation {
    return (
      this.config[agent] ?? {
        expected: false,
        startupGraceMs: 30_000,
        staleAfterMs: 30_000,
      }
    );
  }

  /** Agents that opted into event supervision, with their expectations. */
  expectedAgents(): Record<string, HeartbeatExpectation> {
    return Object.fromEntries(
      Object.entries(this.config).filter(([, value]) => value.expected),
    );
  }

  private parse(raw: string | undefined): SupervisionConfig {
    if (!raw) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new Error(
        `ORCHESTRATOR_SUPERVISION_CONFIG must be valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        "ORCHESTRATOR_SUPERVISION_CONFIG must be a JSON object keyed by agent name",
      );
    }
    const result: SupervisionConfig = {};
    for (const [agent, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      const heartbeat = (value as Record<string, unknown> | undefined)?.heartbeat;
      if (!heartbeat || typeof heartbeat !== "object") {
        throw new Error(
          `ORCHESTRATOR_SUPERVISION_CONFIG: agent "${agent}" must define a heartbeat object`,
        );
      }
      const { expected, startupGraceMs, staleAfterMs } = heartbeat as Record<
        string,
        unknown
      >;
      if (typeof expected !== "boolean") {
        throw new Error(
          `ORCHESTRATOR_SUPERVISION_CONFIG: agent "${agent}" heartbeat.expected must be a boolean`,
        );
      }
      result[agent] = {
        expected,
        startupGraceMs: this.duration(agent, "startupGraceMs", startupGraceMs),
        staleAfterMs: this.duration(agent, "staleAfterMs", staleAfterMs),
      };
    }
    return result;
  }

  private duration(agent: string, field: string, value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new Error(
        `ORCHESTRATOR_SUPERVISION_CONFIG: agent "${agent}" heartbeat.${field} must be an integer`,
      );
    }
    if (value < MIN_DURATION_MS || value > MAX_DURATION_MS) {
      throw new Error(
        `ORCHESTRATOR_SUPERVISION_CONFIG: agent "${agent}" heartbeat.${field} must be between ${MIN_DURATION_MS} and ${MAX_DURATION_MS} ms`,
      );
    }
    return value;
  }
}
