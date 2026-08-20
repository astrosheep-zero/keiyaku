import { cpSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = resolve(root, "build/integrations");
rmSync(target, { recursive: true, force: true });
mkdirSync(resolve(root, "build"), { recursive: true });
cpSync(resolve(root, "integrations"), target, { recursive: true });
const launchName = "windows-launch.exe";
const launchDir = resolve(root, "build/src/runtime/proc");
mkdirSync(launchDir, { recursive: true });
cpSync(resolve(root, "src/runtime/proc", launchName), resolve(launchDir, launchName));
