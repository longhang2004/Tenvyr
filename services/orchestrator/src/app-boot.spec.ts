import { Test } from "@nestjs/testing";
import { AppModule } from "./app.module";

/**
 * P2 closure round 2 regression: the FULL AppModule must compile — every
 * Nest provider resolves. The round-2 DI bug (ModelDiscoveryService not
 * registered) crashed the REAL orchestrator boot (docker-showcase
 * "orchestrator: fetch failed") while every unit spec still passed
 * (specs construct services manually). Postgres-gated because the module
 * boots the real DATA_SOURCE.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;

describeWithPostgres("AppModule boot (DI wiring regression)", () => {
  it("compiles the full application module — every provider resolves", async () => {
    const url = new URL(TEST_DATABASE_URL!);
    const previous = {
      POSTGRES_HOST: process.env.POSTGRES_HOST,
      POSTGRES_PORT: process.env.POSTGRES_PORT,
      POSTGRES_USER: process.env.POSTGRES_USER,
      POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD,
      POSTGRES_DB: process.env.POSTGRES_DB,
    };
    process.env.POSTGRES_HOST = url.hostname;
    process.env.POSTGRES_PORT = url.port;
    process.env.POSTGRES_USER = decodeURIComponent(url.username);
    process.env.POSTGRES_PASSWORD = decodeURIComponent(url.password);
    process.env.POSTGRES_DB = decodeURIComponent(
      url.pathname.replace(/^\/+/, "").replace(/\/+$/, ""),
    );
    try {
      const module = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      await module.close();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
