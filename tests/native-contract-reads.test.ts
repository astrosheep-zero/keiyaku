import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { classifyVerb } from "../src/library/keiyaku-classify.js";
import { parseAkumaId } from "../src/akuma/identity.js";
import { AuthorityCorruptionError } from "../src/core/facts/errors.js";
import { contractId } from "../src/core/facts/types.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { GitPlumbingError } from "../src/git/process.js";
import { createKeiHandle } from "../src/library/kei.js";
import { captureLocalContractComposition } from "../src/library/contract-settings.js";
import { scopeForRepo } from "../src/library/repo.js";
import { withScopeAbortSignal } from "../src/protocol/operations.js";
import { contractJournalPath } from "../src/git/identity.js";
import { decodeJournal, encodeEntry } from "../src/core/facts/codec.js";
import { withGitDecodeChannel, withGitReadObservation } from "../src/git/read-observation.js";
import {
  GIT_REF,
  readGitPaths,
  repositoryAt,
  updateGitTree,
  updateRefsAtomically,
  writeBlob,
  writeStateCommit,
} from "../src/git/repository.js";
import { Keis, Keiyaku, KeiyakuError, Repo } from "../src/index.js";
import {
  contractHistorySchema,
  type ContractHistory,
  type ContractHistoryInput,
} from "../src/library/contract-types.js";
import { guidanceSchema } from "../src/library/kei.js";
import { waitForFile, withGitShim } from "./support/git.js";
import { accepted, document, present, repositoryWithMain } from "./support/library-verbs.js";
import { assertWireRoundTrip } from "./support/schema-parity.js";
import { temporaryDirectory } from "./support/process.js";

/** Address-bearing row labels: enough to prove order, stable addresses and enrichment placement. */
function rowLabels(history: ContractHistory): readonly string[] {
  assert.ok(history.kind === "contract");
  return history.events.map((event) =>
    event.kind === "dispatch" ? `dispatch ${event.akumaId}` : `${event.kind} ${event.id}`,
  );
}

function dispatchBytes(akumaId: string, contract: string, dispatchedAt: string): string {
  return `${JSON.stringify({ akumaId, contractId: contract, dispatchedAt })}\n`;
}

function dispatchPath(akumaId: string): string {
  return `dispatch/${createHash("sha256").update(akumaId).digest("hex")}.json`;
}

test("Contract history pages journal addresses, and an exact address recovers its own record", async () => {
  const repository = repositoryWithMain();
  const contracts = Keis.of(await Repo.at({ path: repository.path }));
  const parent = accepted(await contracts.bind({ terms: document(), target: null }));
  const bound = accepted(
    await contracts.bind({
      terms: document().replace("Call only the package-root API.", "Historical terms. ".repeat(8)),
      target: null,
      gates: ["reviewed"],
    }),
  );
  const original = present(await bound.kei.state()).terms.document.bytes;
  accepted(await bound.kei.amend({
    edits: "## Replace: Objective\n\nThe amended objective.\n",
    after: [parent.contractId],
    target: parent.contractId,
  }));
  const state = present(await bound.kei.state());
  const target = state.coordinates.target;
  assert.ok(typeof target === "object");
  accepted(await bound.kei.arc({ body: "# A historical chapter\n\nExact narrative body.\n" }));

  const page = await bound.kei.history();
  assert.deepEqual(rowLabels(page), ["bind 1", "amend 2", "arc 3"]);
  assert.ok(page.kind === "contract");
  assert.equal(page.lowestRetainedSequence, 1);
  assert.equal(page.highestSequence, 3);
  assert.equal(page.omitted, undefined);
  assert.equal(page.dispatches, undefined);
  assertWireRoundTrip(contractHistorySchema, page);

  const binding = await bound.kei.history({ item: "1" });
  assert.ok(binding.kind === "contract-exact");
  assert.ok(binding.event.kind === "bind");
  assert.equal(binding.event.id, "1");
  assert.equal(binding.event.start, state.coordinates.start);
  assert.equal(binding.event.document, original);
  assert.deepEqual(binding.event.gates, ["reviewed"]);
  assert.deepEqual(binding.event.after, []);
  assert.equal(binding.event.target, undefined);
  assertWireRoundTrip(contractHistorySchema, binding);

  const amendment = await bound.kei.history({ item: "2" });
  assert.ok(amendment.kind === "contract-exact");
  assert.ok(amendment.event.kind === "amend");
  assert.deepEqual(amendment.event, {
    kind: "amend",
    id: "2",
    at: amendment.event.at,
    document: state.terms.document.bytes,
    gates: ["reviewed"],
    after: [parent.contractId],
    target: { kind: "contract", contractId: parent.contractId },
    targetIncarnation: target.worktree,
  });
  assertWireRoundTrip(contractHistorySchema, amendment);

  const chapter = await bound.kei.history({ item: "3" });
  assert.ok(chapter.kind === "contract-exact");
  assert.ok(chapter.event.kind === "arc");
  assert.equal(chapter.event.chapter, 1);
  assert.equal(chapter.event.title, "A historical chapter");
  assert.equal(chapter.event.body, "\nExact narrative body.\n");
  assertWireRoundTrip(contractHistorySchema, chapter);
  assert.deepEqual(page.events, [binding.event, amendment.event, chapter.event]);

  assert.deepEqual(await bound.kei.history({ item: "4" }), {
    kind: "contract-unknown-history",
    contractId: bound.contractId,
  });

  const recent = await bound.kei.history({ before: 3, limit: 2 });
  assert.deepEqual(rowLabels(recent), ["bind 1", "amend 2"]);
  assert.ok(recent.kind === "contract");
  assert.equal(recent.omitted, undefined);
  const boundedAmendment = await bound.kei.history({ since: 1, limit: 1 });
  assert.deepEqual(rowLabels(boundedAmendment), ["amend 2"]);
  assert.ok(boundedAmendment.kind === "contract");
  assert.equal(boundedAmendment.omitted, 1);
  assert.deepEqual(boundedAmendment.events, [amendment.event]);
  const latest = await bound.kei.history({ limit: 1 });
  assert.deepEqual(rowLabels(latest), ["arc 3"]);
  assert.ok(latest.kind === "contract");
  assert.equal(latest.omitted, 2);

  for (const invalid of [
    { item: "1", limit: 1 },
    { item: "1", before: 2 },
    { before: 2, since: 1 },
    { item: "turn/1" },
    { item: "report/1" },
    { item: "answer" },
    { item: "last" },
    { item: "0" },
    { item: "01" },
    { before: 0 },
    { limit: 5_001 },
  ] as readonly ContractHistoryInput[]) {
    await assert.rejects(bound.kei.history(invalid), (error: unknown) => {
      assert.ok(error instanceof KeiyakuError);
      assert.equal(error.category, "invalid-input");
      return true;
    });
  }
  await withGitShim(
    'if [ "$1 $2" = "cat-file --batch" ]; then exit 73; fi\nexec "$KEIYAKU_REAL_GIT" "$@"',
    {},
    async (gitPath) => {
      const kei = Keis.of(await Repo.at({ path: repository.path, gitPath })).kei({ id: bound.contractId });
      // Invalid caller intent is refused before any product observation could fail.
      await assert.rejects(kei.history({ item: "answer" }), (error: unknown) => {
        assert.ok(error instanceof KeiyakuError);
        assert.equal(error.category, "invalid-input");
        return true;
      });
    },
  );
  for (let chapter = 2; chapter < 12; chapter += 1)
    accepted(await bound.kei.arc({ body: `# Chapter ${chapter}\n\nRetained chapter ${chapter}.\n` }));
  accepted(await bound.kei.arc({ body: "# Empty chapter\n" }));
  const tail = await bound.kei.history();
  assert.ok(tail.kind === "contract");
  assert.equal(tail.highestSequence, 14);
  assert.equal(tail.omitted, 2);
  assert.deepEqual(tail.events.map(event => event.kind === "dispatch" ? undefined : event.id), Array.from({ length: 12 }, (_, index) => String(index + 3)));
  const emptyChapter = await bound.kei.history({ item: "14" });
  assert.ok(emptyChapter.kind === "contract-exact" && emptyChapter.event.kind === "arc");
  assert.equal(emptyChapter.event.body, "");
  assert.deepEqual(tail.events.at(-1), emptyChapter.event);
  const traversed: string[] = [];
  let since = 1;
  for (;;) {
    const page = await bound.kei.history({ since, limit: 4 });
    assert.ok(page.kind === "contract");
    const rows = page.events.filter(event => event.kind !== "dispatch");
    traversed.push(...rows.map(row => row.id));
    if (page.omitted === undefined) break;
    since = Number(rows.at(-1)!.id);
  }
  assert.deepEqual(traversed, Array.from({ length: 13 }, (_, index) => String(index + 2)));
  const old = await bound.kei.history({ before: 3, limit: 1 });
  assert.ok(old.kind === "contract");
  assert.deepEqual(old.events, [amendment.event]);
});

async function overwriteAuthority(path: string, changes: ReadonlyMap<string, string>): Promise<void> {
  const git = await repositoryAt(path);
  const snapshot = await readGitPaths(git, []);
  const blobs = new Map(
    await Promise.all([...changes].map(async ([key, bytes]) => [key, { oid: await writeBlob(git, bytes) }] as const)),
  );
  const tree = await updateGitTree(git, snapshot.tree, blobs);
  const commit = await writeStateCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal(
    (await updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }])).kind,
    "published",
  );
}

test("Dispatch enrichment anchors to the preceding journal row without touching journal addresses", async () => {
  const raw = repositoryWithMain();
  const bound = accepted(await Keis.of(await Repo.at({ path: raw.path })).bind({ terms: document(), target: null }));
  accepted(await bound.kei.amend({ edits: "## Replace: Objective\n\nThe amended objective.\n" }));
  accepted(await bound.kei.arc({ body: "# Tied chapter\n" }));
  const early = "2026-09-01T01:00:00.000Z";
  const late = "2026-09-01T02:00:00.000Z";
  const journalPath = contractJournalPath(bound.contractId);
  const journal = decodeJournal(raw.run(["show", `${GIT_REF}:${journalPath}`]));
  const records = journal.map((entry) => encodeEntry({ ...entry, at: entry.kind === "amend" ? early : late }));
  await overwriteAuthority(raw.path, new Map([[journalPath, records.join("")]]));
  const git = await repositoryAt(raw.path);
  const fallback = parseAkumaId("aku/worker/00000001").id;
  const firstTie = parseAkumaId("aku/worker/00000002").id;
  const secondTie = parseAkumaId("aku/worker/00000009").id;
  const earlier = parseAkumaId("aku/worker/00000003").id;
  for (const akumaId of [secondTie, fallback, earlier, firstTie]) {
    assert.equal(
      (await publishDispatch({ repository: git, akumaId, contractId: bound.contractId })).kind,
      "dispatched",
    );
  }
  await overwriteAuthority(
    raw.path,
    new Map([
      // Earlier than every journal timestamp still belongs to the first appended row.
      [dispatchPath(fallback), dispatchBytes(fallback, bound.contractId, "2000-01-01T00:00:00.000Z")],
      [dispatchPath(firstTie), dispatchBytes(firstTie, bound.contractId, late)],
      [dispatchPath(secondTie), dispatchBytes(secondTie, bound.contractId, late)],
      [dispatchPath(earlier), dispatchBytes(earlier, bound.contractId, early)],
    ]),
  );

  const page = await bound.kei.history();
  assert.ok(page.kind === "contract");
  const journalRows = page.events.filter((event) => event.kind !== "dispatch");
  // Append order stays authoritative even though the first row now carries the later clock.
  assert.deepEqual(
    journalRows.map((row) => [row.id, row.at]),
    [
      ["1", late],
      ["2", early],
      ["3", late],
    ],
  );
  assert.deepEqual(rowLabels(page), [
    "bind 1",
    `dispatch ${fallback}`,
    "amend 2",
    `dispatch ${earlier}`,
    "arc 3",
    `dispatch ${firstTie}`,
    `dispatch ${secondTie}`,
  ]);
  assert.deepEqual(rowLabels(await bound.kei.history({ before: 2 })), ["bind 1", `dispatch ${fallback}`]);
  const latestPage = await bound.kei.history({ limit: 1 });
  assert.deepEqual(rowLabels(latestPage), ["arc 3", `dispatch ${firstTie}`, `dispatch ${secondTie}`]);
  assert.ok(latestPage.kind === "contract");
  assert.equal(latestPage.omitted, 2);
  const binding = await bound.kei.history({ item: "1" });
  assert.ok(binding.kind === "contract-exact");
  assert.equal(binding.event.kind, "bind");
  assertWireRoundTrip(contractHistorySchema, binding);
});

test("Contract history retains its journal when unrelated Dispatch authority is malformed", async () => {
  const raw = repositoryWithMain();
  const contracts = Keis.of(await Repo.at({ path: raw.path }));
  const bound = accepted(await contracts.bind({ terms: document(), target: null }));
  accepted(await bound.kei.amend({ edits: "## Replace: Objective\n\nRetained amended objective.\n" }));
  accepted(await bound.kei.arc({ body: "# Retained chapter\n\nExact journal narrative.\n" }));
  const healthy = await bound.kei.history();
  assert.deepEqual(rowLabels(healthy), ["bind 1", "amend 2", "arc 3"]);
  const git = await repositoryAt(raw.path);
  const member = parseAkumaId("aku/worker/00000001").id;
  const unrelated = parseAkumaId("aku/worker/00000002").id;
  for (const [akumaId, owner] of [
    [member, bound.contractId],
    [unrelated, contractId("kei/unrelated")],
  ] as const) {
    assert.equal((await publishDispatch({ repository: git, akumaId, contractId: owner })).kind, "dispatched");
  }
  const enriched = await bound.kei.history();
  assert.deepEqual(rowLabels(enriched), ["bind 1", "amend 2", "arc 3", `dispatch ${member}`]);
  assert.ok(enriched.kind === "contract");
  assert.equal(enriched.dispatches, undefined);
  assertWireRoundTrip(Keiyaku.verbs.history.output, enriched);
  assert.equal(
    classifyVerb("history", { selector: bound.contractId }, { kind: "returned", value: enriched }),
    "accepted",
  );

  const badPath = dispatchPath(unrelated);
  await overwriteAuthority(
    raw.path,
    new Map([
      [
        badPath,
        `${JSON.stringify({ akuId: unrelated, contractId: "kei/unrelated", dispatchedAt: "2026-08-09T00:00:00.000Z" })}\n`,
      ],
    ]),
  );
  const history = await bound.kei.history();
  // Unavailable association authority supplies no partial membership at all.
  assert.deepEqual(rowLabels(history), ["bind 1", "amend 2", "arc 3"]);
  assert.ok(history.kind === "contract");
  assert.equal(history.dispatches?.kind, "unavailable");
  assert.equal(history.dispatches?.category, "authority-corruption");
  assert.ok(history.dispatches?.diagnostic.includes(badPath));
  assertWireRoundTrip(contractHistorySchema, history);
  assertWireRoundTrip(Keiyaku.verbs.history.output, history);
  const bounded = await bound.kei.history({ before: 3, limit: 1 });
  assert.deepEqual(rowLabels(bounded), ["amend 2"]);
  assert.ok(bounded.kind === "contract");
  assert.equal(bounded.dispatches?.category, "authority-corruption");
  const binding = await bound.kei.history({ item: "1" });
  assert.ok(binding.kind === "contract-exact");
  assert.equal(binding.event.kind, "bind");
  assert.equal("dispatches" in binding, false);
  assert.deepEqual(await contracts.kei({ id: contractId("kei/missing") }).history(), {
    kind: "contract-missing",
    contractId: "kei/missing",
  });

  await overwriteAuthority(raw.path, new Map([[contractJournalPath(bound.contractId), "not a journal\n"]]));
  for (const request of [undefined, { item: "1" }] as const) {
    await assert.rejects(bound.kei.history(request), (error: unknown) => {
      assert.ok(error instanceof KeiyakuError);
      assert.equal(error.category, "authority-corruption");
      assert.ok(error.cause instanceof AuthorityCorruptionError);
      return true;
    });
  }
});

test("history propagates native cancellation during optional Dispatch enrichment", async (t) => {
  const raw = repositoryWithMain();
  const repo = await Repo.at({ path: raw.path });
  const bound = accepted(await Keis.of(repo).bind({ terms: document(), target: null }));
  const git = await repositoryAt(raw.path);
  assert.equal(
    (
      await publishDispatch({
        repository: git,
        akumaId: parseAkumaId("aku/worker/00000003").id,
        contractId: bound.contractId,
      })
    ).kind,
    "dispatched",
  );
  const snapshot = await withGitDecodeChannel(git, (channel) =>
    withGitReadObservation(git, channel, (observation) => observation.snapshot),
  );
  const dispatch = [...snapshot.paths].find(([path]) => path.startsWith("dispatch/"))![1];
  const marker = join(temporaryDirectory(t, "history-cancellation-"), "dispatch-started");
  const controller = new AbortController();
  await withGitShim(
    [
      'if [ "$1 $2" = "cat-file --batch" ]; then',
      "  while IFS= read -r oid; do",
      '    if [ "$oid" = "$KEIYAKU_CANCEL_OID" ]; then',
      '      printf started > "$KEIYAKU_CANCEL_MARKER"',
      "      while :; do sleep 10; done",
      "    fi",
      '    printf "%s\\n" "$oid" | "$KEIYAKU_REAL_GIT" cat-file --batch',
      "  done",
      "  exit 0",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_CANCEL_OID: dispatch.oid, KEIYAKU_CANCEL_MARKER: marker },
    async (gitPath) => {
      const scope = withScopeAbortSignal(scopeForRepo(await Repo.at({ path: raw.path, gitPath })), controller.signal);
      const kei = createKeiHandle(bound.contractId, scope, captureLocalContractComposition());
      const rejected = assert.rejects(kei.history(), (error: unknown) => {
        assert.ok(error instanceof KeiyakuError);
        assert.ok(error.cause instanceof GitPlumbingError);
        assert.match(error.cause.message, /git process cancelled/u);
        return true;
      });
      try {
        await waitForFile(marker);
      } finally {
        controller.abort();
      }
      await rejected;
    },
  );
});

test("history reports internal unavailable Dispatch enrichment when the Dispatch blob read fails", async () => {
  const raw = repositoryWithMain();
  const bound = accepted(await Keis.of(await Repo.at({ path: raw.path })).bind({ terms: document(), target: null }));
  accepted(await bound.kei.amend({ edits: "## Replace: Objective\n\nRetained amended objective.\n" }));
  const healthy = await bound.kei.history();
  assert.deepEqual(rowLabels(healthy), ["bind 1", "amend 2"]);
  const akumaId = parseAkumaId("aku/worker/00000004").id;
  const git = await repositoryAt(raw.path);
  assert.equal((await publishDispatch({ repository: git, akumaId, contractId: bound.contractId })).kind, "dispatched");
  const snapshot = await withGitDecodeChannel(git, (channel) =>
    withGitReadObservation(git, channel, (observation) => observation.snapshot),
  );
  const dispatch = [...snapshot.paths].find(([path]) => path.startsWith("dispatch/"))![1];
  await withGitShim(
    [
      'if [ "$1 $2" = "cat-file --batch" ]; then',
      "  while IFS= read -r oid; do",
      '    if [ "$oid" = "$KEIYAKU_BROKEN_OID" ]; then',
      '      printf "%s blob\\n" "$oid"',
      "    else",
      '      printf "%s\\n" "$oid" | "$KEIYAKU_REAL_GIT" cat-file --batch',
      "    fi",
      "  done",
      "  exit 0",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_BROKEN_OID: dispatch.oid },
    async (gitPath) => {
      const kei = Keis.of(await Repo.at({ path: raw.path, gitPath })).kei({ id: bound.contractId });
      const history = await kei.history();
      assert.deepEqual(rowLabels(history), ["bind 1", "amend 2"]);
      assert.ok(history.kind === "contract");
      assert.equal(history.dispatches?.kind, "unavailable");
      assert.equal(history.dispatches?.category, "internal");
      const diagnostic = history.dispatches?.diagnostic ?? "";
      assert.match(diagnostic, /unexpected header/u);
      assert.ok(diagnostic.includes(dispatch.oid));
      assertWireRoundTrip(contractHistorySchema, history);
      const binding = await kei.history({ item: "1" });
      assert.ok(binding.kind === "contract-exact");
      assert.equal(binding.event.kind, "bind");
    },
  );
});

test("history preserves observation and decode-channel retirement failures", async (t) => {
  const raw = repositoryWithMain();
  const bound = accepted(await Keis.of(await Repo.at({ path: raw.path })).bind({ terms: document(), target: null }));
  const log = join(temporaryDirectory(t, "history-retirement-"), "closed");
  await withGitShim(
    [
      'if [ "$1 $2" = "cat-file --batch" ]; then',
      '  "$KEIYAKU_REAL_GIT" "$@"',
      '  printf closed > "$KEIYAKU_CLOSE_LOG"',
      "  exit 73",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_CLOSE_LOG: log },
    async (gitPath) => {
      const kei = Keis.of(await Repo.at({ path: raw.path, gitPath })).kei({ id: bound.contractId });
      await assert.rejects(kei.history(), /did not close cleanly/u);
      assert.equal(readFileSync(log, "utf8"), "closed");
    },
  );
  await withGitShim(
    'if [ "$1" = "rev-parse" ] && [ "$4" = "refs/heads/keiyaku-state" ]; then exit 73; fi\nexec "$KEIYAKU_REAL_GIT" "$@"',
    {},
    async (gitPath) => {
      const kei = Keis.of(await Repo.at({ path: raw.path, gitPath })).kei({ id: bound.contractId });
      await assert.rejects(kei.history(), KeiyakuError);
    },
  );
});

test("guidance preserves exact requested bytes and distinguishes missing authority from a present read", async (t) => {
  const repository = repositoryWithMain();
  const contracts = Keis.of(await Repo.at({ path: repository.path }));
  const bound = accepted(await contracts.bind({ terms: document(), target: null }));
  const facet = Keiyaku.for({ cwd: repository.path, environment: {}, home: temporaryDirectory(t, "guidance-home-") });
  const guidance = await bound.kei.guidance();
  assert.ok(guidance.kind === "present");
  assert.ok(guidance.guidance.includes("## Objective"));
  assert.deepEqual(await facet.show({ selector: bound.contractId }), guidance);
  assertWireRoundTrip(guidanceSchema, guidance);

  const missing = contracts.kei({ id: "kei/missing" as never });
  const missingGuidance = await missing.guidance();
  assert.deepEqual(missingGuidance, { kind: "missing" });
  const missingHistory = await missing.history();
  assert.deepEqual(missingHistory, { kind: "contract-missing", contractId: "kei/missing" });
  assertWireRoundTrip(guidanceSchema, missingGuidance);
  assertWireRoundTrip(contractHistorySchema, missingHistory);
  assert.equal(
    classifyVerb("show", { selector: "kei/missing" }, { kind: "returned", value: missingGuidance }),
    "refused",
  );
  assert.equal(
    classifyVerb("history", { selector: "kei/missing" }, { kind: "returned", value: missingHistory }),
    "refused",
  );
});
