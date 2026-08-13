import { spawnSync } from "node:child_process";

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
  ? ["tests/**/*.test.ts", "tests/maintainability.test.js"]
  : files;
const result = spawnSync(process.execPath, [
  "--import", "tsx",
  "--test",
  "--test-reporter=dot",
  ...options,
  ...testFiles,
], { stdio: "inherit" });

if (result.error) throw result.error;
process.exit(result.status ?? 1);
