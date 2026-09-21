import { temporaryDirectory } from "./support/process.js";
import { deferred as promiseBarrier } from "./support/process.js";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync, rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import { killAkumaWithRecovery } from "../src/akuma/akuma.js";
import { AkumaHandle } from "../src/akuma/akuma-handle.js";
import { LEASH_HELD_EXIT, resolveRuntimeExecutable, spawnAkumaBody } from "../src/akuma/body.js";
import {
  HeldAkumaLeash,
  admitRequest,
  activitySlice,
  appendActivity,
  AkumaBusyError,
  beginTurn,
  bindTellsToTurn,
  breakBody,
  decidePendingTellDisposition,
  resolvePendingTellDisposition,
  readOpenPendingTellDisposition,
  drainPendingTells,
  endTurn,
  finishBodyIfIdle, initializeHeart,
  HeartAbsentError,
  life,
  probeLeash,
  pauseRequested,
  readHeart,
  readForkPoint, readTell, readRequest,
  recordSession,
  recordTell as heartRecordTell,
  recordTellDeliveries,
  recordTellReceipt,
  readTurn,
  requestPause,
  requestStop, stopRequested, type Soul
} from "../src/akuma/heart/index.js";
import type { OwnedProcess } from "../src/runtime/proc/run.js";
import { decodeSoul, decodeSoulRow, encodeSoulRow } from "../src/akuma/heart/soul.js";
import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
import { World } from "../src/world.js";

async function fixture() {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-akuma-heart-")));
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1234abcd" });
  await initializeHeart(allocated.paths);
  const soul: Soul = {
    id: allocated.id,
    archetype: "claude",
    description: "Claude fixture",
    provider: { name: "claude", kind: "claude-agent-sdk" },
    options: { model: "claude-sonnet-4-5", systemPrompt: "Be precise." },
    cwd: root,
    origin: { kind: "direct" },
    allowed: ALLOWED_ACTIONS,
    createdAt: "2026-08-08T00:00:00.000Z",
  };
  return { root, allocated, soul, close: () => rmSync(root, { recursive: true, force: true }) };
}

async function recordTell(
  paths: Parameters<typeof heartRecordTell>[0],
  tell: Readonly<{ id: string; body: string; recordedAt: string }>,
) {
  return await heartRecordTell(paths, { kind: "tell", ...tell });
}

async function tellFixture(
  value: Awaited<ReturnType<typeof fixture>>,
  input: Readonly<{
    body: string;
    tellId: string;
    recordedAt?: string;
    runtime?: Parameters<AkumaHandle["tell"]>[3];
  }>,
) {
  return await new AkumaHandle(value.allocated.id, value.root).tell(
    input.body,
    input.tellId,
    input.recordedAt,
    input.runtime,
  );
}

test("existing non-database Heart paths preserve the SQLite open failure", async () => {
  const value = await fixture();
  try {
    unlinkSync(value.allocated.paths.heart);
    mkdirSync(value.allocated.paths.heart);
    await assert.rejects(readHeart(value.allocated.paths), (error: unknown) => {
      assert.equal(error instanceof HeartAbsentError, false);
      assert.equal(typeof (error as { errcode?: unknown }).errcode, "number");
      return true;
    });
    assert.equal(existsSync(value.allocated.paths.heart), true);
  } finally {
    value.close();
  }
});

test("Tell attribution is durable and part of stable input identity", async () => {
  const value = await fixture();
  const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
  try {
    await leash.birth(value.allocated.paths, value.soul);
    const tell = {
      kind: "tell" as const,
      id: "attributed-tell",
      body: "continue",
      initiator: "Bob",
      recordedAt: value.soul.createdAt,
    };
    await heartRecordTell(value.allocated.paths, tell);
    assert.equal((await readTell(value.allocated.paths, tell.id))?.initiator, "Bob");
    assert.equal((await readHeart(value.allocated.paths)).pending[0]?.initiator, "Bob");
    assert.deepEqual(await heartRecordTell(value.allocated.paths, tell), {
      kind: "recorded",
      tell: await readTell(value.allocated.paths, tell.id),
    });
    await assert.rejects(
      heartRecordTell(value.allocated.paths, { ...tell, initiator: "Alice" }),
      /reused different input/u,
    );
  } finally {
    leash.release();
    value.close();
  }
});

test("birth and seal share the child's leash adjudicator", async () => {
  const value = await fixture();
  try {
    const sealer = (await HeldAkumaLeash.try(value.allocated.paths))!;
    assert.equal(
      await sealer.sealIfUnborn(value.allocated.paths, { evidence: "call-timeout", at: value.soul.createdAt }),
      "sealed",
    );
    const lateBody = (await HeldAkumaLeash.try(value.allocated.paths))!;
    assert.equal(await lateBody.birth(value.allocated.paths, value.soul), "sealed");
    lateBody.release();
  } finally {
    value.close();
  }
});

test("control cancellation while waiting for Heart admission leaves no stop or pause", async () => {
  const value = await fixture();
  const paths = value.allocated.paths;
  const leash = (await HeldAkumaLeash.try(paths))!;
  const blocker = new DatabaseSync(paths.heart);
  try {
    await leash.birth(paths, value.soul);
    await leash.recordBody(paths, { leashTakenAt: value.soul.createdAt });
    blocker.exec("BEGIN IMMEDIATE");
    const controller = new AbortController();
    const reason = new Error("caller stopped waiting");
    const handle = new AkumaHandle(value.allocated.id, value.root);
    const results = Promise.allSettled([
      handle.interrupt("not admitted", { signal: controller.signal }),
      handle.kill({ signal: controller.signal }),
    ]);
    const timer = setTimeout(() => controller.abort(reason), 20);
    try {
      for (const result of await results) {
        assert.equal(result.status, "rejected");
        if (result.status === "rejected") assert.equal(result.reason, reason);
      }
    } finally {
      clearTimeout(timer);
    }
    blocker.exec("ROLLBACK");
    const heart = await readHeart(paths);
    assert.equal(heart.stop, null);
    assert.equal(heart.pause, null);
    assert.deepEqual(heart.pending, []);
  } finally {
    blocker.close();
    leash.release();
    value.close();
  }
});

test("a commit failure rolls back the Heart mutation without replaying it", async (context) => {
  const value = await fixture();
  const paths = value.allocated.paths;
  const at = value.soul.createdAt;
  const leash = (await HeldAkumaLeash.try(paths))!;
  try {
    await leash.birth(paths, value.soul);
    const body = await leash.recordBody(paths, { leashTakenAt: at });
    const turn = await beginTurn(paths, { bodySequence: body.sequence, startedAt: at });
    const failure = Object.assign(new Error("commit busy"), { errcode: 5 });
    const exec = DatabaseSync.prototype.exec;
    let commits = 0;
    let begins = 0;
    const injected = context.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE") begins++;
      if (sql === "COMMIT") {
        commits++;
        throw failure;
      }
      return exec.call(this, sql);
    });
    await assert.rejects(
      appendActivity(paths, { turnSequence: turn.sequence, event: { type: "note", text: "rollback" }, at }),
      (error) => error === failure,
    );
    injected.mock.restore();
    assert.equal(begins, 1);
    assert.equal(commits, 1);
    assert.equal((await activitySlice(paths)).rows.filter((fact) => fact.kind === "activity").length, 0);
    await appendActivity(paths, { turnSequence: turn.sequence, event: { type: "note", text: "next call" }, at });
    assert.equal((await activitySlice(paths)).rows.filter((fact) => fact.kind === "activity").length, 1);
  } finally {
    leash.release();
    value.close();
  }
});

test("Pi sessionFile coordinates round trip through Heart custody", async () => {
  const value = await fixture();
  try {
    const body = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await body.birth(value.allocated.paths, value.soul);
    await recordSession(value.allocated.paths, {
      provider: "pi",
      options: { model: "openai/gpt" },
      coordinate: { sessionFile: "/sessions/pi.jsonl", sessionId: "pi-native" },
      cwd: value.root,
      admittedAt: "2026-08-08T00:00:01.000Z",
    });
    body.release();
    assert.deepEqual((await readHeart(value.allocated.paths)).latestSession?.coordinate, {
      sessionFile: "/sessions/pi.jsonl",
      sessionId: "pi-native",
    });
  } finally {
    value.close();
  }
});

test("tell admission shares activity order and delivery witnesses fold without mutable stages", async () => {
  const value = await fixture();
  try {
    const body = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await body.birth(value.allocated.paths, value.soul);
    const bodyFact = await body.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    const turn = await beginTurn(value.allocated.paths, {
      bodySequence: bodyFact.sequence,
      startedAt: "2026-08-08T00:00:00.000Z",
    });
    const firstActivity = await appendActivity(value.allocated.paths, {
      turnSequence: turn.sequence,
      event: { type: "note", text: "before" },
      at: "2026-08-08T00:00:00.000Z",
    });
    const admitted = await recordTell(value.allocated.paths, {
      id: "tell-1",
      body: "first",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    assert.ok(admitted.kind === "recorded", "expected admitted.kind = \"recorded\"");
    const afterActivity = await appendActivity(value.allocated.paths, {
      turnSequence: turn.sequence,
      event: { type: "note", text: "after" },
      at: "2026-08-08T00:00:02.000Z",
    });
    assert.deepEqual([firstActivity, admitted.tell.sequence, afterActivity], [2, 3, 4]);
    assert.deepEqual(
      (await activitySlice(value.allocated.paths)).rows.map((fact) => fact.kind),
      ["turn-start", "activity", "tell", "activity"],
    );

    const delivery = {
      tellId: admitted.tell.id,
      route: "launch" as const,
      turnSequence: turn.sequence,
      fence: "launch-fence",
      deliveredAt: "2026-08-08T00:00:03.000Z",
    };
    await recordTellDeliveries(value.allocated.paths, [delivery]);
    await recordTellDeliveries(value.allocated.paths, [delivery]);
    const told = (await activitySlice(value.allocated.paths)).rows[2];
    assert.equal(told !== undefined && "id" in told ? told.state : null, "told");
    assert.equal((await readHeart(value.allocated.paths)).pending.length, 0);
    body.release();
  } finally {
    value.close();
  }
});

test("runtime resolution re-resolves a displaced record and refuses with the stale path and remedy", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-stale-runtime-");
  const bin = join(root, "bin");
  const replaced = join(bin, "node");
  const displaced = join(root, "retired-runtime", "node");
  mkdirSync(bin, { recursive: true });
  writeFileSync(replaced, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const live = (path: string) => path === replaced;
  // A record still on disk wins as it stands.
  assert.equal(await resolveRuntimeExecutable(replaced, { current: displaced, path: bin, exists: live }), replaced);
  // A displaced record re-resolves to the current process executable...
  assert.equal(await resolveRuntimeExecutable(displaced, { current: replaced, path: bin, exists: live }), replaced);
  // ...and, when the current process executable is that same vanished value, to the recorded
  // command name on the present PATH instead of the gone value again.
  assert.equal(await resolveRuntimeExecutable(displaced, { current: displaced, path: bin, exists: live }), replaced);
  // A record with no live file and no PATH command refuses with the stale path, the failed
  // re-resolution, and the kill-and-call-fresh remedy, never a bare launch absence.
  const vanished = join(root, "vanished-runtime", "keiyaku-body");
  await assert.rejects(
    resolveRuntimeExecutable(vanished, { current: vanished, path: bin, exists: live }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /no longer exists/);
      assert.match(message, /re-resolution failed/);
      assert.match(message, /kill this Akuma and call a fresh one/);
      assert.doesNotMatch(message, /ENOENT/);
      return true;
    },
  );
});

test("wake reports the typed stale-runtime refusal instead of a bare launch absence", async () => {
  const value = await fixture();
  const vanished = join(value.root, "vanished-runtime", "keiyaku-body");
  const emptyBin = join(value.root, "empty-bin");
  mkdirSync(emptyBin, { recursive: true });
  try {
    const born = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await born.birth(value.allocated.paths, value.soul);
    born.release();
    const result = await tellFixture(value, {
      body: "continue",
      tellId: "tell-unresolvable-runtime",
      recordedAt: value.soul.createdAt,
      runtime: {
        async spawn(paths): Promise<OwnedProcess> {
          // The production launch refuses when no runtime resolves, before any spawn happens.
          return await spawnAkumaBody(
            { paths, refuseIfHeld: true },
            { recorded: vanished, environment: { current: vanished, path: emptyBin } },
          );
        },
      },
    });
    assert.equal(result.wake.kind, "failed");
    const diagnostic = result.wake.kind === "failed" ? result.wake.diagnostic : "";
    assert.ok(diagnostic.includes(vanished), diagnostic);
    assert.match(diagnostic, /no longer exists/);
    assert.match(diagnostic, /re-resolution failed/);
    assert.match(diagnostic, /kill this Akuma and call a fresh one/);
    assert.doesNotMatch(diagnostic, /ENOENT/);
    const heart = await readHeart(value.allocated.paths);
    assert.deepEqual(
      heart.pending.map((tell) => tell.id),
      ["tell-unresolvable-runtime"],
    );
    assert.equal(heart.latestBody, null);
  } finally {
    value.close();
  }
});

test("Tell reports held only from its spawned child's private leash refusal", async () => {
  const value = await fixture();
  let spawned = 0;
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    const result = await tellFixture(value, {
      body: "continue",
      tellId: "tell-held",
      recordedAt: value.soul.createdAt,
      runtime: {
        async spawn(): Promise<OwnedProcess> {
          spawned += 1;
          return {
            pid: 1,
            exited: Promise.resolve({
              code: LEASH_HELD_EXIT,
              signal: null,
              log: { path: value.allocated.paths.log, from: 0, to: 0 },
            }),
            async terminate() {},
            release() {},
          };
        },
      },
    });
    assert.deepEqual(result.wake, { kind: "held" });
    assert.equal(spawned, 1);
    assert.deepEqual(
      (await readHeart(value.allocated.paths)).pending.map((tell) => tell.id),
      ["tell-held"],
    );
    leash.release();
  } finally {
    value.close();
  }
});

test("Tell lets a successor Body win when its child exit races Heart observation", async () => {
  const value = await fixture();
  let winnerSequence: number | undefined;
  try {
    const born = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await born.birth(value.allocated.paths, value.soul);
    born.release();
    const result = await tellFixture(value, {
      body: "continue",
      tellId: "tell-successor-race",
      recordedAt: value.soul.createdAt,
      runtime: {
        async spawn(): Promise<OwnedProcess> {
          const winner = (await HeldAkumaLeash.try(value.allocated.paths))!;
          const body = await winner.recordBody(value.allocated.paths, { leashTakenAt: value.soul.createdAt });
          winnerSequence = body.sequence;
          winner.release();
          return {
            pid: 1,
            exited: Promise.resolve({
              code: 7,
              signal: null,
              log: { path: value.allocated.paths.log, from: 0, to: 0 },
            }),
            async terminate() {},
            release() {},
          };
        },
      },
    });
    assert.deepEqual(result.wake, { kind: "pursuing", bodySequence: winnerSequence });
  } finally {
    value.close();
  }
});

test("live receipts are terminal only under their exact Heart correlation", async () => {
  const value = await fixture();
  try {
    const body = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await body.birth(value.allocated.paths, value.soul);
    const firstBody = await body.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    const firstTurn = await beginTurn(value.allocated.paths, {
      bodySequence: firstBody.sequence,
      startedAt: "2026-08-08T00:00:00.000Z",
    });
    const required = await recordTell(value.allocated.paths, {
      id: "tell-required",
      body: "wait for receipt",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    const unavailable = await recordTell(value.allocated.paths, {
      id: "tell-unavailable",
      body: "ack is terminal",
      recordedAt: "2026-08-08T00:00:02.000Z",
    });
    assert.equal(required.kind, "recorded");
    assert.equal(unavailable.kind, "recorded");
    await recordTellDeliveries(value.allocated.paths, [
      {
        tellId: "tell-required",
        route: "live",
        receipt: "required",
        turnSequence: firstTurn.sequence,
        fence: "shared-fence",
        deliveredAt: "2026-08-08T00:00:03.000Z",
      },
      {
        tellId: "tell-unavailable",
        route: "live",
        receipt: "unavailable",
        turnSequence: firstTurn.sequence,
        fence: "ack-fence",
        deliveredAt: "2026-08-08T00:00:03.000Z",
      },
    ]);
    assert.deepEqual(
      (await readHeart(value.allocated.paths)).pending.map((tell) => tell.id),
      ["tell-required"],
    );
    await assert.rejects(
      recordTellReceipt(value.allocated.paths, {
        evidence: "fence",
        turnSequence: firstTurn.sequence + 1,
        fence: "shared-fence",
        kind: "accepted",
        receivedAt: "2026-08-08T00:00:04.000Z",
      }),
      /no delivery mapping/u,
    );
    assert.deepEqual(
      (await readHeart(value.allocated.paths)).pending.map((tell) => tell.id),
      ["tell-required"],
    );
    await recordTellReceipt(value.allocated.paths, {
      evidence: "fence",
      turnSequence: firstTurn.sequence,
      fence: "shared-fence",
      kind: "accepted",
      receivedAt: "2026-08-08T00:00:05.000Z",
    });
    assert.deepEqual((await readHeart(value.allocated.paths)).pending, []);

    const exact = await recordTell(value.allocated.paths, {
      id: "tell-exact",
      body: "exact",
      recordedAt: "2026-08-08T00:00:06.000Z",
    });
    assert.equal(exact.kind, "recorded");
    await recordTellReceipt(value.allocated.paths, {
      evidence: "exact",
      tellId: "tell-exact",
      kind: "consumed",
      receivedAt: "2026-08-08T00:00:07.000Z",
    });
    assert.deepEqual((await readHeart(value.allocated.paths)).pending, []);
    body.release();
  } finally {
    value.close();
  }
});

test("kill witnesses one stopped Body without burning pending work", async () => {
  const value = await fixture();
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    const firstBody = await leash.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    const pending = await recordTell(value.allocated.paths, {
      id: "tell-pending",
      body: "pending",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    assert.equal(pending.kind, "recorded");
    const request = await admitRequest(value.allocated.paths, {
      id: "00000000-0000-4000-8000-000000000010",
      action: "akuma.call",
      payloadJson: JSON.stringify({ body: "child work" }),
      admittedAt: "2026-08-08T00:00:02.000Z",
      permitted: true,
    });
    assert.deepEqual(await requestStop(value.allocated.paths, "2026-08-08T00:00:03.000Z"), {
      kind: "requested",
      body: firstBody,
    });
    await breakBody(value.allocated.paths, {
      sequence: firstBody.sequence,
      end: "put-down",
      at: "2026-08-08T00:00:03.500Z",
    });
    assert.deepEqual(await leash.settleStop(value.allocated.paths), {
      target: { bodySequence: firstBody.sequence, requestedAt: "2026-08-08T00:00:03.000Z" },
      result: "recorded",
    });
    assert.equal((await requestStop(value.allocated.paths, "later")).kind, "already-killed");
    let snapshot = await readHeart(value.allocated.paths);
    assert.equal(snapshot.latestKill?.bodySequence, firstBody.sequence);
    assert.deepEqual(
      snapshot.pending.map((tell) => tell.id),
      ["tell-pending"],
    );
    assert.equal((await readRequest(value.allocated.paths, request.id))?.state, "admitted");
    assert.equal(
      life({
        leash: "free",
        body: { ...firstBody, end: "put-down" },
        kill: snapshot.latestKill,
      }),
      "killed",
    );

    leash.release();
    const successor = (await HeldAkumaLeash.try(value.allocated.paths))!;
    const secondBody = await successor.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:04.000Z",
    });
    const secondTurn = await beginTurn(value.allocated.paths, {
      bodySequence: secondBody.sequence,
      startedAt: "2026-08-08T00:00:04.000Z",
    });
    snapshot = await readHeart(value.allocated.paths);
    assert.equal(
      life({
        leash: "free",
        body: { ...secondBody, end: "exited" },
        kill: snapshot.latestKill,
      }),
      "asleep",
    );
    await recordTellDeliveries(value.allocated.paths, [
      {
        tellId: "tell-pending",
        route: "launch",
        turnSequence: secondTurn.sequence,
        fence: "successor",
        deliveredAt: "2026-08-08T00:00:05.000Z",
      },
    ]);
    assert.deepEqual((await readHeart(value.allocated.paths)).pending, []);
    assert.equal((await readRequest(value.allocated.paths, request.id))?.state, "admitted");
    successor.release();
  } finally {
    value.close();
  }
});

test("kill admission witnesses a stranded settled Body instead of requesting a stop", async () => {
  const value = await fixture();
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    const body = await leash.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    await breakBody(value.allocated.paths, {
      sequence: body.sequence,
      end: "broke-off",
      at: "2026-08-08T00:00:01.000Z",
    });
    leash.release();

    assert.deepEqual(await requestStop(value.allocated.paths, "2026-08-08T00:00:02.000Z"), {
      kind: "witnessed",
      body: { ...body, end: "broke-off", endedAt: "2026-08-08T00:00:01.000Z" },
    });
    const snapshot = await readHeart(value.allocated.paths);
    assert.deepEqual(snapshot.latestKill, {
      sequence: snapshot.latestKill!.sequence,
      bodySequence: body.sequence,
      evidence: "killed",
      at: "2026-08-08T00:00:02.000Z",
    });
    assert.equal(snapshot.stop, null);
    assert.equal(await stopRequested(value.allocated.paths), false);
    assert.equal(
      life({ leash: "free", body: snapshot.latestBody, kill: snapshot.latestKill }),
      "killed",
    );
    assert.equal(
      (await requestStop(value.allocated.paths, "2026-08-08T00:00:03.000Z")).kind,
      "already-killed",
    );
  } finally {
    value.close();
  }
});

test("kill admission of a put-down stranded Body consumes its stop control", async () => {
  const value = await fixture();
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    const body = await leash.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    assert.deepEqual(await requestStop(value.allocated.paths, "2026-08-08T00:00:01.000Z"), {
      kind: "requested",
      body,
    });
    await breakBody(value.allocated.paths, {
      sequence: body.sequence,
      end: "put-down",
      at: "2026-08-08T00:00:02.000Z",
    });
    leash.release();

    // The first kill caller vanished before settling; a later kill witnesses
    // the already settled Body and consumes the lingering stop control.
    assert.equal((await requestStop(value.allocated.paths, "2026-08-08T00:00:03.000Z")).kind, "witnessed");
    assert.equal(await stopRequested(value.allocated.paths), false);
    assert.equal(
      (await readHeart(value.allocated.paths)).latestKill?.bodySequence,
      body.sequence,
    );
  } finally {
    value.close();
  }
});

test("kill of a normally exited Body stays already stopped without a witness", async () => {
  const value = await fixture();
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    const body = await leash.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    await finishBodyIfIdle(value.allocated.paths, { sequence: body.sequence, at: "2026-08-08T00:00:01.000Z" });
    leash.release();

    assert.equal((await requestStop(value.allocated.paths, "2026-08-08T00:00:02.000Z")).kind, "already-stopped");
    assert.equal((await readHeart(value.allocated.paths)).latestKill, null);
    assert.equal(
      life({
        leash: "free",
        body: (await readHeart(value.allocated.paths)).latestBody,
        kill: null,
      }),
      "asleep",
    );
  } finally {
    value.close();
  }
});

test("kill evaluates stranded pending Tell recovery exactly once", async () => {
  const value = await fixture();
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    const body = await leash.recordBody(value.allocated.paths, { leashTakenAt: value.soul.createdAt });
    await breakBody(value.allocated.paths, { sequence: body.sequence, end: "put-down", at: value.soul.createdAt });
    await recordTell(value.allocated.paths, {
      id: "tell-recover-on-kill",
      body: "continue",
      recordedAt: value.soul.createdAt,
    });
    leash.release();
    let recoveries = 0;
    const { promise: recoveryDone, resolve: recoveryFinished } = promiseBarrier<void>();
    assert.equal(
      await killAkumaWithRecovery(value.allocated.paths, async (paths) => {
        try {
          recoveries += 1;
          assert.deepEqual(
            (await readHeart(paths)).pending.map((tell) => tell.id),
            ["tell-recover-on-kill"],
          );
          assert.equal(await probeLeash(paths), "free");
        } finally {
          recoveryFinished();
        }
      }),
      "killed",
    );
    assert.equal((await readHeart(value.allocated.paths)).latestKill?.bodySequence, body.sequence);
    assert.equal(recoveries, 1);
    await recoveryDone;
  } finally {
    value.close();
  }
});

test("unknown Body Request state is authority corruption", async () => {
  const value = await fixture();
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    await admitRequest(value.allocated.paths, {
      id: "00000000-0000-4000-8000-000000000004",
      action: "akuma.call",
      payloadJson: "{}",
      admittedAt: "2026-08-08T00:00:01.000Z",
      permitted: true,
    });
    leash.release();
    const heart = new DatabaseSync(value.allocated.paths.heart);
    heart.exec("PRAGMA ignore_check_constraints = ON");
    heart.prepare("UPDATE requests SET state = 'unknown' WHERE id = ?").run("00000000-0000-4000-8000-000000000004");
    heart.close();
    await assert.rejects(
      readRequest(value.allocated.paths, "00000000-0000-4000-8000-000000000004"),
      /unknown request state: unknown/u,
    );
  } finally {
    value.close();
  }
});

test("heart schema version 29 and leash schema version 4 hard-refuse old authority", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-schema-cut-");
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "30000000" });
  const heart = new DatabaseSync(allocated.paths.heart);
  heart.exec(
    "CREATE TABLE akuma_schema(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO akuma_schema VALUES (1, 14)",
  );
  heart.close();
  const leash = new DatabaseSync(allocated.paths.leash);
  leash.exec(
    "CREATE TABLE leash_schema(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO leash_schema VALUES (1, 2)",
  );
  leash.close();
  await assert.rejects(readHeart(allocated.paths), /heart schema version must be 29/u);
  await assert.rejects(HeldAkumaLeash.try(allocated.paths), /leash schema version must be 4/u);
});

test("schema Tell admission refuses a running Body and binds once with frozen schema JSON", async () => {
  const value = await fixture();
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    const body = await leash.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    const schemaJson = '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}';
    await assert.rejects(
      heartRecordTell(value.allocated.paths, {
        kind: "tell",
        id: "schema-busy",
        body: "return structured",
        recordedAt: "2026-08-08T00:00:01.000Z",
        schemaJson,
      }),
      AkumaBusyError,
    );
    assert.equal((await readHeart(value.allocated.paths)).pending.length, 0);

    await breakBody(value.allocated.paths, {
      sequence: body.sequence,
      end: "put-down",
      at: "2026-08-08T00:00:02.000Z",
    });
    const admitted = await heartRecordTell(value.allocated.paths, {
      kind: "tell",
      id: "schema-idle",
      body: "return structured",
      recordedAt: "2026-08-08T00:00:03.000Z",
      schemaJson,
    });
    assert.ok(admitted.kind === "recorded", "expected admitted.kind = \"recorded\"");
    const following = await heartRecordTell(value.allocated.paths, {
      kind: "tell",
      id: "plain-join",
      body: "also",
      recordedAt: "2026-08-08T00:00:04.000Z",
    });
    const laterSchema = await heartRecordTell(value.allocated.paths, {
      kind: "tell",
      id: "schema-later",
      body: "next turn",
      recordedAt: "2026-08-08T00:00:05.000Z",
      schemaJson,
    });
    assert.equal(following.kind, "recorded");
    assert.equal(laterSchema.kind, "recorded");
    const pending = (await readHeart(value.allocated.paths)).pending;
    assert.deepEqual(
      drainPendingTells(pending).map((tell) => tell.id),
      ["schema-idle", "plain-join"],
    );
    const turn = await beginTurn(value.allocated.paths, {
      bodySequence: body.sequence,
      startedAt: "2026-08-08T00:00:06.000Z",
      schemaJson,
    });
    await bindTellsToTurn(value.allocated.paths, {
      turnSequence: turn.sequence,
      tellIds: ["schema-idle", "plain-join"],
      boundAt: "2026-08-08T00:00:06.000Z",
    });
    await bindTellsToTurn(value.allocated.paths, {
      turnSequence: turn.sequence,
      tellIds: ["schema-idle"],
      boundAt: "2026-08-08T00:00:07.000Z",
    });
    assert.deepEqual(
      drainPendingTells((await readHeart(value.allocated.paths)).pending).map((tell) => tell.id),
      ["schema-idle", "plain-join"],
    );
    const rebindingTurn = await beginTurn(value.allocated.paths, {
      bodySequence: body.sequence,
      startedAt: "2026-08-08T00:00:08.000Z",
    });
    await bindTellsToTurn(value.allocated.paths, {
      turnSequence: rebindingTurn.sequence,
      tellIds: ["schema-idle"],
      boundAt: "2026-08-08T00:00:08.000Z",
    });
    const started = await readTurn(value.allocated.paths, turn.sequence);
    assert.equal(started?.schemaJson, schemaJson);
    await endTurn(value.allocated.paths, {
      turnSequence: turn.sequence,
      outcome: {
        kind: "invalid-output",
        diagnostic: "Unexpected token",
        answer: "not-json",
      },
      completedAt: "2026-08-08T00:00:09.000Z",
    });
    const ended = await readTurn(value.allocated.paths, turn.sequence);
    assert.equal(ended?.end?.outcome.kind, "invalid-output");
    if (ended?.end?.outcome.kind === "invalid-output") {
      assert.equal(ended.end.outcome.answer, "not-json");
    }
    leash.release();
  } finally {
    value.close();
  }
});

test("a binding-before-delivery crash remains recoverable without predecessor terminality", async () => {
  const value = await fixture();
  try {
    const predecessor = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await predecessor.birth(value.allocated.paths, value.soul);
    const firstBody = await predecessor.recordBody(value.allocated.paths, { leashTakenAt: value.soul.createdAt });
    await heartRecordTell(value.allocated.paths, {
      kind: "tell",
      id: "crash-window",
      body: "resume after crash",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    const firstTurn = await beginTurn(value.allocated.paths, {
      bodySequence: firstBody.sequence,
      startedAt: "2026-08-08T00:00:02.000Z",
    });
    await bindTellsToTurn(value.allocated.paths, {
      turnSequence: firstTurn.sequence,
      tellIds: ["crash-window"],
      boundAt: "2026-08-08T00:00:02.000Z",
    });
    predecessor.release();

    const pending = (await readHeart(value.allocated.paths)).pending;
    assert.deepEqual(
      drainPendingTells(pending).map((tell) => tell.id),
      ["crash-window"],
    );
    assert.deepEqual(drainPendingTells(pending, [firstTurn.sequence]), []);

    const successor = (await HeldAkumaLeash.try(value.allocated.paths))!;
    const secondBody = await successor.recordBody(value.allocated.paths, { leashTakenAt: "2026-08-08T00:00:03.000Z" });
    const secondTurn = await beginTurn(value.allocated.paths, {
      bodySequence: secondBody.sequence,
      startedAt: "2026-08-08T00:00:03.000Z",
    });
    await bindTellsToTurn(value.allocated.paths, {
      turnSequence: secondTurn.sequence,
      tellIds: ["crash-window"],
      boundAt: "2026-08-08T00:00:03.000Z",
    });
    const recovered = await readTell(value.allocated.paths, "crash-window");
    assert.equal(recovered?.state, "pending");
    assert.equal(recovered?.binding?.turnSequence, secondTurn.sequence);
    assert.equal((await readTurn(value.allocated.paths, firstTurn.sequence))?.end, undefined);
    assert.equal((await readHeart(value.allocated.paths)).latestBody?.sequence, secondBody.sequence);
    successor.release();
  } finally {
    value.close();
  }
});

test("an unresolved Tell disposition remains eligible for recovery", async () => {
  const value = await fixture();
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    const body = await leash.recordBody(value.allocated.paths, { leashTakenAt: value.soul.createdAt });
    await heartRecordTell(value.allocated.paths, {
      kind: "tell",
      id: "unresolved-disposition",
      body: "recover me",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    await breakBody(value.allocated.paths, {
      sequence: body.sequence,
      end: "put-down",
      at: "2026-08-08T00:00:02.000Z",
    });
    const disposition = await decidePendingTellDisposition(value.allocated.paths, {
      bodySequence: body.sequence,
      at: "2026-08-08T00:00:02.000Z",
      handoff: true,
    });
    assert.deepEqual(disposition?.tellIds, ["unresolved-disposition"]);
    assert.deepEqual(
      drainPendingTells((await readHeart(value.allocated.paths)).pending).map((tell) => tell.id),
      ["unresolved-disposition"],
    );
    leash.release();
  } finally {
    value.close();
  }
});

test("pause remains distinct from stop and can be cleared only under the leash", async () => {
  const value = await fixture();
  try {
    const body = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await body.birth(value.allocated.paths, value.soul);
    const firstBody = await body.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    body.release();
    assert.deepEqual(await requestStop(value.allocated.paths, "2026-08-08T00:00:01.000Z"), {
      kind: "requested",
      body: firstBody,
    });
    assert.deepEqual(await requestPause(value.allocated.paths, "2026-08-08T00:00:02.000Z"), {
      kind: "requested",
      body: firstBody,
    });
    assert.equal(await stopRequested(value.allocated.paths), true);
    assert.equal(await pauseRequested(value.allocated.paths), true);

    const interruptor = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await interruptor.clearPause(value.allocated.paths);
    interruptor.release();
    assert.equal(await pauseRequested(value.allocated.paths), false);
    assert.equal(await stopRequested(value.allocated.paths), true);

    assert.deepEqual(await requestPause(value.allocated.paths, "2026-08-08T00:00:04.000Z"), {
      kind: "requested",
      body: firstBody,
    });
    assert.equal(await pauseRequested(value.allocated.paths), true);
  } finally {
    value.close();
  }
});

test("normal body completion refuses while a tell remains pending", async () => {
  const value = await fixture();
  try {
    const claim = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await claim.birth(value.allocated.paths, value.soul);
    const body = await claim.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    await recordSession(value.allocated.paths, {
      provider: "claude",
      options: value.soul.options,
      coordinate: { sessionId: "native-session" },
      cwd: value.root,
      admittedAt: "2026-08-08T00:00:00.000Z",
    });
    await recordTell(value.allocated.paths, {
      id: "tell-1",
      body: "pending",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    const firstTurn = await beginTurn(value.allocated.paths, {
      bodySequence: body.sequence,
      startedAt: "2026-08-08T00:00:01.000Z",
    });
    await endTurn(value.allocated.paths, {
      turnSequence: firstTurn.sequence,
      outcome: {
        kind: "answered",
        historyId: "turn-1",
        session: { sessionId: "native-session" },
        answer: "done",
      },
      completedAt: "2026-08-08T00:00:02.000Z",
    });
    assert.deepEqual(
      await finishBodyIfIdle(value.allocated.paths, {
        sequence: body.sequence,
        at: "2026-08-08T00:00:02.000Z",
      }),
      { kind: "pending", tells: ["tell-1"] },
    );
    const secondTurn = await beginTurn(value.allocated.paths, {
      bodySequence: body.sequence,
      startedAt: "2026-08-08T00:00:02.000Z",
    });
    await endTurn(value.allocated.paths, {
      turnSequence: secondTurn.sequence,
      outcome: { kind: "failed", diagnostic: "later failure" },
      completedAt: "2026-08-08T00:00:03.000Z",
    });
    assert.deepEqual(
      (await activitySlice(value.allocated.paths)).rows
        .filter((fact) => fact.kind === "turn-end")
        .map((turn) => turn.outcome),
      [
        {
          kind: "answered",
          historyId: "turn-1",
          session: { sessionId: "native-session" },
          answer: "done",
        },
        { kind: "failed", diagnostic: "later failure" },
      ],
    );
    assert.deepEqual(await readForkPoint(value.allocated.paths, `turn/${firstTurn.sequence}`), {
      historyId: "turn-1",
      session: { sessionId: "native-session" },
      provider: "claude",
      cwd: value.root,
      options: value.soul.options,
    });
    assert.equal(await readForkPoint(value.allocated.paths, "missing-turn"), null);
    claim.release();
  } finally {
    value.close();
  }
});

test("fork birth admits the child session in the soul birth transaction", async () => {
  const value = await fixture();
  try {
    const body = (await HeldAkumaLeash.try(value.allocated.paths))!;
    assert.equal(
      await body.birth(value.allocated.paths, value.soul, {
        provider: "claude",
        coordinate: { sessionId: "fork-child" },
        cwd: value.root,
        options: value.soul.options,
        admittedAt: "2026-08-08T00:00:00.000Z",
      }),
      "born",
    );
    assert.deepEqual((await readHeart(value.allocated.paths)).latestSession, {
      sequence: 1,
      provider: "claude",
      coordinate: { sessionId: "fork-child" },
      cwd: value.root,
      options: value.soul.options,
      admittedAt: "2026-08-08T00:00:00.000Z",
    });
    body.release();
  } finally {
    value.close();
  }
});

test("Body idle settlement atomically obeys current control", async () => {
  const value = await fixture();
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    const body = await leash.recordBody(value.allocated.paths, { leashTakenAt: "2026-08-08T00:00:00.000Z" });
    await requestPause(value.allocated.paths, "2026-08-08T00:00:01.000Z");
    assert.deepEqual(
      await finishBodyIfIdle(value.allocated.paths, {
        sequence: body.sequence,
        at: "2026-08-08T00:00:02.000Z",
      }),
      { kind: "controlled" },
    );
    assert.equal((await readHeart(value.allocated.paths)).latestBody?.end, "put-down");
    leash.release();
  } finally {
    value.close();
  }
});

test("life is the sole leash and settlement interpretation", async () => {
  const body = { sequence: 1, leashTakenAt: "2026-08-08T00:00:00.000Z" };
  const kill = { sequence: 1, bodySequence: 1, evidence: "killed" as const, at: "life" };
  const project = (input: Partial<Parameters<typeof life>[0]>) =>
    life({
      leash: "free",
      body,
      kill: null,
      ...input,
    });
  assert.equal(project({ leash: "held", kill }), "running");
  assert.equal(project({ leash: "held" }), "running");
  assert.equal(
    project({
      leash: "held",
      body: {
        ...body,
        hung: { diagnostic: "provider custody remained live", at: "2026-08-08T00:00:02.000Z" },
      },
    }),
    "hung",
  );
  assert.equal(project({}), "untidy");
  assert.equal(project({ body: { ...body, end: "exited" } }), "asleep");
  assert.equal(project({ body: { ...body, end: "broke-off" } }), "stranded");
  assert.equal(project({ body: { ...body, end: "put-down" }, kill }), "killed");
});

test("Body hung custody evidence round trips through Heart", async () => {
  const value = await fixture();
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    const body = await leash.recordBody(value.allocated.paths, { leashTakenAt: "2026-08-08T00:00:00.000Z" });
    await leash.recordBodyHung(value.allocated.paths, {
      sequence: body.sequence,
      diagnostic: "provider custody remained live",
      at: "2026-08-08T00:00:01.000Z",
    });
    assert.deepEqual((await readHeart(value.allocated.paths)).latestBody?.hung, {
      diagnostic: "provider custody remained live",
      at: "2026-08-08T00:00:01.000Z",
    });
    await breakBody(value.allocated.paths, {
      sequence: body.sequence,
      end: "broke-off",
      at: "2026-08-08T00:00:02.000Z",
    });
    assert.equal(
      life({ leash: "held", body: (await readHeart(value.allocated.paths)).latestBody, kill: null }),
      "hung",
    );
    leash.release();
    assert.equal(
      life({ leash: "free", body: (await readHeart(value.allocated.paths)).latestBody, kill: null }),
      "hung",
    );
    const successor = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await assert.rejects(
      successor.recordBody(value.allocated.paths, {
        leashTakenAt: "2026-08-08T00:00:03.000Z",
      }),
      /permanently gated by hung custody/u,
    );
    successor.release();
    await assert.rejects(
      leash.recordBodyHung(value.allocated.paths, {
        sequence: body.sequence,
        diagnostic: "late fabricated custody",
        at: "2026-08-08T00:00:02.000Z",
      }),
      /not owned by this leash/u,
    );
  } finally {
    value.close();
  }
});

function codecSoul(): Soul {
  return {
    id: "aku/claude/1234abcd" as Soul["id"],
    archetype: "claude",
    description: "Codec fixture",
    provider: {
      name: "codex",
      kind: "codex-app-server",
      executable: "codex",
      config: { flag: true },
      env: { HOME: "/tmp/home" },
    },
    options: { model: "claude-sonnet-4-5", effort: "high", readonly: true, network: "disabled", systemPrompt: "Work." },
    readonly: { enforcement: "native" },
    cwd: "/tmp/work",
    origin: {
      kind: "request",
      parent: "aku/parent/1234abcd" as Soul["id"],
      requestId: "00000000-0000-4000-8000-000000000001",
    },
    allowed: ["akuma.call", "task.add"],
    createdAt: "2026-08-15T00:00:00.000Z",
  };
}

test("soul codec hard-fails invalid known members", () => {
  // prettier-ignore
  const corruptions: readonly Readonly<{ name: string; change: (soul: Soul) => unknown }>[] = [
    { name: "missing required field", change: (soul) => { const copy = { ...soul }; delete (copy as Record<string, unknown>).cwd; return copy; } },
    { name: "options readonly false", change: (soul) => ({ ...soul, options: { ...soul.options, readonly: false } }) },
    { name: "readonly option without restraint", change: (soul) => { const copy = { ...soul }; delete (copy as Record<string, unknown>).readonly; return copy; } },
    { name: "restraint without readonly option", change: (soul) => ({ ...soul, options: { ...soul.options, readonly: undefined } }) },
    { name: "none restraint blank diagnostic", change: (soul) => ({ ...soul, readonly: { enforcement: "none", diagnostic: " " } }) },
    { name: "none restraint non-string diagnostic", change: (soul) => ({ ...soul, readonly: { enforcement: "none", diagnostic: 7 } }) },
    { name: "unknown restraint enforcement", change: (soul) => ({ ...soul, readonly: { enforcement: "warn" } }) },
    { name: "unknown systemPromptMode", change: (soul) => ({ ...soul, options: { ...soul.options, systemPromptMode: "merge" } }) },
    { name: "systemPromptMode without systemPrompt", change: (soul) => {
      const options = { ...soul.options, systemPromptMode: "append" };
      delete (options as { systemPrompt?: string }).systemPrompt;
      return { ...soul, options };
    } },
    { name: "unknown provider kind", change: (soul) => ({ ...soul, provider: { ...soul.provider, kind: "grok" } }) },
    { name: "blank provider name", change: (soul) => ({ ...soul, provider: { ...soul.provider, name: " " } }) },
    { name: "provider env non-string value", change: (soul) => ({ ...soul, provider: { ...soul.provider, env: { HOME: 9 } } }) },
    { name: "request origin missing parent", change: (soul) => ({ ...soul, origin: { kind: "request", requestId: "00000000-0000-4000-8000-000000000001" } }) },
    { name: "request origin parent has non-hex suffix", change: (soul) => ({ ...soul, origin: { kind: "request", parent: "aku/parent/nothex", requestId: "00000000-0000-4000-8000-000000000001" } }) },
    { name: "fork origin parent has extra segment", change: (soul) => ({ ...soul, origin: { kind: "fork", parent: "aku/parent/1234abcd/extra", at: "history" } }) },
    { name: "unknown origin kind", change: (soul) => ({ ...soul, origin: { kind: "rebirth" } }) },
    { name: "id is not an Akuma coordinate", change: (soul) => ({ ...soul, id: "garbage" }) },
    { name: "id has a single segment", change: (soul) => ({ ...soul, id: "aku/claude" }) },
    { name: "id suffix is not lower hex8", change: (soul) => ({ ...soul, id: "aku/claude/nothex" }) },
    { name: "id has an extra segment", change: (soul) => ({ ...soul, id: "aku/claude/1234abcd/extra" }) },
    { name: "id archetype is not normalized", change: (soul) => ({ ...soul, id: "aku/Claude/1234abcd" }) },
    { name: "id and archetype disagree", change: (soul) => ({ ...soul, archetype: "worker" }) },
    { name: "blank cwd", change: (soul) => ({ ...soul, cwd: "" }) },
    { name: "blank description", change: (soul) => ({ ...soul, description: " " }) },
    { name: "unknown allowed action", change: (soul) => ({ ...soul, allowed: ["akuma.unknown"] }) },
    { name: "duplicate allowed action", change: (soul) => ({ ...soul, allowed: ["akuma.call", "akuma.call"] }) },
    { name: "non-string allowed action", change: (soul) => ({ ...soul, allowed: [1] }) },
  ];
  for (const { name, change } of corruptions) {
    assert.throws(() => decodeSoul(change(codecSoul())), undefined as never, name);
    assert.throws(() => decodeSoulRow({ soul_json: JSON.stringify(change(codecSoul())) }), undefined as never, name);
    assert.throws(() => encodeSoulRow(change(codecSoul()) as Soul), undefined as never, name);
  }
  assert.throws(() => decodeSoulRow({ soul_json: "not json" }), SyntaxError);
  assert.throws(() => decodeSoulRow({ soul_json: JSON.stringify("garbage") }));
  assert.throws(() => decodeSoulRow({ soul_json: JSON.stringify(42) }));
});



test("historical Soul omission retains the complete vocabulary", () => {
  const historical = { ...codecSoul() } as Record<string, unknown>;
  delete historical.allowed;
  assert.deepEqual(decodeSoul(historical).allowed, ALLOWED_ACTIONS);
});




function seedClosedHistoryActivity(paths: Parameters<typeof readHeart>[0], turnSequence: number, count: number): void {
  const database = new DatabaseSync(paths.heart);
  try {
    database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    const latest = database.prepare("SELECT COALESCE(MAX(sequence), 0) AS value FROM timeline").get() as {
      value: number;
    };
    database
      .prepare(
        `WITH RECURSIVE rows(value) AS (
      VALUES(1) UNION ALL SELECT value + 1 FROM rows WHERE value < ?
    ) INSERT INTO timeline(kind) SELECT 'activity' FROM rows`,
      )
      .run(count);
    database
      .prepare(
        `INSERT INTO activity(sequence, turn_sequence, event_json, at)
      SELECT sequence, ?, '{"type":"note","text":"old history"}', '2026-08-08T00:00:10.000Z'
      FROM timeline WHERE sequence > ?`,
      )
      .run(turnSequence, latest.value);
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}

test("open disposition pins witnessed Tells until atomic resolution, then pruning releases the members", async () => {
  const value = await fixture();
  const paths = value.allocated.paths;
  const at = value.soul.createdAt;
  let leash = (await HeldAkumaLeash.try(paths))!;
  try {
    await leash.birth(paths, value.soul);
    const predecessor = await leash.recordBody(paths, { leashTakenAt: at });
    await recordTell(paths, { id: "frozen", body: "continue", recordedAt: at });
    const disposition = await decidePendingTellDisposition(paths, {
      bodySequence: predecessor.sequence,
      at,
      handoff: true,
    });
    assert.deepEqual(disposition?.tellIds, ["frozen"]);
    assert.equal(await resolvePendingTellDisposition(paths, predecessor.sequence, at), false);
    leash.release();
    leash = (await HeldAkumaLeash.try(paths))!;
    const successor = await leash.recordBody(paths, { leashTakenAt: at });
    const delivered = await beginTurn(paths, { bodySequence: successor.sequence, startedAt: at });
    await recordTellDeliveries(paths, [
      {
        tellId: "frozen",
        route: "launch",
        turnSequence: delivered.sequence,
        fence: "delivered",
        deliveredAt: at,
      },
    ]);
    await endTurn(paths, {
      turnSequence: delivered.sequence,
      outcome: { kind: "failed", diagnostic: "fixture end" },
      completedAt: at,
    });
    const active = await beginTurn(paths, { bodySequence: successor.sequence, startedAt: at });
    seedClosedHistoryActivity(paths, active.sequence, 5501);
    await appendActivity(paths, {
      turnSequence: active.sequence,
      event: { type: "note", text: "prune while open" },
      at,
    });
    assert.equal((await readTell(paths, "frozen"))?.state, "told");
    assert.ok(
      await readTurn(paths, delivered.sequence),
      "the delivery witness must survive while the decision is open",
    );
    assert.deepEqual(await readOpenPendingTellDisposition(paths), disposition);
    assert.deepEqual(
      await Promise.all([
        resolvePendingTellDisposition(paths, predecessor.sequence, at),
        resolvePendingTellDisposition(paths, predecessor.sequence, at),
      ]),
      [true, true],
    );
    assert.equal(await readOpenPendingTellDisposition(paths), null);
    seedClosedHistoryActivity(paths, active.sequence, 501);
    await appendActivity(paths, {
      turnSequence: active.sequence,
      event: { type: "note", text: "prune after consumption" },
      at,
    });
    assert.equal(await readTell(paths, "frozen"), null);
    assert.equal(await readTurn(paths, delivered.sequence), null);
    assert.equal(
      await resolvePendingTellDisposition(paths, predecessor.sequence, at),
      true,
      "late resolution uses the resolved decision, not retired Tells",
    );
    const database = new DatabaseSync(paths.heart);
    try {
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM tell_disposition_members").get()?.count, 0);
    } finally {
      database.close();
    }
  } finally {
    leash.release();
    value.close();
  }
});

test("undelivered disposition settles only its persisted snapshot and cannot decide twice", async () => {
  const value = await fixture();
  const paths = value.allocated.paths;
  const at = value.soul.createdAt;
  const leash = (await HeldAkumaLeash.try(paths))!;
  try {
    await leash.birth(paths, value.soul);
    const body = await leash.recordBody(paths, { leashTakenAt: at });
    await recordTell(paths, { id: "before", body: "frozen", recordedAt: at });
    await decidePendingTellDisposition(paths, { bodySequence: body.sequence, at, handoff: true });
    await recordTell(paths, { id: "after", body: "not this decision", recordedAt: at });
    assert.equal(await resolvePendingTellDisposition(paths, body.sequence, at, "undelivered"), true);
    assert.equal((await readTell(paths, "before"))?.state, "told");
    assert.equal((await readTell(paths, "after"))?.state, "pending");
    assert.equal(await decidePendingTellDisposition(paths, { bodySequence: body.sequence, at, handoff: true }), null);
    assert.equal(await resolvePendingTellDisposition(paths, body.sequence, at, "undelivered"), true);
    assert.equal((await readTell(paths, "after"))?.state, "pending");
    await assert.rejects(resolvePendingTellDisposition(paths, body.sequence + 100, at), /disposition .* is missing/);
  } finally {
    leash.release();
    value.close();
  }
});

test("protected backlog does not repeat unchanged sweeps and releasing a Tell triggers reclamation", async (t) => {
  const value = await fixture();
  const paths = value.allocated.paths;
  const at = value.soul.createdAt;
  const leash = (await HeldAkumaLeash.try(paths))!;
  try {
    await leash.birth(paths, value.soul);
    const body = await leash.recordBody(paths, { leashTakenAt: at });
    const turn = await beginTurn(paths, { bodySequence: body.sequence, startedAt: at });
    const database = new DatabaseSync(paths.heart);
    try {
      database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      const insert = database.prepare("INSERT INTO timeline(kind) VALUES ('tell')");
      const tell = database.prepare("INSERT INTO tells(id, sequence, body, recorded_at) VALUES (?, ?, 'pending', ?)");
      for (let index = 0; index < 5501; index += 1) tell.run(`pending-${index}`, insert.run().lastInsertRowid, at);
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    const prepare = DatabaseSync.prototype.prepare;
    let sweeps = 0;
    let fullCounts = 0;
    t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (sql.includes("DELETE FROM timeline")) sweeps += 1;
      if (/COUNT\(\*\).*FROM timeline/i.test(sql)) fullCounts += 1;
      return prepare.call(this, sql);
    });
    // Each append reopens Heart, so the assertion also proves the maintenance
    // cursor survives connection lifetimes rather than being an in-memory cache.
    for (let index = 0; index < 20; index += 1)
      await appendActivity(paths, {
        turnSequence: turn.sequence,
        event: { type: "note", text: `update-${index}` },
        at,
      });
    assert.equal(sweeps, 1, "protected-only sweeps are not repeated for every append");
    assert.equal(fullCounts, 0, "the append path must not count the full retained timeline");
    await recordTellReceipt(paths, { evidence: "exact", tellId: "pending-0", kind: "consumed", receivedAt: at });
    assert.equal(sweeps, 2, "releasing protection creates a reclamation opportunity without 500 new events");
    assert.equal(await readTell(paths, "pending-0"), null);
    assert.equal((await readTell(paths, "pending-1"))?.state, "pending");
    const retained = await readHeart(paths);
    assert.equal(retained.pending.length, 5500);
  } finally {
    leash.release();
    value.close();
  }
});
