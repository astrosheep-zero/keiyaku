import { spawnSync } from "node:child_process";
import { existsSync, globSync } from "node:fs";
import { TEST_MANIFESTS } from "./test-manifests.mjs";

const DEFAULT_TEST_PATTERNS = ["tests/**/*.test.ts", "tests/maintainability.test.js"];

const supplied = process.argv.slice(2);
const valueOptions = new Set([
  "--test-concurrency",
  "--test-name-pattern",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-shard",
  "--test-timeout",
  "--suite",
]);
/** @param {string[]} suppliedArguments @returns {{ options: string[], files: string[] }} */
function parseArguments(suppliedArguments) {
  /** @type {string[]} */
  const options = [];
  /** @type {string[]} */
  const files = [];
  for (let index = 0; index < suppliedArguments.length; index += 1) {
    const argument = suppliedArguments[index];
    if (argument === undefined) continue;
    if (!argument.startsWith("--")) {
      files.push(argument);
      continue;
    }
    options.push(argument);
    const value = suppliedArguments[index + 1];
    if (valueOptions.has(argument) && value !== undefined) {
      options.push(value);
      index += 1;
    }
  }
  return { options, files };
}

const { options, files } = parseArguments(supplied);

const suiteOption = options.findIndex((option) => option === "--suite" || option.startsWith("--suite="));
const suiteFlag = options[suiteOption];
const rawSuite =
  suiteOption === -1
    ? undefined
    : suiteFlag?.startsWith("--suite=")
      ? suiteFlag.slice("--suite=".length)
      : options[suiteOption + 1];
/** @param {string | undefined} value */
function isTestSuite(value) {
  return value === "local" || value === "integration";
}
if (suiteOption !== -1 && !isTestSuite(rawSuite)) {
  console.error(`Unknown test suite: ${rawSuite ?? "(missing value)"}. Expected local or integration.`);
  process.exit(1);
}
const suite = isTestSuite(rawSuite) ? rawSuite : undefined;
const testFiles = suite
  ? [...TEST_MANIFESTS[suite]]
  : files.length === 0
    ? DEFAULT_TEST_PATTERNS.flatMap((pattern) => globSync(pattern)).sort()
    : files;
if (testFiles.length === 0) {
  console.error("No test files matched the default test patterns.");
  process.exit(1);
}
const missingTestFiles = suite ? testFiles.filter((file) => !existsSync(file)) : [];
if (missingTestFiles.length > 0) {
  console.error(`Test manifest contains missing file(s): ${missingTestFiles.join(", ")}`);
  process.exit(1);
}
const testOptions =
  suiteOption === -1
    ? options
    : options.filter(
        (_, index) => index !== suiteOption && !(suiteFlag === "--suite" && index === suiteOption + 1),
      );
const reporterOptions = testOptions.some(
  (option) => option === "--test-reporter" || option.startsWith("--test-reporter="),
)
  ? []
  : ["--test-reporter=dot"];
const environment = { ...process.env };
delete environment.AKUMA_REQUESTS;
const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...reporterOptions, ...testOptions, ...testFiles],
  { stdio: "inherit", env: environment },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
