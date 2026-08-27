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

const suiteOption = options.findIndex((option) => option === "--suite" || option.startsWith("--suite="));
const suite =
  suiteOption === -1
    ? undefined
    : options[suiteOption].startsWith("--suite=")
      ? options[suiteOption].slice("--suite=".length)
      : options[suiteOption + 1];
if (suiteOption !== -1 && !Object.hasOwn(TEST_MANIFESTS, suite)) {
  console.error(`Unknown test suite: ${suite ?? "(missing value)"}. Expected local or integration.`);
  process.exit(1);
}
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
        (_, index) => index !== suiteOption && !(options[suiteOption] === "--suite" && index === suiteOption + 1),
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
