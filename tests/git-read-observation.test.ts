import assert from "node:assert/strict";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import test from "node:test";
import {
  GIT_FORMAT_BYTES,
  GIT_FORMAT_PATH,
  GIT_REF,
  readGitPaths,
  repositoryAt,
  updateGitTree,
  writeBlob,
  writeStateCommit,
} from "../src/git/repository.js";
import { contractId } from "../src/core/facts/types.js";
import { AuthorityCorruptionError } from "../src/core/facts/errors.js";
import { GitPlumbingError } from "../src/git/process.js";
import { parseTreeEntries } from "../src/git/tree.js";
import { mintSnapshotId } from "../src/git/identity.js";
import { readConflictHandoffs, recordConflictHandoff } from "../src/git/workspace.js";
import {
  readBlobResults,
  withGitDecodeChannel,
  withGitReadObservation,
  withGitTargetedReadObservation,
  type GitDecodeChannel,
  type GitReadObservation,
} from "../src/git/read-observation.js";
import { makeGitRepository, waitForFile, withGitShim } from "./support/git.js";

const MISSING_OID = "0000000000000000000000000000000000000000";

test("Git read observation returns typed missing objects and closes its capabilities", async () => {
  const repository = makeGitRepository();
  let retained: GitReadObservation | undefined;
  let retainedChannel: GitDecodeChannel | undefined;
  const git = await repositoryAt(repository.path);
  const result = await withGitDecodeChannel(git, (channel) => {
    retainedChannel = channel;
    return withGitReadObservation(git, channel, async (observation) => {
      retained = observation;
      return (await observation.readBlobs([MISSING_OID])).get(MISSING_OID);
    });
  });
  assert.deepEqual(result, { kind: "missing" });
  await assert.rejects(readGitPaths(git, ["../invalid"]), /invalid Git path/u);
  await assert.rejects(retained!.selectPaths([]), /Git read observation is closed/u);
  await assert.rejects(retained!.readBlobs([]), /Git read observation is closed/u);
  await assert.rejects(retained!.resolveRef("refs/heads/main"), /Git read observation is closed/u);
  await assert.rejects(retainedChannel!.readObjects([]), /Git decode channel is closed/u);
  await assert.rejects(retainedChannel!.readRef(GIT_REF), /Git decode channel is closed/u);
  await assert.rejects(retainedChannel!.readTreeSelection(MISSING_OID, {}), /Git decode channel is closed/u);
});

test("native tree parsing preserves literal names and rejects incomplete directory records", () => {
  const oid = "1".repeat(40);
  const name = "literal\tline\nfile";
  assert.deepEqual(parseTreeEntries(Buffer.from(`100644 blob ${oid}\t${name}\0`)).get(name), {
    mode: "100644",
    type: "blob",
    oid,
  });
  for (const output of [
    `100644 blob ${oid}\tname`,
    `100644 blob ${oid}\t\0`,
    `100644 unknown ${oid}\tname\0`,
    `100644 blob ${oid}\tname\0`.repeat(2),
  ])
    assert.throws(() => parseTreeEntries(Buffer.from(output)));
});

test("wrong-type state commits and immutable tree roots remain corruption", async () => {
  const raw = makeGitRepository();
  const git = await repositoryAt(raw.path);
  const blob = await writeBlob(git, "not a tree\n");
  // Raw fixture construction deliberately creates corrupt authority, not a production writer shim.
  const commit = raw
    .run(["hash-object", "--literally", "-w", "-t", "commit", "--stdin"], `tree ${blob}\n\ncorrupt root\n`)
    .trim();
  raw.run(["update-ref", GIT_REF, commit]);
  await assert.rejects(readGitPaths(git, []), AuthorityCorruptionError);
  await withGitDecodeChannel(git, async (channel) => {
    await assert.rejects(channel.readTreeSelection(commit, null), AuthorityCorruptionError);
    await assert.rejects(channel.readTreeSelection(MISSING_OID, {}), AuthorityCorruptionError);
  });
});

test("non-root directory objects retain corruption judgments in exact, subtree and full reads", async () => {
  const raw = makeGitRepository();
  const git = await repositoryAt(raw.path);
  const blob = await writeBlob(git, "a blob where a directory must be\n");
  const format = await writeBlob(git, GIT_FORMAT_BYTES);
  const meta = raw.run(["mktree"], `100644 blob ${format}\tformat.json\n`).trim();
  const corrupt = raw
    .run(
      ["hash-object", "--literally", "-w", "-t", "tree", "--stdin"],
      Buffer.concat([Buffer.from("40000 broken\0"), Buffer.from(blob, "hex")]),
    )
    .trim();
  const root = raw.run(["mktree"], `040000 tree ${meta}\tmeta\n040000 tree ${corrupt}\touter\n`).trim();
  const commit = await writeStateCommit({ repository: git, tree: root, parent: null });
  raw.run(["update-ref", GIT_REF, commit]);
  for (const selection of [{ paths: ["outer/broken/child"] }, { subtrees: ["outer"] }, null]) {
    await assert.rejects(
      withGitDecodeChannel(git, (channel) =>
        selection === null
          ? withGitReadObservation(git, channel, () => assert.fail("corrupt authority escaped"))
          : withGitTargetedReadObservation(git, channel, selection, () => assert.fail("corrupt authority escaped")),
      ),
      AuthorityCorruptionError,
    );
  }
});

test("overlapping finite reads await the independent child and retain both failures", async () => {
  const raw = makeGitRepository();
  const git = await repositoryAt(raw.path);
  const broken = await writeBlob(git, "corrupt loose object\n");
  const healthy = await writeBlob(git, "healthy sibling\n");
  const loose = join(raw.path, ".git", "objects", broken.slice(0, 2), broken.slice(2));
  chmodSync(loose, 0o600);
  writeFileSync(loose, deflateSync(Buffer.from("blob 100\0short")));
  for (const status of [0, 73]) {
    const started = join(raw.path, `sibling-${status}.pid`);
    const release = join(raw.path, `release-${status}`);
    await withGitShim(
      [
        'if [ "$1 $2" = "cat-file --batch" ]; then',
        "  IFS= read -r oid",
        '  if [ "$oid" = "$KEIYAKU_BROKEN_OID" ]; then',
        '    while [ ! -f "$KEIYAKU_STARTED" ]; do sleep 0.01; done',
        '    printf "%s\\n" "$oid" | "$KEIYAKU_REAL_GIT" "$@"',
        '    exit "$?"',
        "  fi",
        '  printf "%s\\n" "$oid" | "$KEIYAKU_REAL_GIT" "$@" || exit "$?"',
        '  echo "$$" > "$KEIYAKU_STARTED"',
        '  while [ ! -f "$KEIYAKU_RELEASE" ]; do sleep 0.01; done',
        '  exit "$KEIYAKU_LATE_STATUS"',
        "fi",
        'exec "$KEIYAKU_REAL_GIT" "$@"',
      ].join("\n"),
      {
        KEIYAKU_BROKEN_OID: broken,
        KEIYAKU_STARTED: started,
        KEIYAKU_RELEASE: release,
        KEIYAKU_LATE_STATUS: String(status),
      },
      async (gitPath) => {
        let failed!: () => void;
        const observedFailure = new Promise<void>((resolve) => {
          failed = resolve;
        });
        let operation: unknown;
        let settled = false;
        const controller = new AbortController();
        const backstop = setTimeout(() => controller.abort(), 5000);
        const scope = withGitDecodeChannel({ ...git, gitPath, signal: controller.signal }, (channel) =>
          Promise.all([
            channel.readObjects([broken]).catch((error) => {
              operation = error;
              failed();
              throw error;
            }),
            channel.readObjects([broken, healthy]),
          ]),
        );
        const outcome = scope.then(
          () => {
            settled = true;
            return { error: undefined };
          },
          (error: unknown) => {
            settled = true;
            return { error };
          },
        );
        try {
          await observedFailure;
          await new Promise<void>((resolve) => setImmediate(resolve));
          const pid = Number(readFileSync(started, "utf8"));
          process.kill(pid, 0);
          assert.ok(operation instanceof GitPlumbingError);
          assert.equal(settled, false, "scope must remain open until the sibling command retires");
        } finally {
          writeFileSync(release, "release\n");
          await outcome;
          clearTimeout(backstop);
        }
        const { error } = await outcome;
        if (status === 0) assert.equal(error, operation);
        else {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.cause, operation);
          assert.equal(error.errors[0], operation);
          assert.ok(error.errors[1] instanceof GitPlumbingError);
          assert.equal(error.errors[1].status, status);
        }
        const pid = Number(readFileSync(started, "utf8").trim());
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      },
    );
  }
});

test("native ls-tree failure survives unusable directory evidence", async (t) => {
  const raw = makeGitRepository();
  const git = await repositoryAt(raw.path);
  const format = await writeBlob(git, GIT_FORMAT_BYTES);
  const root = await updateGitTree(git, null, new Map([[GIT_FORMAT_PATH, { oid: format }]]));
  raw.run(["update-ref", GIT_REF, await writeStateCommit({ repository: git, tree: root, parent: null })]);
  const marker = join(raw.path, "tree-failed");
  for (const fault of ["partial tree", "malformed type", "malformed required type"]) {
    await t.test(fault, async () => {
      await withGitShim(
        [
          'if [ "$1" = "ls-tree" ]; then',
          '  "$KEIYAKU_REAL_GIT" "$@" || exit "$?"',
          '  if [ "$KEIYAKU_FAULT" = "partial tree" ]; then printf "040000 tree "; fi',
          '  touch "$KEIYAKU_MARKER"',
          '  echo "native disk read error" >&2; exit 73',
          'fi',
          'if [ "$1 $2" = "cat-file --batch-check=%(objectname) %(objecttype)" ] &&',
          '   { [ "$KEIYAKU_FAULT" = "malformed required type" ] ||',
          '     { [ "$KEIYAKU_FAULT" = "malformed type" ] && [ -f "$KEIYAKU_MARKER" ]; }; }; then',
          '  while IFS= read -r oid; do printf "%s blob\\n" "$oid"; done',
          '  printf truncated; exit 0',
          'fi',
          'exec "$KEIYAKU_REAL_GIT" "$@"',
        ].join("\n"),
        { KEIYAKU_FAULT: fault, KEIYAKU_MARKER: marker },
        async (gitPath) => {
          const scoped = { ...git, gitPath };
          await assert.rejects(withGitDecodeChannel(scoped, (channel) =>
            withGitReadObservation(scoped, channel, () => assert.fail("failed listing escaped")),
          ), (error) => {
            assert.ok(error instanceof GitPlumbingError, String(error));
            if (fault === "malformed required type") assert.match(error.message, /malformed .*batch-check/u);
            else {
              assert.equal(error.status, 73);
              assert.equal(error.stderr.toString(), "native disk read error\n");
            }
            return true;
          });
        },
      );
    });
    rmSync(marker, { force: true });
  }
});

test("handoff batching exposes ref, missing-object and finite command failures", async () => {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const git = await repositoryAt(repository.path);
  const coordinate = { contractId: contractId("kei/handoff-test"), place: "test", workspace: repository.path };
  const head = mintSnapshotId(repository.run(["rev-parse", "HEAD"]).trim());
  await recordConflictHandoff(git, { ...coordinate, head, mergeHead: head });
  const cases = [
    {
      body: 'if [ "$1 $2" = "cat-file --batch-check=%(objectname)" ]; then echo "ref read failed" >&2; exit 74; fi',
      expected: /ref read failed/u,
    },
    {
      body: 'if [ "$1 $2" = "cat-file --batch" ]; then while IFS= read -r oid; do printf "%s missing\\n" "$oid"; done; exit 0; fi',
      expected: /Git handoff receipt is missing/u,
    },
    {
      body: 'if [ "$1 $2" = "cat-file --batch" ]; then echo "blob read failed" >&2; exit 75; fi',
      expected: /cat-file --batch/u,
    },
  ];
  for (const { body, expected } of cases) {
    await withGitShim(`${body}\nexec "$KEIYAKU_REAL_GIT" "$@"`, {}, async (gitPath) => {
      const scoped = { ...git, gitPath };
      await assert.rejects(
        withGitDecodeChannel(scoped, (channel) =>
          readConflictHandoffs(scoped, (oids) => readBlobResults(channel, oids), [coordinate]),
        ),
        expected,
      );
    });
  }
});

test("a command that emits valid frames then fails exposes no partial successful batch", async () => {
  const repository = makeGitRepository();
  const git = await repositoryAt(repository.path);
  const oid = await writeBlob(git, "present\0payload\n");
  await withGitShim(
    'if [ "$1 $2" = "cat-file --batch" ]; then "$KEIYAKU_REAL_GIT" "$@"; exit 73; fi\nexec "$KEIYAKU_REAL_GIT" "$@"',
    {},
    async (gitPath) => {
      await withGitDecodeChannel({ ...git, gitPath }, async (channel) => {
        const results = await Promise.allSettled([channel.readObjects([oid, MISSING_OID]), channel.readObjects([oid])]);
        for (const result of results) {
          assert.equal(result.status, "rejected");
          if (result.status === "rejected") assert.match(result.reason.message, /git exited with status 73/u);
        }
      });
    },
  );
});

test("Git read cancellation awaits physical child retirement", async () => {
  const repository = makeGitRepository();
  const marker = join(repository.path, "batch-cancellation-pid");
  const controller = new AbortController();
  await withGitShim(
    [
      'if [ "$1 $2" = "cat-file --batch" ]; then',
      '  echo "$$" > "$KEIYAKU_BATCH_CANCEL_MARKER"',
      "  while :; do sleep 10; done",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_BATCH_CANCEL_MARKER: marker },
    async (gitPath) => {
      const git = { ...(await repositoryAt(repository.path, gitPath)), signal: controller.signal };
      const pending = assert.rejects(
        withGitDecodeChannel(git, (channel) => channel.readObjects([MISSING_OID])),
        /git process cancelled/u,
      );
      try {
        await waitForFile(marker);
      } finally {
        controller.abort();
      }
      await pending;
      const pid = Number(readFileSync(marker, "utf8").trim());
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    },
  );
});

test("finite batch parser rejects malformed, truncated and trailing frames for every affected caller", async () => {
  const repository = makeGitRepository();
  const other = "1".repeat(40);
  for (const frame of [
    `${other} blob 0\n\n`,
    `${MISSING_OID} missing\ntrailing bytes`,
    `${MISSING_OID} blob 0\n\n${other} blob 3\nx`,
  ]) {
    const fixture = join(repository.path, "batch-frame.mjs");
    writeFileSync(
      fixture,
      `process.stdin.resume(); process.stdin.on("end", () => process.stdout.end(${JSON.stringify(frame)}));`,
    );
    await withGitShim(
      'if [ "$1 $2" = "cat-file --batch" ]; then exec "$KEIYAKU_FRAME_NODE" "$KEIYAKU_FRAME_SCRIPT"; fi\nexec "$KEIYAKU_REAL_GIT" "$@"',
      { KEIYAKU_FRAME_NODE: process.execPath, KEIYAKU_FRAME_SCRIPT: fixture },
      async (gitPath) => {
        await withGitDecodeChannel(await repositoryAt(repository.path, gitPath), async (channel) => {
          const oids = frame.endsWith(`${other} blob 3\nx`) ? [MISSING_OID, other] : [MISSING_OID];
          const results = await Promise.allSettled([channel.readObjects(oids), channel.readObjects([MISSING_OID])]);
          for (const result of results) {
            assert.equal(result.status, "rejected");
            if (result.status === "rejected") assert.match(result.reason.message, /malformed cat-file --batch output/u);
          }
        });
      },
    );
  }
});

test("finite batches preserve binary payloads and share concurrent duplicate OIDs", async () => {
  const repository = makeGitRepository();
  const git = await repositoryAt(repository.path);
  const bytes = Buffer.concat([Buffer.from([0, 255, 10, 0]), Buffer.alloc(128 * 1024, 0x61), Buffer.from("\n")]);
  const oid = await writeBlob(git, bytes);
  const next = await writeBlob(git, "second\nblob\0");
  await withGitDecodeChannel(git, async (channel) => {
    const [first, second] = await Promise.all([
      channel.readObjects([oid, next, oid, MISSING_OID]),
      channel.readObjects([next, oid]),
    ]);
    assert.deepEqual([...first.keys()], [oid, next, MISSING_OID]);
    assert.deepEqual(first.get(oid), { kind: "present", type: "blob", bytes });
    assert.equal(second.get(oid), first.get(oid));
    assert.equal(second.get(next), first.get(next));
    assert.deepEqual(first.get(MISSING_OID), { kind: "missing" });
    const tree = repository.run(["mktree"], "").trim();
    await assert.rejects(readBlobResults(channel, [tree]), AuthorityCorruptionError);
    await assert.rejects(channel.readObjects(["HEAD"]), /not a Git object ID/u);
  });
});

test("selected and extended reads retain immutable roots, directory entries and per-epoch refs", async () => {
  const raw = makeGitRepository();
  const git = await repositoryAt(raw.path);
  const old = await writeBlob(git, "old\n");
  const fresh = await writeBlob(git, "fresh\n");
  const format = await writeBlob(git, GIT_FORMAT_BYTES);
  const root = await updateGitTree(
    git,
    null,
    new Map([
      [GIT_FORMAT_PATH, { oid: format }],
      ["selected/one", { oid: old }],
      ["selected/two", { oid: old }],
      ["foreign/value", { oid: fresh }],
      ["wrong", { oid: old }],
    ]),
  );
  const before = await writeStateCommit({ repository: git, tree: root, parent: null });
  raw.run(["update-ref", GIT_REF, before]);
  const changed = await updateGitTree(git, root, new Map([["selected/two", { oid: fresh }]]));
  const after = await writeStateCommit({ repository: git, tree: changed, parent: before });
  await withGitDecodeChannel(git, async (channel) => {
    await withGitTargetedReadObservation(git, channel, { paths: ["selected/one", "wrong/child"] }, async (epoch) => {
      assert.equal(epoch.snapshot.paths.get("selected/one")?.oid, old);
      assert.equal(epoch.snapshot.paths.get("wrong")?.type, "blob");
      assert.equal(epoch.snapshot.paths.has("foreign/value"), false);
      raw.run(["update-ref", GIT_REF, after]);
      assert.equal(await epoch.resolveRef(GIT_REF), before);
      const extended = await epoch.selectPaths(["selected/two"]);
      assert.equal(extended.get("selected/two")?.oid, old);
      const exact = await epoch.selectPaths(["selected"]);
      assert.equal(exact.get("selected")?.type, "tree");
      assert.equal(exact.has("selected/one"), false);
      const subtree = await channel.readTreeSelection(root, { subtrees: ["selected"] });
      assert.equal(subtree.get("selected")?.type, "tree");
      assert.equal(subtree.get("selected/two")?.oid, old);
      assert.equal(subtree.has("foreign/value"), false);
    });
    await withGitTargetedReadObservation(git, channel, { paths: ["selected/two"] }, (next) => {
      assert.equal(next.snapshot.commit, after);
      assert.equal(next.snapshot.paths.get("selected/two")?.oid, fresh);
    });
  });
  assert.equal((await readGitPaths(git, ["selected/two"])).paths.get("selected/two")?.oid, fresh);
});
