import { accepted, present } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, readlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { Keis, KeiyakuError, Repo, settings, World } from "../src/index.js";
import { waitForFixtureFile } from "./support/process.js";
import { renderRootHelp } from "../src/cli/parse.js";
import { decodeContractDocument, verificationDefinition } from "../src/body/decode.js";
import { withGitDecodeChannel } from "../src/git/read-observation.js";
import { contractId, entryUlid } from "../src/core/facts/types.js";
import { verificationRequirement } from "../src/verification/declaration.js";
import { previewDeliveryOperation } from "../src/protocol/delivery-preview.js";
import { admitDeliveryOperation, prepareDelivery } from "../src/protocol/deliver.js";
import { decideDeliver } from "../src/core/verbs/deliver.js";
import { scopeOperation } from "../src/protocol/operations.js";
import { observeContractAt } from "../src/git/observe.js";
import { prepareVerificationDeclaration } from "../src/verification/declaration.js";
import { renderDeliveryPreview } from "../src/cli/render/delivery-preview.js";
import { changeId, snapshotId } from "../src/core/facts/types.js";
import type { DeliveryPreviewOutcome } from "../src/index.js";
import { withGitShim, type TestGitRepository } from "./support/git.js";
import { repositoryWithMain } from "./support/library-verbs.js";
import { projectFailure } from "../src/library/outcome.js";

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

test("a stale document derivation is refused by the pure decision and restarts the protocol", async () => {
  const repository = repositoryWithMain();
  const bound = accepted(
    await Keis.of(await Repo.at({ path: repository.path })).bind({
      markdown: verificationBody(null),
      workspace: "worktree",
    }),
  );
  const state = present(await bound.kei.state());
  const decoded = decodeContractDocument(state.terms.document.bytes);
  const derivation = {
    document: decoded.document.key,
    bytes: state.terms.document.bytes,
    title: decoded.title,
    verification: prepareVerificationDeclaration(verificationDefinition(decoded)),
  };
  await bound.kei.amend({ markdown: "## Replace: Objective\nA newer document.\n\n" });
  const scope = await scopeOperation({ coordinate: repository.path });

  await withGitDecodeChannel(scope, async (channel) => {
    // A pure mismatched decision refuses its own stale document.
    const current = present((await observeContractAt(scope, channel, state.id)).state);
    const prepared = await prepareDelivery(
      scope,
      { contractId: state.id, coordinates: current.coordinates },
      { title: decoded.title, document: decoded.document.bytes },
    );
    assert.ok(prepared.kind === "prepared", 'expected prepared.kind = "prepared"');
    assert.deepEqual(
      decideDeliver({
        input: {
          contractId: state.id,
          at: "2026-08-06T00:00:00Z",
          preparation: { kind: "prepared", document: derivation.document, data: prepared.data },
        },
        attempt: { entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5F99")] },
        observation: new Map([[state.id, current]]),
      }),
      { kind: "refused", refusal: { kind: "document-moved" } },
    );
    // The protocol never publishes the stale preparation: the same derivation exhausts its restarts.
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
      { kind: "retry", reason: { kind: "exhausted" } },
    );
  });
});

test("preview without Verification still returns an accepted ready candidate", async () => {
  const repository = repositoryWithMain();
  const bound = accepted(
    await Keis.of(await Repo.at({ path: repository.path })).bind({
      markdown: verificationBody(null),
      workspace: "worktree",
      // This preview fixture observes a deliberately targetless Contract.
      target: null,
    }),
  );

  const scope = await scopeOperation({ coordinate: repository.path });
  const contractId = present(await bound.kei.state()).id;
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
        verification: prepareVerificationDeclaration(verificationDefinition(decoded)),
      }),
    }),
  );
  assert.ok(result.kind === "accepted", 'expected result.kind = "accepted"');
  assert.deepEqual(result.facts, []);
  assert.equal(result.head, observed.state!.head);
  assert.ok(result.value.kind === "ready");
  assert.equal(result.value.diff, undefined);
  assert.equal(result.value.unmetGates, undefined);
  assert.equal(result.value.target, undefined);
});

test("ungated preview reports undeclared without executing declarations or admitting testimony", async () => {
  const repository = repositoryWithMain();
  const marker = `${repository.path}/verification-ran`;
  const contract = accepted(
    await Keis.of(await Repo.at({ path: repository.path })).bind({
      markdown: verificationBody(`touch '${marker}'\nexit 1`),
      workspace: "worktree",
      gates: ["reviewed"],
    }),
  ).kei;
  const audited = await contract.previewDelivery();
  assert.ok(audited.kind === "ready");
  assert.equal(audited.unmetGates?.some(({ gate }) => gate === "verified"), false);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(present(await contract.state()).attestations, []);
});

test("preview target lag is absent at zero and counted when the target moved", () => {
  const report = (behind: number): Extract<DeliveryPreviewOutcome, { kind: "ready" }> => ({
    kind: "ready", contractId: contractId("kei/audit-lag"),
    candidate: snapshotId("a".repeat(40)), integration: snapshotId("b".repeat(40)),
    contentId: changeId("c".repeat(40)), scope: {},
    target: {
      kind: "placeable",
      ref: "refs/heads/main",
      head: snapshotId("a".repeat(40)),
      ...(behind === 0 ? {} : { behind }),
    },
  });

  const unmoved = renderDeliveryPreview(report(0), { columns: 120, color: false });
  assert.match(unmoved, /main @ aaaaaaa/u);
  assert.doesNotMatch(unmoved, /behind 0/u, "zero lag is an absent fact, not a printed zero");

  const moved = renderDeliveryPreview(report(5), { columns: 120, color: false });
  assert.match(moved, /behind 5/u, "a moved target still names its lag");
});

function workspaceBytes(directory: string): unknown {
  return readdirSync(directory)
    .sort()
    .filter((name) => name !== ".git")
    .map((name) => {
      const path = join(directory, name);
      const stat = lstatSync(path);
      return [
        name,
        stat.mode,
        stat.isSymbolicLink()
          ? readlinkSync(path)
          : stat.isDirectory()
            ? workspaceBytes(path)
            : readFileSync(path).toString("base64"),
      ];
    });
}

function custodySnapshot(repository: TestGitRepository, worktree: string): unknown {
  const index = (path: string) =>
    readFileSync(resolve(path, repository.run(["-C", path, "rev-parse", "--git-path", "index"]).trim())).toString(
      "base64",
    );
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
  const { cliJson, runCli } = await import("./support/cli-fixtures.js");
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const verificationMarker = join(repository.path, "verification-ran");
  const hookMarker = join(repository.path, "hook-ran");
  const bound = accepted(
    await Keis.of(repo).bind({
      markdown: verificationBody(`touch '${verificationMarker}'`),
      gates: ["reviewed", "verified"],
    }),
  );
  assert.ok(bound.worktreePath);
  const worktree = bound.worktreePath;
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
  const native = Keis.of(repo, { settings: configured }).kei({ id: bound.contractId });
  const before = custodySnapshot(repository, worktree);
  const history = await native.history();
  const blocked = await native.previewDelivery();
  assert.ok(blocked.kind === "blocked" && blocked.reason.kind === "dirty-workspace");
  const preview = await native.previewDelivery({ includeDirty: true, showDiff: true });
  assert.ok(preview.kind === "ready");
  assert.ok(preview.diff?.kind === "present");
  assert.match(preview.diff.text, /final unstaged version/u);
  assert.match(preview.diff.text, /untracked/u);
  assert.doesNotMatch(preview.diff.text, /^\+staged version$/mu);
  const requirement = verificationRequirement(
    decodeContractDocument(present(await native.state()).terms.document.bytes).verification[0]!,
  );
  assert.deepEqual(preview.unmetGates?.find((item) => item.gate === "verified"), {
    gate: "verified", requirement, state: "missing",
  });
  assert.equal(preview.target?.kind, "placeable");
  const cli = await cliJson<DeliveryPreviewOutcome>(
    ["-C", repository.path, "deliver", bound.contractId, "--dry-run", "--include-dirty", "--show-diff"],
    { environment: {} },
  );
  assert.equal(cli.exit, 0, cli.stderr);
  assert.deepEqual(cli.value, preview);
  assert.deepEqual(await native.history(), history);
  assert.deepEqual(custodySnapshot(repository, worktree), before);
  assert.equal(existsSync(verificationMarker), false);
  assert.equal(existsSync(hookMarker), false);
  assert.equal("audit" in native, false);
  assert.doesNotMatch(renderRootHelp(), /^\s+audit\s/mu);
  for (const options of [["--overwrite"], ["--materialize-conflict"], ["--message", "unused"]]) {
    await assert.rejects(runCli(["-C", repository.path, "deliver", bound.contractId, "--dry-run", ...options]));
  }
  await assert.rejects(runCli(["-C", repository.path, "audit", bound.contractId]));
  assert.deepEqual(custodySnapshot(repository, worktree), before);
  const delivered = accepted(await native.deliver({ includeDirty: true }));
  assert.equal(delivered.placement?.kind, "gates-unsatisfied");
  assert.equal(existsSync(verificationMarker), false);
  assert.equal(existsSync(hookMarker), false);
});

test("preview reports prerequisite and gate judgments without claiming acceptance readiness", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const prerequisite = accepted(await Keis.of(repo).bind({ markdown: verificationBody(null), gates: [] }));
  const dependent = accepted(
    await Keis.of(repo).bind({
      markdown: verificationBody(),
      after: [prerequisite.contractId],
      gates: ["reviewed", "verified"],
    }),
  );
  const before = await dependent.kei.history();
  const result = await dependent.kei.previewDelivery();
  assert.ok(result.kind === "ready");
  assert.deepEqual(result.unmetPrerequisites, [{ contractId: prerequisite.contractId, state: "active" }]);
  assert.deepEqual(result.unmetGates?.map(({ gate, state }) => [gate, state]),
    [["reviewed", "missing"], ["verified", "missing"]]);
  const text = renderDeliveryPreview(result, { columns: 160, color: false });
  assert.match(text, /deliver --dry-run/u);
  assert.match(text, /candidate  prepared/u);
  assert.ok(text.includes(prerequisite.contractId));
  assert.doesNotMatch(text, /candidate  ready|accepted|delivered/u);
  assert.deepEqual(await dependent.kei.history(), before);
});

test("preview reports integration conflicts without materializing a merge or changing custody", async () => {
  const repository = repositoryWithMain({ files: { "shared.txt": "base\n" } });
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keis.of(repo).bind({ markdown: verificationBody(null), gates: [] }));
  assert.ok(bound.worktreePath);
  const worktree = bound.worktreePath;
  writeFileSync(join(worktree, "shared.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "shared.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  writeFileSync(join(repository.path, "shared.txt"), "target\n");
  repository.run(["add", "shared.txt"]);
  repository.run(["commit", "--quiet", "-m", "target"]);
  const before = custodySnapshot(repository, worktree);
  const history = await bound.kei.history();
  const result = await bound.kei.previewDelivery({ showDiff: true });
  assert.ok(result.kind === "blocked");
  assert.equal(result.reason.kind, "integration-conflict");
  assert.equal(repository.run(["-C", worktree, "ls-files", "-u"]), "");
  assert.deepEqual(custodySnapshot(repository, worktree), before);
  assert.deepEqual(await bound.kei.history(), history);
});

test("cancelling the target dry-run preserves native abort and partial preview instead of accepting target.failed", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keis.of(repo).bind({ markdown: verificationBody(null), gates: [] }));
  assert.ok(bound.worktreePath);
  const worktree = bound.worktreePath;
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "candidate.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  const barrier = join(repository.path, ".git", "target-probe-started");
  const before = custodySnapshot(repository, worktree);
  const history = await bound.kei.history();
  await withGitShim([
    'if [ "$3" = "read-tree" ] && [ "$4" = "--dry-run" ]; then',
    '  : > "$KEIYAKU_TEST_BARRIER"',
    '  exec sleep 30',
    'fi',
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n"), { KEIYAKU_TEST_BARRIER: barrier }, async (gitPath) => {
    const controller = new AbortController();
    const reason = new Error("stop preview in target probe");
    const native = Keis.of(await Repo.at({ path: repository.path, gitPath })).kei({ id: bound.contractId });
    const pending = native.previewDelivery({ signal: controller.signal });
    // Attach the rejection consumer before waiting on the in-flight process barrier.
    const rejection = assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof KeiyakuError);
      assert.equal(error.category, "aborted");
      assert.equal(error.cause, reason);
      assert.ok(error.outcome?.kind === "contract");
      assert.ok(error.outcome.preview?.kind === "ready");
      assert.ok(error.outcome.preview.candidate);
      assert.equal(error.outcome.preview.target, undefined, "interrupted target observation is not a failed answer");
      assert.equal(error.outcome.admitted, undefined);
      assert.ok((error.outcome.issues ?? []).every((effect) => effect.kind === "decode-channel-retirement"),
        "only native decode-channel retirement diagnostics may accompany cancellation");
      const json = JSON.parse(JSON.stringify(projectFailure(error)));
      assert.equal(json.category, "aborted");
      assert.equal(json.causeClass, "Error");
      assert.equal(json.causeDiagnostic, reason.message);
      assert.deepEqual(json.outcome, error.outcome);
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
  assert.deepEqual(await bound.kei.history(), history);
  assert.deepEqual(custodySnapshot(repository, worktree), before);
});

test("preview names overlapping dirty target checkout while normal delivery still lands and preserves its bytes", async () => {
  const repository = repositoryWithMain({ files: { "delivered.txt": "base\n" } });
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keis.of(repo).bind({ markdown: verificationBody(null), gates: [] }));
  assert.ok(bound.worktreePath);
  const worktree = bound.worktreePath;
  writeFileSync(join(worktree, "delivered.txt"), "candidate\n");
  repository.run(["-C", worktree, "add", "delivered.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  const dirty = "target checkout uncommitted bytes\n";
  writeFileSync(join(repository.path, "delivered.txt"), dirty);
  const before = custodySnapshot(repository, worktree);
  const history = await bound.kei.history();
  const probes = join(repository.path, ".git", "preview-probes");
  // Count the existing probe; reporting followability must not introduce a second one.
  const preview = await withGitShim(
    [
      'if [ "$3" = "read-tree" ] && [ "$4" = "--dry-run" ]; then',
      '  printf "probe\\n" >> "$KEIYAKU_TEST_PROBES"',
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_TEST_PROBES: probes },
    async (gitPath) => {
      const native = Keis.of(await Repo.at({ path: repository.path, gitPath })).kei({
        id: bound.contractId,
      });
      const result = await native.previewDelivery();
      assert.ok(result.kind === "ready");
      return result;
    },
  );
  assert.equal(readFileSync(probes, "utf8"), "probe\n");
  assert.ok(preview.target?.kind === "placeable");
  assert.equal(preview.target.checkouts?.length, 1);
  const checkout = preview.target.checkouts![0]!;
  assert.equal(checkout.path, repository.path);
  assert.match(checkout.diagnostic, /delivered\.txt.*not uptodate|not uptodate.*delivered\.txt/su);
  const text = renderDeliveryPreview(preview, { columns: 200, color: false });
  // The receipt hard-wraps a long payload at the column boundary, even mid-word, so the human-facing text is judged
  // without display whitespace while the whole rendering stays in the failure evidence.
  const displayed = text.replace(/\s+/gu, "");
  assert.match(text, /target  placeable/u);
  assert.ok(text.includes(`checkout cannot follow  ${repository.path}`));
  assert.ok(displayed.includes("notuptodate"), `preview must render the checkout diagnostic; got:\n${text}`);

  assert.deepEqual(custodySnapshot(repository, worktree), before);
  assert.deepEqual(await bound.kei.history(), history);
  const delivered = accepted(await bound.kei.deliver());
  assert.ok(delivered.placement?.kind === "placed");
  assert.equal(repository.run(["rev-parse", "refs/heads/main"]).trim(), delivered.integration);
  assert.equal(present(await bound.kei.state()).terminal?.kind, "claimed");
  const retained = (delivered.issues ?? []).find((effect) => effect.kind === "target-checkout-retained");
  assert.ok(retained?.kind === "target-checkout-retained");
  assert.equal(retained.path, repository.path);
  assert.match(retained.diagnostic, /not uptodate/u);
  assert.equal(readFileSync(join(repository.path, "delivered.txt"), "utf8"), dirty);
});
