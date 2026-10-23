import { accepted, present } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, readlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { Keiyaku, KeiyakuError, Repo, settings, World } from "../src/index.js";
import { waitForFixtureFile } from "./support/process.js";
import { cliJson, runCli } from "./support/cli-fixtures.js";
import { renderRootHelp } from "../src/cli/parse.js";
import { decodeContractDocument, verificationDefinition } from "../src/body/decode.js";
import { repositoryAt } from "../src/git/repository.js";
import { withGitDecodeChannel } from "../src/git/read-observation.js";
import { contractId, entryUlid, gate } from "../src/core/facts/types.js";
import { dependencyKeySet } from "../src/core/subject.js";
import { verifyDelivery } from "../src/protocol/intent.js";
import { previewDeliveryOperation } from "../src/protocol/delivery-preview.js";
import { admitDeliveryOperation } from "../src/protocol/deliver.js";
import { scopeOperation } from "../src/protocol/operations.js";
import { observeContractAt } from "../src/git/observe.js";
import { prepareVerificationDeclaration } from "../src/verification/declaration.js";
import { renderDeliveryPreview } from "../src/cli/render/delivery-preview.js";
import { contractHead } from "../src/core/facts/types.js";
import type { DeliveryPreviewOutcome } from "../src/index.js";
import { appointedWorktreePath, withGitShim, type TestGitRepository } from "./support/git.js";
import { repositoryWithMain } from "./support/library-verbs.js";
import { outcomeSchema, encodeFailureWire, decodeFailureWire } from "../src/library/outcome.js";
import { deliveryPreviewReportSchema } from "../src/protocol/delivery-preview.js";

function verificationBody(script: string | null = "exit 1"): string {
  return contractMarkdown("Audit", {
    Context: "Exercise the audit reader.",
    Objective: "Keep reports derived and compact.",
    Design: "Run the stored Verification.",
    Region: "~~~\nsrc/**\n~~~",
    Criteria: [
      "### Audit",
      "The report follows the journal.",
      ...(script === null ? [] : ["", "## Verification", "~~~bash timeout=5m", script, "~~~"]),
      "",
    ].join("\n"),
  });
}

async function failedStoredVerification(): Promise<
  Readonly<{
    repository: TestGitRepository;
    contract: Keiyaku;
    state: NonNullable<Awaited<ReturnType<Keiyaku["state"]>>>;
  }>
> {
  const repository = repositoryWithMain();
  const bound = accepted(await Keiyaku.with().bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: verificationBody(),
    workspace: "worktree",
    gates: ["verified"],
  }));
  const boundState = present(await bound.value.keiyaku.state());
  const worktree = await appointedWorktreePath(await repositoryAt(repository.path), boundState.id);
  writeFileSync(`${worktree}/candidate.txt`, "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  await bound.value.keiyaku.deliver();
  const state = present(await bound.value.keiyaku.state());
  assert.equal(state.attestations.at(-1)?.data.verdict, "unsatisfied");
  assert.equal(state.attestations.at(-1)?.data.summary, "[1 bash exit 1]");
  return { repository, contract: bound.value.keiyaku, state };
}

test("a stale document derivation is refused inside its E-decision", async () => {
  const repository = repositoryWithMain();
  const bound = accepted(await Keiyaku.with().bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: verificationBody(null),
    workspace: "worktree",
  }));
  const state = present(await bound.value.keiyaku.state());
  const decoded = decodeContractDocument(state.terms.document.bytes);
  const derivation = {
    document: decoded.document.key,
    bytes: state.terms.document.bytes,
    title: decoded.title,
    verification: prepareVerificationDeclaration({
      gates: [gate("verified")],
      definition: verificationDefinition(decoded),
      contractId: state.id,
    }),
  };
  await bound.value.keiyaku.amend({ markdown: "## Replace: Objective\nA newer document.\n\n" });
  const scope = await scopeOperation({ coordinate: repository.path });
  const refusal = { kind: "document-moved", contractId: state.id };

  await withGitDecodeChannel(scope, async (channel) => {
    assert.deepEqual(
      await admitDeliveryOperation({
        scope,
        channel,
        contractId: state.id,
        deriveDocument: () => derivation,
        requireBranchesToBeUpToDate: false,
        includeDirty: false,
        materializeConflict: false,
      }),
      { kind: "refused", refusal },
    );
    assert.deepEqual(
      await previewDeliveryOperation({
        scope,
        channel,
        contractId: state.id,
        deriveDocument: () => derivation,
      }),
      { kind: "refused", refusal },
    );
  });
});

test("preview without Verification still returns an accepted ready candidate", async () => {
  const repository = repositoryWithMain();
  const bound = accepted(await Keiyaku.with().bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: verificationBody(null),
    workspace: "worktree",
    // This preview fixture observes a deliberately targetless Contract.
    target: null,
  }));

  const scope = await scopeOperation({ coordinate: repository.path });
  const contractId = (present(await bound.value.keiyaku.state())).id;
  const observed = await withGitDecodeChannel(scope, (channel) => observeContractAt(scope, channel, contractId));
  const decoded = decodeContractDocument(observed.state!.terms.document.bytes);
  const result = await withGitDecodeChannel(scope, (channel) =>
    previewDeliveryOperation({
      scope,
      channel,
      contractId,
      deriveDocument: () => ({
        document: decoded.document.key,
        bytes: decoded.document.bytes,
        title: decoded.title,
        verification: prepareVerificationDeclaration({
          gates: observed.state!.terms.gates,
          definition: verificationDefinition(decoded),
          contractId,
        }),
      }),
    }),
  );
  assert.ok(result.kind === "accepted", 'expected result.kind = "accepted"');
  assert.deepEqual(result.facts, []);
  assert.equal(result.head, observed.state!.head);
  assert.ok(result.value.candidate.kind === "ready", 'expected result.value.candidate.kind = "ready"');
  assert.equal(result.value.candidate.identity.method, "squash");
  assert.equal("diff" in result.value.candidate, false);
  assert.equal(result.value.verification.kind, "undeclared");
  assert.equal(result.value.target.kind, "not-observed");
});

test("ungated preview reports undeclared without executing declarations or admitting testimony", async () => {
  const repository = repositoryWithMain();
  const marker = `${repository.path}/verification-ran`;
  const contract = accepted(await Keiyaku.with().bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: verificationBody(`touch '${marker}'\nexit 1`),
    workspace: "worktree",
    gates: ["reviewed"],
  })).value.keiyaku;
  const audited = accepted(await contract.previewDelivery());
  assert.equal(audited.value.candidate.kind, "ready");
  assert.deepEqual(audited.value.verification, { kind: "undeclared" });
  assert.deepEqual(audited.facts, []);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(present(await contract.state()).attestations, []);
});

test("Verification reuse reads the durable current testimony, not a caller's state copy", async () => {
  const { repository, state } = await failedStoredVerification();
  const definition = verificationDefinition(decodeContractDocument(state.terms.document.bytes))!;
  const unrelated = {
    ...state.attestations.at(-1)!,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAE"),
    data: {
      gate: gate("verified"),
      subject: dependencyKeySet([{ kind: "document", value: state.terms.document.key }]),
      verdict: "satisfied" as const,
    },
  };
  const git = await repositoryAt(repository.path);
  const result = await withGitDecodeChannel(git, (channel) =>
    verifyDelivery({
      channel,
      repository: git,
      contractId: state.id,
      at: "2026-08-06T00:00:03.000Z",
      state: { ...state, attestations: [...state.attestations, unrelated] },
      verification: definition,
    }),
  );
  assert.ok(result !== null);
  if (!("kind" in result.step)) throw new Error("verification did not return a protocol result");
  assert.equal(result.step.kind, "reused");
  if (result.step.kind === "reused") {
    assert.equal(result.step.reuse.entry, state.attestations.at(-1)!.entry);
    assert.notEqual(result.step.reuse.entry, unrelated.entry);
  }
});

// Test declaration admission at its owner, without binding two complete worktrees.
test("verified terms require a declaration at both unbound and identified boundaries", () => {
  for (const id of [undefined, contractId("kei/verify-boundary")]) {
    assert.deepEqual(
      prepareVerificationDeclaration({
        gates: [gate("verified")],
        definition: null,
        ...(id === undefined ? {} : { contractId: id }),
      }),
      {
        kind: "refused",
        refusal: { kind: "verification-declaration-invalid", ...(id === undefined ? {} : { contractId: id }) },
      },
    );
    assert.deepEqual(
      prepareVerificationDeclaration({
        gates: [gate("reviewed")],
        definition: null,
        ...(id === undefined ? {} : { contractId: id }),
      }),
      {
        kind: "prepared",
        data: null,
      },
    );
  }
});

test("preview target lag is absent at zero and counted when the target moved", () => {
  const report = (behind: number): Extract<DeliveryPreviewOutcome, { kind: "accepted" }> =>
    ({
      kind: "accepted",
      operation: "deliver-preview",
      contract: contractId("kei/audit-lag"),
      head: contractHead("head"),
      facts: [],
      effects: [],
      pending: [],
      value: {
        candidate: { kind: "blocked", refusal: { kind: "verification-declaration-invalid" } },
        verification: { kind: "not-run" },
        target: { kind: "placeable", ref: "refs/heads/main", head: "a".repeat(40), checkouts: [] },
        targetLag: { kind: "counted", behind },
      },
    }) as unknown as Extract<DeliveryPreviewOutcome, { kind: "accepted" }>;

  const unmoved = renderDeliveryPreview(report(0), { columns: 120, color: false });
  assert.match(unmoved, /main @ aaaaaaa/u);
  assert.doesNotMatch(unmoved, /behind 0/u, "zero lag is an absent fact, not a printed zero");

  const moved = renderDeliveryPreview(report(5), { columns: 120, color: false });
  assert.match(moved, /behind 5/u, "a moved target still names its lag");
});

function workspaceBytes(directory: string): unknown {
  return readdirSync(directory).sort().filter((name) => name !== ".git").map((name) => {
    const path = join(directory, name);
    const stat = lstatSync(path);
    return [name, stat.mode, stat.isSymbolicLink() ? readlinkSync(path)
      : stat.isDirectory() ? workspaceBytes(path) : readFileSync(path).toString("base64")];
  });
}

function custodySnapshot(repository: TestGitRepository, worktree: string): unknown {
  const index = (path: string) => readFileSync(resolve(path,
    repository.run(["-C", path, "rev-parse", "--git-path", "index"]).trim(),
  )).toString("base64");
  return {
    refs: repository.run(["for-each-ref", "--format=%(refname) %(objectname)"]),
    registrations: repository.run(["worktree", "list", "--porcelain"]),
    primaryIndex: index(repository.path),
    candidateIndex: index(worktree),
    primary: workspaceBytes(repository.path),
    candidate: workspaceBytes(worktree),
  };
}

test("native and CLI preview preserve authority, refs, real indexes and bytes, never executing Verification or hooks", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const verificationMarker = join(repository.path, "verification-ran");
  const hookMarker = join(repository.path, "hook-ran");
  const bound = accepted(await Keiyaku.with().bind({
    repo, markdown: verificationBody(`touch '${verificationMarker}'`), gates: ["reviewed", "verified"],
  }));
  assert.ok(bound.value.workspace?.kind === "worktree");
  const worktree = bound.value.workspace.path;
  writeFileSync(join(worktree, "candidate.txt"), "staged version\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  writeFileSync(join(worktree, "candidate.txt"), "final unstaged version\n");
  writeFileSync(join(worktree, "untracked.txt"), "untracked\n");
  mkdirSync(join(repository.path, ".keiyaku"), { recursive: true });
  const hook = { name: "marker", argv: ["bash", "-c", `touch '${hookMarker}'`], timeoutMs: 5000 };
  const hookSettings = JSON.stringify({ worktree: { create: [hook], destroy: [hook] } });
  writeFileSync(join(repository.path, ".keiyaku", "settings.json"), hookSettings);
  mkdirSync(join(worktree, ".keiyaku"), { recursive: true });
  writeFileSync(join(worktree, ".keiyaku", "settings.json"), hookSettings);
  repository.run(["-C", worktree, "add", ".keiyaku/settings.json"]);
  const configured = await settings({ root: await World.at(repository.path) });
  const native = Keiyaku.with({ settings: configured }).select({ repo, id: bound.contract });
  const before = custodySnapshot(repository, worktree);
  const history = await native.history();
  const blocked = accepted(await native.previewDelivery());
  assert.ok(blocked.value.candidate.kind === "blocked" && blocked.value.candidate.refusal.kind === "dirty-workspace");
  const preview = accepted(await native.previewDelivery({ includeDirty: true, showDiff: true }));
  assert.ok(preview.value.candidate.kind === "ready");
  assert.match(preview.value.candidate.diff ?? "", /final unstaged version/u);
  assert.match(preview.value.candidate.diff ?? "", /untracked/u);
  assert.doesNotMatch(preview.value.candidate.diff ?? "", /^\+staged version$/mu);
  assert.deepEqual(preview.value.verification, { kind: "required" });
  assert.equal(preview.value.target.kind, "placeable");
  assert.deepEqual(preview.facts, []);
  assert.deepEqual(preview.effects, []);
  assert.deepEqual(preview.pending, []);
  const cli = await cliJson<DeliveryPreviewOutcome>([
    "-C", repository.path, "deliver", bound.contract, "--dry-run", "--include-dirty", "--show-diff",
  ], { environment: {} });
  assert.equal(cli.exit, 0, cli.stderr);
  assert.equal(accepted(cli.value).operation, "deliver-preview");
  assert.deepEqual(accepted(cli.value).value.verification, { kind: "required" });
  assert.deepEqual(await native.history(), history);
  assert.deepEqual(custodySnapshot(repository, worktree), before);
  assert.equal(existsSync(verificationMarker), false);
  assert.equal(existsSync(hookMarker), false);
  assert.equal("audit" in native, false);
  assert.doesNotMatch(renderRootHelp(), /^\s+audit\s/mu);
  for (const options of [["--overwrite"], ["--materialize-conflict"], ["--message", "unused"]]) {
    await assert.rejects(runCli(["-C", repository.path, "deliver", bound.contract, "--dry-run", ...options]));
  }
  await assert.rejects(runCli(["-C", repository.path, "audit", bound.contract]));
  assert.deepEqual(custodySnapshot(repository, worktree), before);
  // The dry-run opts do not weaken normal delivery: the same bytes now admit and execute.
  const delivered = accepted(await native.deliver({ includeDirty: true }));
  assert.ok(delivered.facts.some((fact) => fact.kind === "deliver"));
  assert.ok(delivered.facts.some((fact) => fact.kind === "attestation" && fact.data.gate === "verified"));
  assert.equal(existsSync(verificationMarker), true);
  assert.equal(existsSync(hookMarker), true);
});

test("preview reports prerequisite and gate judgments without claiming acceptance readiness", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const prerequisite = accepted(await Keiyaku.with().bind({ repo, markdown: verificationBody(null), gates: [] }));
  const dependent = accepted(await Keiyaku.with().bind({
    repo, markdown: verificationBody(), after: [prerequisite.contract], gates: ["reviewed", "verified"],
  }));
  const before = await dependent.value.keiyaku.history();
  const result = accepted(await dependent.value.keiyaku.previewDelivery());
  assert.ok(result.value.candidate.kind === "ready");
  assert.deepEqual(result.value.candidate.requirements, {
    gates: [
      { gate: "reviewed", current: { kind: "missing" } },
      { gate: "verified", current: { kind: "missing" } },
    ],
    unmetPrerequisites: [{ contractId: prerequisite.contract, state: "active" }],
  });
  const text = renderDeliveryPreview(result, { columns: 160, color: false });
  assert.match(text, /deliver --dry-run/u);
  assert.match(text, /candidate  prepared/u);
  assert.ok(text.includes(prerequisite.contract));
  assert.doesNotMatch(text, /candidate  ready|accepted|delivered/u);
  assert.deepEqual(result.facts, []);
  assert.deepEqual(await dependent.value.keiyaku.history(), before);
});

test("preview reports integration conflicts without materializing a merge or changing custody", async () => {
  const repository = repositoryWithMain({ files: { "shared.txt": "base\n" } });
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keiyaku.with().bind({ repo, markdown: verificationBody(null), gates: [] }));
  assert.ok(bound.value.workspace?.kind === "worktree");
  const worktree = bound.value.workspace.path;
  writeFileSync(join(worktree, "shared.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "shared.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  writeFileSync(join(repository.path, "shared.txt"), "target\n");
  repository.run(["add", "shared.txt"]);
  repository.run(["commit", "--quiet", "-m", "target"]);
  const before = custodySnapshot(repository, worktree);
  const history = await bound.value.keiyaku.history();
  const result = accepted(await bound.value.keiyaku.previewDelivery({ showDiff: true }));
  assert.ok(result.value.candidate.kind === "blocked");
  assert.ok(result.value.candidate.refusal.kind === "integration-failed" && result.value.candidate.refusal.reason === "conflict");
  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.effects, []);
  assert.equal(repository.run(["-C", worktree, "ls-files", "-u"]), "");
  assert.deepEqual(custodySnapshot(repository, worktree), before);
  assert.deepEqual(await bound.value.keiyaku.history(), history);
});

test("cancelling the target dry-run preserves native abort and partial preview instead of accepting target.failed", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keiyaku.with().bind({ repo, markdown: verificationBody(null), gates: [] }));
  assert.ok(bound.value.workspace?.kind === "worktree");
  const worktree = bound.value.workspace.path;
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  const barrier = join(repository.path, ".git", "target-probe-started");
  const before = custodySnapshot(repository, worktree);
  const history = await bound.value.keiyaku.history();
  await withGitShim([
    'if [ "$3" = "read-tree" ] && [ "$4" = "--dry-run" ]; then',
    '  : > "$KEIYAKU_TEST_BARRIER"',
    '  exec sleep 30',
    'fi',
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n"), { KEIYAKU_TEST_BARRIER: barrier }, async (gitPath) => {
    const controller = new AbortController();
    const reason = new Error("stop preview in target probe");
    const native = Keiyaku.with().select({ repo: await Repo.at({ path: repository.path, gitPath }), id: bound.contract });
    const pending = native.previewDelivery({ signal: controller.signal });
    // Attach the rejection consumer before waiting on the in-flight process barrier.
    const rejection = assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof KeiyakuError);
      assert.equal(error.category, "aborted");
      assert.equal(error.cause, reason);
      assert.equal(error.outcome?.operation, "deliver-preview");
      assert.ok(error.outcome?.operation === "deliver-preview");
      assert.equal(error.outcome.value?.candidate?.kind, "ready");
      assert.deepEqual(error.outcome.value?.verification, { kind: "undeclared" });
      assert.equal(error.outcome.value?.target, undefined, "interrupted target observation is not a failed answer");
      assert.deepEqual(error.outcome.facts, []);
      assert.ok(error.outcome.effects.every((effect) =>
        effect.kind === "cleanup" && effect.issue.kind === "decode-channel-retirement",
      ), "only native decode-channel retirement diagnostics may accompany cancellation");
      const forwarded = decodeFailureWire(encodeFailureWire(error));
      assert.ok(forwarded);
      assert.equal(forwarded.category, "aborted");
      assert.deepEqual(forwarded.outcome, error.outcome);
      return true;
    });
    try {
      await waitForFixtureFile(barrier);
      controller.abort(reason);
      await rejection;
    } finally {
      if (!controller.signal.aborted) controller.abort(reason);
      await pending.catch(() => undefined);
    }
  });
  assert.deepEqual(await bound.value.keiyaku.history(), history);
  assert.deepEqual(custodySnapshot(repository, worktree), before);
});

test("preview names overlapping dirty target checkout while normal delivery still lands and preserves its bytes", async () => {
  const repository = repositoryWithMain({ files: { "delivered.txt": "base\n" } });
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keiyaku.with().bind({ repo, markdown: verificationBody(null), gates: [] }));
  assert.ok(bound.value.workspace?.kind === "worktree");
  const worktree = bound.value.workspace.path;
  writeFileSync(join(worktree, "delivered.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "delivered.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  const dirty = "target checkout uncommitted bytes\n";
  writeFileSync(join(repository.path, "delivered.txt"), dirty);
  const before = custodySnapshot(repository, worktree);
  const history = await bound.value.keiyaku.history();
  const probes = join(repository.path, ".git", "preview-probes");
  // Count the existing probe; reporting followability must not introduce a second one.
  const preview = await withGitShim([
    'if [ "$3" = "read-tree" ] && [ "$4" = "--dry-run" ]; then',
    '  printf "probe\\n" >> "$KEIYAKU_TEST_PROBES"',
    'fi',
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n"), { KEIYAKU_TEST_PROBES: probes }, async (gitPath) => {
    const native = Keiyaku.with().select({ repo: await Repo.at({ path: repository.path, gitPath }), id: bound.contract });
    return accepted(await native.previewDelivery());
  });
  assert.equal(readFileSync(probes, "utf8"), "probe\n");
  assert.equal(preview.value.target.kind, "placeable");
  assert.ok(preview.value.target.kind === "placeable");
  assert.equal(preview.value.target.checkouts.length, 1);
  const checkout = preview.value.target.checkouts[0]!;
  assert.equal(checkout.path, repository.path);
  assert.ok(checkout.kind === "not-followable");
  assert.match(checkout.diagnostic, /delivered\.txt.*not uptodate|not uptodate.*delivered\.txt/su);
  const text = renderDeliveryPreview(preview, { columns: 200, color: false });
  assert.match(text, /target  placeable/u);
  assert.ok(text.includes(`checkout cannot follow  ${repository.path}`));
  assert.ok(text.includes("not uptodate"));
  const schema = outcomeSchema("deliver-preview", deliveryPreviewReportSchema);
  assert.deepEqual(schema.parse(JSON.parse(JSON.stringify(preview))), preview, "live forwarding retains checkout diagnostics");
  assert.deepEqual(custodySnapshot(repository, worktree), before);
  assert.deepEqual(await bound.value.keiyaku.history(), history);
  assert.deepEqual(preview.facts, []);
  assert.deepEqual(preview.effects, []);
  const delivered = accepted(await bound.value.keiyaku.deliver());
  assert.ok(delivered.value.completion);
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), delivered.value.completion.integration);
  assert.ok(delivered.facts.some((fact) => fact.kind === "claimed"));
  const retained = delivered.effects.find((effect) => effect.kind === "checkout-retained");
  assert.ok(retained?.kind === "checkout-retained");
  assert.equal(retained.path, repository.path);
  assert.match(retained.diagnostic, /not uptodate/u);
  assert.equal(readFileSync(join(repository.path, "delivered.txt"), "utf8"), dirty);
});
