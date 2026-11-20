import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Keis, Keiyaku, Repo, Settings } from "../src/index.js";
import { assertWireRoundTrip } from "./support/schema-parity.js";
import { accepted, document, present, repositoryWithMain } from "./support/library-verbs.js";
import { withGitShim } from "./support/git.js";
import { cliJson } from "./support/cli-fixtures.js";

test("a child lands into the appointed parent without changing parent authority or main", async () => {
  const raw = repositoryWithMain({ files: { "base.txt": "base\n", ".gitignore": "local.txt\n" } });
  const repo = await Repo.at({ path: raw.path });
  const contracts = Keis.of(repo);
  const parentBound = accepted(
    await contracts.bind({ terms: document(), target: "main", gates: ["reviewed"] }),
  );
  const parent = parentBound.kei;
  const parentBefore = present(await parent.state());
  const parentPath = parentBound.worktreePath;
  assert.ok(parentPath);
  const mainBefore = raw.run(["rev-parse", "main"]).trim();
  const bound = accepted(await contracts.bind({ terms: document(), target: parentBefore.id, gates: [] }));
  const child = bound.kei;
  const childBefore = present(await child.state());
  assert.equal(typeof childBefore.coordinates.target, "object");
  assert.equal(childBefore.coordinates.start, raw.run(["-C", parentPath, "rev-parse", "HEAD"]).trim());
  const childPath = bound.worktreePath;
  assert.ok(childPath);
  writeFileSync(join(parentPath, "local.txt"), "untouched\n");
  writeFileSync(join(childPath, "child.txt"), "landed\n");
  raw.run(["-C", childPath, "add", "child.txt"]);
  raw.run(["-C", childPath, "commit", "--quiet", "-m", "child"]);
  const delivered = accepted(await child.deliver());
  assert.equal(present(await child.state()).terminal?.kind, "claimed", JSON.stringify(delivered));
  assert.equal(delivered.placement?.kind, "placed");
  assert.equal(raw.run(["-C", parentPath, "rev-parse", "HEAD"]).trim(), delivered.integration);
  assert.equal(raw.run(["rev-parse", "main"]).trim(), mainBefore);
  assert.equal(readFileSync(join(parentPath, "child.txt"), "utf8"), "landed\n");
  assert.equal(readFileSync(join(parentPath, "local.txt"), "utf8"), "untouched\n");
  assert.equal(present(await parent.state()).head, parentBefore.head);
});

test("unrelated targetless Contracts do not retain an abandoned unsealed workspace", async () => {
  const raw = repositoryWithMain();
  const repo = await Repo.at({ path: raw.path });
  const contracts = Keis.of(repo);
  accepted(await contracts.bind({ terms: document(), target: null, gates: ["reviewed"] }));
  const second = accepted(await contracts.bind({ terms: document(), target: null, gates: ["reviewed"] }));
  const path = second.worktreePath!;
  writeFileSync(join(path, "unsealed.txt"), "unsealed\n");
  const abandoned = accepted(await second.kei.abandon());
  assert.equal(existsSync(path), false);
  assert.equal(abandoned.issues, undefined);
  const recovery = raw.run(["fsck", "--unreachable", "--no-reflogs"]).split("\n")
    .flatMap((line) => /^unreachable commit ([0-9a-f]+)$/u.exec(line)?.[1] ?? [])
    .find((oid) => raw.run(["show", "-s", "--format=%s", oid]).includes("ephemeral abandoned-workspace recovery"));
  assert.ok(recovery);
  assert.equal(raw.run(["show", `${recovery}:unsealed.txt`]), "unsealed\n");
});

test("a parent delivers combined content while the child's exact integration remains reachable", async () => {
  const raw = repositoryWithMain();
  const repo = await Repo.at({ path: raw.path });
  const contracts = Keis.of(repo);
  const parent = accepted(await contracts.bind({ terms: document(), target: "main", gates: ["reviewed"] }));
  const parentId = present(await parent.kei.state()).id;
  const child = accepted(await contracts.bind({ terms: document(), target: parentId, gates: [] }));
  const childPath = child.worktreePath!;
  writeFileSync(join(childPath, "child.txt"), "child\n");
  raw.run(["-C", childPath, "add", "child.txt"]);
  raw.run(["-C", childPath, "commit", "--quiet", "-m", "child"]);
  accepted(await child.kei.deliver());
  const integration = present(await child.kei.state()).currentIntegration!.snapshot;
  const parentPath = parent.worktreePath!;
  writeFileSync(join(parentPath, "parent.txt"), "parent\n");
  raw.run(["-C", parentPath, "add", "parent.txt"]);
  raw.run(["-C", parentPath, "commit", "--quiet", "-m", "parent"]);
  accepted(await parent.kei.deliver());
  accepted(await parent.kei.review({ verdict: "satisfied", summary: "Landing review passed" }));
  assert.equal(present(await parent.kei.state()).terminal?.kind, "claimed");
  assert.equal(existsSync(parentPath), false);
  assert.equal(raw.run(["show", "main:child.txt"]), "child\n");
  assert.equal(raw.run(["show", "main:parent.txt"]), "parent\n");
  assert.equal(raw.run(["cat-file", "-t", integration]).trim(), "commit");
  assert.ok(raw.run(["for-each-ref", "--contains", integration, "--format=%(refname)"]).trim());
});

test("siblings reintegrate against a moved parent without losing reviewed or optimistic verified content", async () => {
  const raw = repositoryWithMain();
  const repo = await Repo.at({ path: raw.path });
  const contracts = Keis.of(repo);
  const parentBind = accepted(
    await contracts.bind({ terms: document(), target: "main", gates: ["reviewed"] }),
  );
  const parent = parentBind.kei;
  const parentId = present(await parent.state()).id;
  const parentPath = parentBind.worktreePath!;
  const firstBind = accepted(
    await contracts.bind({ terms: document("true"), target: parentId, gates: ["reviewed", "verified"] }),
  );
  const secondBind = accepted(await contracts.bind({ terms: document(), target: parentId, gates: [] }));
  for (const [name, bound] of [
    ["first", firstBind],
    ["second", secondBind],
  ] as const) {
    const path = bound.worktreePath!;
    writeFileSync(join(path, `${name}.txt`), `${name}\n`);
    raw.run(["-C", path, "add", `${name}.txt`]);
    raw.run(["-C", path, "commit", "--quiet", "-m", name]);
  }
  accepted(await firstBind.kei.verify());
  accepted(await firstBind.kei.deliver());
  assert.equal(present(await firstBind.kei.state()).terminal, null);
  accepted(await secondBind.kei.deliver());
  const reviewed = accepted(await firstBind.kei.review({ verdict: "satisfied", summary: "Landing review passed" }));
  assert.equal(reviewed.placement?.kind, "placed");
  const firstState = present(await firstBind.kei.state());
  assert.equal(firstState.terminal?.kind, "claimed");
  assert.equal(firstState.attestations.filter((entry) => entry.data.gate === "verified").length, 1);
  assert.equal(firstState.attestations.filter((entry) => entry.data.gate === "reviewed").length, 1);
  assert.equal(readFileSync(join(parentPath, "first.txt"), "utf8"), "first\n");
  assert.equal(readFileSync(join(parentPath, "second.txt"), "utf8"), "second\n");
  assert.equal(present(await parent.state()).terminal, null);
});

test("touching parent edits lag safely and recovery works after parent terminality", async () => {
  const raw = repositoryWithMain({ files: { "shared.txt": "base\n" } });
  const repo = await Repo.at({ path: raw.path });
  const contracts = Keis.of(repo);
  const parent = accepted(await contracts.bind({ terms: document(), target: "main", gates: ["reviewed"] }));
  const parentId = present(await parent.kei.state()).id;
  const parentPath = parent.worktreePath!;
  const child = accepted(await contracts.bind({ terms: document(), target: parentId, gates: [] }));
  const childPath = child.worktreePath!;
  writeFileSync(join(childPath, "shared.txt"), "child\n");
  raw.run(["-C", childPath, "add", "shared.txt"]);
  raw.run(["-C", childPath, "commit", "--quiet", "-m", "child"]);
  writeFileSync(join(parentPath, "shared.txt"), "parent edit\n");
  const landed = accepted(await child.kei.deliver());
  assert.equal(present(await child.kei.state()).terminal?.kind, "claimed");
  assert.equal(readFileSync(join(parentPath, "shared.txt"), "utf8"), "parent edit\n");
  assert.ok(JSON.stringify(landed).includes("target-checkout-retained"));
  accepted(await parent.kei.abandon());
  assert.equal(existsSync(parentPath), true);
  writeFileSync(join(parentPath, "shared.txt"), "base\n");
  raw.run(["-C", parentPath, "update-index", "--refresh"]);
  const repaired = await contracts.reconcile({ contract: present(await child.kei.state()).id });
  assert.ok(repaired.kind === "contract");
  assert.ok((repaired.effects ?? []).some((effect) => effect.kind === "target-checkout"), JSON.stringify(repaired));
  assert.equal(readFileSync(join(parentPath, "shared.txt"), "utf8"), "child\n");
});

test("recovery refuses to adopt a replacement even when its HEAD matches the accepted movement", async () => {
  const raw = repositoryWithMain({ files: { "shared.txt": "base\n" } });
  const repo = await Repo.at({ path: raw.path });
  const contracts = Keis.of(repo);
  const parent = accepted(await contracts.bind({ terms: document(), target: "main", gates: ["reviewed"] }));
  const parentId = present(await parent.kei.state()).id;
  const parentPath = parent.worktreePath!;
  const child = accepted(await contracts.bind({ terms: document(), target: parentId, gates: [] }));
  const childPath = child.worktreePath!;
  writeFileSync(join(childPath, "shared.txt"), "child\n");
  raw.run(["-C", childPath, "add", "shared.txt"]);
  raw.run(["-C", childPath, "commit", "--quiet", "-m", "child"]);
  writeFileSync(join(parentPath, "shared.txt"), "local\n");
  accepted(await child.kei.deliver());
  const state = present(await child.kei.state());
  assert.equal(state.terminal?.kind, "claimed");
  const integration = state.currentIntegration!.snapshot;
  raw.run(["worktree", "remove", "--force", parentPath]);
  raw.run(["worktree", "add", "--quiet", "--detach", parentPath, integration]);
  writeFileSync(join(parentPath, "preserve.txt"), "replacement\n");
  const result = await contracts.reconcile({ contract: state.id });
  assert.ok(result.kind === "contract");
  assert.ok(
    (result.issues ?? []).some(
      (issue) => issue.kind === "target-workspace-retained" && issue.reason === "replaced",
    ),
  );
  assert.equal(readFileSync(join(parentPath, "preserve.txt"), "utf8"), "replacement\n");
  assert.equal(raw.run(["-C", parentPath, "rev-parse", "HEAD"]).trim(), integration);
});

test("ignored parent bytes follow the child candidate without changing main", async () => {
  const raw = repositoryWithMain({ files: { ".gitignore": "ignored.txt\n" } });
  const repo = await Repo.at({ path: raw.path });
  const contracts = Keis.of(repo);
  const parent = accepted(await contracts.bind({ terms: document(), target: "main", gates: ["reviewed"] }));
  const parentId = present(await parent.kei.state()).id;
  const parentPath = parent.worktreePath!;
  const child = accepted(await contracts.bind({ terms: document(), target: parentId, gates: [] }));
  const childPath = child.worktreePath!;
  writeFileSync(join(childPath, "ignored.txt"), "candidate\n");
  raw.run(["-C", childPath, "add", "-f", "ignored.txt"]);
  raw.run(["-C", childPath, "commit", "--quiet", "-m", "child"]);
  writeFileSync(join(parentPath, "ignored.txt"), "keep me\n");
  const mainBefore = raw.run(["rev-parse", "main"]).trim();
  const result = accepted(await child.kei.deliver());
  assert.equal(result.placement?.kind, "placed");
  assert.equal(present(await child.kei.state()).terminal?.kind, "claimed");
  assert.equal(raw.run(["-C", parentPath, "rev-parse", "HEAD"]).trim(), result.integration);
  assert.ok(!result.issues?.some((issue) => issue.kind === "target-checkout-retained"));
  assert.equal(raw.run(["-C", parentPath, "show", ":ignored.txt"]).trim(), "candidate");
  assert.equal(raw.run(["-C", parentPath, "status", "--porcelain"]), "");
  assert.equal(readFileSync(join(parentPath, "ignored.txt"), "utf8"), "candidate\n");
  assert.equal(raw.run(["rev-parse", "main"]).trim(), mainBefore);
});

test("fork inherits the exact target incarnation and refuses a replacement", async () => {
  const raw = repositoryWithMain();
  const repo = await Repo.at({ path: raw.path });
  const contracts = Keis.of(repo);
  const parent = accepted(await contracts.bind({ terms: document(), target: "main", gates: ["reviewed"] }));
  const parentId = present(await parent.kei.state()).id;
  const child = accepted(await contracts.bind({ terms: document(), target: parentId, gates: ["reviewed"] }));
  const source = present(await child.kei.state());
  const fork = accepted(await contracts.bind({ forkOf: source.id }));
  const inherited = present(await fork.kei.state());
  assert.deepEqual(inherited.coordinates.target, source.coordinates.target);
  assert.equal(inherited.coordinates.start, source.coordinates.start);
  const path = parent.worktreePath!;
  const head = raw.run(["-C", path, "rev-parse", "HEAD"]).trim();
  raw.run(["worktree", "remove", "--force", path]);
  raw.run(["worktree", "add", "--quiet", "--detach", path, head]);
  const refused = await contracts.bind({ forkOf: source.id });
  assert.deepEqual(refused, {
    kind: "refused",
    reason: { kind: "target-workspace-unavailable", targetContractId: parentId, reason: "replaced" },
  });
  assertWireRoundTrip(Keiyaku.verbs.bind.output, refused);
});

test("explicit retarget recovers a child of an accepted or abandoned parent with fresh verification", async (t) => {
  for (const [mode, disposition] of [
    ["optimistic", "accepted"], ["optimistic", "abandoned"],
    ["strict", "accepted"], ["strict", "abandoned"],
  ] as const) await t.test(`${mode}: ${disposition}`, async () => {
    const raw = repositoryWithMain();
    mkdirSync(join(raw.path, ".keiyaku"), { recursive: true });
    writeFileSync(join(raw.path, ".keiyaku", "settings.json"), JSON.stringify({ verification: { mode } }));
    const settings = await Settings.load({ cwd: raw.path, home: join(raw.path, ".git", "home") });
    const contracts = Keis.of(await Repo.at({ path: raw.path }), { settings });
    const parent = accepted(await contracts.bind({ terms: document(), target: "main", gates: [] }));
    const parentId = present(await parent.kei.state()).id;
    const child = accepted(await contracts.bind({
      terms: document("test -f child.txt"), target: parentId, gates: ["reviewed", "verified"],
    }));
    const path = child.worktreePath!;
    writeFileSync(join(path, "child.txt"), "child\n");
    raw.run(["-C", path, "add", "child.txt"]);
    raw.run(["-C", path, "commit", "--quiet", "-m", "child"]);
    const childHead = raw.run(["-C", path, "rev-parse", "HEAD"]).trim();
    accepted(await child.kei.review({ verdict: "satisfied", summary: "Child patch reviewed" }));
    const oldVerification = accepted(await child.kei.verify());
    const before = present(await child.kei.state());
    if (disposition === "accepted") accepted(await parent.kei.deliver());
    else accepted(await parent.kei.abandon());
    const stranded = await child.kei.deliver();
    assert.equal(stranded.kind, "refused");
    if (stranded.kind === "refused") assert.equal(stranded.reason.kind, "target-contract-terminal");

    const amended = await cliJson<{ kind: string; target?: string }>([
      "-C", raw.path, "amend", before.id, "--target", "main",
    ], { environment: {} });
    assert.equal(amended.value.kind, "accepted", amended.stdout);
    assert.equal(amended.value.target, "refs/heads/main");
    const state = present(await child.kei.state());
    assert.equal(state.coordinates.start, before.coordinates.start);
    assert.equal(state.coordinates.target, "refs/heads/main");
    assert.deepEqual(state.attestations, before.attestations, "amend must not rewrite testimony");
    assert.equal(raw.run(["-C", path, "rev-parse", "HEAD"]).trim(), childHead);
    const preview = await child.kei.previewDelivery();
    assert.equal(preview.kind, "ready");
    if (preview.kind !== "ready") assert.fail("retargeted candidate unavailable");
    assert.deepEqual(preview.unmetGates?.map(({ gate, state }) => ({ gate, state })), [{ gate: "verified", state: "stale" }]);
    const fresh = accepted(await child.kei.verify());
    if (disposition === "abandoned") assert.equal(fresh.snapshot, oldVerification.snapshot, "equal-head retarget still needs a fresh check");
    assert.ok(fresh.checks[0]?.kind === "terminal");
    assert.equal(fresh.checks[0].admission, "admitted");
    const delivered = accepted(await child.kei.deliver());
    assert.equal(delivered.placement?.kind, "placed", JSON.stringify(delivered));
    const final = present(await child.kei.state());
    assert.equal(final.terminal?.kind, "claimed");
    assert.equal(final.currentIntegration?.snapshot, fresh.snapshot);
    assert.equal(final.attestations.filter((entry) => entry.data.gate === "reviewed").length, 1);
    assert.equal(final.attestations.filter((entry) => entry.data.gate === "verified").length, 2);
    assert.equal(raw.run(["show", "main:child.txt"]), "child\n");
    assert.equal(existsSync(path), false);
  });
});

test("amend refuses a transitive destination cycle without changing authority", async () => {
  const raw = repositoryWithMain();
  const contracts = Keis.of(await Repo.at({ path: raw.path }));
  const parent = accepted(await contracts.bind({ terms: document(), target: "main", gates: ["reviewed"] }));
  const before = present(await parent.kei.state());
  const child = accepted(await contracts.bind({ terms: document(), target: before.id, gates: [] }));
  const refused = await parent.kei.amend({ target: present(await child.kei.state()).id });
  assert.equal(refused.kind, "refused", JSON.stringify(refused));
  if (refused.kind === "refused") assert.equal(refused.reason.kind, "cyclic-target");
  assert.deepEqual(present(await parent.kei.state()), before);
});

test("a parent terminal before placement cannot receive an already delivered child", async () => {
  const raw = repositoryWithMain();
  const repo = await Repo.at({ path: raw.path });
  const contracts = Keis.of(repo);
  const parent = accepted(await contracts.bind({ terms: document(), target: "main", gates: ["reviewed"] }));
  const parentId = present(await parent.kei.state()).id;
  const child = accepted(await contracts.bind({ terms: document(), target: parentId, gates: ["reviewed"] }));
  const path = child.worktreePath!;
  writeFileSync(join(path, "child.txt"), "child\n");
  raw.run(["-C", path, "add", "child.txt"]);
  raw.run(["-C", path, "commit", "--quiet", "-m", "child"]);
  accepted(await child.kei.deliver());
  accepted(await parent.kei.abandon());
  accepted(await child.kei.review({ verdict: "satisfied", summary: "Landing review passed" }));
  assert.equal(present(await child.kei.state()).terminal, null);
  assert.equal(present(await parent.kei.state()).terminal?.kind, "abandoned");
});

test("parent terminality during Verification prevents the child's placement", async () => {
  const raw = repositoryWithMain();
  const repo = await Repo.at({ path: raw.path });
  const contracts = Keis.of(repo);
  const parent = accepted(await contracts.bind({ terms: document(), target: "main", gates: ["reviewed"] }));
  const parentId = present(await parent.kei.state()).id;
  const started = join(raw.path, ".git", "verification-started");
  const release = join(raw.path, ".git", "verification-release");
  const script = `touch '${started}'; while [ ! -e '${release}' ]; do sleep 0.05; done`;
  const child = accepted(
    await contracts.bind({ terms: document(script), target: parentId, gates: ["verified"] }),
  );
  const childPath = child.worktreePath!;
  writeFileSync(join(childPath, "child.txt"), "child\n");
  raw.run(["-C", childPath, "add", "child.txt"]);
  raw.run(["-C", childPath, "commit", "--quiet", "-m", "child"]);
  accepted(await child.kei.deliver());
  const landing = child.kei.verify();
  void landing.catch(() => undefined);
  try {
    for (let attempt = 0; attempt < 1500 && !existsSync(started); attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(existsSync(started), true, "Verification did not start");
    accepted(await parent.kei.abandon());
  } finally {
    writeFileSync(release, "go");
  }
  accepted(await landing);
  const childState = present(await child.kei.state());
  assert.equal(childState.terminal, null);
  assert.ok(childState.delivery);
  assert.ok(
    childState.attestations.some((entry) => entry.data.gate === "verified" && entry.data.verdict === "satisfied"),
  );
});

test("parent cleanup waits for an already admitted child follow and retains its unsealed landing", async () => {
  const raw = repositoryWithMain();
  const repo = await Repo.at({ path: raw.path });
  const contracts = Keis.of(repo);
  const parentBind = accepted(
    await contracts.bind({ terms: document(), target: "main", gates: ["reviewed"] }),
  );
  const parent = parentBind.kei;
  const parentState = present(await parent.state());
  const parentPath = parentBind.worktreePath!;
  const childBind = accepted(await contracts.bind({ terms: document(), target: parentState.id, gates: [] }));
  const child = childBind.kei;
  const childId = present(await child.state()).id;
  const childPath = childBind.worktreePath!;
  writeFileSync(join(childPath, "child.txt"), "landed\n");
  raw.run(["-C", childPath, "add", "child.txt"]);
  raw.run(["-C", childPath, "commit", "--quiet", "-m", "child"]);
  const marker = join(raw.path, ".git", "follow-started");
  const release = join(raw.path, ".git", "follow-release");
  await withGitShim(
    [
      'case " $* " in',
      '  *" read-tree -m -u --dry-run "*) ;;',
      '  *" read-tree -m -u "*)',
      '    touch "$FOLLOW_STARTED"',
      '    i=0; while [ ! -e "$FOLLOW_RELEASE" ]; do i=$((i + 1)); if [ "$i" -ge 3000 ]; then exit 1; fi; sleep 0.01; done ;;',
      "esac",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { FOLLOW_STARTED: marker, FOLLOW_RELEASE: release },
    async (gitPath) => {
      const childAtShim = Keis.of(await Repo.at({ path: raw.path, gitPath })).kei({ id: childId });
      const landing = childAtShim.deliver();
      void landing.catch(() => undefined);
      let ending: ReturnType<typeof parent.abandon> | undefined;
      try {
        for (let attempt = 0; attempt < 1500 && !existsSync(marker); attempt += 1)
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(existsSync(marker), true, "follow did not start");
        assert.equal(present(await child.state()).terminal?.kind, "claimed");
        const integration = present(await child.state()).currentIntegration!.snapshot;
        assert.equal(raw.run(["-C", parentPath, "rev-parse", "HEAD"]).trim(), integration);
        ending = parent.abandon();
        void ending.catch(() => undefined);
        for (let attempt = 0; attempt < 200 && present(await parent.state()).terminal === null; attempt += 1)
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(present(await parent.state()).terminal?.kind, "abandoned");
        assert.equal(existsSync(parentPath), true);
        assert.equal(existsSync(join(parentPath, "child.txt")), false);
      } finally {
        writeFileSync(release, "go");
        await landing.catch(() => undefined);
        await ending?.catch(() => undefined);
      }
      accepted(await landing);
      assert.ok(ending);
      accepted(await ending);
      assert.equal(readFileSync(join(parentPath, "child.txt"), "utf8"), "landed\n");
      const integration = present(await child.state()).currentIntegration!.snapshot;
      assert.equal(raw.run(["cat-file", "-t", integration]).trim(), "commit");
      assert.ok(
        raw.run(["for-each-ref", "--format=%(objectname)", "refs/keiyaku/candidate"]).split("\n").includes(integration),
      );
    },
  );
});
