import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
if (process.platform !== "win32") process.exit(0);

const source = resolve(root, "src/runtime/proc/windows-launch.c");
const outputDirectory = resolve(root, "build/src/runtime/proc");
const output = resolve(outputDirectory, "windows-launch.exe");
const temporary = mkdtempSync(join(tmpdir(), "keiyaku-windows-launch-"));
mkdirSync(outputDirectory, { recursive: true });
try {
  execFileSync("cl.exe", [
    "/nologo",
    "/O2",
    "/W4",
    "/MT",
    "/DWIN32_LEAN_AND_MEAN",
    "/DUNICODE",
    "/D_UNICODE",
    `/Fe${output}`,
    `/Fo${join(temporary, "windows-launch.obj")}`,
    source,
    "/link",
    "/SUBSYSTEM:WINDOWS",
    "/MACHINE:X64",
  ], { cwd: root, stdio: "inherit" });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
if (!existsSync(output)) throw new Error(`MSVC did not produce ${output}`);
