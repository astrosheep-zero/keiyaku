import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";

const DEFAULT_TEST_PATTERNS = ["tests/**/*.test.ts", "tests/maintainability.test.js"];

const supplied = process.argv.slice(2);
const valueOptions = new Set([
  "--test-concurrency",
  "--test-name-pattern",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-shard",
  "--test-timeout",
]);
const options = [];
const files = [];

for (let index = 0; index < supplied.length; index += 1) {
  const argument = supplied[index];
  if (!argument.startsWith("--")) {
    files.push(argument);
    continue;
  }
  options.push(argument);
  if (valueOptions.has(argument) && supplied[index + 1] !== undefined) {
    options.push(supplied[index + 1]);
    index += 1;
  }
}

const testFiles = files.length === 0
  ? DEFAULT_TEST_PATTERNS.flatMap((pattern) => globSync(pattern)).sort()
  : files;
if (testFiles.length === 0) {
  console.error("No test files matched the default test patterns.");
  process.exit(1);
}
const reporterOptions = options.some((option) => option === "--test-reporter" || option.startsWith("--test-reporter="))
  ? []
  : ["--test-reporter=dot"];
const result = spawnSync(process.execPath, [
  "--import", "tsx",
  "--test",
  ...reporterOptions,
  ...options,
  ...testFiles,
], { stdio: "inherit" });

if (result.error) throw result.error;
process.exit(result.status ?? 1);
