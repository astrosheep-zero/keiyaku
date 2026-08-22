import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  Keiyaku,
  KeiyakuRefused,
  Repo,
  type KeiyakuRefusal,
} from "../../src/index.js";
import { makeGitRepository, type TestGitRepository } from "./git.js";

export interface RepositoryWithMainOptions {
  readonly files?: Readonly<Record<string, string>>;
}

export function repositoryWithMain(options: RepositoryWithMainOptions = {}): TestGitRepository {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  const files = options.files ?? {};
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(repository.path, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  if (Object.keys(files).length === 0) {
    repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  } else {
    repository.run(["add", "--", ...Object.keys(files)]);
    repository.run(["commit", "--quiet", "-m", "initial"]);
  }
  return repository;
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
    ...(verification === undefined ? [] : [
      "",
      "## Verification",
      "~~~bash",
      verification,
      "~~~",
    ]),
    "",
  ].join("\n");
}

export async function bind(repository: TestGitRepository, verification?: string) {
  const result = await Keiyaku.bind({ repo: await Repo.at({ path: repository.path }),
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
