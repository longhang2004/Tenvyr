/**
 * P2 shutdown-lifecycle closure: disposable Orchestrator boot used ONLY
 * by signal-lifecycle.spec.ts (guarded by SIGNAL_WORKER=1). Boots the
 * REAL AppModule exactly like main.ts (including enableShutdownHooks),
 * creates a live OpenCode auth flow against a fake management server,
 * and writes a READY marker with the fake server's PID. The parent spec
 * SIGTERMs this process and proves OnModuleDestroy -> closeAll terminates
 * the management child.
 */
import { NestFactory } from "@nestjs/core";
import { readFileSync, writeFileSync } from "node:fs";
import { AppModule } from "./app.module";
import { ProviderDiscoveryService } from "./services/provider-discovery.service";

async function run(): Promise<void> {
  if (process.env.SIGNAL_WORKER !== "1") {
    return;
  }
  const connectionId = process.env.SIGNAL_CONNECTION;
  const fixturePath = process.env.SIGNAL_FIXTURE;
  const markerPath = process.env.SIGNAL_MARKER;
  if (!connectionId || !fixturePath || !markerPath) {
    throw new Error("SIGNAL_WORKER requires SIGNAL_CONNECTION/SIGNAL_FIXTURE/SIGNAL_MARKER");
  }
  const port = Number(process.env.ORCHESTRATOR_PORT) || 3199;
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableShutdownHooks();
  await app.listen(port);
  const discovery = app.get(ProviderDiscoveryService);
  const begun = await discovery.beginAuthFlow({
    connectionId,
    providerId: "openai",
    methodIndex: 0,
  });
  const pid = Number(readFileSync(`${fixturePath}.pid`, "utf8"));
  writeFileSync(markerPath, `READY ${pid} ${begun.authFlowId}\n`);
  // The HTTP server keeps this process alive until SIGTERM; Nest's
  // shutdown hooks then run onModuleDestroy (closeAll) and close the app.
  console.log(`SIGNAL-WORKER-READY pid=${pid} flow=${begun.authFlowId}`);
}

void run();
