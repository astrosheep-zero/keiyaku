import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestGitRepository {
  readonly path: string;
  readonly run: (args: readonly string[], input?: string | Uint8Array) => string;
}

export function makeGitRepository(): TestGitRepository {
  const path = mkdtempSync(join(tmpdir(), "keiyaku-v4-"));
  execFileSync("git", ["init", "--quiet", path]);
  const run = (args: readonly string[], input?: string | Uint8Array): string =>
    execFileSync("git", ["-C", path, ...args], { input, encoding: "utf8" }).toString();
  return { path, run };
}

export function cloneGitRepository(source: TestGitRepository): TestGitRepository {
  const path = mkdtempSync(join(tmpdir(), "keiyaku-v4-clone-"));
  execFileSync("git", ["clone", "--quiet", source.path, path]);
  execFileSync("git", ["-C", path, "fetch", "--quiet", "origin", "refs/heads/keiyaku-state:refs/heads/keiyaku-state"]);
  const run = (args: readonly string[], input?: string | Uint8Array): string =>
    execFileSync("git", ["-C", path, ...args], { input, encoding: "utf8" }).toString();
  return { path, run };
}

export function gitRepositoryPath(): string {
  return mkdtempSync(join(tmpdir(), "keiyaku-v4-"));
}
