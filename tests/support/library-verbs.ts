import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import {
  Keiyaku,
  KeiyakuRefused,
  Repo,
  type KeiyakuRefusal,
} from "../../src/index.js";
import { makeGitRepository, type TestGitRepository } from "./git.js";

export function repositoryWithMain(): TestGitRepository {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
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
    workspace: "here",
    gates: verification === undefined ? ["reviewed"] : ["verified"],
  });
  return result.keiyaku;
}

export function commitCandidate(repository: TestGitRepository): void {
  writeFileSync(`${repository.path}/candidate.txt`, "candidate\n");
  repository.run(["add", "candidate.txt"]);
  repository.run(["commit", "--quiet", "-m", "candidate"]);
}
