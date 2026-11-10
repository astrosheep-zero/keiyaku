import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";
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
import {
  Keis,
  Keiyaku,
  KeiyakuError,
  Repo,
  classifyVerb,
  contractHistorySchema,
  guidanceSchema,
} from "../src/index.js";
import { cliJson, runCli } from "./support/cli-fixtures.js";
import { waitForFile, withGitShim } from "./support/git.js";
import { accepted, document, present, repositoryWithMain } from "./support/library-verbs.js";
import { assertWireRoundTrip } from "./support/schema-parity.js";
import { temporaryDirectory } from "./support/process.js";

test("default Contract history is semantic; explicit full history retains each historical version", async (t) => {
  const repository = repositoryWithMain();
  const bound = accepted(
    await Keis.of(await Repo.at({ path: repository.path })).bind({
      markdown: document().replace("Call only the package-root API.", "Historical terms. ".repeat(80)),
      target: null,
      gates: ["reviewed"],
    }),
  );
  const original = present(await bound.kei.state()).terms.document.bytes;
  accepted(await bound.kei.amend({ markdown: "## Replace: Objective\n\nThe amended objective.\n" }));
  const amended = present(await bound.kei.state()).terms.document.bytes;
  accepted(await bound.kei.arc({ markdown: "# A historical chapter\n\nExact narrative body.\n" }));

  const semantic = await bound.kei.history();
  assert.ok(semantic.kind === "contract");
  assert.equal(semantic.contractId, bound.contractId);
  assert.deepEqual(
    semantic.events.map((event) => event.kind),
    ["bind", "amend", "arc"],
  );
  const amendment = semantic.events.find((event) => event.kind === "amend");
  assert.deepEqual(amendment?.changedSections, ["Objective"]);
  assert.equal(
    semantic.events.every((event) => !("document" in event)),
    true,
  );
  assertWireRoundTrip(contractHistorySchema, semantic);

  const facet = Keiyaku.at({
    cwd: repository.path,
    environment: {},
    home: temporaryDirectory(t, "history-full-home-"),
  });
  const full = await facet.run("history", { selector: bound.contractId, full: true });
  assert.ok(full.kind === "contract");
  const boundEvent = full.events.find((event) => event.kind === "bind");
  const amendedEvent = full.events.find((event) => event.kind === "amend");
  assert.ok(boundEvent?.kind === "bind");
  assert.ok(amendedEvent?.kind === "amend");
  assert.equal(boundEvent.document, original);
  assert.equal(amendedEvent.document, amended);
  assert.deepEqual(boundEvent.gates, ["reviewed"]);
  assert.deepEqual(amendedEvent.gates, ["reviewed"]);
  assert.deepEqual(amendedEvent.after, []);
  assert.notEqual(original, amended);
  assert.ok(
    full.events.every((event) =>
      event.kind === "bind" || event.kind === "amend" ? event.document !== undefined : true,
    ),
  );
  assertWireRoundTrip(contractHistorySchema, full);
  assert.deepEqual(await facet.run("history", { selector: bound.contractId }), semantic);
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

test("Contract history retains its journal and CLI content when unrelated Dispatch authority is malformed", async (t) => {
  const raw = repositoryWithMain();
  const repo = await Repo.at({ path: raw.path });
  const contracts = Keis.of(repo);
  const bound = accepted(await contracts.bind({ markdown: document(), target: null }));
  accepted(await bound.kei.amend({ markdown: "## Replace: Objective\n\nRetained amended objective.\n" }));
  accepted(await bound.kei.arc({ markdown: "# Retained chapter\n\nExact journal narrative.\n" }));
  const semantic = await bound.kei.history();
  assert.ok(semantic.kind === "contract");
  const before = await bound.kei.history({ full: true });
  assert.ok(before.kind === "contract");
  assert.equal(before.dispatches, undefined);
  const git = await repositoryAt(raw.path);
  const member = parseAkumaId("aku/worker/00000001").id;
  const unrelated = parseAkumaId("aku/worker/00000002").id;
  for (const [akumaId, owner] of [
    [member, bound.contractId],
    [unrelated, contractId("kei/unrelated")],
  ] as const) {
    assert.equal((await publishDispatch({ repository: git, akumaId, contractId: owner })).kind, "dispatched");
  }
  const healthy = await bound.kei.history({ full: true });
  assert.ok(healthy.kind === "contract");
  assert.equal(healthy.dispatches, undefined);
  assert.deepEqual(
    healthy.events.filter((event) => event.kind === "dispatch").map((event) => event.akumaId),
    [member],
  );
  assert.deepEqual(
    healthy.events.map((event) => event.at),
    healthy.events.map((event) => event.at).sort(),
  );
  const badPath = `dispatch/${createHash("sha256").update(unrelated).digest("hex")}.json`;
  await overwriteAuthority(
    raw.path,
    new Map([
      [
        badPath,
        `${JSON.stringify({ akuId: unrelated, contractId: "kei/unrelated", dispatchedAt: "2026-08-09T00:00:00.000Z" })}\n`,
      ],
    ]),
  );
  const facet = Keiyaku.at({ cwd: raw.path, environment: {}, home: temporaryDirectory(t, "history-corruption-home-") });
  for (const full of [false, true]) {
    const history = await bound.kei.history({ full });
    assert.ok(history.kind === "contract");
    assert.deepEqual(history.events, full ? before.events : semantic.events);
    assert.equal(history.dispatches?.kind, "unavailable");
    assert.equal(history.dispatches?.category, "authority-corruption");
    assert.ok(history.dispatches?.diagnostic.includes(badPath));
    assertWireRoundTrip(contractHistorySchema, history);
    assertWireRoundTrip(Keiyaku.verbs.history.output, history);
    assert.deepEqual(await facet.run("history", { selector: bound.contractId, full }), history);
    assert.equal(
      classifyVerb("history", { selector: bound.contractId, full }, { kind: "returned", value: history }),
      "accepted",
    );
    const argv = ["-C", raw.path, "history", bound.contractId, ...(full ? ["--full"] : [])];
    const json = await cliJson(argv, { environment: {} });
    assert.equal(json.exit, 0, json.stderr);
    assert.deepEqual(json.value, history);
    const text = await runCli(argv, { environment: {} });
    assert.equal(text.exit, 0, text.stderr);
    assert.match(text.stdout, /Retained chapter/u);
    assert.match(text.stdout, /Dispatch history unavailable/u);
    assert.ok(text.stdout.includes(badPath));
    if (full) {
      for (const event of before.events) {
        if (event.kind === "bind" || event.kind === "amend") {
          assert.ok(event.document);
          for (const line of event.document.trim().split("\n")) assert.ok(text.stdout.includes(line));
        }
      }
    }
    assert.deepEqual(await contracts.kei({ id: contractId("kei/missing") }).history({ full }), {
      kind: "contract-missing",
      contractId: "kei/missing",
    });
  }
  await overwriteAuthority(raw.path, new Map([[contractJournalPath(bound.contractId), "not a journal\n"]]));
  for (const full of [false, true]) {
    await assert.rejects(bound.kei.history({ full }), (error: unknown) => {
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
  const bound = accepted(await Keis.of(repo).bind({ markdown: document(), target: null }));
  const git = await repositoryAt(raw.path);
  assert.equal(
    (await publishDispatch({ repository: git, akumaId: parseAkumaId("aku/worker/00000003").id, contractId: bound.contractId })).kind,
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

test("history preserves observation and decode-channel retirement failures", async (t) => {
  const raw = repositoryWithMain();
  const bound = accepted(await Keis.of(await Repo.at({ path: raw.path })).bind({ markdown: document(), target: null }));
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
  const bound = accepted(await contracts.bind({ markdown: document(), target: null }));
  const facet = Keiyaku.at({ cwd: repository.path, environment: {}, home: temporaryDirectory(t, "guidance-home-") });
  const guidance = await bound.kei.guidance();
  assert.ok(guidance.kind === "present");
  assert.ok(guidance.guidance.includes("## Objective"));
  assert.deepEqual(await facet.show({ contract: bound.contractId }), guidance);
  assertWireRoundTrip(guidanceSchema, guidance);

  const missing = contracts.kei({ id: "kei/missing" as never });
  const missingGuidance = await missing.guidance();
  assert.deepEqual(missingGuidance, { kind: "missing" });
  const missingHistory = await missing.history({ full: true });
  assert.deepEqual(missingHistory, { kind: "contract-missing", contractId: "kei/missing" });
  assertWireRoundTrip(guidanceSchema, missingGuidance);
  assertWireRoundTrip(contractHistorySchema, missingHistory);
  assert.equal(classifyVerb("show", {}, { kind: "returned", value: missingGuidance }), "refused");
  assert.equal(
    classifyVerb("history", { selector: "kei/missing" }, { kind: "returned", value: missingHistory }),
    "refused",
  );
});
