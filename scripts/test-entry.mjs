import { spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/** @type {readonly { name: string, args: readonly string[] }[]} */
const RELEASE_PHASES = [
  { name: "format:check", args: ["run", "format:check"] },
  { name: "build", args: ["run", "build"] },
  { name: "architecture", args: ["run", "test:architecture"] },
  { name: "maintainability", args: ["run", "test:maintainability"] },
  { name: "reachability", args: ["run", "test:reachability"] },
  { name: "test:parallel", args: ["run", "test:parallel"] },
];

/** @type {readonly { name: string, args: readonly string[] }[]} */
const DEV_PHASES = [
  { name: "typecheck", args: ["run", "test:typecheck"] },
  { name: "architecture", args: ["run", "test:architecture"] },
  { name: "local", args: ["run", "test:local"] },
];

/**
 * @param {"test:release" | "test:dev"} mode
 * @param {readonly { name: string, args: readonly string[] }[]} phases
 * @returns {number}
 */
function runTimedPhases(mode, phases) {
  for (const phase of phases) {
    const started = performance.now();
    const result = spawnSync(npm, [...phase.args], { stdio: "inherit" });
    if (result.error) throw result.error;
    const status = result.status ?? 1;
    console.error(`[${mode}] ${phase.name} ${Math.round(performance.now() - started)} status=${status}`);
    if (status !== 0) return status;
  }
  return 0;
}

const supplied = process.argv.slice(2);
const mode = supplied[0] === "--release" ? "release" : supplied[0] === "--dev" ? "dev" : null;

if (mode !== null) {
  const remainder = supplied.slice(1);
  if (remainder.length > 0) {
    console.error(
      mode === "dev"
        ? "test:dev does not accept focused file arguments; use npm test -- <files> or npm run test:focused."
        : "test:release does not accept focused file arguments; use npm test -- <files> or npm run test:focused.",
    );
    process.exit(1);
  }
  const status =
    mode === "release" ? runTimedPhases("test:release", RELEASE_PHASES) : runTimedPhases("test:dev", DEV_PHASES);
  process.exit(status);
}

if (supplied.length === 0) {
  process.exit(runTimedPhases("test:release", RELEASE_PHASES));
}

const argumentsForFocusedRun = supplied.map((argument) =>
  argument === "--runInBand" ? "--test-concurrency=1" : argument,
);
const result = spawnSync(process.execPath, ["scripts/run-tests.mjs", ...argumentsForFocusedRun], {
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
