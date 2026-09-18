import spawn from "cross-spawn";
import { runReleasePlan } from "./test-plan.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const supplied = process.argv.slice(2);
const mode = supplied[0] === "--dev" ? "dev" : "release";
const explicitMode = supplied[0] === "--dev" || supplied[0] === "--release";

/** @param {string} command @param {string[]} args @param {string} name @param {NodeJS.ProcessEnv} [environment] @returns {Promise<number>} */
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
    if (mode === "release") {
      process.exitCode = await runReleasePlan((name) =>
        name === "tests"
          ? run(process.execPath, ["scripts/run-tests.mjs", "--compiled", "--test-concurrency=10"], name, environment)
          : run("npm", ["run", name], name, environment),
      );
    } else {
      const statuses = await Promise.all(
        ["test:typecheck", "test:architecture"].map((name) => run("npm", ["run", name], name, environment)),
      );
      process.exitCode = statuses.find((status) => status !== 0) ?? 0;
      if (process.exitCode === 0) {
        process.exitCode = await run("npm", ["run", "test:local"], "test:local", environment);
      }
    }
  } finally {
    if (cache !== undefined) rmSync(cache, { recursive: true, force: true });
  }
}
