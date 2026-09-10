import spawn from "cross-spawn";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const supplied = process.argv.slice(2);
const mode = supplied[0] === "--dev" ? "dev" : "release";
const explicitMode = supplied[0] === "--dev" || supplied[0] === "--release";

/** @param {string} command @param {string[]} args @param {string} name @param {NodeJS.ProcessEnv} [environment] */
function run(command, args, name, environment = process.env) {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", env: environment });
    child.once("error", (error) => {
      console.error(error);
      resolve(1);
    });
    child.once("close", (code) => {
      const status = code ?? 1;
      console.error(`[test:${mode}] ${name} ${Math.round(performance.now() - started)} status=${status}`);
      resolve(status);
    });
  });
}

if (explicitMode && supplied.length > 1) {
  console.error(`test:${mode} does not accept focused arguments; use npm test -- <files>.`);
  process.exitCode = 1;
} else if (supplied.length > 0 && !explicitMode) {
  process.exitCode = await run(
    process.execPath,
    [
      "scripts/run-tests.mjs",
      ...supplied.map((argument) => (argument === "--runInBand" ? "--test-concurrency=1" : argument)),
    ],
    "focused",
  );
} else {
  // Cache bytecode, never test results. Every invocation starts with a fresh cache;
  // coverage runs keep V8's precise, uncached function instrumentation.
  const cache =
    process.env.NODE_V8_COVERAGE || process.env.NODE_DISABLE_COMPILE_CACHE === "1"
      ? undefined
      : mkdtempSync(join(tmpdir(), "keiyaku-test-bytecode-"));
  const environment = cache === undefined ? process.env : { ...process.env, NODE_COMPILE_CACHE: cache };
  try {
    // These checks read source independently. Await every child before running tests
    // or returning a failure, so an unsuccessful gate never leaves work detached.
    // Build is the heaviest release preparation step. Running it beside four
    // other CPU-heavy Node/TypeScript checks made the build several times slower
    // on small CI runners. Give it the machine first, then overlap only the
    // independent static/transpile checks.
    const buildStatus = mode === "release" ? await run("npm", ["run", "build"], "build", environment) : 0;
    const preparation =
      mode === "dev"
        ? ["test:typecheck", "test:architecture"]
        : ["format:check", "test:architecture", "test:maintainability", "test:compile"];
    const statuses =
      buildStatus === 0
        ? await Promise.all(preparation.map((name) => run("npm", ["run", name], name, environment)))
        : [buildStatus];
    process.exitCode = buildStatus || statuses.find((status) => status !== 0) || 0;
    if (process.exitCode === 0) {
      // Reachability may inspect generated package exports, so it follows build.
      const checks = mode === "dev" ? ["test:local"] : ["test:reachability"];
      const running = checks.map((name) => run("npm", ["run", name], name, environment));
      if (mode === "release")
        running.push(
          run(process.execPath, ["scripts/run-tests.mjs", "--compiled", "--test-concurrency=8"], "tests", environment),
        );
      const results = await Promise.all(running);
      process.exitCode = results.find((status) => status !== 0) ?? 0;
    }
  } finally {
    if (cache !== undefined) rmSync(cache, { recursive: true, force: true });
  }
}
