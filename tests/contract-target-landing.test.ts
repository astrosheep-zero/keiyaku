import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Keis, Repo } from "../src/index.js";
import { accepted, document, present, repositoryWithMain } from "./support/library-verbs.js";
import { withGitShim } from "./support/git.js";

test("a child lands into the appointed parent without changing parent authority or main", async () => {
  const raw = repositoryWithMain({ files: { "base.txt": "base\n" } });
  const repo = await Repo.at({ path: raw.path });
  const contracts = Keis.of(repo);
  const parentBound = accepted(
    await contracts.bind({ markdown: document(), target: "main", gates: ["reviewed"] }),
  );
  const parent = parentBound.value.kei;
  const parentBefore = present(await parent.state());
  const parentPath = parentBound.value.workspace?.path;
  assert.ok(parentPath);
  const mainBefore = raw.run(["rev-parse", "main"]).trim();
  const bound = accepted(await contracts.bind({ markdown: document(), target: parentBefore.id, gates: [] }));
  const child = bound.value.kei;
  const childBefore = present(await child.state());
  assert.equal(typeof childBefore.coordinates.target, "object");
  assert.equal(childBefore.coordinates.start, raw.run(["-C", parentPath, "rev-parse", "HEAD"]).trim());
  const childPath = bound.value.workspace?.path;
  assert.ok(childPath);
  writeFileSync(join(parentPath, "local.txt"), "untouched\n");
  writeFileSync(join(childPath, "child.txt"), "landed\n");
  raw.run(["-C", childPath, "add", "child.txt"]);
  raw.run(["-C", childPath, "commit", "--quiet", "-m", "child"]);
  const delivered = accepted(await child.deliver());
  assert.equal(present(await child.state()).terminal?.kind, "claimed", JSON.stringify(delivered));
  assert.equal(raw.run(["rev-parse", "main"]).trim(), mainBefore);
  assert.equal(readFileSync(join(parentPath, "child.txt"), "utf8"), "landed\n");
  assert.equal(readFileSync(join(parentPath, "local.txt"), "utf8"), "untouched\n");
  assert.equal(present(await parent.state()).head, parentBefore.head);
});

test("unrelated targetless Contracts do not retain an abandoned unsealed workspace", async () => {
  const raw = repositoryWithMain();
  const repo = await Repo.at({ path: raw.path });
  const contracts = Keis.of(repo);
  accepted(await contracts.bind({ markdown: document(), target: null, gates: ["reviewed"] }));
  const second = accepted(await contracts.bind({ markdown: document(), target: null, gates: ["reviewed"] }));
  const path = second.value.workspace!.path;
  writeFileSync(join(path, "unsealed.txt"), "unsealed\n");
  const abandoned = accepted(await second.value.kei.abandon());
  assert.equal(existsSync(path), false);
  assert.ok(JSON.stringify(abandoned).includes("recovery-snapshot"));
});

test("a parent delivers combined content while the child's exact integration remains reachable", async () => {
  const raw = repositoryWithMain();
  const repo = await Repo.at({ path: raw.path });
  const contracts = Keis.of(repo);
  const parent = accepted(await contracts.bind({ markdown: document(), target: "main", gates: ["reviewed"] }));
  const parentId = present(await parent.value.kei.state()).id;
  const child = accepted(await contracts.bind({ markdown: document(), target: parentId, gates: [] }));
  const childPath = child.value.workspace!.path;
  writeFileSync(join(childPath, "child.txt"), "child\n");
  raw.run(["-C", childPath, "add", "child.txt"]);
  raw.run(["-C", childPath, "commit", "--quiet", "-m", "child"]);
  accepted(await child.value.kei.deliver());
  const integration = present(await child.value.kei.state()).currentIntegration!.snapshot;
  const parentPath = parent.value.workspace!.path;
  writeFileSync(join(parentPath, "parent.txt"), "parent\n");
  raw.run(["-C", parentPath, "add", "parent.txt"]);
  raw.run(["-C", parentPath, "commit", "--quiet", "-m", "parent"]);
  accepted(await parent.value.kei.deliver());
  accepted(await parent.value.kei.review({ verdict: "satisfied", summary: "Landing review passed" }));
  assert.equal(present(await parent.value.kei.state()).terminal?.kind, "claimed");
  assert.equal(existsSync(parentPath), false);
  assert.equal(raw.run(["show", "main:child.txt"]), "child\n");
  assert.equal(raw.run(["show", "main:parent.txt"]), "parent\n");
  assert.equal(raw.run(["cat-file", "-t", integration]).trim(), "commit");
  assert.ok(raw.run(["for-each-ref", "--contains", integration, "--format=%(refname)"]).trim());
});

test("siblings reintegrate against a moved parent without losing reviewed content", async () => {
  const raw = repositoryWithMain();
  const repo = await Repo.at({ path: raw.path });
  const contracts = Keis.of(repo);
  const parentBind = accepted(
    await contracts.bind({ markdown: document(), target: "main", gates: ["reviewed"] }),
  );
  const parent = parentBind.value.kei;
  const parentId = present(await parent.state()).id;
  const parentPath = parentBind.value.workspace!.path;
  const firstBind = accepted(
    await contracts.bind({ markdown: document("true"), target: parentId, gates: ["reviewed", "verified"] }),
  );
  const secondBind = accepted(await contracts.bind({ markdown: document(), target: parentId, gates: [] }));
  for (const [name, bound] of [
    ["first", firstBind],
    ["second", secondBind],
  ] as const) {
    const path = bound.value.workspace!.path;
    writeFileSync(join(path, `${name}.txt`), `${name}\n`);
    raw.run(["-C", path, "add", `${name}.txt`]);
    raw.run(["-C", path, "commit", "--quiet", "-m", name]);
  }
  accepted(await firstBind.value.kei.verify());
  accepted(await firstBind.value.kei.deliver());
  assert.equal(present(await firstBind.value.kei.state()).terminal, null);
  accepted(await secondBind.value.kei.deliver());
  const reviewed = accepted(await firstBind.value.kei.review({ verdict: "satisfied", summary: "Landing review passed" }));
  assert.equal(reviewed.value.gates?.find(({ gate }) => gate === "verified")?.requirements[0]?.current.kind, "stale");
  assert.equal(present(await firstBind.value.kei.state()).terminal, null);
  assert.equal(
    present(await firstBind.value.kei.state()).attestations.filter((entry) => entry.data.gate === "verified")
      .length,
    1,
  );
  accepted(await firstBind.value.kei.verify());
  const firstState = present(await firstBind.value.kei.state());
  assert.equal(firstState.terminal?.kind, "claimed");
  assert.equal(firstState.attestations.filter((entry) => entry.data.gate === "verified").length, 2);
  assert.equal(firstState.attestations.filter((entry) => entry.data.gate === "reviewed").length, 1);
  assert.equal(readFileSync(join(parentPath, "first.txt"), "utf8"), "first\n");
  assert.equal(readFileSync(join(parentPath, "second.txt"), "utf8"), "second\n");
  assert.equal(present(await parent.state()).terminal, null);
});

test("touching parent edits lag safely and recovery works after parent terminality", async () => {
  const raw = repositoryWithMain({ files: { "shared.txt": "base\n" } });
  const repo = await Repo.at({ path: raw.path });
  const contracts = Keis.of(repo);
  const parent = accepted(await contracts.bind({ markdown: document(), target: "main", gates: ["reviewed"] }));
  const parentId = present(await parent.value.kei.state()).id;
  const parentPath = parent.value.workspace!.path;
  const child = accepted(await contracts.bind({ markdown: document(), target: parentId, gates: [] }));
  const childPath = child.value.workspace!.path;
  writeFileSync(join(childPath, "shared.txt"), "child\n");
  raw.run(["-C", childPath, "add", "shared.txt"]);
  raw.run(["-C", childPath, "commit", "--quiet", "-m", "child"]);
  writeFileSync(join(parentPath, "shared.txt"), "parent edit\n");
  const landed = accepted(await child.value.kei.deliver());
  assert.equal(present(await child.value.kei.state()).terminal?.kind, "claimed");
  assert.equal(readFileSync(join(parentPath, "shared.txt"), "utf8"), "parent edit\n");
  assert.ok(JSON.stringify(landed).includes("target-checkout-retained"));
  accepted(await parent.value.kei.abandon());
  assert.equal(existsSync(parentPath), true);
  writeFileSync(join(parentPath, "shared.txt"), "base\n");
  raw.run(["-C", parentPath, "update-index", "--refresh"]);
  const repaired = await contracts.reconcile({ contract: present(await child.value.kei.state()).id });
  assert.ok(JSON.stringify(repaired).includes("recovered"), JSON.stringify(repaired));
  assert.equal(readFileSync(join(parentPath, "shared.txt"), "utf8"), "child\n");
});

test("recovery refuses to adopt a replacement even when its HEAD matches the accepted movement", async () => {
  const raw = repositoryWithMain({ files: { "shared.txt": "base\n" } });
  const repo = await Repo.at({ path: raw.path });
  const contracts = Keis.of(repo);
  const parent = accepted(await contracts.bind({ markdown: document(), target: "main", gates: ["reviewed"] }));
  const parentId = present(await parent.value.kei.state()).id;
  const parentPath = parent.value.workspace!.path;
  const child = accepted(await contracts.bind({ markdown: document(), target: parentId, gates: [] }));
  const childPath = child.value.workspace!.path;
  writeFileSync(join(childPath, "shared.txt"), "child\n");
  raw.run(["-C", childPath, "add", "shared.txt"]);
  raw.run(["-C", childPath, "commit", "--quiet", "-m", "child"]);
  writeFileSync(join(parentPath, "shared.txt"), "local\n");
  accepted(await child.value.kei.deliver());
  const state = present(await child.value.kei.state());
  assert.equal(state.terminal?.kind, "claimed");
  const integration = state.currentIntegration!.snapshot;
  raw.run(["worktree", "remove", "--force", parentPath]);
  raw.run(["worktree", "add", "--quiet", "--detach", parentPath, integration]);
  writeFileSync(join(parentPath, "preserve.txt"), "replacement\n");
  const result = await contracts.reconcile({ contract: state.id });
  assert.ok(result.lag.some((lag) => lag.kind === "target-workspace-retained" && lag.reason === "replaced"));
  assert.equal(readFileSync(join(parentPath, "preserve.txt"), "utf8"), "replacement\n");
  assert.equal(raw.run(["-C", parentPath, "rev-parse", "HEAD"]).trim(), integration);
});

test("ignored parent bytes refuse overwrite before child acceptance", async () => {
  const raw = repositoryWithMain({ files: { ".gitignore": "ignored.txt\n" } });
  const repo = await Repo.at({ path: raw.path });
  const contracts = Keis.of(repo);
  const parent = accepted(await contracts.bind({ markdown: document(), target: "main", gates: ["reviewed"] }));
  const parentId = present(await parent.value.kei.state()).id;
  const parentPath = parent.value.workspace!.path;
  const child = accepted(await contracts.bind({ markdown: document(), target: parentId, gates: [] }));
  const childPath = child.value.workspace!.path;
  writeFileSync(join(childPath, "ignored.txt"), "candidate\n");
  raw.run(["-C", childPath, "add", "-f", "ignored.txt"]);
  raw.run(["-C", childPath, "commit", "--quiet", "-m", "child"]);
  writeFileSync(join(parentPath, "ignored.txt"), "keep me\n");
  const before = raw.run(["-C", parentPath, "rev-parse", "HEAD"]).trim();
  const result = accepted(await child.value.kei.deliver());
  assert.ok(JSON.stringify(result).includes("checkout-not-followable"));
  assert.equal(present(await child.value.kei.state()).terminal, null);
  assert.equal(raw.run(["-C", parentPath, "rev-parse", "HEAD"]).trim(), before);
  assert.equal(readFileSync(join(parentPath, "ignored.txt"), "utf8"), "keep me\n");
});

test("fork inherits the exact target incarnation and refuses a replacement", async () => {
  const raw = repositoryWithMain();
  const repo = await Repo.at({ path: raw.path });
  const contracts = Keis.of(repo);
  const parent = accepted(await contracts.bind({ markdown: document(), target: "main", gates: ["reviewed"] }));
  const parentId = present(await parent.value.kei.state()).id;
  const child = accepted(await contracts.bind({ markdown: document(), target: parentId, gates: ["reviewed"] }));
  const source = present(await child.value.kei.state());
  const fork = accepted(await contracts.bind({ forkOf: source.id }));
  const inherited = present(await fork.value.kei.state());
  assert.deepEqual(inherited.coordinates.target, source.coordinates.target);
  assert.equal(inherited.coordinates.start, source.coordinates.start);
  const path = parent.value.workspace!.path;
  const head = raw.run(["-C", path, "rev-parse", "HEAD"]).trim();
  raw.run(["worktree", "remove", "--force", path]);
  raw.run(["worktree", "add", "--quiet", "--detach", path, head]);
  const refused = await contracts.bind({ forkOf: source.id });
  assert.equal(refused.kind, "refused", JSON.stringify(refused));
  if (refused.kind === "refused") {
    assert.equal(refused.refusal.kind, "target-workspace-unavailable");
    if (refused.refusal.kind === "target-workspace-unavailable") assert.equal(refused.refusal.reason, "replaced");
  }
});

test("a parent terminal before placement cannot receive an already delivered child", async () => {
  const raw = repositoryWithMain();
  const repo = await Repo.at({ path: raw.path });
  const contracts = Keis.of(repo);
  const parent = accepted(await contracts.bind({ markdown: document(), target: "main", gates: ["reviewed"] }));
  const parentId = present(await parent.value.kei.state()).id;
  const child = accepted(await contracts.bind({ markdown: document(), target: parentId, gates: ["reviewed"] }));
  const path = child.value.workspace!.path;
  writeFileSync(join(path, "child.txt"), "child\n");
  raw.run(["-C", path, "add", "child.txt"]);
  raw.run(["-C", path, "commit", "--quiet", "-m", "child"]);
  accepted(await child.value.kei.deliver());
  accepted(await parent.value.kei.abandon());
  accepted(await child.value.kei.review({ verdict: "satisfied", summary: "Landing review passed" }));
  assert.equal(present(await child.value.kei.state()).terminal, null);
  assert.equal(present(await parent.value.kei.state()).terminal?.kind, "abandoned");
});

test("parent terminality during Verification prevents the child's placement", async () => {
  const raw = repositoryWithMain();
  const repo = await Repo.at({ path: raw.path });
  const contracts = Keis.of(repo);
  const parent = accepted(await contracts.bind({ markdown: document(), target: "main", gates: ["reviewed"] }));
  const parentId = present(await parent.value.kei.state()).id;
  const started = join(raw.path, ".git", "verification-started");
  const release = join(raw.path, ".git", "verification-release");
  const script = `touch '${started}'; while [ ! -e '${release}' ]; do sleep 0.05; done`;
  const child = accepted(
    await contracts.bind({ markdown: document(script), target: parentId, gates: ["verified"] }),
  );
  const childPath = child.value.workspace!.path;
  writeFileSync(join(childPath, "child.txt"), "child\n");
  raw.run(["-C", childPath, "add", "child.txt"]);
  raw.run(["-C", childPath, "commit", "--quiet", "-m", "child"]);
  accepted(await child.value.kei.deliver());
  const landing = child.value.kei.verify();
  void landing.catch(() => undefined);
  try {
    for (let attempt = 0; attempt < 1500 && !existsSync(started); attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(existsSync(started), true, "Verification did not start");
    accepted(await parent.value.kei.abandon());
  } finally {
    writeFileSync(release, "go");
  }
  accepted(await landing);
  const childState = present(await child.value.kei.state());
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
    await contracts.bind({ markdown: document(), target: "main", gates: ["reviewed"] }),
  );
  const parent = parentBind.value.kei;
  const parentState = present(await parent.state());
  const parentPath = parentBind.value.workspace!.path;
  const childBind = accepted(await contracts.bind({ markdown: document(), target: parentState.id, gates: [] }));
  const child = childBind.value.kei;
  const childId = present(await child.state()).id;
  const childPath = childBind.value.workspace!.path;
  writeFileSync(join(childPath, "child.txt"), "landed\n");
  raw.run(["-C", childPath, "add", "child.txt"]);
  raw.run(["-C", childPath, "commit", "--quiet", "-m", "child"]);
  const marker = join(raw.path, ".git", "follow-started");
  const release = join(raw.path, ".git", "follow-release");
  await withGitShim(
    [
      'case " $* " in',
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
