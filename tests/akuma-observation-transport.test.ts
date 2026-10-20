import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { bornDirectAkuma, heartFixture } from "./support/akuma-fixtures.js";
import { temporaryDirectory, waitForCondition } from "./support/process.js";
import { BodySupervisor } from "../src/akuma/body-supervisor.js";
import { observeAdmittedAskAkuma } from "../src/akuma/akuma-selection-execution.js";
import { recordTell, readRequest, beginTurn, bindTellsToTurn, endTurn, breakBody, readTell } from "../src/akuma/heart/index.js";
import { AkumaOwner } from "../src/akuma/akuma-owner.js";
import { World } from "../src/world.js";
import { createHeartReader, HeartAbsentError } from "../src/akuma/heart/storage.js";
import { BodyRequestPump, serveRequest } from "../src/akuma/request-serve.js";
import { requestBodyCommand } from "../src/akuma/request-rendezvous.js";
import { eraseRequestCommand, receiptPath, type ServiceRequestCommand } from "../src/akuma/request-wire.js";

const AT = "2026-10-01T00:00:00.000Z";

function command(
  execute: ServiceRequestCommand<string, string, string, string>["execute"],
): ServiceRequestCommand<string, string, string, string> {
  return {
    completion: "service",
    protocol: {
      action: "test.service",
      encodeRequest: (value) => value,
      decodeRequest: (value) => (typeof value === "string" ? value : null),
      encodeResult: (value) => value,
      decodeResult: (value) => String(value),
      decodeReference: (value) => String(value),
      isPermitted: () => true,
    },
    encodeService: (value) => value,
    decodeService: (value) => String(value),
    projectService: (value) => value,
    execute,
  };
}

async function born(root: string) {
  return await bornDirectAkuma({ root, archetype: "worker", draw: "1234abcd", createdAt: AT });
}

test("observer reuses its connection without retaining a transaction and detects replacement and absence", async () => {
  const fixture = await heartFixture("kei-reader-reuse-");
  const { paths } = fixture.allocated;
  const reader = createHeartReader(paths);
  let first: DatabaseSync | undefined;
  try {
    await reader.read((db) => {
      first = db;
    });
    const writer = new DatabaseSync(paths.heart);
    try {
      writer.exec("CREATE TABLE reader_probe(value INTEGER); INSERT INTO reader_probe VALUES (1)");
      await reader.read((db) => {
        assert.equal(db, first);
        assert.equal(db.prepare("SELECT value FROM reader_probe").get()?.value, 1);
      });
      writer.exec("UPDATE reader_probe SET value=2");
      await reader.read((db) => assert.equal(db.prepare("SELECT value FROM reader_probe").get()?.value, 2));
      assert.equal(writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy, 0);
    } finally {
      writer.close();
    }
    const old = `${paths.heart}.old`;
    await rename(paths.heart, old);
    await rename(`${paths.heart}-wal`, `${old}-wal`).catch(() => {});
    await rename(`${paths.heart}-shm`, `${old}-shm`).catch(() => {});
    const replacement = new DatabaseSync(paths.heart);
    const source = new DatabaseSync(old, { readOnly: true });
    try {
      const version = source.prepare("SELECT version FROM akuma_schema").get()!.version;
      replacement.exec(
        `CREATE TABLE akuma_schema(singleton INTEGER PRIMARY KEY, version INTEGER); INSERT INTO akuma_schema VALUES(1, ${version})`,
      );
    } finally {
      source.close();
      replacement.close();
    }
    await reader.read((db) => assert.notEqual(db, first));
    assert.equal(first!.isOpen, false);
    await rm(paths.heart);
    await assert.rejects(
      reader.read(() => assert.fail("absent Heart must not be read")),
      HeartAbsentError,
    );
  } finally {
    reader.clear();
    fixture.close();
  }
});

test("ask shares its Heart connection across rounds and releases it after settlement", async (context) => {
  const root = await World.at(temporaryDirectory(context, "kei-ask-reader-"));
  const parent = await born(root);
  const body = await parent.leash.recordBody(parent.paths, { leashTakenAt: AT });
  const turn = await beginTurn(parent.paths, { bodySequence: body.sequence, startedAt: AT });
  await recordTell(parent.paths, { kind: "tell", id: "asked", body: "work", recordedAt: AT });
  await bindTellsToTurn(parent.paths, { turnSequence: turn.sequence, tellIds: ["asked"], boundAt: AT });
  const connections = new Set<DatabaseSync>();
  const prepare = DatabaseSync.prototype.prepare;
  context.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql.includes("FROM tells WHERE id = ?")) connections.add(this);
    return prepare.call(this, sql);
  });
  let rounds = 0;
  try {
    const result = await new AkumaOwner(parent.id, root).tellOutcome("asked", {
      timeoutMs: 3000,
      observe: async () => {
        if (++rounds === 2) {
          await endTurn(parent.paths, {
            turnSequence: turn.sequence,
            outcome: { kind: "failed", diagnostic: "test settlement" },
            completedAt: AT,
          });
        }
      },
    });
    assert.equal(result.reason, "completed");
    assert.equal(result.outcome?.kind, "failed");
    assert.ok(rounds >= 3);
    assert.equal(connections.size, 1);
    assert.equal([...connections][0]!.isOpen, false);
  } finally {
    parent.leash.release();
  }
});

test("ask stops on an abandoned bound Turn without inventing an answer", async (context) => {
  const root = await World.at(temporaryDirectory(context, "kei-ask-stopped-"));
  const parent = await born(root);
  const body = await parent.leash.recordBody(parent.paths, { leashTakenAt: AT });
  await recordTell(parent.paths, { kind: "tell", id: "asked", body: "work", recordedAt: AT });
  const turn = await beginTurn(parent.paths, { bodySequence: body.sequence, startedAt: AT });
  await bindTellsToTurn(parent.paths, { turnSequence: turn.sequence, tellIds: ["asked"], boundAt: AT });
  await breakBody(parent.paths, { sequence: body.sequence, end: "put-down", at: AT });
  parent.leash.release();
  const result = await new AkumaOwner(parent.id, root).tellOutcome("asked", { signal: AbortSignal.timeout(2000) });
  assert.equal(result.reason, "completed");
  assert.equal(result.outcome, null);
  assert.equal((await readTell(parent.paths, "asked"))?.state, "pending");
});

test("ask preserves the launch gap, then returns an explicit failed wake without waiting forever", async (context) => {
  const root = await World.at(temporaryDirectory(context, "kei-ask-wake-failed-"));
  const parent = await born(root);
  await recordTell(parent.paths, { kind: "tell", id: "asked", body: "work", recordedAt: AT });
  parent.leash.release();
  const owner = new AkumaOwner(parent.id, root);
  const receipt = await owner.admittedReceipt("asked");
  let release!: (value: typeof receipt) => void;
  const wake = new Promise<typeof receipt>((resolve) => { release = resolve; });
  let rounds = 0;
  const result = await observeAdmittedAskAkuma({
    path: root, id: parent.id, tellId: "asked", wake,
    signal: AbortSignal.timeout(2000),
    onObserve: { observe: async () => {
      if (++rounds === 2) release({ ...receipt, wake: { kind: "failed", diagnostic: "spawn failed" } });
    } },
  });
  assert.ok(rounds >= 3);
  assert.equal(result.observation.reason, "unanswered");
  assert.deepEqual(result.tell.wake, { kind: "failed", diagnostic: "spawn failed" });
  assert.equal((await readTell(parent.paths, "asked"))?.state, "pending");
});

test("ask cancellation interrupts contended Heart admission", async (context) => {
  const root = await World.at(temporaryDirectory(context, "kei-ask-cancel-"));
  const parent = await born(root);
  await recordTell(parent.paths, { kind: "tell", id: "blocked", body: "work", recordedAt: AT });
  const blocker = new DatabaseSync(parent.paths.heart);
  blocker.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
  blocker.prepare("SELECT version FROM akuma_schema").get();
  const controller = new AbortController();
  const reason = new Error("cancel ask read");
  const timer = setTimeout(() => controller.abort(reason), 20);
  try {
    await assert.rejects(
      new AkumaOwner(parent.id, root).tellOutcome("blocked", { signal: controller.signal }),
      (error) => error === reason,
    );
  } finally {
    clearTimeout(timer);
    blocker.close();
    parent.leash.release();
  }
});

test("unchanged Body observations do not wake the Turn, but a new Tell does", async (context) => {
  const parent = await born(temporaryDirectory(context, "kei-control-changes-"));
  const body = await parent.leash.recordBody(parent.paths, { leashTakenAt: AT });
  const supervisor = await BodySupervisor.open(parent.paths, body.sequence, parent.leash);
  try {
    const previous = supervisor.current();
    let woke = false;
    const next = supervisor.next(previous).then((snapshot) => {
      woke = true;
      return snapshot;
    });
    await supervisor.refresh();
    await supervisor.refresh();
    assert.equal(supervisor.current(), previous);
    assert.equal(woke, false);
    await recordTell(parent.paths, { kind: "tell", id: "new-tell", body: "work", recordedAt: AT });
    await supervisor.refresh();
    assert.equal((await next).pending[0]?.id, "new-tell");
  } finally {
    await supervisor.close();
    parent.leash.release();
  }
});

test("consumed claims disappear while Heart still prevents duplicate execution", async (context) => {
  const parent = await born(temporaryDirectory(context, "kei-claim-consumption-"));
  let calls = 0;
  const descriptor = command(async () => {
    calls++;
    return { kind: "served", result: "live", service: "reference" };
  });
  const pump = await BodyRequestPump.open({
    paths: parent.paths,
    allowed: [],
    bodySequence: 1,
    now: () => AT,
    signal: new AbortController().signal,
    commands: { "test.service": eraseRequestCommand(descriptor) },
  });
  try {
    const id = randomUUID();
    const input = { directory: pump.directory, id, command: descriptor.protocol, value: "work" };
    assert.equal((await requestBodyCommand(input)).kind, "returned");
    assert.equal((await requestBodyCommand(input)).kind, "reference");
    assert.equal(calls, 1);
    await waitForCondition(
      "consumed request files removed",
      async () => !(await readdir(pump.directory)).some((name) => name.endsWith(".request.json")),
    );
    assert.equal((await readRequest(parent.paths, id))?.state, "served");
    assert.equal((await readdir(pump.directory)).filter((name) => name.endsWith(".receipt.json")).length, 2);
  } finally {
    await pump.close();
    parent.leash.release();
  }
});

test("receipt failure never re-enters owner failure encoding or settlement", async (context) => {
  const root = temporaryDirectory(context, "kei-receipt-failure-");
  const parent = await born(root);
  let failures = 0;
  const descriptor = command(async () => ({ kind: "served", result: "ok", service: "reference" }));
  const served = {
    ...descriptor,
    protocol: {
      ...descriptor.protocol,
      encodeFailure: () => {
        failures++;
        return null;
      },
    },
  };
  const transportId = randomUUID();
  const id = randomUUID();
  await mkdir(receiptPath(root, transportId));
  try {
    await assert.rejects(
      serveRequest({
        paths: parent.paths,
        allowed: [],
        directory: root,
        transportId,
        now: () => AT,
        signal: new AbortController().signal,
        admissionOpen: () => true,
        claim: { id, action: "test.service", payload: "work" },
        commands: { "test.service": eraseRequestCommand(served) },
      }),
    );
    assert.equal(failures, 0);
    assert.equal((await readRequest(parent.paths, id))?.state, "served");
  } finally {
    parent.leash.release();
  }
});

test("owner ENOENT failure is returned immediately instead of being mistaken for a missing receipt", async (context) => {
  const parent = await born(temporaryDirectory(context, "kei-receipt-owner-enoent-"));
  const ownerError = Object.assign(new Error("owner file missing"), { code: "ENOENT" });
  const descriptor = command(async () => {
    throw ownerError;
  });
  const protocol = {
    ...descriptor.protocol,
    encodeFailure: () => ({ kind: "refused" }),
    decodeFailure: () => ownerError,
  };
  const pump = await BodyRequestPump.open({
    paths: parent.paths,
    allowed: [],
    bodySequence: 1,
    now: () => AT,
    signal: new AbortController().signal,
    commands: { "test.service": eraseRequestCommand({ ...descriptor, protocol }) },
  });
  try {
    await assert.rejects(
      requestBodyCommand({
        directory: pump.directory,
        command: protocol,
        value: "work",
        signal: AbortSignal.timeout(3_000),
      }),
      (error) => error === ownerError,
    );
  } finally {
    await pump.close();
    parent.leash.release();
  }
});
