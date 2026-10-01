import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after } from "node:test";
import { Repo } from "../../src/index.js";
import { readManagedWorktreeAppointment } from "../../src/workspace-place.js";
import type { ContractId } from "../../src/core/facts/types.js";
import { observeContractAt } from "../../src/git/observe.js";
import { withGitDecodeChannel } from "../../src/git/read-observation.js";
import type { GitRepository } from "../../src/git/process.js";
import { repositoryAt as productionRepositoryAt } from "../../src/git/repository.js";
import { contractIdFromSegment } from "../../src/core/facts/types.js";
import { fitIdentityStem, normalizeIdentityStem } from "../../src/identity/normalize.js";
import {
  ownFixtureRoot,
  ownedFixtureRootPaths,
  releaseOwnedFixtureRoot,
  removeTempDirectory,
  retainedFixtureRoot,
} from "./process.js";

// Every helper-owned fixture root is registered with the process-local retention owner in
// ./process.js where it is allocated, and this file's teardown is the last hook that retires
// them, so a root stays usable across the tests that share it and no individual test retires a
// directory another consumer still reads. The hook is created while this module is evaluated,
// so helpers must be imported at file scope: a dynamic import from inside a running test would
// bind any later teardown registration to that test instead. A root retained without a declared
// expectation is left untouched and fails the file by name; declared evidence and unretained
// roots keep the transient removal policy and their failures stay visible.
after(async () => {
  const failures: string[] = [];
  for (const path of ownedFixtureRootPaths()) {
    const retention = retainedFixtureRoot(path);
    if (retention !== undefined) {
      // A declared retention is this test's own evidence; every other retention
      // is unexpected and the file fails by name.
      if (!retention.expected) failures.push(`unexpectedly retained ${path}: ${retention.reason}`);
      continue;
    }
    try {
      await removeTempDirectory(path);
      releaseOwnedFixtureRoot(path);
    } catch (error) {
      failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(`fixture directory cleanup failed: ${failures.join("; ")}`);
});

const repositoryCapabilities = new Map<string, Promise<GitRepository>>();
const repositoryTemplateHasTrackedEntries = new WeakMap<TestGitRepository, boolean>();
const repos = new Map<string, Promise<Repo>>();

export function cachedRepoAt(path: string, gitPath = "git"): Promise<Repo> {
  const key = `${resolve(path)}\0${gitPath}`;
  const existing = repos.get(key);
  if (existing !== undefined) return existing;

  const repo = Repo.at({ path, gitPath });
  repos.set(key, repo);
  void repo.catch(() => {
    if (repos.get(key) === repo) repos.delete(key);
  });
  return repo;
}

export function cachedRepositoryAt(cwd: string, gitPath = "git"): Promise<GitRepository> {
  const key = `${resolve(cwd)}\0${gitPath}`;
  const existing = repositoryCapabilities.get(key);
  if (existing !== undefined) return existing;

  const capability = productionRepositoryAt(cwd, gitPath);
  repositoryCapabilities.set(key, capability);
  void capability.catch(() => {
    if (repositoryCapabilities.get(key) === capability) repositoryCapabilities.delete(key);
  });
  return capability;
}

export function protocolContractId(title: string): ContractId {
  return contractIdFromSegment(
    fitIdentityStem({
      stem: normalizeIdentityStem({ source: title }) || "contract",
      maxBytes: 48,
    }),
  );
}

export async function waitForFile(path: string): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
}

export interface TestGitRepository {
  readonly path: string;
  readonly run: (args: readonly string[], input?: string | Uint8Array) => string;
}

export function gitExecutablePath(): string {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  return execFileSync(locator, ["git"], { encoding: "utf8" }).split(/\r?\n/u)[0]!.trim();
}

export function withGitShim<T>(
  body: string,
  variables: Readonly<Record<string, string>>,
  action: (gitPath: string) => Promise<T>,
): Promise<T>;
export function withGitShim<T>(
  body: string,
  variables: Readonly<Record<string, string>>,
  action: (gitPath: string) => T,
): T;
export function withGitShim<T>(
  body: string,
  variables: Readonly<Record<string, string>>,
  action: (gitPath: string) => T | Promise<T>,
): T | Promise<T> {
  // Registered before executable setup so a failing locator, write, or chmod still retires its shim.
  const directory = ownFixtureRoot(mkdtempSync(join(tmpdir(), "keiyaku-v4-git-shim-")));
  const realGit = gitExecutablePath();
  const shimPath = join(directory, "git");
  const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const environment = { KEIYAKU_REAL_GIT: realGit, ...variables };
  const assignments = Object.entries(environment)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join("\n");
  writeFileSync(shimPath, `#!/bin/sh\n${assignments}\nexport ${Object.keys(environment).join(" ")}\n${body}\n`, {
    mode: 0o755,
  });
  chmodSync(shimPath, 0o755);
  return action(shimPath);
}

function initializedGitRepository(): TestGitRepository {
  const directory = ownFixtureRoot(mkdtempSync(join(tmpdir(), "keiyaku-v4-")));
  const path = realpathSync(directory);
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", path]);
  appendFileSync(
    join(path, ".git", "config"),
    [
      "",
      "[user]",
      "\tname = Keiyaku Test",
      "\temail = keiyaku-test@example.invalid",
      "[core]",
      "\tautocrlf = false",
      "[gc]",
      "\tauto = 0",
      "[maintenance]",
      "\tauto = false",
      "",
    ].join("\n"),
  );
  const run = (args: readonly string[], input?: string | Uint8Array): string =>
    execFileSync("git", ["-C", path, ...args], { input, encoding: "utf8" }).toString();
  return { path, run };
}

let emptyRepositoryTemplate: TestGitRepository | undefined;

export function makeGitRepository(): TestGitRepository {
  const template = (emptyRepositoryTemplate ??= initializedGitRepository());
  return snapshotGitRepository(template);
}

export function snapshotGitRepository(source: TestGitRepository): TestGitRepository {
  const directory = ownFixtureRoot(mkdtempSync(join(tmpdir(), "keiyaku-v4-snapshot-")));
  const path = join(realpathSync(directory), "repository");
  cpSync(source.path, path, { recursive: true, dereference: false, preserveTimestamps: true, verbatimSymlinks: true });
  let hasTrackedEntries = repositoryTemplateHasTrackedEntries.get(source);
  if (hasTrackedEntries === undefined) {
    hasTrackedEntries = source.run(["ls-files", "--cached", "-z"]) !== "";
    repositoryTemplateHasTrackedEntries.set(source, hasTrackedEntries);
  }
  if (hasTrackedEntries) {
    execFileSync("git", ["-C", path, "update-index", "--refresh", "-q"]);
  }
  const run = (args: readonly string[], input?: string | Uint8Array): string =>
    execFileSync("git", ["-C", path, ...args], { input, encoding: "utf8" }).toString();
  return { path, run };
}

export function repositoryWithCommit(): TestGitRepository {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Keiyaku Test"]);
  repository.run(["config", "user.email", "keiyaku@example.invalid"]);
  repository.run(["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  return repository;
}

export function deliveryRefFor(contract: ContractId): string {
  return `refs/keiyaku/delivery/kei-${contract.slice("kei/".length)}`;
}

export function candidatePinRefFor(contract: ContractId): string {
  return `refs/keiyaku/candidate/kei-${contract.slice("kei/".length)}`;
}

export function observeContract(repository: GitRepository, id: ContractId) {
  return withGitDecodeChannel(repository, (channel) => observeContractAt(repository, channel, id));
}

export async function appointedWorktreePath(repository: GitRepository, contract: ContractId): Promise<string> {
  const appointment = await readManagedWorktreeAppointment(repository, contract);
  if (appointment.kind !== "appointed") {
    throw new Error(`expected appointed Place for ${contract}, got ${appointment.kind}`);
  }
  return appointment.path;
}

export type WorktreeFixtureFile = Readonly<{ path: string; bytes: Buffer; mode: number }>;

/** Snapshot generated guidance only. Each restored worktree gets independent files. */
export function captureWorktreeFiles(
  worktree: string,
  paths: readonly string[] = [
    ".keiyaku/.gitignore", ".keiyaku/KEIYAKU.md",
    ".agents/skills/keiyaku-deliver/.gitignore", ".agents/skills/keiyaku-deliver/SKILL.md",
    ".agents/skills/keiyaku-review/.gitignore", ".agents/skills/keiyaku-review/SKILL.md",
  ],
): readonly WorktreeFixtureFile[] {
  return paths.map((path) => ({
    path,
    bytes: readFileSync(join(worktree, path)),
    mode: statSync(join(worktree, path)).mode & 0o777,
  }));
}

export function restoreWorktreeFiles(worktree: string, files: readonly WorktreeFixtureFile[]): void {
  for (const generated of files) {
    const path = join(worktree, generated.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, generated.bytes);
    chmodSync(path, generated.mode);
  }
}
