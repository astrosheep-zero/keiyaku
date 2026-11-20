import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { classifyVerb } from "../src/library/keiyaku-classify.js";
import { parseAkumaId } from "../src/akuma/identity.js";
import { AuthorityCorruptionError } from "../src/core/facts/errors.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { contractJournalPath } from "../src/git/identity.js";
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
} from "../src/library/contract-types.js";
import { accepted, document, present, repositoryWithMain } from "./support/library-verbs.js";
import { assertWireRoundTrip } from "./support/schema-parity.js";

/** Address-bearing row labels: enough to prove order, stable addresses and enrichment placement. */
function rowLabels(history: ContractHistory): readonly string[] {
  assert.ok(history.kind === "contract");
  return history.events.map((event) =>
    event.kind === "dispatch" ? `dispatch ${event.akumaId}` : `${event.kind} ${event.id}`,
  );
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

test("Contract history retains its journal when unrelated Dispatch authority is malformed", async () => {
  const raw = repositoryWithMain();
  const contracts = Keis.of(await Repo.at({ path: raw.path }));
  const bound = accepted(await contracts.bind({ terms: document(), target: null }));
  accepted(await bound.kei.amend({ edits: "## Replace: Objective\n\nRetained amended objective.\n" }));
  accepted(await bound.kei.arc({ body: "# Retained chapter\n\nExact journal narrative.\n" }));
  const git = await repositoryAt(raw.path);
  const member = parseAkumaId("aku/worker/00000001").id;
  const unrelated = parseAkumaId("aku/worker/00000002").id;
  assert.equal((await publishDispatch({ repository: git, akumaId: member, contractId: bound.contractId })).kind, "dispatched");
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
