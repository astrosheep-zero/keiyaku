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

if (process.env.ZIG_GLOBAL_CACHE_DIR === undefined) mkdirSync(zigGlobalCacheDirectory, { recursive: true });
if (process.env.ZIG_LOCAL_CACHE_DIR === undefined) mkdirSync(zigLocalCacheDirectory, { recursive: true });

mkdirSync(outputDirectory, { recursive: true });
execFileSync(
  process.env.KEIYAKU_ZIG ?? "zig",
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
