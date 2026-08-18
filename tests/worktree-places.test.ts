import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appointManagedWorktrees,
  canonicalPlaceRegister,
  CONTRACT_PLACES,
  decodePlaceRegister,
  emptyPlaceRegister,
  nextPlace,
  place,
  placeRegisterPath,
  readManagedWorktreeAppointment,
  readPlaceRegister,
  releaseManagedWorktrees,
} from "../src/workspace-place.js";
import { AuthorityCorruptionError } from "../src/core/facts/errors.js";
import { contractId } from "../src/core/facts/types.js";
import { worktreePath } from "../src/git/workspace.js";
import { repositoryAt } from "../src/git/repository.js";
import { withGitDecodeChannel } from "../src/git/read-observation.js";
import { resolveContextualContract } from "../src/cli/selectors.js";
import { invoke } from "../src/cli/invoke.js";
import { parseArgv } from "../src/cli/parse.js";
import { worldContractStates } from "../src/protocol/reconcile.js";
import { readContractObservationAt } from "../src/protocol/read/status.js";
import { Keiyaku, Repo, type ContractBoard, type ContractId } from "../src/index.js";
import { Tasks } from "../src/task/index.js";
import { World } from "../src/world.js";
import { makeGitRepository } from "./support/git.js";
import * as workspace from "../src/git/workspace.js";

const EXAMPLE = contractId("kei/example");
const OTHER = contractId("kei/other");
const ATLANTIS = place("atlantis");
const HOGWARTS = place("hogwarts");
const CANONICAL = '{"version":1,"appointments":{"atlantis":"kei/example"}}\n';
const EMPTY = '{"version":1,"appointments":{}}\n';

function repositoryWithCommit() {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  return repository;
}

function registerOf(appointments: readonly { place: ReturnType<typeof place>; contract: ContractId }[]) {
  return decodePlaceRegister("places.json", canonicalPlaceRegister({
    appointments,
    byPlace: new Map(),
    byContract: new Map(),
  }));
}

test("Place register bytes are one canonical JSON line", () => {
  const appointed = registerOf([{ place: ATLANTIS, contract: EXAMPLE }]);
  assert.equal(canonicalPlaceRegister(appointed), CANONICAL);
  assert.equal(canonicalPlaceRegister(emptyPlaceRegister()), EMPTY);
  assert.equal(appointed.appointments[0]?.place, ATLANTIS);
  assert.equal(appointed.byPlace.get(ATLANTIS)?.contract, EXAMPLE);
  assert.equal(appointed.byContract.get(EXAMPLE)?.place, ATLANTIS);
  assert.deepEqual(decodePlaceRegister("places.json", EMPTY).appointments, []);
});

test("Place allocation is generation-major and first-free", async () => {
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
  const repository = await repositoryAt(repositoryWithCommit().path);
  const seed = [EXAMPLE, contractId("kei/seed-hogwarts"), OTHER];
  await appointManagedWorktrees(repository, seed);
  await releaseManagedWorktrees(repository, [seed[1]!]);
  const firstFree = await appointManagedWorktrees(repository, [contractId("kei/first-free")]);
  assert.equal(firstFree.byContract.get(contractId("kei/first-free"))?.place, HOGWARTS);

  const fullRepository = await repositoryAt(repositoryWithCommit().path);
  await appointManagedWorktrees(fullRepository, CONTRACT_PLACES.map((_, index) => contractId(`kei/letter-${index}`)));
  const nextGeneration = await appointManagedWorktrees(fullRepository, [contractId("kei/next-generation")]);
  assert.equal(nextGeneration.byContract.get(contractId("kei/next-generation"))?.place, place("atlantis2"));
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
  assert.throws(() => decodePlaceRegister(path, '{"version":1,"appointments":{"atlantis":"kei/example"}}'), AuthorityCorruptionError);
  assert.throws(() => decodePlaceRegister(path, '{"appointments":{},"version":1}\n'), AuthorityCorruptionError);
  assert.throws(() => decodePlaceRegister(path, '{"version":2,"appointments":{}}\n'), AuthorityCorruptionError);
  assert.throws(() => decodePlaceRegister(path, '{"version":1,"appointments":{"Atlantis":"kei/example"}}\n'), AuthorityCorruptionError);
  assert.throws(() => decodePlaceRegister(path, '{"version":1,"appointments":{"atlantis":"not-a-contract"}}\n'), AuthorityCorruptionError);
  assert.throws(() => decodePlaceRegister(path, '{"version":1,"appointments":{"atlantis":"kei/example","hogwarts":"kei/example"}}\n'), AuthorityCorruptionError);
});

test("concurrent appoint and release preserve every mapping", async () => {
  const repository = await repositoryAt(repositoryWithCommit().path);
  const first = Array.from({ length: 8 }, (_, index) => contractId(`kei/first-${index}`));
  const second = Array.from({ length: 8 }, (_, index) => contractId(`kei/second-${index}`));
  await appointManagedWorktrees(repository, first);
  await Promise.all([
    releaseManagedWorktrees(repository, first),
    appointManagedWorktrees(repository, second),
  ]);
  const register = await readPlaceRegister(repository);
  assert.equal(register.appointments.length, second.length);
  assert.deepEqual(
    new Set(register.appointments.map((appointment) => appointment.contract)),
    new Set(second),
  );
  assert.equal(
    new Set(register.appointments.map((appointment) => appointment.place)).size,
    second.length,
  );
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
  assert.equal(reused.place, first.place);
  assert.equal(appointed.byContract.get(EXAMPLE)?.place, HOGWARTS);
  assert.deepEqual(await readPlaceRegister(repository), appointed);
  assert.notEqual(appointed.byContract.get(EXAMPLE)?.place, snapshot.byContract.get(EXAMPLE)?.place);
});

test("retry reuses the durable Place and never inspects Git topology", async () => {
  const repository = await repositoryAt(repositoryWithCommit().path);
  const firstRegister = await appointManagedWorktrees(repository, [EXAMPLE]);
  const first = firstRegister.byContract.get(EXAMPLE)!;
  assert.equal(first.place, ATLANTIS);
  mkdirSync(worktreePath(repository, "hogwarts"), { recursive: true });
  writeFileSync(join(worktreePath(repository, "hogwarts"), "noise.txt"), "not an appointment\n");
  const retry = await appointManagedWorktrees(repository, [EXAMPLE]);
  assert.deepEqual(retry.byContract.get(EXAMPLE), first);
  const other = await appointManagedWorktrees(repository, [OTHER]);
  assert.equal(other.byContract.get(OTHER)?.place, HOGWARTS);
});

test("the three-arm reader does not inspect the journal or filesystem", async () => {
  const repository = await repositoryAt(repositoryWithCommit().path);
  assert.deepEqual(await readManagedWorktreeAppointment(repository, EXAMPLE), { kind: "unappointed" });
  const appointedRegister = await appointManagedWorktrees(repository, [EXAMPLE]);
  const appointed = appointedRegister.byContract.get(EXAMPLE)!;
  assert.deepEqual(await readManagedWorktreeAppointment(repository, EXAMPLE), {
    kind: "appointed",
    place: appointed.place,
    path: worktreePath(repository, appointed.place),
  });
  writeFileSync(join(repository.commonDirectory, "keiyaku", "places.json"), '{"version":1}\n');
  const failed = await readManagedWorktreeAppointment(repository, EXAMPLE);
  assert.equal(failed.kind, "failed");
  if (failed.kind !== "failed") throw new Error("expected failed appointment read");
  assert.match(failed.diagnostic, /Place file has invalid fields/u);
});

test("here Contracts stay unappointed in the Place register", async () => {
  const repository = await repositoryAt(repositoryWithCommit().path);
  assert.deepEqual(await readManagedWorktreeAppointment(repository, EXAMPLE), { kind: "unappointed" });
  assert.deepEqual(await readPlaceRegister(repository), emptyPlaceRegister());
});

function placeAt(index: number) {
  const generation = Math.floor(index / CONTRACT_PLACES.length) + 1;
  const base = CONTRACT_PLACES[index % CONTRACT_PLACES.length]!;
  return place(generation === 1 ? base : `${base}${String(generation)}`);
}

function contractBody(title: string): string {
  return [
    `# ${title}`, "", "## Context", "Place worktree.", "", "## Objective", "Keep Place appointments.",
    "", "## Design", "Use the appointed Place path.", "", "## Region", "```", "src/**", "```", "",
    "## Criteria", "### Result", "The appointed Place is reused.", "",
  ].join("\n");
}

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
  const nextContract = contractId("kei/bulk-next");
  const next = await appointManagedWorktrees(git, [nextContract]);
  writeFileSync(path, "not-canonical\n");
  assert.equal(register.byPlace.size, 10_000);
  assert.equal(register.byContract.size, 10_000);
  assert.equal(register.byContract.get(appointments[0]!.contract)?.place, appointments[0]!.place);
  assert.equal(register.byPlace.get(appointments[9_999]!.place)?.contract, appointments[9_999]!.contract);
  assert.equal(next.byContract.get(nextContract)?.place, placeAt(10_000));
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

test("current path projection is the appointed Place", async () => {
  assert.equal("deliveryWorktreePath" in workspace, false);
  const git = await repositoryAt(repositoryWithCommit().path);
  const appointedRegister = await appointManagedWorktrees(git, [EXAMPLE]);
  const appointed = appointedRegister.byContract.get(EXAMPLE)!;
  const current = await readManagedWorktreeAppointment(git, EXAMPLE);
  assert.equal(current.kind, "appointed");
  if (current.kind !== "appointed") throw new Error("expected appointed path");
  assert.equal(current.path, worktreePath(git, appointed.place));
});

test("linked worktrees share the appointed Place under the common directory", async () => {
  const repository = repositoryWithCommit();
  const linked = mkdtempSync(join(tmpdir(), "keiyaku-place-linked-"));
  repository.run(["worktree", "add", "--quiet", "--detach", linked]);
  const primary = await repositoryAt(repository.path);
  const secondary = await repositoryAt(linked);
  const appointedRegister = await appointManagedWorktrees(primary, [EXAMPLE]);
  const appointed = appointedRegister.byContract.get(EXAMPLE)!;
  assert.deepEqual(await readManagedWorktreeAppointment(secondary, EXAMPLE), {
    kind: "appointed",
    place: appointed.place,
    path: worktreePath(primary, appointed.place),
  });
  assert.equal(worktreePath(secondary, appointed.place), worktreePath(primary, appointed.place));
});

test("contextual selection matches the appointed Place path", () => {
  const id = "kei/active-contract" as ContractId;
  const path = "/repo/.git/keiyaku/wt/atlantis";
  const board = {
    root: "/repo",
    state: null,
    rows: [{
      id,
      title: "Active",
      phase: "bound",
      phaseAt: "2026-08-12T00:00:00.000Z",
      disposition: "active",
      workspace: "worktree",
      worktreePath: path,
      workspaceObservation: {
        kind: "clean",
        location: { kind: "worktree", path },
        counts: { staged: 0, unstaged: 0, untracked: 0, submodules: 0 },
      },
      target: null,
      targetLag: { kind: "none" },
      delivery: null,
      targetObservation: null,
      gates: { reports: [], satisfied: true },
    }],
  } satisfies ContractBoard;
  assert.equal(resolveContextualContract(board, undefined, path), id);
  assert.equal(resolveContextualContract(board, "@active-contract", "/repo"), id);
});

test("terminal cleanup releases the Place only after hooks and removal succeed", async () => {
  const repository = repositoryWithCommit();
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-place-hook-"));
  const attempts = join(directory, "attempts.log");
  const ready = join(directory, "ready");
  const destroy = {
    argv: [process.execPath, "-e", [
      `const fs = require("node:fs");`,
      `fs.appendFileSync(${JSON.stringify(attempts)}, "attempt\\n");`,
      `if (!fs.existsSync(${JSON.stringify(ready)})) process.exit(9);`,
    ].join(" ")],
    timeoutMs: 5_000,
  };
  const hooks = { create: [], destroy: [destroy] };
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody("Release order"),
    workspace: "worktree",
    hooks,
  });
  const git = await repositoryAt(repository.path);
  const appointment = await readManagedWorktreeAppointment(git, bound.keiyaku.id);
  assert.equal(appointment.kind, "appointed");
  if (appointment.kind !== "appointed") throw new Error("expected appointment");
  const failed = await bound.keiyaku.abandon({ hooks });
  assert.ok(failed.lags.length > 0);
  assert.equal(existsSync(appointment.path), true);
  assert.deepEqual(await readManagedWorktreeAppointment(git, bound.keiyaku.id), appointment);
  const other = await appointManagedWorktrees(git, [OTHER]);
  assert.equal(other.byContract.get(OTHER)?.place, HOGWARTS);
  writeFileSync(ready, "ready\n");
  const released = await bound.keiyaku.reconcile({ hooks, retryHooks: true });
  assert.deepEqual(released.lag, []);
  assert.equal(existsSync(appointment.path), false);
  assert.deepEqual(await readManagedWorktreeAppointment(git, bound.keiyaku.id), { kind: "unappointed" });
});

test("corrupt Place register fails mutation and isolates the Contract status section", async () => {
  const repository = repositoryWithCommit();
  const tasks = Tasks.of(await World.at(repository.path));
  const added = await tasks.add({ title: "Independent task", priority: 0 });
  assert.equal(added.kind, "accepted");
  const bound = await Keiyaku.bind({
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
  assert.equal(status.kind, "status");
  if (status.kind !== "status") throw new Error("expected status");
  assert.equal(status.report.contracts.kind, "failed");
  if (status.report.contracts.kind !== "failed") throw new Error("expected failed contracts");
  assert.match(status.report.contracts.failure.message, /Place file has invalid fields/u);
  assert.equal(status.report.tasks.kind, "present");
  if (status.report.tasks.kind === "present") {
    assert.equal(status.report.tasks.value.rows.some((row) => row.id === added.value.id), true);
  }
  assert.notEqual(status.report.akuma.kind, "failed");
});

test("appoint write failure causes no Git ref or worktree effect", async () => {
  const repository = repositoryWithCommit();
  const git = await repositoryAt(repository.path);
  const directory = join(git.commonDirectory, "keiyaku");
  mkdirSync(directory, { recursive: true });
  chmodSync(directory, 0o555);
  const worktrees = repository.run(["worktree", "list", "--porcelain"]);
  try {
    const bound = await Keiyaku.bind({
      repo: await Repo.at({ path: repository.path }),
      markdown: contractBody("Unrealized"),
      workspace: "worktree",
      hooks: { create: [], destroy: [] },
    });
    assert.ok(bound.lags.some((lag) => lag.kind === "contract-file-failed"));
    assert.equal(existsSync(worktreePath(git, "atlantis")), false);
    assert.equal(repository.run(["worktree", "list", "--porcelain"]), worktrees);
    assert.doesNotMatch(repository.run(["show-ref"]), /refs\/keiyaku\/delivery\//u);
    assert.deepEqual(await readManagedWorktreeAppointment(git, bound.keiyaku.id), { kind: "unappointed" });
  } finally {
    chmodSync(directory, 0o755);
  }
});

test("release write failure keeps the appointment after physical removal", async () => {
  const repository = repositoryWithCommit();
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody("Release write"),
    workspace: "worktree",
    hooks: { create: [], destroy: [] },
  });
  const git = await repositoryAt(repository.path);
  const appointment = await readManagedWorktreeAppointment(git, bound.keiyaku.id);
  assert.equal(appointment.kind, "appointed");
  if (appointment.kind !== "appointed") throw new Error("expected appointment");
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
  assert.deepEqual(await readManagedWorktreeAppointment(git, bound.keiyaku.id), appointment);
  const repaired = await bound.keiyaku.reconcile();
  assert.deepEqual(repaired.lag, []);
  assert.deepEqual(await readManagedWorktreeAppointment(git, bound.keiyaku.id), { kind: "unappointed" });
  const again = await bound.keiyaku.reconcile();
  assert.deepEqual(again.lag, []);
  assert.deepEqual(await readManagedWorktreeAppointment(git, bound.keiyaku.id), { kind: "unappointed" });
});

test("a clean terminal stays unappointed across per-Contract and repo reconcile", async () => {
  const repository = repositoryWithCommit();
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody("Terminal idle"),
    workspace: "worktree",
    hooks: { create: [], destroy: [] },
  });
  const git = await repositoryAt(repository.path);
  const abandoned = await bound.keiyaku.abandon();
  assert.deepEqual(abandoned.lags, []);
  assert.deepEqual(await readManagedWorktreeAppointment(git, bound.keiyaku.id), { kind: "unappointed" });
  const once = await bound.keiyaku.reconcile();
  assert.deepEqual(once.lag, []);
  assert.deepEqual(await readManagedWorktreeAppointment(git, bound.keiyaku.id), { kind: "unappointed" });
  const world = await (await Repo.at({ path: repository.path })).reconcile();
  assert.equal(world.contracts.every((contract) => contract.report.lag.length === 0), true);
  assert.deepEqual(await readManagedWorktreeAppointment(git, bound.keiyaku.id), { kind: "unappointed" });
  const observed = await withGitDecodeChannel(git, (channel) =>
    readContractObservationAt(git, channel, bound.keiyaku.id));
  assert.equal(observed.kind, "present");
  if (observed.kind !== "present") throw new Error("expected present observation");
  assert.equal(observed.row.worktreePath, null);
  assert.deepEqual(observed.row.workspaceObservation, { kind: "unappointed" });
});

test("an unregistered appointed path that still exists keeps the appointment", async () => {
  const repository = repositoryWithCommit();
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody("Hidden bytes"),
    workspace: "worktree",
    hooks: { create: [], destroy: [] },
  });
  const git = await repositoryAt(repository.path);
  const appointment = await readManagedWorktreeAppointment(git, bound.keiyaku.id);
  assert.equal(appointment.kind, "appointed");
  if (appointment.kind !== "appointed") throw new Error("expected appointment");
  repository.run(["worktree", "remove", "--force", appointment.path]);
  mkdirSync(appointment.path, { recursive: true });
  writeFileSync(join(appointment.path, "hidden.txt"), "hidden\n");
  const abandoned = await bound.keiyaku.abandon();
  assert.ok(abandoned.lags.some((lag) => lag.kind === "worktree-retained"));
  assert.equal(readFileSync(join(appointment.path, "hidden.txt"), "utf8"), "hidden\n");
  assert.deepEqual(await readManagedWorktreeAppointment(git, bound.keiyaku.id), appointment);
});

test("an already-absent appointed path may release without a removal effect", async () => {
  const repository = repositoryWithCommit();
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody("Already absent"),
    workspace: "worktree",
    hooks: { create: [], destroy: [] },
  });
  const git = await repositoryAt(repository.path);
  const appointment = await readManagedWorktreeAppointment(git, bound.keiyaku.id);
  assert.equal(appointment.kind, "appointed");
  if (appointment.kind !== "appointed") throw new Error("expected appointment");
  repository.run(["worktree", "remove", "--force", appointment.path]);
  const abandoned = await bound.keiyaku.abandon();
  assert.deepEqual(abandoned.lags, []);
  assert.equal(existsSync(appointment.path), false);
  assert.deepEqual(await readManagedWorktreeAppointment(git, bound.keiyaku.id), { kind: "unappointed" });
});

test("repo reconcile isolates a Place-register outage from here repair", async () => {
  const repository = repositoryWithCommit();
  const here = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody("Here isolated"),
    workspace: "here",
    hooks: { create: [], destroy: [] },
  });
  const managed = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: contractBody("Managed isolated"),
    workspace: "worktree",
    hooks: { create: [], destroy: [] },
  });
  const git = await repositoryAt(repository.path);
  const appointment = await readManagedWorktreeAppointment(git, managed.keiyaku.id);
  assert.equal(appointment.kind, "appointed");
  const derived = join(git.primaryWorktree, ".keiyaku", ".gitignore");
  unlinkSync(derived);
  const lock = join(git.commonDirectory, "keiyaku", "locks", "places.sqlite");
  unlinkSync(lock);
  mkdirSync(lock);
  const worktrees = repository.run(["worktree", "list", "--porcelain"]);
  let world;
  try {
    world = await (await Repo.at({ path: repository.path })).reconcile();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
  const observed = await withGitDecodeChannel(git, (channel) => worldContractStates({ scope: git, channel }));
  assert.deepEqual(world.contracts.map((contract) => contract.contractId), observed.map((state) => state.id));
  assert.deepEqual(new Set(world.contracts.map((contract) => contract.contractId)), new Set([
    here.keiyaku.id,
    managed.keiyaku.id,
  ]));
  const hereReport = world.contracts.find((contract) => contract.contractId === here.keiyaku.id)!.report;
  const managedReport = world.contracts.find((contract) => contract.contractId === managed.keiyaku.id)!.report;
  assert.equal(managedReport.effects.length, 0);
  assert.equal(managedReport.settlement.actions.length, 0);
  assert.ok(managedReport.lag.some((lag) =>
    lag.kind === "contract-file-failed" && lag.path === placeRegisterPath(git)));
  assert.deepEqual(await readManagedWorktreeAppointment(git, managed.keiyaku.id), appointment);
  assert.equal(repository.run(["worktree", "list", "--porcelain"]), worktrees);
  assert.equal(existsSync(derived), true);
  assert.ok(hereReport.effects.some((effect) =>
    effect.kind === "contract-file" && effect.path === derived));
  assert.deepEqual(hereReport.lag, []);
});
