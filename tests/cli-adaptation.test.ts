import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { invoke as invokeRaw } from "../src/cli/invoke.js";
import { parseArgv } from "../src/cli/parse.js";
import { makeGitRepository } from "./support/git.js";
import { contractMarkdown } from "./support/markdown.js";

function executable(argv: readonly string[]) {
  const parsed = parseArgv(argv);
  if (!("command" in parsed)) throw new Error("expected command invocation");
  return parsed;
}

test("Task CLI adapts a successful mutation and read", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-task-cli-adaptation-"));
  mkdirSync(join(root, ".keiyaku"));
  try {
    const added = (await invokeRaw(executable(["-C", root, "task", "add", "CLI task", "--note", "created"]))) as unknown as {
      kind: string;
      value: { id: string };
    };
    assert.equal(added.kind, "accepted");
    if (added.kind !== "accepted") return;

    const shown = (await invokeRaw(executable(["-C", root, "task", "show", added.value.id]))) as {
      task: { title: string; note: string };
    };
    assert.equal(shown.task.title, "CLI task");
    assert.equal(shown.task.note, "created");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Contract CLI adapts a successful delivery result", async () => {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  repository.run(["checkout", "--quiet", "-b", "candidate"]);
  writeFileSync(join(repository.path, "candidate.txt"), "candidate\n");
  repository.run(["add", "candidate.txt"]);
  repository.run(["commit", "--quiet", "-m", "candidate"]);
  const markdown = contractMarkdown("CLI delivery", {
    Context: "A CLI caller delegates admission.",
    Objective: "Preserve the public delivery result.",
    Design: "Adapt it once.",
    Region: "~~~\nsrc/**\n~~~",
    Criteria: "### Delivery\nThe CLI receives the owner result.",
  });
  const bound = (await invokeRaw(executable(["-C", repository.path, "bind", "--target", "refs/heads/main", "-"]), {
    environment: {},
    readStdin: async () => markdown,
  })) as unknown as { kind: string; contract: string };
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") return;

  const delivered = (await invokeRaw(executable(["-C", repository.path, "deliver", bound.contract]), {
    environment: { KEIYAKU_ACTOR_ID: "cli-test" },
  })) as unknown as { kind: string; verb: string; facts: readonly { kind: string }[] };
  assert.equal(delivered.kind, "accepted");
  if (delivered.kind !== "accepted") return;
  assert.equal(delivered.verb, "deliver");
  assert.ok(delivered.facts.some((fact) => fact.kind === "deliver"));
});
