import { accepted, present } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import { projectSettings } from "../src/settings.js";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync, rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import {
  appointManagedWorktrees,
  canonicalPlaceRegister,
  CONTRACT_PLACES,
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
const EXAMPLE_START_INDEX = 15;
const OTHER_START_INDEX = 86;
const BULK_NEXT = { contract: contractId("kei/bulk-next"), startIndex: 28 } as const;

function repositoryWithCommit() {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  return repository;
}




function expectedForwardAllocation(
  startIndex: number,
  occupied: ReadonlySet<ReturnType<typeof place>>,
): ReturnType<typeof place> {
  for (let generation = 1n; ; generation += 1n) {
    for (let offset = 0; offset < CONTRACT_PLACES.length; offset += 1) {
      const base = CONTRACT_PLACES[(startIndex + offset) % CONTRACT_PLACES.length]!;
      const candidate = place(generation === 1n ? base : `${base}${generation.toString()}`);
      if (!occupied.has(candidate)) return candidate;
    }
  }
}

function placeAt(index: number) {
  const generation = Math.floor(index / CONTRACT_PLACES.length) + 1;
  const base = CONTRACT_PLACES[index % CONTRACT_PLACES.length]!;
  return place(generation === 1 ? base : `${base}${String(generation)}`);
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
  test("Place allocation preserves catalog vocabulary and suffix arithmetic", () => {
    assert.equal(CONTRACT_PLACES.length, 173);
    assert.equal(CONTRACT_PLACES[0], "atlantis");
    assert.equal(CONTRACT_PLACES[1], "hogwarts");
    assert.equal(CONTRACT_PLACES[172], "clawmachine");
    assert.throws(() => place("a"), TypeError);
    assert.throws(() => place("Atlantis"), TypeError);
    assert.throws(() => place("atlantis1"), TypeError);
    assert.throws(() => place("atlantis01"), TypeError);
    assert.throws(() => place("not-a-place"), TypeError);
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
  });

  test("concurrent appoint and release preserve every mapping", async () => {
    const repository = await repositoryAt(repositoryWithCommit().path);
    const first = Array.from({ length: 8 }, (_, index) => contractId(`kei/first-${index}`));
    const second = Array.from({ length: 8 }, (_, index) => contractId(`kei/second-${index}`));
    await appointManagedWorktrees(repository, first);
    await Promise.all([releaseManagedWorktrees(repository, first), appointManagedWorktrees(repository, second)]);
    const register = await readPlaceRegister(repository);
    assert.equal(register.appointments.length, second.length);
    assert.deepEqual(new Set(register.appointments.map((appointment) => appointment.contract)), new Set(second));
    assert.equal(new Set(register.appointments.map((appointment) => appointment.place)).size, second.length);
    assert.equal(
      readFileSync(join(repository.commonDirectory, "keiyaku", "places.json"), "utf8"),
      canonicalPlaceRegister(register),
    );
  });

  test("appointment after a concurrent release uses the locked on-disk register", async () => {
    const repository = await repositoryAt(repositoryWithCommit().path);
    const firstRegister = await appointManagedWorktrees(repository, [EXAMPLE]);
    const first = firstRegister.byContract.get(EXAMPLE)!;
    const snapshot = await readPlaceRegister(repository);
    await releaseManagedWorktrees(repository, [EXAMPLE]);
    const reusedRegister = await appointManagedWorktrees(repository, [OTHER]);
    const reused = reusedRegister.byContract.get(OTHER)!;
    const appointed = await appointManagedWorktrees(repository, [EXAMPLE]);
    assert.equal(snapshot.byContract.get(EXAMPLE)?.place, first.place);
    assert.equal(reused.place, expectedForwardAllocation(OTHER_START_INDEX, new Set()));
    assert.equal(
      appointed.byContract.get(EXAMPLE)?.place,
      expectedForwardAllocation(EXAMPLE_START_INDEX, new Set([reused.place])),
    );
    assert.deepEqual((await readPlaceRegister(repository)).byContract, appointed.byContract);
  });

  test("physical unregistered Place paths are occupied without being adopted", async () => {
    const repository = await repositoryAt(repositoryWithCommit().path);
    const expected = expectedForwardAllocation(EXAMPLE_START_INDEX, new Set());
    mkdirSync(worktreePath(repository, expected), { recursive: true });

    const register = await appointManagedWorktrees(repository, [EXAMPLE]);
    const appointed = register.byContract.get(EXAMPLE)!;

    assert.notEqual(appointed.place, expected);
    assert.equal(existsSync(worktreePath(repository, expected)), true);
    assert.equal(register.byPlace.has(place(expected)), false);
  });

  test("a 10000-appointment observation decodes the register once", async () => {
    const git = await repositoryAt(repositoryWithCommit().path);
    const appointments = Array.from({ length: 10_000 }, (_, index) => ({
      place: placeAt(index),
      contract: contractId(`kei/bulk-${index}`),
    }));
    const bytes = canonicalPlaceRegister({ appointments, byPlace: new Map(), byContract: new Map() });
    const path = join(git.commonDirectory, "keiyaku", "places.json");
    mkdirSync(join(git.commonDirectory, "keiyaku"), { recursive: true });
    writeFileSync(path, bytes);
    const register = decodePlaceRegister(path, bytes);
    const next = await appointManagedWorktrees(git, [BULK_NEXT.contract]);
    writeFileSync(path, "not-canonical\n");
    assert.equal(register.byPlace.size, 10_000);
    assert.equal(register.byContract.size, 10_000);
    assert.equal(register.byContract.get(appointments[0]!.contract)?.place, appointments[0]!.place);
    assert.equal(register.byPlace.get(appointments[9_999]!.place)?.contract, appointments[9_999]!.contract);
    assert.equal(
      next.byContract.get(BULK_NEXT.contract)?.place,
      expectedForwardAllocation(BULK_NEXT.startIndex, new Set(appointments.map((appointment) => appointment.place))),
    );
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
      markdown: contractBody("Release order"),
    }));
    const git = await repositoryAt(repository.path);
    const appointment = await readManagedWorktreeAppointment(git, (present(await bound.kei.state())).id);
    assert.ok(appointment.kind === "appointed", "expected appointment.kind = \"appointed\"");
    const failed = accepted(await bound.kei.abandon({}));
    assert.ok((failed.issues ?? []).length > 0, JSON.stringify(failed));
    assert.equal(existsSync(appointment.path), true);
    assert.deepEqual(await readManagedWorktreeAppointment(git, (present(await bound.kei.state())).id), appointment);
    const other = await appointManagedWorktrees(git, [OTHER]);
    assert.equal(
      other.byContract.get(OTHER)?.place,
      expectedForwardAllocation(OTHER_START_INDEX, new Set([appointment.place])),
    );
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
      markdown: contractBody("Retry removal"),
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
      markdown: contractBody("Dangling path"),
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
      markdown: contractBody("Corrupt register"),
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
    const status = await cliJson<StatusReport>(["-C", repository.path, "status"]);
    // Bare World status keeps the corrupt Place local to its Contract section.
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
    const directory = join(git.commonDirectory, "keiyaku");
    mkdirSync(directory, { recursive: true });
    const target = placeRegisterPath(git);
    mkdirSync(target);
    const worktrees = repository.run(["worktree", "list", "--porcelain"]);
    try {
      const bound = accepted(await Keis.of(await Repo.at({ path: repository.path })).bind({
        markdown: contractBody("Unrealized"),
        }));
      assert.ok((bound.issues ?? []).some((issue) => issue.kind === "contract-file-failed"));
      assert.equal(existsSync(worktreePath(git, "atlantis")), false);
      assert.equal(repository.run(["worktree", "list", "--porcelain"]), worktrees);
      assert.doesNotMatch(repository.run(["show-ref"]), /refs\/keiyaku\/delivery\//u);
      rmSync(target, { recursive: true });
      assert.deepEqual(await readManagedWorktreeAppointment(git, (present(await bound.kei.state())).id), { kind: "unappointed" });
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("release write failure keeps the appointment after physical removal", async () => {
    const repository = repositoryWithCommit();
    const repo = await Repo.at({ path: repository.path });
    const bound = accepted(await Keis.of(repo).bind({
      markdown: contractBody("Release write"),
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
    assert.deepEqual(await readManagedWorktreeAppointment(git, (present(await bound.kei.state())).id), { kind: "unappointed" });
    const again = await Keis.of(repo).reconcile({ contract: (present(await bound.kei.state())).id });
    assert.ok(again.kind === "contract");
    assert.equal((again.issues ?? []).length, 0, JSON.stringify(again));
    assert.deepEqual(await readManagedWorktreeAppointment(git, (present(await bound.kei.state())).id), { kind: "unappointed" });
  });
});
