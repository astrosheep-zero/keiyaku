import { spawnSync } from "node:child_process";
import { existsSync, globSync, statSync } from "node:fs";
import { TEST_MANIFESTS } from "./test-manifests.mjs";

const DEFAULT_TEST_PATTERNS = ["tests/**/*.test.ts", "tests/maintainability.test.js"];

const compiled = process.argv.includes("--compiled");
const supplied = process.argv.slice(2).filter((argument) => argument !== "--compiled");
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
const missingTestFiles = testFiles.filter((file) => !existsSync(file) && globSync(file).length === 0);
if (missingTestFiles.length > 0) {
  console.error(`Test selection contains missing file(s): ${missingTestFiles.join(", ")}`);
  process.exit(1);
}
const testOptions =
  suiteOption === -1
    ? options
    : options.filter((_, index) => index !== suiteOption && !(suiteFlag === "--suite" && index === suiteOption + 1));
const reporterOptions = testOptions.some(
  (option) => option === "--test-reporter" || option.startsWith("--test-reporter="),
)
  ? []
  : ["--test-reporter=dot"];
const selectedFiles = [...new Set(testFiles.flatMap((file) => (existsSync(file) ? [file] : globSync(file))))];
const runtimeFiles = compiled
  ? selectedFiles.map((file) => ".test-build/" + file.replace(/\.ts$/u, ".js"))
  : selectedFiles;
if (compiled && runtimeFiles.some((file) => !existsSync(file))) {
  console.error("Compiled test files are missing; run npm run test:compile first.");
  process.exit(1);
}
const loader = compiled ? ["--enable-source-maps"] : ["--import", "tsx"];
const environment = { ...process.env };
delete environment.AKUMA_REQUESTS;
// This is a new runner, including when invoked by a test of the runner itself.
delete environment.NODE_TEST_CONTEXT;
const started = performance.now();
// The CLI sorts its glob results. Use the public files API only for the ordinary
// compiled sweep so larger files can start first, without changing native focused
// flags, reporters, filtering, or sharding. Every file still has its own process.
if (compiled && files.length === 0 && testOptions.every((option) => /^--test-concurrency=\d+$/u.test(option))) {
  const { run } = await import("node:test");
  const { spec } = await import("node:test/reporters");
  const ordered = testFiles.map((file) => ({ file, size: statSync(file).size }));
  ordered.sort((left, right) => right.size - left.size || left.file.localeCompare(right.file));
  delete process.env.AKUMA_REQUESTS;
  delete process.env.NODE_TEST_CONTEXT;
  const stream = run({
    files: ordered.map(({ file }) => ".test-build/" + file.replace(/\.ts$/u, ".js")),
    concurrency: Number(testOptions.at(-1)?.split("=")[1] ?? 8),
    execArgv: loader,
  });
  stream.on("test:fail", () => {
    process.exitCode = 1;
  });
  stream.compose(spec).pipe(process.stdout);
} else {
  const result = spawnSync(
    process.execPath,
    [...loader, "--test", ...reporterOptions, ...testOptions, ...runtimeFiles],
    {
      stdio: "inherit",
      env: environment,
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
if (suite !== undefined) {
  process.once("beforeExit", () =>
    console.error(
      `[run-tests] suite=${suite} files=${testFiles.length} elapsed=${Math.round(performance.now() - started)} status=${process.exitCode ?? 0}`,
    ),
  );
}
