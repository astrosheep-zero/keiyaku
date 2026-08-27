import { spawnSync } from "node:child_process";

const argumentsForFocusedRun = process.argv
  .slice(2)
  .map((argument) => (argument === "--runInBand" ? "--test-concurrency=1" : argument));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result =
  argumentsForFocusedRun.length === 0
    ? spawnSync(npm, ["run", "test:all"], { stdio: "inherit" })
    : spawnSync(process.execPath, ["scripts/run-tests.mjs", ...argumentsForFocusedRun], { stdio: "inherit" });

if (result.error) throw result.error;
process.exit(result.status ?? 1);
