import { databaseOptions } from "./data-source";

describe("databaseOptions", () => {
  it("never enables synchronize in production", () => {
    const options = databaseOptions({
      NODE_ENV: "production",
      TENVYR_DB_SYNCHRONIZE: "true",
    });
    expect(options.synchronize).toBe(false);
    expect(options.migrationsRun).toBe(true);
  });

  it("requires an explicit flag for disposable development synchronization", () => {
    expect(databaseOptions({ NODE_ENV: "development" }).synchronize).toBe(
      false,
    );
    const options = databaseOptions({
      NODE_ENV: "development",
      TENVYR_DB_SYNCHRONIZE: "true",
    });
    expect(options.synchronize).toBe(true);
    expect(options.migrationsRun).toBe(false);
  });

  it("uses the supplied environment for the database name", () => {
    expect(databaseOptions({ POSTGRES_DB: "isolated-test-db" }).database).toBe(
      "isolated-test-db",
    );
  });
});
