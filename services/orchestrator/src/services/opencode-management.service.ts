/**
 * P2 closure (round 2): bounded connection-scoped OpenCode management
 * session.
 *
 * Starts the EXACT selected Runtime Connection's executable with the
 * official `serve` subcommand on 127.0.0.1 + an ephemeral port + a
 * cryptographically random OPENCODE_SERVER_PASSWORD. No shell, fixed
 * argv, strict startup/API timeouts, bounded responses, deterministic
 * teardown, password never logged or surfaced.
 *
 * The management adapter is for runtime/provider MANAGEMENT ONLY — never
 * an inference proxy, never a credential vault. The runtime's auth.json
 * is never read.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import {
  OPENCODE_SERVER_BOUNDS,
  OpenCodeServerError,
  parseOpenCodeAuthAuthorization,
  parseOpenCodeAuthMethods,
  parseOpenCodeProviderList,
  type OpenCodeAuthMethodsV1,
  type OpenCodeAuthAuthorizationV1,
  type OpenCodeProviderListV1,
} from "../executors/opencode-server";

const SERVER_USERNAME = "opencode";
const OUTPUT_RING_BYTES = 16 * 1024;

export type OpenCodeManagementProfile = {
  /** Absolute path to the connection's fixed executable. */
  command: string;
  /** Fixed working directory (the revision's cli.cwd). */
  cwd?: string;
  /** Approved environment (resolved env allowlist/secret references). */
  env?: Record<string, string>;
};

export class OpenCodeManagementSession {
  private readonly child: ChildProcess;
  private readonly port: number;
  private readonly password: string;
  private readonly baseUrl: string;
  private closed = false;
  private readonly stderrTail: string[] = [];

  private constructor(
    child: ChildProcess,
    port: number,
    password: string,
  ) {
    this.child = child;
    this.port = port;
    this.password = password;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  /** Pick a free ephemeral port (bounded retries). */
  private static async pickPort(): Promise<number> {
    for (let attempt = 0; attempt < OPENCODE_SERVER_BOUNDS.portRetries; attempt++) {
      try {
        const port = await new Promise<number>((resolve, reject) => {
          const server = createServer();
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") {
              server.close();
              reject(new Error("no port"));
              return;
            }
            const bound = address.port;
            server.close(() => resolve(bound));
          });
        });
        return port;
      } catch {
        // retry
      }
    }
    throw new OpenCodeServerError("start-failed", "no ephemeral port available");
  }

  /** Start the management server for the connection's exact executable.
   *  Fails (and terminates the child) if READY is not reached within the
   *  startup bound. */
  static async start(profile: OpenCodeManagementProfile): Promise<OpenCodeManagementSession> {
    const port = await OpenCodeManagementSession.pickPort();
    const password = randomBytes(24).toString("base64url");
    // Fixed argv: official `serve` subcommand + documented flags. The
    // password travels ONLY via environment, never argv — it can never
    // appear in process listings or logs.
    const argv = ["serve", "--port", String(port), "--hostname", "127.0.0.1"];
    const child = spawn(profile.command, argv, {
      cwd: profile.cwd,
      env: {
        ...process.env,
        ...(profile.env ?? {}),
        OPENCODE_SERVER_PASSWORD: password,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const session = new OpenCodeManagementSession(child, port, password);
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      session.stderrTail.push(text);
      while (session.stderrTail.join("").length > OUTPUT_RING_BYTES) {
        session.stderrTail.shift();
      }
    });
    child.stdout?.resume();
    try {
      await session.waitReady();
    } catch (error) {
      await session.close();
      throw error;
    }
    return session;
  }

  /** Poll GET /provider until the server answers (bounded). The password
   *  never leaves this process except as the HTTP basic-auth header. */
  private async waitReady(): Promise<void> {
    const deadline = Date.now() + OPENCODE_SERVER_BOUNDS.startTimeoutMs;
    let lastError: OpenCodeServerError | null = null;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) {
        throw new OpenCodeServerError(
          "start-failed",
          `management server exited early (code ${this.child.exitCode})`,
        );
      }
      try {
        await this.providers();
        return;
      } catch (error) {
        lastError =
          error instanceof OpenCodeServerError
            ? error
            : new OpenCodeServerError("unreachable", String(error));
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    const tail = this.stderrTail.join("").slice(-512);
    throw new OpenCodeServerError(
      "start-timeout",
      `management server did not become ready within ${
        OPENCODE_SERVER_BOUNDS.startTimeoutMs
      }ms${tail ? ` (stderr tail: ${tail})` : ""}`,
    );
  }

  private async call(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<unknown> {
    if (this.closed) {
      throw new OpenCodeServerError("unreachable", "management session is closed");
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      OPENCODE_SERVER_BOUNDS.apiTimeoutMs,
    );
    const basic = Buffer.from(
      `${SERVER_USERNAME}:${this.password}`,
      "utf8",
    ).toString("base64");
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Basic ${basic}`,
          ...(init.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
        redirect: "error",
      });
      if (response.status === 401 || response.status === 403) {
        throw new OpenCodeServerError("auth-failed", "management server rejected credentials");
      }
      if (!response.ok) {
        throw new OpenCodeServerError(
          "unreachable",
          `management server answered ${response.status}`,
        );
      }
      const text = await response.text();
      if (text.length > OPENCODE_SERVER_BOUNDS.responseBytes) {
        throw new OpenCodeServerError("oversized", "management response exceeded the byte bound");
      }
      if (text.length === 0) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new OpenCodeServerError("malformed", "management response was not JSON");
      }
    } catch (error) {
      if (error instanceof OpenCodeServerError) throw error;
      if (controller.signal.aborted) {
        throw new OpenCodeServerError("api-timeout", "management API call timed out");
      }
      throw new OpenCodeServerError("unreachable", String(error));
    } finally {
      clearTimeout(timer);
    }
  }

  async providers(): Promise<OpenCodeProviderListV1> {
    return parseOpenCodeProviderList(await this.call("/provider"));
  }

  async authMethods(): Promise<OpenCodeAuthMethodsV1> {
    return parseOpenCodeAuthMethods(await this.call("/provider/auth"));
  }

  async authorize(providerId: string): Promise<OpenCodeAuthAuthorizationV1> {
    const raw = await this.call(`/provider/${encodeURIComponent(providerId)}/oauth/authorize`, {
      method: "POST",
      body: {},
    });
    return parseOpenCodeAuthAuthorization(raw);
  }

  async completeOauth(providerId: string): Promise<boolean> {
    const raw = await this.call(`/provider/${encodeURIComponent(providerId)}/oauth/callback`, {
      method: "POST",
      body: {},
    });
    return raw === true;
  }

  /** Deterministic teardown: SIGTERM, bounded grace, SIGKILL. Safe to call
   *  multiple times. Every wait is RACED against a bound so close() can
   *  never hang on an already-exited child. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.child.exitCode === null) {
      const exited = new Promise<void>((resolve) =>
        this.child.once("exit", () => resolve()),
      );
      this.child.kill("SIGTERM");
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
      if (this.child.exitCode === null) {
        this.child.kill("SIGKILL");
        await Promise.race([
          exited,
          new Promise<void>((resolve) => setTimeout(resolve, 1000)),
        ]);
      }
    }
    this.stderrTail.length = 0;
  }
}

/** Run one bounded management-server interaction with guaranteed
 *  teardown. */
export async function withOpenCodeSession<T>(
  profile: OpenCodeManagementProfile,
  fn: (session: OpenCodeManagementSession) => Promise<T>,
): Promise<T> {
  const session = await OpenCodeManagementSession.start(profile);
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}
