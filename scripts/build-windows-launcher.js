import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const source = resolve(root, "src/runtime/proc/windows-launch.c");
const outputDirectory = resolve(root, "build/src/runtime/proc");
const output = resolve(outputDirectory, "windows-launch.exe");
const zigCacheRoot = resolve(tmpdir(), "keiyaku-zig-cache");
const zigGlobalCacheDirectory = process.env.ZIG_GLOBAL_CACHE_DIR ?? resolve(zigCacheRoot, "global");
const zigLocalCacheDirectory = process.env.ZIG_LOCAL_CACHE_DIR ?? resolve(zigCacheRoot, "local");
const zigExecutable = process.env.KEIYAKU_ZIG ?? "zig";
const minimumZigVersion = [0, 14, 1];
const minimumZigVersionText = minimumZigVersion.join(".");

/** @param {unknown} error */
function boundedCause(error) {
  const message = error instanceof Error ? error.message : String(error);
  const stderr =
    typeof error === "object" && error !== null && "stderr" in error && error.stderr !== undefined
      ? String(error.stderr)
      : "";
  const detail = stderr !== "" && !message.includes(stderr) ? `${message}: ${stderr}` : message;
  return detail.replace(/\s+/gu, " ").trim().slice(0, 512);
}

/** @param {string} reportedVersion */
function supportsWindowsLauncher(reportedVersion) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.+-]+)?$/u.exec(reportedVersion);
  if (match === null) return false;

  for (const [index, minimum] of minimumZigVersion.entries()) {
    const reported = Number(match[index + 1]);
    if (reported !== minimum) return reported > minimum;
  }
  return true;
}

function zigPreflight() {
  try {
    const reportedVersion = execFileSync(zigExecutable, ["version"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
    if (!supportsWindowsLauncher(reportedVersion)) {
      throw new Error(`reported version ${reportedVersion || "(empty)"}; require at least ${minimumZigVersionText}`);
    }
  } catch (error) {
    return boundedCause(error);
  }
  return undefined;
}

const preflightFailure = zigPreflight();
if (preflightFailure !== undefined) {
  const diagnostic =
    `Zig ${minimumZigVersionText} or later is required for the Windows launcher; ` +
    `install it on PATH or set KEIYAKU_ZIG to an executable. ` +
    `Cause: ${preflightFailure}`;
  if (process.platform === "win32") throw new Error(diagnostic);
  console.warn(`${diagnostic} Skipping Windows launcher on non-Windows host.`);
  process.exit(0);
}

if (process.env.ZIG_GLOBAL_CACHE_DIR === undefined) mkdirSync(zigGlobalCacheDirectory, { recursive: true });
if (process.env.ZIG_LOCAL_CACHE_DIR === undefined) mkdirSync(zigLocalCacheDirectory, { recursive: true });

mkdirSync(outputDirectory, { recursive: true });
execFileSync(
  zigExecutable,
  [
    "cc",
    "-target",
    "x86_64-windows-gnu",
    "-O2",
    "-g0",
    "-static",
    "-DWIN32_LEAN_AND_MEAN",
    "-DUNICODE",
    "-D_UNICODE",
    "-municode",
    "-Wl,/subsystem:windows",
    source,
    "-o",
    output,
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      ZIG_GLOBAL_CACHE_DIR: zigGlobalCacheDirectory,
      ZIG_LOCAL_CACHE_DIR: zigLocalCacheDirectory,
    },
    stdio: "inherit",
  },
);
rmSync(output.replace(/\.exe$/u, ".pdb"), { force: true });
if (!existsSync(output)) throw new Error(`Zig did not produce ${output}`);
