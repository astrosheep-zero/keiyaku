import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContractId } from "../../src/core/facts/types.js";
import { observeContractAt } from "../../src/git/observe.js";
import { withGitDecodeChannel } from "../../src/git/read-observation.js";
import type { GitRepository } from "../../src/git/repository.js";

export interface TestGitRepository {
  readonly path: string;
  readonly run: (args: readonly string[], input?: string | Uint8Array) => string;
}

export function withGitShim<T>(body: string, variables: Readonly<Record<string, string>>, action: () => Promise<T>): Promise<T>;
export function withGitShim<T>(body: string, variables: Readonly<Record<string, string>>, action: () => T): T;
export function withGitShim<T>(
  body: string,
  variables: Readonly<Record<string, string>>,
  action: () => T | Promise<T>,
): T | Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-v4-git-shim-"));
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const shimPath = join(directory, "git");
  writeFileSync(shimPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(shimPath, 0o755);
  const updates = {
    PATH: `${directory}:${process.env.PATH ?? ""}`,
    KEIYAKU_REAL_GIT: realGit,
    ...variables,
  };
  const previous = new Map(Object.keys(updates).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(updates)) process.env[key] = value;
  const restore = (): void => {
    for (const key of Object.keys(updates)) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = action();
    if (result instanceof Promise) return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
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

export function observeContract(repository: GitRepository, id: ContractId) {
  return withGitDecodeChannel(repository, (channel) => observeContractAt(repository, channel, id));
}
