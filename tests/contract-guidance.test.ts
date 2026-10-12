import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTRACT_DELIVERER_SKILL,
  CONTRACT_ONBOARDING_SKILL,
  CONTRACT_REVIEWER_SKILL,
  renderContractGuidance,
} from "../src/contract-guidance.js";
import { projectContractWorktree } from "../src/contract-worktree.js";
import { repositoryAt } from "../src/git/repository.js";
import { worktreePath } from "../src/git/workspace.js";
import { appointManagedWorktrees } from "../src/workspace-place.js";
import { repositoryWithMain } from "./support/library-verbs.js";
import { withGitShim } from "./support/git.js";
import {
  contractHead,
  contractId,
  documentKey,
  entryUlid,
  snapshotId,
  type ContractState,
} from "../src/core/facts/types.js";

const source = "# Guidance\r\n\r\n## Context\r\nExact source bytes.\r\n";

function state(currentArc: ContractState["currentArc"]): ContractState {
  return {
    id: contractId("kei/guidance"),
    head: contractHead("head"),
    coordinates: { start: snapshotId("start"), workspace: "worktree" },
    terms: {
      document: { bytes: source, key: documentKey("document") },
      segments: [],
      gates: [],
      after: [],
    },
    delivery: null,
    currentIntegration: null,
    attestations: [],
    ...(currentArc === undefined ? {} : { currentArc }),
    terminal: null,
  };
}

test("guidance preserves source bytes and projects the lawful fulfillment structure", () => {
  const guidance = renderContractGuidance(state(undefined));
  const fulfillment = guidance.slice(guidance.indexOf("## Fulfillment"));

  assert.ok(
    guidance.startsWith(
      "---\ncontract: kei/guidance\ndescription: This is a read-only projection. Do not edit manually.\n---\n\n",
    ),
  );
  assert.ok(guidance.includes(source.trimEnd()));
  assert.equal(fulfillment.match(/^## Fulfillment$/gm)?.length, 1);
  assert.deepEqual(
    [...fulfillment.matchAll(/^### (.+)$/gm)].map((match) => match[1]),
    ["Appointment", "Worktree", "Deliverer", "Reviewer"],
  );
  assert.match(fulfillment, /every commission into it names exactly one seat — Deliverer or Reviewer/);
  assert.match(fulfillment, /terms are the standing acceptance floor, changed only by journaled amend/);
  assert.match(fulfillment, /full current worktree state is the candidate/);
  assert.match(fulfillment, /first decides whether each Criterion is adjudicable as written/);
  assert.match(fulfillment, /covered Criteria, findings, term defects, and missing evidence/);
  assert.match(
    fulfillment,
    /Read the Deliverer operating procedures at `\.agents\/skills\/keiyaku-deliver\/SKILL\.md`\./,
  );
  assert.match(
    fulfillment,
    /Read the Reviewer operating procedures at `\.agents\/skills\/keiyaku-review\/SKILL\.md`\./,
  );
  assert.doesNotMatch(guidance, /^## Arc$/m);
  assert.ok(guidance.endsWith("\n"));
});

test("guidance inserts the current Arc before Fulfillment", () => {
  const guidance = renderContractGuidance(
    state({
      v: 1,
      kind: "arc",
      contract: contractId("kei/guidance"),
      entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
      at: "2026-08-13T00:00:00.000Z",
      data: { seq: 2, title: "Second", body: "Continue.\n\nDo the next coherent work." },
    }),
  );

  assert.match(guidance, /^## Arc\n\n### Sequence\n\n2$/m);
  assert.match(guidance, /### Body\n\nContinue\.\n\nDo the next coherent work\./);
  assert.ok(guidance.indexOf("## Arc") < guidance.indexOf("## Fulfillment"));
});

test("projection batches each index as generated files grow and preserves bytes and effect order", async () => {
  const repository = repositoryWithMain();
  const git = await repositoryAt(repository.path);
  const current = state(undefined);
  const register = await appointManagedWorktrees(git, [current.id]);
  const worktree = worktreePath(git, register.byContract.get(current.id)!.place);
  repository.run(["worktree", "add", "--detach", worktree, "HEAD"]);
  const skills = [
    ["keiyaku-onboarding", CONTRACT_ONBOARDING_SKILL],
    ["keiyaku-deliver", CONTRACT_DELIVERER_SKILL],
    ["keiyaku-review", CONTRACT_REVIEWER_SKILL],
  ] as const;
  for (const [seat] of skills) {
    const leaf = join(worktree, ".agents", "skills", seat);
    mkdirSync(leaf, { recursive: true });
    writeFileSync(join(leaf, "SKILL.md"), "# User skill\n");
  }
  const log = join(repository.path, "tracking-queries");
  await withGitShim(
    [
      'if [ "$1" = "ls-files" ]; then',
      '  printf "%s\\0" "$PWD" "$@" >> "$KEIYAKU_QUERY_LOG"',
      '  printf "\\n" >> "$KEIYAKU_QUERY_LOG"',
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_QUERY_LOG: log },
    async (gitPath) => {
      const capability = { ...git, gitPath };
      const small = await projectContractWorktree(capability, current, register);
      assert.deepEqual(small.lag, []);
      assert.deepEqual(
        small.effects.map((effect) => effect.action),
        ["created", "created", "created"],
      );
      for (const [seat] of skills) unlinkSync(join(worktree, ".agents", "skills", seat, "SKILL.md"));
      const full = await projectContractWorktree(capability, current, register);
      assert.deepEqual(full.lag, []);
      const generated: readonly (readonly [string, string])[] = [
        [".keiyaku/.gitignore", ".gitignore\nKEIYAKU.md\n"],
        [".keiyaku/KEIYAKU.md", renderContractGuidance(current)],
        ...skills.flatMap(([seat, bytes]): (readonly [string, string])[] => [
          [`.agents/skills/${seat}/.gitignore`, ".gitignore\nSKILL.md\n"],
          [`.agents/skills/${seat}/SKILL.md`, bytes],
        ]),
      ];
      assert.deepEqual(
        full.effects.map((effect) => [effect.path, effect.action]),
        [
          [join(repository.path, ".keiyaku", ".gitignore"), "unchanged"],
          ...generated.map(([path], index) => [join(worktree, path), index < 2 ? "unchanged" : "created"]),
        ],
      );
      assert.equal(
        readFileSync(join(repository.path, ".keiyaku", ".gitignore"), "utf8"),
        "*\n!settings.json\n!tasks/\n!tasks/**\n",
      );
      for (const [path, bytes] of generated) assert.equal(readFileSync(join(worktree, path), "utf8"), bytes);
      const retried = await projectContractWorktree(capability, current, register);
      assert.deepEqual(retried.lag, []);
      assert.deepEqual(
        retried.effects,
        full.effects.map((effect) => ({ ...effect, action: "unchanged" })),
      );
      const queries = readFileSync(log, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => line.split("\0").slice(0, -1));
      const expected = [
        [repository.path, "ls-files", "-z", "--", ":(literal).keiyaku/.gitignore"],
        [worktree, "ls-files", "-z", "--", ...generated.map(([path]) => `:(literal)${path}`)],
      ];
      assert.deepEqual(queries, [...expected, ...expected, ...expected]);
      assert.equal(repository.run(["status", "--porcelain", "--untracked-files=no"]), "");
      assert.equal(repository.run(["-C", worktree, "status", "--porcelain", "--untracked-files=no"]), "");
    },
  );
});
