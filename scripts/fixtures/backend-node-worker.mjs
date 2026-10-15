import { createRequire } from "node:module";
const require = createRequire(
  new URL(
    "../../examples/typescript-http-worker/package.json",
    import.meta.url,
  ),
);
const { createTenvyrWorker, defineAgent } = require("@tenvyr/worker");
const worker = createTenvyrWorker({
  agent: defineAgent({
    name: "remote-echo-agent",
    inputParser: (value) => value,
    outputParser: (value) => value,
    execute: async (context, input) =>
      context.success({
        output:
          input.mode === "safe-boundaries"
            ? {
                maximum: Number.MAX_SAFE_INTEGER,
                minimum: Number.MIN_SAFE_INTEGER,
              }
            : input.mode === "unsafe-output"
              ? { unsafe: Number.MAX_SAFE_INTEGER + 2 }
              : { echo: input.message },
      }),
  }),
  authentication: { bearerToken: process.env.TENVYR_WORKER_TOKEN },
  callbackAuthentication: {
    keys: {
      [process.env.TENVYR_CALLBACK_KEY_ID]: process.env.TENVYR_CALLBACK_SECRET,
    },
  },
  callbackPolicy: {
    allowedOrigins: [process.env.TENVYR_CALLBACK_ORIGIN],
    allowInsecureHttp: true,
  },
});
const address = await worker.start({ host: "127.0.0.1", port: 0 });
console.log(JSON.stringify({ event: "tenvyr.worker.ready", ...address }));
process.once("SIGTERM", async () => {
  await worker.stop();
  console.log(JSON.stringify({ event: "tenvyr.worker.stopped" }));
});
