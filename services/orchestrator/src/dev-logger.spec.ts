import { TenvyrDevLogger, detectLogMode, selectBootstrapLogger, shouldEmitLogLine } from "./dev-logger";

const FAKE_ENV = (extra: Record<string, string> = {}) => ({
  ...process.env,
  NODE_ENV: "development",
  NO_COLOR: "1",
  ...extra,
});

describe("bootstrap logger selection (terminal-UX closure)", () => {
  test("production never installs the compact dev presenter", () => {
    expect(selectBootstrapLogger({ NODE_ENV: "production" })).toBe("default");
    expect(
      selectBootstrapLogger({ NODE_ENV: "production", TENVYR_LOG_LEVEL: "normal" }),
    ).toBe("default");
  });

  test("verbose development uses native (lossless) Nest logging", () => {
    expect(selectBootstrapLogger({ NODE_ENV: "development", TENVYR_LOG_LEVEL: "verbose" })).toBe(
      "default",
    );
  });

  test("development + normal uses the concise presenter", () => {
    expect(selectBootstrapLogger({ NODE_ENV: "development" })).toBe("dev-normal");
    expect(selectBootstrapLogger({ NODE_ENV: "development", TENVYR_LOG_LEVEL: "normal" })).toBe(
      "dev-normal",
    );
  });
});

describe("TenvyrDevLogger (development terminal UX)", () => {
  test("mode detection: normal default in dev; verbose via env or production", () => {
    expect(detectLogMode({ NODE_ENV: "development" })).toBe("normal");
    expect(detectLogMode({ NODE_ENV: "development", TENVYR_LOG_LEVEL: "verbose" })).toBe("verbose");
    expect(detectLogMode({ NODE_ENV: "development", TENVYR_LOG_LEVEL: "normal" })).toBe("normal");
    expect(detectLogMode({ NODE_ENV: "production" })).toBe("verbose");
  });

  test("normal mode suppresses low-signal Nest bootstrap INFO but keeps everything important", () => {
    // Suppressed: framework bootstrap contexts at INFO level.
    expect(shouldEmitLogLine("RouterExplorer", "log", "normal")).toBe(false);
    expect(shouldEmitLogLine("RoutesResolver", "log", "normal")).toBe(false);
    expect(shouldEmitLogLine("InstanceLoader", "log", "normal")).toBe(false);
    expect(shouldEmitLogLine("NestFactory", "log", "normal")).toBe(false);
    // Preserved: application INFO, ALL warnings, ALL errors.
    expect(shouldEmitLogLine("TeamRunService", "log", "normal")).toBe(true);
    expect(shouldEmitLogLine("anything", "warn", "normal")).toBe(true);
    expect(shouldEmitLogLine("anything", "error", "normal")).toBe(true);
    // Debug/verbose detail is normal-mode noise.
    expect(shouldEmitLogLine("anything", "debug", "normal")).toBe(false);
    expect(shouldEmitLogLine("anything", "verbose", "normal")).toBe(false);
  });

  test("verbose mode preserves every framework line", () => {
    expect(shouldEmitLogLine("RouterExplorer", "log", "verbose")).toBe(true);
    expect(shouldEmitLogLine("RoutesResolver", "log", "verbose")).toBe(true);
    expect(shouldEmitLogLine("InstanceLoader", "log", "verbose")).toBe(true);
    expect(shouldEmitLogLine("anything", "debug", "verbose")).toBe(true);
    expect(shouldEmitLogLine("anything", "verbose", "verbose")).toBe(true);
  });

  test("the logger writes compact lines; suppressed contexts never reach stdout", () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (chunk: string) => {
      written.push(String(chunk));
      return true;
    };
    try {
      const logger = new TenvyrDevLogger(FAKE_ENV());
      logger.log("Mapped {/api/x, GET} route", "RouterExplorer");
      logger.log("Team run started · run_93fe", "TeamRunService");
      logger.warn("Runtime authentication required · Codex", "RuntimeService");
      logger.error("Provider target test failed", "TargetService");
      const output = written.join("");
      expect(output).not.toContain("Mapped {/api/x");
      expect(output).toContain("Team run started · run_93fe");
      expect(output).toContain("WARN");
      expect(output).toContain("Runtime authentication required");
      expect(output).toContain("ERROR");
      expect(output).toContain("Provider target test failed");
      // Compact format: time  service  LEVEL  message (single line each).
      const lines = output.trim().split("\n");
      for (const line of lines) {
        expect(line).toMatch(/^\d{2}:\d{2}:\d{2}\s{2}orchestrator\s{2}(INFO|WARN|ERROR)\s{2,}/);
      }
      // NO_COLOR: no ANSI escape sequences.
      expect(output).not.toMatch(/\u001b\[/);
    } finally {
      process.stdout.write = original;
    }
  });

  test("verbose mode restores framework lines", () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (chunk: string) => {
      written.push(String(chunk));
      return true;
    };
    try {
      const logger = new TenvyrDevLogger(FAKE_ENV({ TENVYR_LOG_LEVEL: "verbose" }));
      logger.log("Mapped {/api/x, GET} route", "RouterExplorer");
      expect(written.join("")).toContain("Mapped {/api/x");
    } finally {
      process.stdout.write = original;
    }
  });
});
