module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/integration/**/*.spec.ts"],
  testTimeout: 30_000,
};
