import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { Keiyaku, KeiyakuRefused, Repo } from "../src/index.js";
import { encodeEntry } from "../src/core/facts/codec.js";
import { changeId, entryUlid, snapshotId } from "../src/core/facts/types.js";
import { contractJournalPath } from "../src/git/identity.js";
import { readBlob, readGit, repositoryAt, updateGitTree, writeBlob, writeCommit } from "../src/git/repository.js";
import { acquireTargetPlacementFence } from "../src/git/target-placement.js";
import { appointedWorktreePath, makeGitRepository, withGitShim } from "./support/git.js";
import { bind, commitCandidate, document, refused, repositoryWithMain } from "./support/library-verbs.js";

const CANONICAL_DESCRIPTION = "This is a read-only projection. Do not edit manually.";

function appoint(repositoryPath: string, contract: string, description?: string): string {
  const root = realpathSync(repositoryPath);
  const path = resolve(root, ".keiyaku", "KEIYAKU.md");
  mkdirSync(resolve(root, ".keiyaku"), { recursive: true });
  writeFileSync(path, description === undefined
    ? `---\ncontract: ${contract}\n---\n`
    : `---\ncontract: ${contract}\ndescription: ${description}\n---\n`);
  return path;
}

function appointmentPath(repositoryPath: string): string {
  return resolve(realpathSync(repositoryPath), ".keiyaku", "KEIYAKU.md");
}

function changeIdFromSubject(subject: string | undefined): string | undefined {
  return (JSON.parse(subject ?? "[]") as readonly (readonly [string, string])[])
    .find(([kind]) => kind === "change")?.[1];
}

async function conflictedTargetReview() {
  const repository = repositoryWithMain();
  writeFileSync(join(repository.path, "a.txt"), "base\n");
  writeFileSync(join(repository.path, "z.txt"), "base\n");
  repository.run(["add", "a.txt", "z.txt"]);
  repository.run(["commit", "--quiet", "-m", "base"]);
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: document(),
    workspace: "worktree",
    target: "refs/heads/main",
    gates: ["reviewed"],
  });
  const worktree = await appointedWorktreePath(await repositoryAt(repository.path), bound.keiyaku.id);
  writeFileSync(join(repository.path, "a.txt"), "target\n");
  writeFileSync(join(repository.path, "z.txt"), "target\n");
  repository.run(["add", "a.txt", "z.txt"]);
  repository.run(["commit", "--quiet", "-m", "target change"]);
  const targetHead = repository.run(["rev-parse", "refs/heads/main"]).trim();
  writeFileSync(join(worktree, "a.txt"), "tender\n");
  writeFileSync(join(worktree, "z.txt"), "tender\n");
  repository.run(["-C", worktree, "add", "a.txt", "z.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "tender change"]);
  return { repository, bound, targetHead };
}

test("here bind preserves and refuses an appointment whose journal is missing", async () => {
  const repository = repositoryWithMain();
  const contract = "kei/missing-appointment";
  const path = appoint(repository.path, contract);
  const before = readFileSync(path, "utf8");

  await assert.rejects(
    Keiyaku.bind({ repo: await Repo.at({ path: repository.path }), markdown: document(), workspace: "here" }),
    refused({ kind: "here-worktree-appointed", path, contract }),
  );

  assert.equal(readFileSync(path, "utf8"), before);
});

test("here bind preserves and refuses a residual terminal appointment", async () => {
  const repository = repositoryWithMain();
  const terminal = await bind(repository);
  const contract = (await terminal.state()).id;
  await terminal.abandon();
  const path = appoint(repository.path, contract);
  const before = readFileSync(path, "utf8");

  await assert.rejects(
    Keiyaku.bind({ repo: await Repo.at({ path: repository.path }), markdown: document(), workspace: "here" }),
    refused({ kind: "here-worktree-appointed", path, contract }),
  );

  assert.equal(readFileSync(path, "utf8"), before);
});

test("here bind preserves a manually changed one-line description appointment", async () => {
  const repository = repositoryWithMain();
  const contract = "kei/edited-description";
  const path = appoint(repository.path, contract, "edited by hand");
  const before = readFileSync(path, "utf8");

  await assert.rejects(
    Keiyaku.bind({ repo: await Repo.at({ path: repository.path }), markdown: document(), workspace: "here" }),
    refused({ kind: "here-worktree-appointed", path, contract }),
  );

  assert.equal(readFileSync(path, "utf8"), before);
});

test("here bind preserves an appointment with an additional identity field", async () => {
  const repository = repositoryWithMain();
  const path = appoint(repository.path, "kei/first");
  const before = "---\ncontract: kei/first\ncontract: kei/second\n---\n";
  writeFileSync(path, before);

  await assert.rejects(
    Keiyaku.bind({ repo: await Repo.at({ path: repository.path }), markdown: document(), workspace: "here" }),
    refused({ kind: "here-worktree-appointed", path }),
  );

  assert.equal(readFileSync(path, "utf8"), before);
});

test("failed here bind releases only the exact reservation it created", async () => {
  const repository = repositoryWithMain();
  const path = appointmentPath(repository.path);

  await assert.rejects(
    Keiyaku.bind({
      repo: await Repo.at({ path: repository.path }),
      markdown: document(),
      workspace: "here",
      after: ["kei/missing-prerequisite"],
    }),
    (error: unknown) => error instanceof KeiyakuRefused && error.refusal.kind === "unknown-prerequisite",
  );

  assert.equal(existsSync(path), false);
});

test("here projection repairs a stale one-field appointment and a changed description", async () => {
  const repository = repositoryWithMain();
  const bound = await bind(repository);
  const id = (await bound.state()).id;
  const path = appointmentPath(repository.path);
  const guidance = await bound.guidance();
  assert.ok(guidance.startsWith(
    `---\ncontract: ${id}\ndescription: ${CANONICAL_DESCRIPTION}\n---\n\n`,
  ));

  chmodSync(path, 0o644);
  writeFileSync(path, `---\ncontract: ${id}\n---\n`);
  const repairedStale = await bound.reconcile();
  assert.equal(readFileSync(path, "utf8"), guidance);
  assert.ok(repairedStale.effects.some((effect) => effect.kind === "contract-file" && effect.action === "updated"));

  chmodSync(path, 0o644);
  writeFileSync(path, guidance.replace(
    `description: ${CANONICAL_DESCRIPTION}`,
    "description: edited by hand",
  ));
  await bound.reconcile();
  assert.equal(readFileSync(path, "utf8"), guidance);
});

test("here projection does not overwrite an additional identity field", async () => {
  const repository = repositoryWithMain();
  const bound = await bind(repository);
  const id = (await bound.state()).id;
  const path = appointmentPath(repository.path);
  const before = `---\ncontract: ${id}\ncontract: kei/other\n---\n`;
  chmodSync(path, 0o644);
  writeFileSync(path, before);

  const report = await bound.reconcile();
  assert.equal(readFileSync(path, "utf8"), before);
  assert.ok(report.lag.some((lag) => lag.kind === "contract-file-failed"));
});

test("terminal here cleanup uses appointment identity and ignores description", async () => {
  const repository = repositoryWithMain();
  const bound = await bind(repository);
  const id = (await bound.state()).id;
  const path = appointmentPath(repository.path);
  chmodSync(path, 0o644);
  writeFileSync(path, `---\ncontract: ${id}\ndescription: edited by hand\n---\n`);

  await bound.abandon();
  assert.equal(existsSync(path), false);
});

test("terminal here cleanup does not remove an invalid additional identity appointment", async () => {
  const repository = repositoryWithMain();
  const bound = await bind(repository);
  const id = (await bound.state()).id;
  const path = appointmentPath(repository.path);
  const before = `---\ncontract: ${id}\ncontract: kei/other\n---\n`;
  chmodSync(path, 0o644);
  writeFileSync(path, before);

  await bound.abandon();
  assert.equal(readFileSync(path, "utf8"), before);
});

test("Delivery.diff freshly reads its pinned candidate diff", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  commitCandidate(repository);
  const delivered = await contract.deliver();

  const log = resolve(repository.path, "delivery-diff.log");
  writeFileSync(log, "");
  const shim = "if [ \"$1\" = \"diff\" ]; then printf 'diff\\n' >> \"$KEIYAKU_DELIVERY_DIFF_LOG\"; fi\nexec \"$KEIYAKU_REAL_GIT\" \"$@\"";
  const variables = { KEIYAKU_DELIVERY_DIFF_LOG: log };
  const first = await withGitShim(shim, variables, () => delivered.value.diff());
  const second = await withGitShim(shim, variables, () => delivered.value.diff());

  assert.match(first, /diff --git a\/candidate\.txt b\/candidate\.txt/);
  assert.equal(second, first);
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2);
});

test("one public handle reuses its resolved repository scope", async () => {
  const repository = repositoryWithMain();
  const initial = await bind(repository);
  const id = (await initial.state()).id;
  commitCandidate(repository);
  const log = resolve(repository.path, ".git", "scope-discovery.log");
  writeFileSync(log, "");

  const operations = await withGitShim(
    [
      "if [ \"$1\" = \"worktree\" ] && [ \"$2\" = \"list\" ]; then",
      "  printf 'discovery\\n' >> \"$KEIYAKU_SCOPE_DISCOVERY_LOG\"",
      "fi",
      "exec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    ].join("\n"),
    { KEIYAKU_SCOPE_DISCOVERY_LOG: log },
    async () => {
      const contract = Keiyaku.of({ repo: await Repo.at({ path: repository.path }), id });
      return [contract.state(), contract.deliver(), contract.reconcile()] as const;
    },
  );
  const [state, delivered] = await Promise.all(operations);

  assert.equal(state.id, id);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["discovery"]);
});

test("public review, abandon, and Arc preserve their ruled testimony", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  assert.equal(await contract.delivery(), null);

  const arc = await contract.arc({ markdown: [
    "# Implementation",
    "",
    "## Objective",
    "Complete the public path.",
    "",
    "## Brief",
    "Keep the change bounded.",
    "",
  ].join("\n") });
  assert.equal((await contract.state()).currentArc?.data.seq, 1);

  commitCandidate(repository);
  const delivered = await contract.deliver();
  const recovered = await contract.delivery();
  assert.equal(recovered?.integration.snapshot, delivered.value.integration.snapshot);
  assert.equal(recovered?.integration.changeId, delivered.value.integration.changeId);

  const reviewed = await contract.review({ verdict: "unsatisfied",
    summary: "The candidate still needs one correction.",
  });
  assert.equal((await contract.state()).attestations.at(-1)?.data.summary, "The candidate still needs one correction.");

  await assert.rejects(
    // @ts-expect-error The deleted reason enum is not an abandon options object.
    () => contract.abandon("manual"),
    /abandon input must be an object/,
  );
  const abandoned = await contract.abandon({ note: "Return the task to planning." });
  assert.equal((await contract.state()).terminal?.kind, "abandoned");
  assert.deepEqual((await contract.state()).terminal?.data, { note: "Return the task to planning." });
  const terminalDelivery = await contract.delivery();
  assert.equal(terminalDelivery?.integration.snapshot, delivered.value.integration.snapshot);
  const contractId = (await contract.state()).id;
  await assert.rejects(
    () => contract.review({ verdict: "satisfied" }),
    refused({ kind: "terminal", contractId }),
  );

  await assert.rejects(
    () => contract.arc({ markdown: [
      "# Late",
      "",
      "## Objective",
      "Too late.",
      "",
      "## Brief",
      "Must refuse.",
      "",
    ].join("\n") }),
    refused({ kind: "terminal", contractId }),
  );
});

test("delivery terminal refusal outranks a missing managed worktree", async () => {
  const repository = repositoryWithMain();
  const prerequisite = await bind(repository);
  const prerequisiteId = (await prerequisite.state()).id;
  const dependent = await Keiyaku.bind({ repo: await Repo.at({ path: repository.path }),
    markdown: document(),
    workspace: "worktree",
    gates: ["reviewed"],
    after: [prerequisiteId],
  });
  assert.equal((await dependent.keiyaku.state()).bound, null);
  const dependentId = (await dependent.keiyaku.state()).id;
  const path = await appointedWorktreePath(await repositoryAt(repository.path), dependentId);
  await dependent.keiyaku.abandon();
  assert.equal(existsSync(path), false);

  const terminalContractId = (await dependent.keiyaku.state()).id;
  await assert.rejects(
    () => dependent.keiyaku.deliver(),
    refused({ kind: "terminal", contractId: terminalContractId }),
  );
});

test("review records before delivery and the same patch can be placed", async () => {
  const repository = repositoryWithMain();
  const result = await Keiyaku.bind({ repo: await Repo.at({ path: repository.path }), markdown: document(), workspace: "here", gates: ["reviewed"] });
  writeFileSync(`${repository.path}/candidate.txt`, "candidate\n");

  const reviewed = await result.keiyaku.review({ verdict: "satisfied" });
  assert.deepEqual(reviewed.facts.map((fact) => fact.kind), ["attestation"]);
  assert.deepEqual(reviewed.value.workspace, {
    staged: [],
    unstaged: [],
    untracked: ["candidate.txt"],
    shortStat: { filesChanged: 1, insertions: 1, deletions: 0 },
  });
  assert.equal(reviewed.value.placement?.refusal.kind, "delivery-missing");
  const subject = (await result.keiyaku.state()).attestations.at(-1)?.data.subject;
  const testimony = JSON.stringify((await result.keiyaku.state()).attestations.at(-1)?.data);
  assert.equal(testimony.includes("workspace"), false);
  assert.equal(testimony.includes("dirty"), false);

  const delivered = await result.keiyaku.deliver({ includeDirty: true });
  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["bound", "deliver", "claimed"]);
  assert.equal((await result.keiyaku.state()).attestations.at(-1)?.data.subject, subject);
  assert.equal((await result.keiyaku.state()).terminal?.kind, "claimed");
});

test("a conflicted satisfied review records testimony before returning its placement stop", async () => {
  const { repository, bound, targetHead } = await conflictedTargetReview();

  const reviewed = await bound.keiyaku.review({ verdict: "satisfied" });

  assert.deepEqual(reviewed.facts.map((fact) => fact.kind), ["attestation"]);
  assert.deepEqual(reviewed.value.placement, {
    refusal: {
      kind: "integration-failed",
      contractId: bound.keiyaku.id,
      reason: "conflict",
      targetHead,
      conflictPaths: ["a.txt", "z.txt"],
    },
  });
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), targetHead);
  const reviewedState = await bound.keiyaku.state();
  assert.equal(reviewedState.delivery, null);
  assert.equal(reviewedState.terminal, null);
  assert.equal(reviewedState.attestations.at(-1)?.data.verdict, "satisfied");
  const reviewedObservation = await Keiyaku.observe({ repo: await Repo.at({ path: repository.path }), id: bound.keiyaku.id });
  assert.equal(reviewedObservation.kind, "present");
  if (reviewedObservation.kind !== "present") throw new Error("contract was not observed");
  assert.deepEqual(reviewedObservation.row.gates, {
    reports: [{ gate: "reviewed", current: { kind: "stale", priorVerdict: "satisfied" } }],
    satisfied: false,
  });

  writeFileSync(join(repository.path, "a.txt"), "base\n");
  writeFileSync(join(repository.path, "z.txt"), "base\n");
  repository.run(["add", "a.txt", "z.txt"]);
  repository.run(["commit", "--quiet", "-m", "resolve target"]);
  const delivered = await bound.keiyaku.deliver();
  const reviewedSubject = reviewedState.attestations.at(-1)?.data.subject;
  const reviewedChangeId = changeIdFromSubject(reviewedSubject);

  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["bound", "deliver", "claimed"]);
  assert.equal(delivered.value.integration.changeId, reviewedChangeId);
  const claimedObservation = await Keiyaku.observe({ repo: await Repo.at({ path: repository.path }), id: bound.keiyaku.id });
  assert.equal(claimedObservation.kind, "present");
  if (claimedObservation.kind !== "present") throw new Error("contract was not observed");
  const claimedGate = claimedObservation.row.gates;
  assert.equal(claimedGate.satisfied, true);
  assert.equal(claimedGate.reports.length, 1);
  assert.equal(claimedGate.reports[0]?.gate, "reviewed");
  assert.equal(claimedGate.reports[0]?.current.kind, "attested");
  if (claimedGate.reports[0]?.current.kind !== "attested") throw new Error("reviewed gate was not attested");
  assert.equal(claimedGate.reports[0].current.verdict, "satisfied");
  assert.equal(typeof claimedGate.reports[0].current.at, "string");
});

test("target movement alone does not stale reviewed worktree content", async () => {
  const repository = repositoryWithMain();
  writeFileSync(join(repository.path, "shared.txt"), "base\n");
  repository.run(["add", "shared.txt"]);
  repository.run(["commit", "--quiet", "-m", "base"]);
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: document(),
    workspace: "worktree",
    target: "refs/heads/main",
    gates: ["reviewed"],
  });
  const worktree = await appointedWorktreePath(await repositoryAt(repository.path), bound.keiyaku.id);
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);

  const reviewed = await bound.keiyaku.review({ verdict: "satisfied" });
  const reviewedChangeId = changeIdFromSubject((await bound.keiyaku.state()).attestations.at(-1)?.data.subject);
  writeFileSync(join(repository.path, "unrelated.txt"), "target only\n");
  repository.run(["add", "unrelated.txt"]);
  repository.run(["commit", "--quiet", "-m", "move target"]);
  const delivered = await bound.keiyaku.deliver();

  assert.equal(reviewed.value.placement?.refusal.kind, "delivery-missing");
  assert.equal(delivered.value.integration.changeId, reviewedChangeId);
  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["bound", "deliver", "claimed"]);
});

test("review and delivery share a worktree ChangeId after the tender incorporates its target", async () => {
  const repository = repositoryWithMain();
  writeFileSync(join(repository.path, "target.txt"), "base\n");
  repository.run(["add", "target.txt"]);
  repository.run(["commit", "--quiet", "-m", "base"]);
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: document(),
    workspace: "worktree",
    target: "refs/heads/main",
    gates: ["reviewed"],
  });
  const worktree = await appointedWorktreePath(await repositoryAt(repository.path), bound.keiyaku.id);
  writeFileSync(join(repository.path, "target.txt"), "target advance\n");
  repository.run(["add", "target.txt"]);
  repository.run(["commit", "--quiet", "-m", "advance target"]);
  repository.run(["-C", worktree, "rebase", "refs/heads/main"]);
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);

  const reviewed = await bound.keiyaku.review({ verdict: "satisfied" });
  const reviewedChangeId = changeIdFromSubject((await bound.keiyaku.state()).attestations.at(-1)?.data.subject);
  const delivered = await bound.keiyaku.deliver();

  assert.equal(reviewed.value.placement?.refusal.kind, "delivery-missing");
  assert.equal(delivered.value.integration.changeId, reviewedChangeId);
  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["bound", "deliver", "claimed"]);
});

test("an unsatisfied conflicted review records the same subject without requesting placement", async () => {
  const { bound } = await conflictedTargetReview();

  const unsatisfied = await bound.keiyaku.review({ verdict: "unsatisfied" });
  const unsatisfiedSubject = (await bound.keiyaku.state()).attestations.at(-1)?.data.subject;
  assert.deepEqual(unsatisfied.facts.map((fact) => fact.kind), ["attestation"]);
  assert.equal(unsatisfied.value.placement, undefined);

  const satisfied = await bound.keiyaku.review({ verdict: "satisfied" });
  const satisfiedState = await bound.keiyaku.state();
  assert.equal(satisfiedState.attestations.at(-1)?.data.subject, unsatisfiedSubject);
  assert.equal(satisfied.value.placement?.refusal.kind, "integration-failed");
});

test("diff presentation config does not change a reviewed worktree ChangeId", async () => {
  const module = makeGitRepository();
  module.run(["commit", "--allow-empty", "--quiet", "-m", "module"]);
  const repository = repositoryWithMain();
  mkdirSync(join(repository.path, "dir"), { recursive: true });
  writeFileSync(join(repository.path, "dir", "nested.txt"), "nested\n");
  writeFileSync(join(repository.path, "hunks.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
  writeFileSync(join(repository.path, "blank.txt"), "keep\n\nkeep2\nkeep3\n");
  repository.run(["add", "dir/nested.txt", "hunks.txt", "blank.txt"]);
  repository.run(["commit", "--quiet", "-m", "base content"]);
  const result = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: document(),
    workspace: "worktree",
    gates: ["reviewed"],
  });
  const worktree = await appointedWorktreePath(await repositoryAt(repository.path), result.keiyaku.id);
  writeFileSync(join(worktree, "dir", "nested.txt"), "nested2\n");
  writeFileSync(join(worktree, "hunks.txt"), "X\n2\n3\n4\n5\n6\n7\n8\n9\nY\n");
  writeFileSync(join(worktree, "blank.txt"), "KEEP\n\nkeep2\nkeep3\n");
  repository.run(["-C", worktree, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", module.path, "vendor/mod"]);
  repository.run(["-C", worktree, "add", "dir/nested.txt", "hunks.txt", "blank.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  const reviewed = await result.keiyaku.review({ verdict: "satisfied" });
  const reviewedChangeId = changeIdFromSubject((await result.keiyaku.state()).attestations.at(-1)?.data.subject);
  for (const [key, value] of [
    ["core.abbrev", "4"],
    ["diff.algorithm", "histogram"],
    ["core.quotePath", "false"],
    ["diff.srcPrefix", "aaa/"],
    ["diff.dstPrefix", "bbb/"],
    ["diff.noPrefix", "true"],
    ["diff.relative", "true"],
    ["diff.interHunkContext", "20"],
    ["diff.suppressBlankEmpty", "true"],
    ["diff.ignoreSubmodules", "all"],
    ["diff.submodule", "log"],
    ["diff.mnemonicPrefix", "true"],
  ] as const) repository.run(["config", key, value]);

  const delivered = await Keiyaku.of({
    repo: await Repo.at({ path: join(worktree, "dir") }),
    id: result.keiyaku.id,
  }).deliver();
  assert.equal(reviewed.value.placement?.refusal.kind, "delivery-missing");
  assert.equal(delivered.value.integration.changeId, reviewedChangeId);
  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["bound", "deliver", "claimed"]);
});

test("a satisfied review waits on the target-placement fence before placing", async () => {
  const { repository, bound } = await conflictedTargetReview();
  const held = await acquireTargetPlacementFence(await repositoryAt(repository.path), "refs/heads/main");
  const pending = bound.keiyaku.review({ verdict: "satisfied" });
  const raced = await Promise.race([
    pending.then(() => "finished" as const),
    new Promise<"blocked">((resolve) => { setTimeout(() => resolve("blocked"), 150); }),
  ]);
  assert.equal(raced, "blocked");
  held.close();
  const reviewed = await pending;
  assert.deepEqual(reviewed.facts.map((fact) => fact.kind), ["attestation"]);
  assert.equal(reviewed.value.placement?.refusal.kind, "integration-failed");
});

test("a satisfied review cannot interleave a stale integration stop across the target fence", async () => {
  const { repository, bound, targetHead } = await conflictedTargetReview();
  const git = await repositoryAt(repository.path);
  const held = await acquireTargetPlacementFence(git, "refs/heads/main");
  const pending = bound.keiyaku.review({ verdict: "satisfied" });
  const deadline = Date.now() + 2000;
  let state = await bound.keiyaku.state();
  while (state.attestations.at(-1)?.data.verdict !== "satisfied" && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    state = await bound.keiyaku.state();
  }
  assert.equal(state.attestations.at(-1)?.data.verdict, "satisfied");
  assert.equal(state.delivery, null);
  const reviewedChangeId = changeIdFromSubject(state.attestations.at(-1)?.data.subject);
  if (reviewedChangeId === undefined) throw new Error("reviewed subject is missing its ChangeId");
  const before = await readGit(git);
  const journalPath = contractJournalPath(state.id);
  const active = before.paths.get(journalPath);
  if (active?.type !== "blob") throw new Error("missing active journal");
  const oid = await writeBlob(git, Buffer.concat([
    await readBlob(git, active.oid),
    Buffer.from(encodeEntry({
      v: 1,
      kind: "bound",
      contract: state.id,
      entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FBW"),
      at: "2026-08-17T00:00:00.000Z",
      data: {},
    })),
    Buffer.from(encodeEntry({
      v: 1,
      kind: "deliver",
      contract: state.id,
      entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FBX"),
      at: "2026-08-17T00:00:01.000Z",
      data: {
        tenderSnapshot: snapshotId(targetHead),
        integration: {
          predecessor: snapshotId(targetHead),
          snapshot: snapshotId(targetHead),
          changeId: changeId(reviewedChangeId),
        },
        method: "squash",
        policy: { requireBranchesToBeUpToDate: false },
      },
    })),
  ]));
  const tree = await updateGitTree(git, before.tree, new Map([[journalPath, { oid }]]));
  const commit = await writeCommit({ repository: git, tree, parent: before.commit });
  repository.run(["update-ref", "refs/heads/keiyaku-state", commit, before.commit]);
  writeFileSync(join(repository.path, "unrelated-target.txt"), "moved\n");
  repository.run(["add", "unrelated-target.txt"]);
  repository.run(["commit", "--quiet", "-m", "move target under fence"]);
  const stillHeld = await Promise.race([
    pending.then(() => "finished" as const),
    new Promise<"blocked">((resolve) => { setTimeout(() => resolve("blocked"), 50); }),
  ]);
  assert.equal(stillHeld, "blocked");
  held.close();
  const reviewed = await pending;
  assert.deepEqual(reviewed.facts.map((fact) => fact.kind), ["attestation"]);
  assert.equal(reviewed.value.placement?.failure, "target-moved");
  if (reviewed.value.placement?.failure === "target-moved") {
    assert.equal(reviewed.value.placement.expected, targetHead);
  }
});

test("a whitespace-only worktree change stales prior review testimony", async () => {
  const repository = repositoryWithMain();
  const result = await Keiyaku.bind({ repo: await Repo.at({ path: repository.path }), markdown: document(), workspace: "here", gates: ["reviewed"] });
  writeFileSync(`${repository.path}/candidate.txt`, "candidate\n");
  const reviewed = await result.keiyaku.review({ verdict: "satisfied" });
  const reviewedChangeId = changeIdFromSubject((await result.keiyaku.state()).attestations.at(-1)?.data.subject);
  writeFileSync(`${repository.path}/candidate.txt`, "candidate \n");

  const delivered = await result.keiyaku.deliver({ includeDirty: true });
  assert.equal(reviewed.value.placement?.refusal.kind, "delivery-missing");
  assert.notEqual(delivered.value.integration.changeId, reviewedChangeId);
  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["bound", "deliver"]);
  assert.equal(delivered.value.placement?.refusal.kind, "gates-unsatisfied");
  assert.equal((await result.keiyaku.state()).terminal, null);
});

test("a changed worktree patch leaves the reviewed placement pending", async () => {
  const repository = repositoryWithMain();
  const result = await Keiyaku.bind({ repo: await Repo.at({ path: repository.path }), markdown: document(), workspace: "here", gates: ["reviewed"] });
  writeFileSync(`${repository.path}/candidate.txt`, "first\n");
  const reviewed = await result.keiyaku.review({ verdict: "satisfied" });
  assert.deepEqual(reviewed.value.workspace?.untracked, ["candidate.txt"]);
  writeFileSync(`${repository.path}/candidate.txt`, "second\n");

  const delivered = await result.keiyaku.deliver({ includeDirty: true });
  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["bound", "deliver"]);
  assert.equal(delivered.value.placement?.refusal.kind, "gates-unsatisfied");
  assert.equal((await result.keiyaku.state()).terminal, null);
});

test("a changed document leaves an otherwise unchanged reviewed patch pending", async () => {
  const repository = repositoryWithMain();
  const result = await Keiyaku.bind({ repo: await Repo.at({ path: repository.path }), markdown: document(), workspace: "here", gates: ["reviewed"] });
  writeFileSync(`${repository.path}/candidate.txt`, "candidate\n");
  const reviewed = await result.keiyaku.review({ verdict: "satisfied" });

  const amended = await result.keiyaku.amend({
    markdown: "## Replace: Objective\nRequire review of the current contract document.\n",
  });

  const delivered = await result.keiyaku.deliver({ includeDirty: true });
  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["bound", "deliver"]);
  assert.equal(delivered.value.placement?.refusal.kind, "gates-unsatisfied");
  assert.equal((await result.keiyaku.state()).terminal, null);
});

test("review testimony is recorded when reviewed is not a placement gate", async () => {
  const repository = repositoryWithMain();
  const result = await Keiyaku.bind({ repo: await Repo.at({ path: repository.path }), markdown: document(), workspace: "here", gates: [] });
  writeFileSync(`${repository.path}/candidate.txt`, "candidate\n");

  const reviewed = await result.keiyaku.review({ verdict: "unsatisfied" });
  assert.deepEqual(reviewed.facts.map((fact) => fact.kind), ["attestation"]);
  assert.equal(reviewed.value.placement, undefined);
  assert.deepEqual(reviewed.value.workspace?.untracked, ["candidate.txt"]);
  assert.equal((await result.keiyaku.state()).attestations.at(-1)?.data.gate, "reviewed");
});
