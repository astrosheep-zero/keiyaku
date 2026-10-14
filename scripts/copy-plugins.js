import { cpSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

// The built marketplace mirrors the source plugin layout: the four host
// directories and the two marketplace manifests. The shared skills have one
// source at the repository root and are copied into build/skills and each
// host that packages its own copy.
const HOST_DIRECTORIES = ["claude", "codex", "opencode", "pi"];
const MARKETPLACE_MANIFESTS = [".claude-plugin", ".agents"];
const SKILL_HOSTS = ["claude", "codex", "opencode"];

const root = resolve(import.meta.dirname, "..");
const plugins = resolve(root, "plugins");
const skills = resolve(root, "skills");
const build = resolve(root, "build");
const target = resolve(build, "plugins");

rmSync(target, { recursive: true, force: true });
rmSync(resolve(build, "skills"), { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const directory of HOST_DIRECTORIES) {
  cpSync(resolve(plugins, directory), resolve(target, directory), { recursive: true });
}
for (const manifest of MARKETPLACE_MANIFESTS) {
  cpSync(resolve(plugins, manifest), resolve(target, manifest), { recursive: true });
}
cpSync(skills, resolve(build, "skills"), { recursive: true });
for (const host of SKILL_HOSTS) {
  cpSync(skills, resolve(target, host, "skills"), { recursive: true });
}
