import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { createExampleWorker } from "../src";

describe("TypeScript HTTP Worker example", () => {
  let callbackServer: Server;
  let callbackOrigin: string;

  beforeEach(async () => {
    callbackServer = createServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      callbackServer.once("error", reject);
      callbackServer.listen(0, "127.0.0.1", () => resolve());
    });
    callbackOrigin = `http://127.0.0.1:${(callbackServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => callbackServer.close(() => resolve()));
  });

  it("starts without model credentials or internet access and exposes health", async () => {
    const worker = createExampleWorker({
      AGENTWEAVE_WORKER_TOKEN: "example-token",
      AGENTWEAVE_CALLBACK_KEY_ID: "example-v1",
      AGENTWEAVE_CALLBACK_SECRET: "example-secret",
      AGENTWEAVE_CALLBACK_ORIGIN: callbackOrigin,
      AGENTWEAVE_ALLOW_INSECURE_HTTP: "true",
    });
    const address = await worker.start({ host: "127.0.0.1", port: 0 });

    expect(
      (await fetch(`http://${address.host}:${address.port}/health/live`))
        .status,
    ).toBe(200);
    expect(worker.agentName).toBe("echo-analyzer");

    await worker.stop();
  });
});
