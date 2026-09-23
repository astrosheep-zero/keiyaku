import { contractMarkdown } from "./support/markdown.js";
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
  nextPlace,
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
import { invoke as invokeRaw, type InvocationResult } from "../src/cli/invoke.js";
import { parseArgv as parseInvocation } from "../src/cli/parse.js";
import { Keiyaku, Repo } from "../src/index.js";
import { Tasks } from "../src/task/index.js";
import { World } from "../src/world.js";
import { cachedRepositoryAt, makeGitRepository, withGitShim } from "./support/git.js";

const repositoryAt = cachedRepositoryAt;

function parseArgv(argv: readonly string[]) {
  const parsed = parseInvocation(argv);
  if (!("command" in parsed)) throw new Error("expected executable command");
  return parsed;
}

async function invoke(
  invocation: Parameters<typeof invokeRaw>[0],
  runtime?: Parameters<typeof invokeRaw>[1],
) {
  return (await invokeRaw(invocation, runtime)) as InvocationResult;
}

const EXAMPLE = contractId("kei/example");
const OTHER = contractId("kei/other");
const ATLANTIS = place("atlantis");
const HOGWARTS = place("hogwarts");
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
    assert.equal(nextPlace(), ATLANTIS);
    assert.equal(nextPlace(ATLANTIS), HOGWARTS);
    assert.equal(nextPlace(place("clawmachine")), place("atlantis2"));
    assert.equal(nextPlace(place("clawmachine2")), place("atlantis3"));
    assert.equal(nextPlace(place("atlantis21")), place("hogwarts21"));
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    assert.equal(nextPlace(place(`clawmachine${huge.toString()}`)), place(`atlantis${(huge + 1n).toString()}`));
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
    const hooks = { create: [], destroy: [destroy] };
    const bound = await Keiyaku.with().bind({
      repo: await Repo.at({ path: repository.path }),
      markdown: contractBody("Release order"),
      workspace: "worktree",
      hooks,
    });
    const git = await repositoryAt(repository.path);
    const appointment = await readManagedWorktreeAppointment(git, (await bound.keiyaku.state()).id);
    assert.ok(appointment.kind === "appointed", "expected appointment.kind = \"appointed\"");
    const failed = await bound.keiyaku.abandon({ hooks });
    assert.ok(failed.lags.length > 0);
    assert.equal(existsSync(appointment.path), true);
    assert.deepEqual(await readManagedWorktreeAppointment(git, (await bound.keiyaku.state()).id), appointment);
    const other = await appointManagedWorktrees(git, [OTHER]);
    assert.equal(
      other.byContract.get(OTHER)?.place,
      expectedForwardAllocation(OTHER_START_INDEX, new Set([appointment.place])),
    );
    writeFileSync(ready, "ready\n");
    const released = await bound.keiyaku.reconcile({ hooks, retryHooks: true });
    assert.deepEqual(released.lag, []);
    assert.equal(existsSync(appointment.path), false);
    assert.deepEqual(await readManagedWorktreeAppointment(git, (await bound.keiyaku.state()).id), { kind: "unappointed" });
  });

  test("Git removal failure retains custody and a fresh reconcile retries successfully", async () => {
    const repository = repositoryWithCommit();
    const bound = await Keiyaku.with().bind({
      repo: await Repo.at({ path: repository.path }),
      markdown: contractBody("Retry removal"),
      workspace: "worktree",
      hooks: { create: [], destroy: [] },
    });
    const git = await repositoryAt(repository.path);
    const state = await bound.keiyaku.state();
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
      const first = await Keiyaku.with().select({ repo: await Repo.at({ path: repository.path, gitPath }), id: state.id }).abandon();
      assert.ok(first.lags.some((lag) => lag.kind === "worktree-retained"));
      assert.equal(repository.run(custody), beforeRefs);
      assert.equal(existsSync(appointment.path), true);
      assert.deepEqual(await readManagedWorktreeAppointment(git, state.id), appointment);
      const second = await Keiyaku.with().select({ repo: await Repo.at({ path: repository.path, gitPath }), id: state.id }).reconcile();
      assert.deepEqual(second.lag, []);
    });

    assert.equal(existsSync(appointment.path), false);
    assert.deepEqual(await readManagedWorktreeAppointment(git, state.id), { kind: "unappointed" });
  });

  test("a dangling symlink recreated after Git removal is retained as physical residue", async () => {
    const repository = repositoryWithCommit();
    const bound = await Keiyaku.with().bind({
      repo: await Repo.at({ path: repository.path }),
      markdown: contractBody("Dangling path"),
      workspace: "worktree",
      hooks: { create: [], destroy: [] },
    });
    const git = await repositoryAt(repository.path);
    const state = await bound.keiyaku.state();
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
        const retained = await Keiyaku.with().select({ repo: await Repo.at({ path: repository.path, gitPath }), id: state.id }).abandon();
        assert.ok(retained.lags.some((lag) => lag.kind === "worktree-retained"));
        assert.equal(lstatSync(appointment.path).isSymbolicLink(), true);
        assert.equal(repository.run(custody), beforeRefs);
        assert.deepEqual(await readManagedWorktreeAppointment(git, state.id), appointment);
        const replay = await bound.keiyaku.reconcile();
        assert.ok(replay.lag.some((lag) => lag.kind === "worktree-retained"));
        assert.equal(replay.effects.some((effect) => effect.kind === "worktree" && effect.action === "removed"), false);
        assert.equal(lstatSync(appointment.path).isSymbolicLink(), true);
        assert.equal(repository.run(custody), beforeRefs);
        assert.deepEqual(await readManagedWorktreeAppointment(git, state.id), appointment);
      },
    );
  });

  test("corrupt Place register fails mutation and isolates the Contract status section", async () => {
    const repository = repositoryWithCommit();
    const tasks = Tasks.of(await World.at(repository.path));
    const added = await tasks.add({ title: "Independent task", priority: 0 });
    assert.equal(added.kind, "accepted");
    const bound = await Keiyaku.with().bind({
      repo: await Repo.at({ path: repository.path }),
      markdown: contractBody("Corrupt register"),
      workspace: "worktree",
      hooks: { create: [], destroy: [] },
    });
    const git = await repositoryAt(repository.path);
    const path = placeRegisterPath(git);
    writeFileSync(path, '{"version":1}\n');
    await assert.rejects(() => bound.keiyaku.deliver(), AuthorityCorruptionError);
    await assert.rejects(() => bound.keiyaku.review({ verdict: "satisfied" }), AuthorityCorruptionError);
    await assert.rejects(() => bound.keiyaku.reconcile(), AuthorityCorruptionError);
    const status = await invoke(parseArgv(["-C", repository.path, "status"]));
    assert.ok(status.kind === "status", "expected status.kind = \"status\"");
    assert.ok(status.report.contracts.kind === "failed", "expected status.report.contracts.kind = \"failed\"");
    assert.match(status.report.contracts.failure.message, /Place file has invalid fields/u);
    assert.equal(status.report.tasks.kind, "present");
    if (status.report.tasks.kind === "present") {
      assert.equal(
        status.report.tasks.value.rows.some((row) => row.id === added.value.id),
        true,
      );
    }
    assert.notEqual(status.report.akuma.kind, "failed");
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
      const bound = await Keiyaku.with().bind({
        repo: await Repo.at({ path: repository.path }),
        markdown: contractBody("Unrealized"),
        workspace: "worktree",
        hooks: { create: [], destroy: [] },
      });
      assert.ok(bound.lags.some((lag) => lag.kind === "contract-file-failed"));
      assert.equal(existsSync(worktreePath(git, "atlantis")), false);
      assert.equal(repository.run(["worktree", "list", "--porcelain"]), worktrees);
      assert.doesNotMatch(repository.run(["show-ref"]), /refs\/keiyaku\/delivery\//u);
      rmSync(target, { recursive: true });
      assert.deepEqual(await readManagedWorktreeAppointment(git, (await bound.keiyaku.state()).id), { kind: "unappointed" });
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("release write failure keeps the appointment after physical removal", async () => {
    const repository = repositoryWithCommit();
    const bound = await Keiyaku.with().bind({
      repo: await Repo.at({ path: repository.path }),
      markdown: contractBody("Release write"),
      workspace: "worktree",
      hooks: { create: [], destroy: [] },
    });
    const git = await repositoryAt(repository.path);
    const appointment = await readManagedWorktreeAppointment(git, (await bound.keiyaku.state()).id);
    assert.ok(appointment.kind === "appointed", "expected appointment.kind = \"appointed\"");
    const bytes = readFileSync(placeRegisterPath(git), "utf8");
    const directory = join(git.commonDirectory, "keiyaku");
    chmodSync(directory, 0o555);
    let abandoned;
    try {
      abandoned = await bound.keiyaku.abandon();
    } finally {
      chmodSync(directory, 0o755);
    }
    assert.equal(existsSync(appointment.path), false);
    assert.ok(abandoned.lags.some((lag) => lag.kind === "contract-file-failed"));
    assert.equal(readFileSync(placeRegisterPath(git), "utf8"), bytes);
    assert.deepEqual(await readManagedWorktreeAppointment(git, (await bound.keiyaku.state()).id), appointment);
    const repaired = await bound.keiyaku.reconcile();
    assert.deepEqual(repaired.lag, []);
    assert.deepEqual(await readManagedWorktreeAppointment(git, (await bound.keiyaku.state()).id), { kind: "unappointed" });
    const again = await bound.keiyaku.reconcile();
    assert.deepEqual(again.lag, []);
    assert.deepEqual(await readManagedWorktreeAppointment(git, (await bound.keiyaku.state()).id), { kind: "unappointed" });
  });
});
