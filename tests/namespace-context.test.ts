import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../src/cli/main.js";
import { captureOutput, cliJson } from "./support/cli-fixtures.js";
import { makeGitRepository } from "./support/git.js";
import { document } from "./support/library-verbs.js";
import { installNamespaceContext, repairNamespaceContext, resolveDebtNamespaceContext } from "../src/debt/context.js";

function temporary(): string {
  return mkdtempSync(join(tmpdir(), "keiyaku-namespace-"));
}

test("namespace context stores root and nested namespaces in canonical bytes", async () => {
  const root = temporary();
  const coordinates = { directory: root, boundary: root };
  assert.deepEqual(await resolveDebtNamespaceContext(coordinates), { namespace: [], source: "default-root" });
  await installNamespaceContext(root, ["contract", "inside"]);
  assert.deepEqual(await resolveDebtNamespaceContext(coordinates), {
    namespace: ["contract", "inside"],
    source: "local-override",
  });
  assert.equal(readFileSync(join(root, ".keiyaku", "namespace", ".gitignore"), "utf8"), "*\n");
  assert.equal(readFileSync(join(root, ".keiyaku", "namespace", "current"), "utf8"), "contract/inside\n");
  await installNamespaceContext(root, []);
  assert.deepEqual(await resolveDebtNamespaceContext(coordinates), { namespace: [], source: "local-override" });
  assert.equal(readFileSync(join(root, ".keiyaku", "namespace", "current"), "utf8"), "\n");
});
test("repair replaces malformed current bytes and readers reject symlinks", async () => {
  const root = temporary(),
    directory = join(root, ".keiyaku", "namespace");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "current"), "Bad Namespace\n");
  assert.deepEqual(await resolveDebtNamespaceContext({ directory: root, boundary: root }), {
    kind: "invalid-namespace-context",
    path: join(root, ".keiyaku", "namespace", "current"),
  });
  assert.equal(await repairNamespaceContext(root, ["default"]), "installed");
  assert.deepEqual(await resolveDebtNamespaceContext({ directory: root, boundary: root }), {
    namespace: ["default"],
    source: "local-override",
  });

  const linked = temporary(),
    target = join(linked, "target");
  mkdirSync(join(linked, ".keiyaku", "namespace"), { recursive: true });
  writeFileSync(target, "linked\n");
  symlinkSync(target, join(linked, ".keiyaku", "namespace", "current"));
  assert.deepEqual(await resolveDebtNamespaceContext({ directory: linked, boundary: linked }), {
    kind: "invalid-namespace-context",
    path: join(linked, ".keiyaku", "namespace", "current"),
  });
});

test("nested directories inherit the boundary namespace and a nearer context overrides it", async () => {
  const root = temporary(),
    nested = join(root, "src", "deep");
  mkdirSync(nested, { recursive: true });
  await installNamespaceContext(root, ["kei", "installed"]);
  const installed = { namespace: ["kei", "installed"], source: "local-override" };
  assert.deepEqual(await resolveDebtNamespaceContext({ directory: root, boundary: root }), installed);
  assert.deepEqual(await resolveDebtNamespaceContext({ directory: join(root, "src"), boundary: root }), installed);
  assert.deepEqual(await resolveDebtNamespaceContext({ directory: nested, boundary: root }), installed);

  await installNamespaceContext(join(root, "src"), ["kei", "nearer"]);
  assert.deepEqual(await resolveDebtNamespaceContext({ directory: nested, boundary: root }), {
    namespace: ["kei", "nearer"],
    source: "local-override",
  });
  assert.deepEqual(await resolveDebtNamespaceContext({ directory: root, boundary: root }), installed);
});

test("namespace source attribution follows the directory that answered", async () => {
  const root = temporary(),
    src = join(root, "src");
  mkdirSync(src, { recursive: true });
  assert.deepEqual(await resolveDebtNamespaceContext({ directory: src, boundary: root, managed: true }), {
    namespace: [],
    source: "default-root",
  });
  await installNamespaceContext(root, ["kei", "installed"]);
  assert.deepEqual(await resolveDebtNamespaceContext({ directory: src, boundary: root, managed: true }), {
    namespace: ["kei", "installed"],
    source: "contract-installed",
  });
  assert.deepEqual(await resolveDebtNamespaceContext({ directory: src, boundary: root, managed: false }), {
    namespace: ["kei", "installed"],
    source: "local-override",
  });
  await installNamespaceContext(src, ["kei", "nearer"]);
  assert.deepEqual(await resolveDebtNamespaceContext({ directory: src, boundary: root, managed: true }), {
    namespace: ["kei", "nearer"],
    source: "local-override",
  });
});

test("the ancestor walk stops at the boundary instead of escaping to an outer context", async () => {
  const outer = temporary(),
    world = join(outer, "world"),
    nested = join(world, "src");
  mkdirSync(nested, { recursive: true });
  await installNamespaceContext(outer, ["outside"]);
  assert.deepEqual(await resolveDebtNamespaceContext({ directory: nested, boundary: world, managed: true }), {
    namespace: [],
    source: "default-root",
  });

  await installNamespaceContext(world, ["inside"]);
  assert.deepEqual(await resolveDebtNamespaceContext({ directory: nested, boundary: world }), {
    namespace: ["inside"],
    source: "local-override",
  });
});

test("a public bind's appointed worktree inherits its installed namespace and shares the Debt World", async () => {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const environment = { KEIYAKU_HOME: join(raw.path, "empty-home") };
  const bound = await cliJson<
    Readonly<{ kind: string; contract: string; value: Readonly<{ workspace: Readonly<{ path: string }> }> }>
  >(["-C", raw.path, "bind", "--gates", "", "-"], { environment, readStdin: async () => document() });
  assert.equal(bound.value.kind, "accepted", JSON.stringify(bound.value));
  const slug = bound.value.contract.slice("kei/".length),
    worktree = bound.value.value.workspace.path,
    namespace = ["kei", slug],
    src = join(worktree, "src");
  mkdirSync(src, { recursive: true });

  for (const directory of [worktree, src])
    assert.deepEqual(
      (await cliJson<Readonly<{ value: unknown }>>(["-C", directory, "debt", "context"], { environment })).value.value,
      { namespace, source: "contract-installed" },
    );

  const added = await cliJson<Readonly<{ value: Readonly<{ id: string }> }>>(
    ["-C", src, "debt", "add", "Worktree ledger entry"],
    { environment },
  );
  const id = added.value.value.id,
    local = id.slice(id.lastIndexOf("/") + 1);
  assert.equal(id, `debt/kei/${slug}/${local}`);
  assert.ok(existsSync(join(raw.path, ".keiyaku", "debts", "kei", slug, `${local}.md`)));
  assert.equal(existsSync(join(worktree, ".keiyaku", "debts")), false);
});

function malformedContext(): { root: string; current: string } {
  const root = realpathSync.native(temporary()),
    current = join(root, ".keiyaku", "namespace", "current");
  mkdirSync(join(root, ".keiyaku", "namespace"), { recursive: true });
  writeFileSync(current, "Bad Namespace\n");
  return { root, current };
}

test("an explicit context replacement installs the supplied namespace over malformed current bytes", async () => {
  const { root, current } = malformedContext();
  const replaced = await cliJson<unknown>(["-C", root, "debt", "context", "good/place"], { environment: {} });
  assert.equal(replaced.exit, 0, replaced.stderr);
  assert.deepEqual(replaced.value, {
    kind: "accepted",
    value: { namespace: ["good", "place"], source: "local-override" },
  });
  assert.equal(readFileSync(current, "utf8"), "good/place\n");
  const read = await cliJson<unknown>(["-C", root, "debt", "context"], { environment: {} });
  assert.equal(read.exit, 0, read.stderr);
  assert.deepEqual(read.value, {
    kind: "accepted",
    value: { namespace: ["good", "place"], source: "local-override" },
  });
  const added = await cliJson<{ value: { id: string } }>(["-C", root, "debt", "add", "Spawned"], { environment: {} });
  assert.equal(added.exit, 0, added.stderr);
  assert.match(added.value.value.id, /^debt\/good\/place\//u);
});

test("a malformed context still refuses the operations that need the default", async () => {
  const { root, current } = malformedContext();
  const refusal = { kind: "invalid-namespace-context", path: current };
  for (const argv of [["context"], ["ls"], ["add", "Needs the default"]]) {
    const result = await cliJson<unknown>(["-C", root, "debt", ...argv], { environment: {} });
    assert.equal(result.exit, 1, `${argv.join(" ")}: ${result.stderr}`);
    assert.deepEqual(result.value, { kind: "refused", refusal });
  }
  assert.equal(readFileSync(current, "utf8"), "Bad Namespace\n");
  assert.equal(existsSync(join(root, ".keiyaku", "debts")), false);
});

test("an unusable context replacement refuses before the installed bytes are touched", async () => {
  const { root, current } = malformedContext();
  for (const invalid of ["Bad Name", "good//place", ".."]) {
    const result = await captureOutput(() => main(["-C", root, "debt", "context", invalid]));
    assert.equal(result.exit, 64, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /namespace must contain normalized segments/u);
    assert.equal(readFileSync(current, "utf8"), "Bad Namespace\n");
  }
});
