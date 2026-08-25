import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const source = resolve(root, "src/runtime/proc/windows-launch.c");
const outputDirectory = resolve(root, "build/src/runtime/proc");
const output = resolve(outputDirectory, "windows-launch.exe");
mkdirSync(outputDirectory, { recursive: true });
execFileSync(process.env.KEIYAKU_ZIG ?? "zig", [
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
], { cwd: root, stdio: "inherit" });
rmSync(output.replace(/\.exe$/u, ".pdb"), { force: true });
if (!existsSync(output)) throw new Error(`Zig did not produce ${output}`);
