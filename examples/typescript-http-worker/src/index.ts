import {
  createAgentWeaveWorker,
  defineAgent,
  type AgentWeaveWorker,
} from "@agentweave/worker";

type EchoInput = {
  message: string;
};

type Environment = Record<string, string | undefined>;

const echoAgent = defineAgent({
  name: "echo-analyzer",
  version: "1.0.0",
  inputParser: {
    parse(value: unknown): EchoInput {
      if (
        value === null ||
        typeof value !== "object" ||
        typeof (value as Record<string, unknown>).message !== "string"
      ) {
        throw new Error("message must be a string");
      }
      return { message: (value as { message: string }).message };
    },
  },
  outputParser(value: unknown) {
    if (
      value === null ||
      typeof value !== "object" ||
      typeof (value as Record<string, unknown>).echo !== "string"
    ) {
      throw new Error("echo output must be a string");
    }
    return value as { echo: string; characters: number };
  },
  async execute(context, input) {
    if (!input.message.trim()) {
      context.fail({
        code: "EMPTY_MESSAGE",
        message: "The message must not be empty",
        retryable: false,
      });
    }
    await abortableDelay(10, context.signal);
    context.logger.info("Echo analysis completed");
    return context.success({
      output: {
        echo: input.message,
        characters: [...input.message].length,
      },
      metadata: {
        example: true,
      },
    });
  },
});

export function createExampleWorker(
  environment: Environment = process.env,
): AgentWeaveWorker {
  const keyId = required(environment, "AGENTWEAVE_CALLBACK_KEY_ID");
  return createAgentWeaveWorker({
    agent: echoAgent,
    authentication: {
      bearerToken: required(environment, "AGENTWEAVE_WORKER_TOKEN"),
    },
    callbackAuthentication: {
      keys: {
        [keyId]: required(environment, "AGENTWEAVE_CALLBACK_SECRET"),
      },
    },
    callbackPolicy: {
      allowedOrigins: [required(environment, "AGENTWEAVE_CALLBACK_ORIGIN")],
      allowInsecureHttp: environment.AGENTWEAVE_ALLOW_INSECURE_HTTP === "true",
    },
  });
}

async function main(): Promise<void> {
  const worker = createExampleWorker();
  const address = await worker.start({
    host: process.env.AGENTWEAVE_WORKER_HOST ?? "0.0.0.0",
    port: Number(process.env.AGENTWEAVE_WORKER_PORT ?? 8080),
  });
  console.log(
    `AgentWeave example Worker listening on ${address.host}:${address.port}`,
  );
  const stop = async () => {
    await worker.stop();
    process.exitCode = 0;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

function required(environment: Environment, name: string): string {
  const value = environment[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("aborted"));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

if (require.main === module) {
  void main().catch((error) => {
    console.error("AgentWeave example Worker failed to start", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    process.exitCode = 1;
  });
}
