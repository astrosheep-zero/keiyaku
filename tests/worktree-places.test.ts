import { accepted, present } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import { projectSettings } from "../src/settings.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { describe } from "node:test";
import {
  appointManagedWorktrees,
  appointmentFor,
  canonicalPlaceRegister,
  decodePlaceRegister,
  emptyPlaceRegister,
  nukeEmptyPlaceAuthority,
  place,
  placeRegisterPath,
  readManagedWorktreeAppointment,
  readPlaceRegister,
  releaseManagedWorktrees,
} from "../src/workspace-place.js";
import { AuthorityCorruptionError } from "../src/core/facts/errors.js";
import { contractId } from "../src/core/facts/types.js";
import { contractLocator } from "../src/git/identity.js";
import { worktreePath } from "../src/git/workspace.js";
import { cliJson } from "./support/cli-fixtures.js";
import { Keis, KeiyakuError, Repo } from "../src/index.js";
import { Debts } from "../src/debt/index.js";
import { World } from "../src/world.js";
import { cachedRepositoryAt, makeGitRepository, withGitShim } from "./support/git.js";

const repositoryAt = cachedRepositoryAt;

const EXAMPLE = contractId("kei/example");
const OTHER = contractId("kei/other");
const EMPTY = '{"version":1,"appointments":{}}\n';
const EXAMPLE_PLACE = "w-6c56a4cd5854176ebf341f0731837916caaac309215095407d50d5e262f6330e";
const OTHER_PLACE = "w-0c842e11b43cefd6da37c6639bd3cf4004d9a7bfdaaff8c11720f60fca8ee6d7";

function repositoryWithCommit() {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  return repository;
}


function contractBody(title: string): string {
  return contractMarkdown(title, {
    Context: "Place worktree.",
    Objective: "Keep Place appointments.",
    Design: "Use the appointed Place path.",
    Region: "```\nsrc/**\n```",
    Criteria: "### Result\nThe appointed Place is reused.\n",
  });
}

// Each case owns its repository, fault injector and cleanup; no process-global mocks.
describe("worktree-places isolated fixtures", { concurrency: 3 }, () => {
  test("Place labels are portable lowercase basenames, not a named vocabulary", () => {
    for (const label of ["a", "litterbox2", "not-a-place", EXAMPLE_PLACE]) {
      assert.equal(place(label), label);
    }
    const unsafe = ["", "2place", "Atlantis", "\u00e9", "a/../b", "a\\b", "a.b", "a b", "a\n", "a\0"];
    const devices = ["con", "prn", "aux", "nul", "com1", "lpt9"];
    for (const label of [...unsafe, ...devices]) {
      assert.throws(() => place(label), TypeError, JSON.stringify(label));
    }
  });

  test("missing Place file is empty and written empty remains canonical", async () => {
    const repository = await repositoryAt(repositoryWithCommit().path);
    const path = join(repository.commonDirectory, "keiyaku", "places.json");
    assert.equal(existsSync(path), false);
    assert.deepEqual(await readPlaceRegister(repository), emptyPlaceRegister());
    await releaseManagedWorktrees(repository, [EXAMPLE]);
    assert.equal(readFileSync(path, "utf8"), EMPTY);
  });

  test("corrupt Place bytes are authority corruption", () => {
    const path = "places.json";
    assert.throws(
      () => decodePlaceRegister(path, '{"version":1,"appointments":{"atlantis":"kei/example"}}'),
      AuthorityCorruptionError,
    );
    assert.throws(() => decodePlaceRegister(path, '{"appointments":{},"version":1}\n'), AuthorityCorruptionError);
    assert.throws(() => decodePlaceRegister(path, '{"version":2,"appointments":{}}\n'), AuthorityCorruptionError);
    assert.throws(
      () => decodePlaceRegister(path, '{"version":1,"appointments":{"Atlantis":"kei/example"}}\n'),
      AuthorityCorruptionError,
    );
    assert.throws(
      () => decodePlaceRegister(path, '{"version":1,"appointments":{"atlantis":"not-a-contract"}}\n'),
      AuthorityCorruptionError,
    );
    assert.throws(
      () =>
        decodePlaceRegister(path, '{"version":1,"appointments":{"atlantis":"kei/example","hogwarts":"kei/example"}}\n'),
      AuthorityCorruptionError,
    );
    assert.throws(
      () => decodePlaceRegister(path, '{"version":1,"appointments":{"atlantis":"kei/example","atlantis":"kei/other"}}\n'),
      AuthorityCorruptionError,
    );
  });

  test("concurrent appoint and release preserve every mapping", async () => {
    const repository = await repositoryAt(repositoryWithCommit().path);
    const first = Array.from({ length: 8 }, (_, index) => contractId(`kei/first-${index}`));
    const second = Array.from({ length: 8 }, (_, index) => contractId(`kei/second-${index}`));
    await appointManagedWorktrees(repository, first);
    await Promise.all([releaseManagedWorktrees(repository, first), appointManagedWorktrees(repository, second)]);
    const register = await readPlaceRegister(repository);
    assert.equal(register.size, second.length);
    assert.deepEqual(new Set(register.keys()), new Set(second));
    assert.equal(new Set(register.values()).size, second.length);
    assert.equal(
      readFileSync(join(repository.commonDirectory, "keiyaku", "places.json"), "utf8"),
      canonicalPlaceRegister(register),
    );
  });

  test("appointment after a concurrent release uses the locked on-disk register", async () => {
    const repository = await repositoryAt(repositoryWithCommit().path);
    const firstRegister = await appointManagedWorktrees(repository, [EXAMPLE]);
    const first = firstRegister.get(EXAMPLE)!;
    const snapshot = await readPlaceRegister(repository);
    await releaseManagedWorktrees(repository, [EXAMPLE]);
    const reusedRegister = await appointManagedWorktrees(repository, [OTHER]);
    const reused = reusedRegister.get(OTHER)!;
    const appointed = await appointManagedWorktrees(repository, [EXAMPLE]);
    assert.equal(snapshot.get(EXAMPLE), first);
    assert.equal(reused, OTHER_PLACE);
    assert.equal(appointed.get(EXAMPLE), EXAMPLE_PLACE);
    assert.deepEqual(await readPlaceRegister(repository), appointed);
  });

  test("allocation skips occupied candidates in order and publishes two appointments in one batch", async () => {
    const fixture = repositoryWithCommit();
    const git = await repositoryAt(fixture.path);
    const held = contractId("kei/held");
    mkdirSync(join(git.commonDirectory, "keiyaku"), { recursive: true });
    writeFileSync(placeRegisterPath(git), `{"version":1,"appointments":{"${EXAMPLE_PLACE}":"${held}"}}\n`);

    const registered = worktreePath(git, `${EXAMPLE_PLACE}-2`);
    fixture.run(["worktree", "add", "--quiet", "--detach", registered]);
    rmSync(registered, { recursive: true });
    const directory = worktreePath(git, `${EXAMPLE_PLACE}-3`);
    const file = worktreePath(git, `${EXAMPLE_PLACE}-4`);
    const link = worktreePath(git, `${EXAMPLE_PLACE}-5`);
    mkdirSync(directory);
    writeFileSync(file, "foreign\n");
    symlinkSync(join(directory, "missing"), link, "file");
    const topology = fixture.run(["worktree", "list", "--porcelain"]);

    await appointManagedWorktrees(git, [EXAMPLE, OTHER, EXAMPLE]);
    const register = await readPlaceRegister(git);
    assert.equal(appointmentFor(register, held)?.place, EXAMPLE_PLACE);
    assert.equal(appointmentFor(register, EXAMPLE)?.place, `${EXAMPLE_PLACE}-6`);
    assert.equal(appointmentFor(register, OTHER)?.place, OTHER_PLACE);
    assert.equal(existsSync(worktreePath(git, EXAMPLE_PLACE)), false);
    assert.equal(existsSync(registered), false);
    assert.equal(fixture.run(["worktree", "list", "--porcelain"]), topology);
    assert.equal(lstatSync(directory).isDirectory(), true);
    assert.equal(readFileSync(file, "utf8"), "foreign\n");
    assert.equal(lstatSync(link).isSymbolicLink(), true);
  });

  for (const parentAlias of [false, true]) {
    const scenario = parentAlias ? "aliased parent" : "case-variant leaf";
    test(`new appointments honor native Git equality for a missing foreign registration: ${scenario}`, async () => {
      const fixture = repositoryWithCommit();
      const git = await repositoryAt(fixture.path);
      const keis = Keis.of(await Repo.at({ path: fixture.path }));
      const bound = accepted(await keis.bind({ terms: contractBody("Missing foreign registration") }));
      const { id } = present(await bound.kei.state());
      const stem = `w-${contractLocator(id)}`;
      const candidate = worktreePath(git, stem);
      fixture.run(["worktree", "remove", candidate]);
      await releaseManagedWorktrees(git, [id]);

      const foreign = parentAlias
        ? join(fixture.path, "foreign-parent", stem)
        : worktreePath(git, stem.toUpperCase());
      fixture.run(["worktree", "add", "--quiet", "--detach", foreign]);
      const moved = join(fixture.path, "moved-checkout");
      renameSync(foreign, moved);
      if (parentAlias) {
        rmdirSync(dirname(foreign));
        if (process.platform === "win32") {
          symlinkSync(dirname(candidate), dirname(foreign), "junction");
        } else {
          // Git must follow the pivot before interpreting '..'. A lexical realpath
          // would land under the primary checkout instead of the managed root.
          const inside = join(dirname(candidate), "inside");
          mkdirSync(inside);
          symlinkSync(inside, join(fixture.path, "pivot"), "dir");
          symlinkSync("pivot/..", dirname(foreign), "dir");
        }
      }
      // An unrelated registration below a non-directory likewise stays untouched.
      const blockedParent = join(fixture.path, "replaced-parent");
      fixture.run(["worktree", "add", "--quiet", "--detach", join(blockedParent, "foreign")]);
      renameSync(blockedParent, join(fixture.path, "moved-parent"));
      writeFileSync(blockedParent, "foreign file\n");
      const topology = () => fixture.run(["worktree", "list", "--porcelain", "-z"]);
      const originalTopology = topology();
      assert.equal(existsSync(candidate), false);

      // Probe Git itself; where the spellings are distinct the control add succeeds and is retired.
      const native = spawnSync(git.gitPath, ["worktree", "add", "--quiet", "--detach", candidate], {
        cwd: fixture.path,
        encoding: "utf8",
      });
      const expected = native.status === 0 ? stem : `${stem}-2`;
      if (native.status === 0) {
        assert.equal(parentAlias, false, "Git must follow the registered parent alias");
        fixture.run(["worktree", "remove", candidate]);
      } else {
        assert.equal(native.status, 128, native.error?.message ?? native.stderr);
        assert.match(native.stderr, /missing but already registered/u);
      }
      assert.equal(topology(), originalTopology);

      const path = worktreePath(git, expected);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const reconciled = await keis.reconcile({ contract: id });
        assert.ok(reconciled.kind === "contract");
        assert.equal((await readPlaceRegister(git)).get(id), expected);
        assert.deepEqual(reconciled.issues ?? [], []);
        assert.equal(resolve(fixture.run(["-C", path, "rev-parse", "--show-toplevel"]).trim()), path);
      }
      const registrations = originalTopology.split("\0\0").slice(1, -1);
      assert.equal(registrations.length, 2);
      const finalTopology = topology().split("\0\0");
      for (const registration of registrations) assert.ok(finalTopology.includes(registration));
      assert.equal(existsSync(join(moved, ".git")), true);
    });
  }

  test("an lstat observation failure aborts allocation without a register or Git effects", async () => {
    const fixture = repositoryWithCommit();
    const git = await repositoryAt(fixture.path);
    const parent = join(git.primaryWorktree, ".keiyaku");
    mkdirSync(parent);
    const file = join(parent, "wt");
    writeFileSync(file, "foreign\n");
    const refs = fixture.run(["show-ref"]);
    const topology = fixture.run(["worktree", "list", "--porcelain"]);

    await assert.rejects(appointManagedWorktrees(git, [EXAMPLE]), { code: "ENOTDIR" });
    assert.equal(existsSync(placeRegisterPath(git)), false);
    assert.equal(fixture.run(["show-ref"]), refs);
    assert.equal(fixture.run(["worktree", "list", "--porcelain"]), topology);
    assert.equal(readFileSync(file, "utf8"), "foreign\n");
  });

  test("reconciliation keeps an existing catalog appointment and its exact path", async () => {
    const fixture = repositoryWithCommit();
    const git = await repositoryAt(fixture.path);
    const keis = Keis.of(await Repo.at({ path: fixture.path }));
    const bound = accepted(await keis.bind({ terms: contractBody("Legacy appointment") }));
    const { id } = present(await bound.kei.state());
    const original = await readManagedWorktreeAppointment(git, id);
    assert.ok(original.kind === "appointed");
    const legacy = "litterbox2";
    const path = worktreePath(git, legacy);
    fixture.run(["worktree", "move", original.path, path]);
    const bytes = `{"version":1,"appointments":{"${legacy}":"${id}"}}\n`;
    writeFileSync(placeRegisterPath(git), bytes);
    writeFileSync(join(path, "authored.txt"), "keep my edits\n");
    const topology = fixture.run(["worktree", "list", "--porcelain"]);

    const reconciled = await keis.reconcile({ contract: id });
    assert.ok(reconciled.kind === "contract");
    assert.deepEqual(reconciled.issues ?? [], []);
    assert.deepEqual(await readManagedWorktreeAppointment(git, id), { kind: "appointed", place: legacy, path });
    assert.equal(readFileSync(placeRegisterPath(git), "utf8"), bytes);
    assert.equal(fixture.run(["worktree", "list", "--porcelain"]), topology);
    assert.equal(readFileSync(join(path, "authored.txt"), "utf8"), "keep my edits\n");
  });

  test("a 10000-appointment observation decodes the register once", async () => {
    const git = await repositoryAt(repositoryWithCommit().path);
    const appointments = Array.from({ length: 10_000 }, (_, index) => ({
      place: place(`sample-${index}`),
      contract: contractId(`kei/bulk-${index}`),
    }));
    const bytes = canonicalPlaceRegister(
      new Map(appointments.map(({ contract, place: appointed }) => [contract, appointed])),
    );
    const path = join(git.commonDirectory, "keiyaku", "places.json");
    mkdirSync(join(git.commonDirectory, "keiyaku"), { recursive: true });
    writeFileSync(path, bytes);
    const register = decodePlaceRegister(path, bytes);
    const bulkNext = contractId("kei/bulk-next");
    const next = await appointManagedWorktrees(git, [bulkNext]);
    writeFileSync(path, "not-canonical\n");
    assert.equal(register.size, 10_000);
    assert.equal(register.get(appointments[0]!.contract), appointments[0]!.place);
    assert.equal(register.get(appointments[9_999]!.contract), appointments[9_999]!.place);
    assert.equal(next.get(bulkNext), `w-${contractLocator(bulkNext)}`);
    for (const appointment of appointments) {
      assert.deepEqual(await readManagedWorktreeAppointment(git, appointment.contract, register), {
        kind: "appointed",
        place: appointment.place,
        path: worktreePath(git, appointment.place),
      });
    }
    const failed = await readManagedWorktreeAppointment(git, EXAMPLE);
    assert.equal(failed.kind, "failed");
  });

  test("Place authority nuke retains a nonempty register and its lock", async () => {
    const git = await repositoryAt(repositoryWithCommit().path);
    await appointManagedWorktrees(git, [EXAMPLE]);
    const lock = join(git.commonDirectory, "keiyaku", "locks", "places.sqlite");
    await assert.rejects(() => nukeEmptyPlaceAuthority(git), /Place authority still has managed worktree appointments/u);
    assert.equal(existsSync(placeRegisterPath(git)), true);
    assert.equal(existsSync(lock), true);
  });

  test("terminal cleanup releases the Place only after hooks and removal succeed", async () => {
    const repository = repositoryWithCommit();
    const directory = mkdtempSync(join(tmpdir(), "keiyaku-place-hook-"));
    const attempts = join(directory, "attempts.log");
    const ready = join(directory, "ready");
    const destroy = {
      name: "destroy",
      argv: [
        process.execPath,
        "-e",
        [
          `const fs = require("node:fs");`,
          `fs.appendFileSync(${JSON.stringify(attempts)}, "attempt\\n");`,
          `if (!fs.existsSync(${JSON.stringify(ready)})) process.exit(9);`,
        ].join(" "),
      ],
      timeoutMs: 5_000,
    };
    mkdirSync(join(repository.path, ".keiyaku"), { recursive: true });
    writeFileSync(
      join(repository.path, ".keiyaku", "settings.json"),
      `${JSON.stringify({ worktree: { create: [], destroy: [destroy] } })}\n`,
    );
    const settings = await projectSettings(repository.path);
    const repo = await Repo.at({ path: repository.path });
    const bound = accepted(await Keis.of(repo, { settings }).bind({
      terms: contractBody("Release order"),
    }));
    const git = await repositoryAt(repository.path);
    const appointment = await readManagedWorktreeAppointment(git, (present(await bound.kei.state())).id);
    assert.ok(appointment.kind === "appointed", "expected appointment.kind = \"appointed\"");
    const failed = accepted(await bound.kei.abandon({}));
    assert.ok((failed.issues ?? []).length > 0, JSON.stringify(failed));
    assert.equal(existsSync(appointment.path), true);
    assert.deepEqual(await readManagedWorktreeAppointment(git, (present(await bound.kei.state())).id), appointment);
    const other = await appointManagedWorktrees(git, [OTHER]);
    assert.equal(other.get(OTHER), OTHER_PLACE);
    writeFileSync(ready, "ready\n");
    const released = await Keis.of(repo, { settings }).reconcile({ contract: (present(await bound.kei.state())).id, retryHooks: true });
    assert.ok(released.kind === "contract");
    assert.equal((released.issues ?? []).length, 0, JSON.stringify(released));
    assert.equal(existsSync(appointment.path), false);
    assert.deepEqual(await readManagedWorktreeAppointment(git, (present(await bound.kei.state())).id), { kind: "unappointed" });
  });

  test("Git removal failure retains custody and a fresh reconcile retries successfully", async () => {
    const repository = repositoryWithCommit();
    const bound = accepted(await Keis.of(await Repo.at({ path: repository.path })).bind({
      terms: contractBody("Retry removal"),
    }));
    const git = await repositoryAt(repository.path);
    const state = present(await bound.kei.state());
    const appointment = await readManagedWorktreeAppointment(git, state.id);
    assert.ok(appointment.kind === "appointed", "expected appointment.kind = \"appointed\"");
    const custody = ["for-each-ref", "refs/keiyaku/delivery", "refs/keiyaku/candidate"];
    const beforeRefs = repository.run(custody);
    assert.notEqual(beforeRefs, "");
    const marker = join(repository.path, ".git", "remove-failed-once");
    const shim = [
      'if [ "$1" = "worktree" ] && [ "$2" = "remove" ] && [ ! -e "$KEIYAKU_REMOVE_MARKER" ]; then',
      '  : > "$KEIYAKU_REMOVE_MARKER"',
      '  printf "forced worktree removal failure\\n" >&2',
      "  exit 1",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n");

    await withGitShim(shim, { KEIYAKU_REMOVE_MARKER: marker }, async (gitPath) => {
      const first = accepted(await Keis.of(await Repo.at({ path: repository.path, gitPath })).kei({ id: state.id }).abandon());
      assert.ok(
        (first.issues ?? []).some(
          (issue) =>
            issue.kind === "worktree-retained" &&
            issue.path === appointment.path &&
            /forced worktree removal failure/u.test(issue.diagnostic ?? ""),
        ),
      );
      assert.equal(repository.run(custody), beforeRefs);
      assert.equal(existsSync(appointment.path), true);
      assert.deepEqual(await readManagedWorktreeAppointment(git, state.id), appointment);
      const second = await Keis.of(await Repo.at({ path: repository.path, gitPath })).reconcile({ contract: state.id });
      assert.ok(second.kind === "contract");
      assert.equal((second.issues ?? []).length, 0, JSON.stringify(second));
    });

    assert.equal(existsSync(appointment.path), false);
    assert.deepEqual(await readManagedWorktreeAppointment(git, state.id), { kind: "unappointed" });
  });

  test("a dangling symlink recreated after Git removal is retained as physical residue", async () => {
    const repository = repositoryWithCommit();
    const repo = await Repo.at({ path: repository.path });
    const bound = accepted(await Keis.of(repo).bind({
      terms: contractBody("Dangling path"),
    }));
    const git = await repositoryAt(repository.path);
    const state = present(await bound.kei.state());
    const appointment = await readManagedWorktreeAppointment(git, state.id);
    assert.ok(appointment.kind === "appointed", "expected appointment.kind = \"appointed\"");
    const custody = ["for-each-ref", "refs/keiyaku/delivery", "refs/keiyaku/candidate"];
    const beforeRefs = repository.run(custody);
    assert.notEqual(beforeRefs, "");
    const shim = [
      'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then',
      '  "$KEIYAKU_REAL_GIT" "$@"',
      '  status=$?',
      '  if [ "$status" -eq 0 ]; then ln -s "$KEIYAKU_MISSING_TARGET" "$KEIYAKU_RECREATE_PATH"; fi',
      '  exit "$status"',
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n");

    await withGitShim(
      shim,
      {
        KEIYAKU_MISSING_TARGET: join(repository.path, "missing-foreign-target"),
        KEIYAKU_RECREATE_PATH: appointment.path,
      },
      async (gitPath) => {
        const retained = accepted(await Keis.of(await Repo.at({ path: repository.path, gitPath })).kei({ id: state.id }).abandon());
        assert.ok(
          (retained.issues ?? []).some(
            (issue) =>
              issue.kind === "worktree-retained" &&
              issue.path === appointment.path &&
              /worktree removal but the path remains/u.test(issue.diagnostic ?? ""),
          ),
        );
        assert.equal(lstatSync(appointment.path).isSymbolicLink(), true);
        assert.equal(repository.run(custody), beforeRefs);
        assert.deepEqual(await readManagedWorktreeAppointment(git, state.id), appointment);
        const replay = await Keis.of(repo).reconcile({ contract: state.id });
        assert.ok(replay.kind === "contract");
        assert.ok((replay.issues ?? []).some((issue) => issue.kind === "worktree-retained"));
        assert.equal((replay.effects ?? []).some((effect) => effect.kind === "worktree-removed"), false);
        assert.equal(lstatSync(appointment.path).isSymbolicLink(), true);
        assert.equal(repository.run(custody), beforeRefs);
        assert.deepEqual(await readManagedWorktreeAppointment(git, state.id), appointment);
      },
    );
  });

  test("corrupt Place register fails mutation and isolates the Contract status section", async () => {
    const repository = repositoryWithCommit();
    const debts = Debts.of(await World.at(repository.path));
    const added = await debts.add({ title: "Independent debt", priority: 0 });
    assert.equal(added.kind, "accepted");
    const repo = await Repo.at({ path: repository.path });
    const bound = accepted(await Keis.of(repo).bind({
      terms: contractBody("Corrupt register"),
    }));
    const git = await repositoryAt(repository.path);
    const path = placeRegisterPath(git);
    writeFileSync(path, '{"version":1}\n');
    await assert.rejects(() => bound.kei.deliver(), (error: unknown) => error instanceof KeiyakuError && error.category === "authority-corruption" && error.cause instanceof AuthorityCorruptionError);
    await assert.rejects(() => bound.kei.review({ verdict: "satisfied", summary: "Worktree review passed" }), (error: unknown) => error instanceof KeiyakuError && error.category === "authority-corruption" && error.cause instanceof AuthorityCorruptionError);
    await assert.rejects(async () => Keis.of(repo).reconcile({ contract: (present(await bound.kei.state())).id }), (error: unknown) => error instanceof KeiyakuError && error.category === "authority-corruption" && error.cause instanceof AuthorityCorruptionError);
    type StatusReport = Readonly<{
      contracts: Readonly<{ kind: string; diagnostic?: string }>;
      debts: Readonly<{ kind: string; rows?: readonly Readonly<{ id: string }>[] }>;
      akumas: Readonly<{ kind: string }>;
    }>;
    const status = await cliJson<StatusReport>(["-C", repository.path, "kanshi"]);
    // World observation keeps the corrupt Place local to its Contract section.
    assert.equal(status.value.contracts.kind, "failed");
    if (status.value.contracts.kind === "failed")
      assert.match(status.value.contracts.diagnostic ?? "", /Place file has invalid fields/u);
    assert.equal(status.value.debts.kind, "present");
    if (status.value.debts.kind === "present") {
      assert.equal(
        (status.value.debts.rows ?? []).some((row) => row.id === added.id),
        true,
      );
    }
    assert.notEqual(status.value.akumas.kind, "failed");
    type ContractStatus = Readonly<{ kind: string; diagnostic?: string }>;
    const selected = await cliJson<ContractStatus>([
      "-C",
      repository.path,
      "status",
      present(await bound.kei.state()).id,
    ]);
    assert.equal(selected.value.kind, "contract-failed");
    assert.match(selected.value.diagnostic ?? "", /Place file has invalid fields/u);
  });

  test("appoint write failure causes no Git ref or worktree effect", async () => {
    const repository = repositoryWithCommit();
    const git = await repositoryAt(repository.path);
    const keis = Keis.of(await Repo.at({ path: repository.path }));
    const directory = join(git.commonDirectory, "keiyaku");
    await releaseManagedWorktrees(git, [EXAMPLE]);
    const worktrees = repository.run(["worktree", "list", "--porcelain"]);
    chmodSync(directory, 0o555);
    let bound;
    try {
      bound = accepted(await keis.bind({ terms: contractBody("Unrealized") }));
    } finally {
      chmodSync(directory, 0o755);
    }
    assert.ok((bound.issues ?? []).some((issue) => issue.kind === "contract-file-failed"));
    const { id } = present(await bound.kei.state());
    assert.equal(existsSync(worktreePath(git, `w-${contractLocator(id)}`)), false);
    assert.equal(repository.run(["worktree", "list", "--porcelain"]), worktrees);
    assert.doesNotMatch(repository.run(["show-ref"]), /refs\/keiyaku\/delivery\//u);
    assert.equal(readFileSync(placeRegisterPath(git), "utf8"), EMPTY);
    assert.deepEqual(await readManagedWorktreeAppointment(git, id), { kind: "unappointed" });
  });

  test("release write failure keeps the appointment after physical removal", async () => {
    const repository = repositoryWithCommit();
    const repo = await Repo.at({ path: repository.path });
    const bound = accepted(await Keis.of(repo).bind({
      terms: contractBody("Release write"),
    }));
    const git = await repositoryAt(repository.path);
    const appointment = await readManagedWorktreeAppointment(git, (present(await bound.kei.state())).id);
    assert.ok(appointment.kind === "appointed", "expected appointment.kind = \"appointed\"");
    const bytes = readFileSync(placeRegisterPath(git), "utf8");
    const directory = join(git.commonDirectory, "keiyaku");
    chmodSync(directory, 0o555);
    let abandoned;
    try {
      abandoned = accepted(await bound.kei.abandon());
    } finally {
      chmodSync(directory, 0o755);
    }
    assert.equal(existsSync(appointment.path), false);
    assert.ok((abandoned.issues ?? []).some((issue) => issue.kind === "contract-file-failed"));
    assert.equal(readFileSync(placeRegisterPath(git), "utf8"), bytes);
    assert.deepEqual(await readManagedWorktreeAppointment(git, (present(await bound.kei.state())).id), appointment);
    const repaired = await Keis.of(repo).reconcile({ contract: (present(await bound.kei.state())).id });
    assert.ok(repaired.kind === "contract");
    assert.equal((repaired.issues ?? []).length, 0, JSON.stringify(repaired));
    assert.equal(repaired.effects, undefined, "release-only retry must not recreate or remove worktree custody again");
    assert.deepEqual(await readManagedWorktreeAppointment(git, (present(await bound.kei.state())).id), { kind: "unappointed" });
    const again = await Keis.of(repo).reconcile({ contract: (present(await bound.kei.state())).id });
    assert.ok(again.kind === "contract");
    assert.equal((again.issues ?? []).length, 0, JSON.stringify(again));
    assert.deepEqual(await readManagedWorktreeAppointment(git, (present(await bound.kei.state())).id), { kind: "unappointed" });
  });
});
