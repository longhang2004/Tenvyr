/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: "src",
  testRegex:
    "^(?!.*http-python-worker\\.integration\\.spec\\.ts$).*\\.spec\\.ts$",
  moduleFileExtensions: ["ts", "js", "json"],
};
