const base = require("./jest.config");

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  ...base,
  testRegex: "agent-adapters/http-java-worker\\.integration\\.spec\\.ts$",
};
