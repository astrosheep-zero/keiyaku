import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Keiyaku, KeiyakuRefused, Repo, type Keiyaku as KeiyakuHandle, type KeiyakuRefusal } from "../../src/index.js";
import {
  appointedWorktreePath,
  cachedRepoAt,
  cachedRepositoryAt,
  makeGitRepository,
  snapshotGitRepository,
  type TestGitRepository,
} from "./git.js";
import { contractMarkdown } from "./markdown.js";

export interface RepositoryWithMainOptions {
  readonly files?: Readonly<Record<string, string>>;
  readonly message?: string;
}

const templates = new Map<string, TestGitRepository>();

function fixtureKey(files: Readonly<Record<string, string>>, message: string): string {
  return JSON.stringify({
    files: Object.entries(files).sort(([left], [right]) => left.localeCompare(right)),
    message,
  });
}

function templateFor(files: Readonly<Record<string, string>>, message: string): TestGitRepository {
  const key = fixtureKey(files, message);
  const existing = templates.get(key);
  if (existing !== undefined) return existing;

  const repository = makeGitRepository();
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(repository.path, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  if (Object.keys(files).length === 0) {
    repository.run(["commit", "--allow-empty", "--quiet", "-m", message]);
  } else {
    repository.run(["add", "--", ...Object.keys(files)]);
    repository.run(["commit", "--quiet", "-m", message]);
  }
  templates.set(key, repository);
  return repository;
}

export function repositoryWithMain(options: RepositoryWithMainOptions = {}): TestGitRepository {
  return snapshotGitRepository(templateFor(options.files ?? {}, options.message ?? "initial"));
}

export function refused(expected: KeiyakuRefusal): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof KeiyakuRefused);
    assert.deepEqual(error.refusal, expected);
    return true;
  };
}

export function document(verification?: string): string {
  return [
    "# Library verbs",
    "",
    "## Context",
    "Exercise the public domain objects.",
    "",
    "## Objective",
    "Keep the CLI from owning a second lifecycle.",
    "",
    "## Design",
    "Call only the package-root API.",
    "",
    "## Region",
    "~~~",
    "src/**",
    "~~~",
    "",
    "## Criteria",
    "### Public path",
    "The public path preserves fact payloads.",
    ...(verification === undefined ? [] : ["", "## Verification", "~~~bash timeout=5m", verification, "~~~"]),
    "",
  ].join("\n");
}

export async function bind(repository: TestGitRepository, verification?: string) {
  const result = await Keiyaku.with().bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: document(verification),
    workspace: "worktree",
    gates: verification === undefined ? ["reviewed"] : ["verified"],
  });
  return result.keiyaku;
}

export function commitCandidate(repository: TestGitRepository, worktreePath = repository.path): void {
  writeFileSync(`${worktreePath}/candidate.txt`, "candidate\n");
  repository.run(["-C", worktreePath, "add", "candidate.txt"]);
  repository.run(["-C", worktreePath, "commit", "--quiet", "-m", "candidate"]);
}

type AcceptedDelivery = Exclude<
  Awaited<ReturnType<KeiyakuHandle["deliver"]>>,
  { kind: "integration-conflict-materialized" }
>;

export function acceptedDelivery(result: Awaited<ReturnType<KeiyakuHandle["deliver"]>>): AcceptedDelivery {
  if (result.kind === "integration-conflict-materialized") {
    throw new Error(`unexpected integration conflict: ${result.conflictPaths.join(",")}`);
  }
  return result;
}

export const TARGET_PLACEMENT_FILES = {
  "delivered.txt": "base\n",
  "local.txt": "base\n",
};

export function targetPlacementDocument(title = "Target checkout placement"): string {
  return contractMarkdown(title, {
    Context: "A target branch may already be checked out.",
    Objective: "Keep the checked-out target coherent with placement.",
    Design: "Fence publication and Git-native follow.",
    Region: "~~~\ndelivered.txt\n~~~",
    Criteria: "### Preserve bytes\nThe journal admits and the checkout follows or stays behind.\n",
  });
}

export async function managedCandidate(repository: TestGitRepository, gates: readonly string[] = []) {
  const bound = await Keiyaku.with().bind({
    repo: await cachedRepoAt(repository.path),
    markdown: targetPlacementDocument(),
    workspace: "worktree",
    target: "refs/heads/main",
    gates,
  });
  const contract = bound.keiyaku;
  const state = await contract.state();
  const path = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
  writeFileSync(resolve(path, "delivered.txt"), "candidate\n");
  repository.run(["-C", path, "add", "delivered.txt"]);
  repository.run(["-C", path, "commit", "--quiet", "-m", "candidate"]);
  return { contract, id: state.id, path };
}
