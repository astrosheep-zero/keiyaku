import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import { killAkumaWithRecovery, tellAkumaWithId } from "../src/akuma/akuma.js";
import { LEASH_HELD_EXIT } from "../src/akuma/body.js";
import {
  HeldAkumaLeash,
  admitRequest,
  activitySlice,
  appendActivity,
  beginTurn,
  breakBody,
  decidePendingTellDisposition,
  endTurn,
  finishBodyIfIdle,
  heartExists,
  initializeHeart,
  HeartAbsentError,
  life,
  probeLeash,
  provePendingTellDispositionCustody,
  pauseRequested,
  readHeart,
  readForkPoint,
  readSoul,
  readNonterminalRequests,
  readRequest,
  recordSession,
  recordTell as heartRecordTell,
  recordTellDeliveries,
  recordTellReceipt,
  requestPause,
  requestStop,
  reserveRequest,
  serveRequest,
  stopRequested,
  refuseRequest,
  voidRequest,
  type Soul,
} from "../src/akuma/heart/index.js";
import type { OwnedProcess } from "../src/runtime/proc/run.js";
import { insertActivityFact, insertKillFact, insertSessionFact, insertStopControl } from "../src/akuma/heart/rows.js";
import { decodeSoul, decodeSoulRow, encodeSoul, encodeSoulRow } from "../src/akuma/heart/soul.js";
import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
import { insertTellFact } from "../src/akuma/heart/tells.js";
import { AuthorityCorruptionError } from "../src/core/facts/errors.js";
import { turnRecipe } from "../src/akuma/turn-drive.js";
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

test("existing Heart opens adjudicate absence without recreating heart.db", async () => {
  const value = await fixture();
  try {
    unlinkSync(value.allocated.paths.heart);
    assert.equal(await heartExists(value.allocated.paths), false);
    assert.equal(await readSoul(value.allocated.paths), null);
    assert.deepEqual(await readHeart(value.allocated.paths), {
      soul: null,
      latestBody: null,
      latestSession: null,
      pending: [],
      latestKill: null,
      stop: null,
      pause: null,
      lastActivityAt: null,
    });
    assert.equal(await readForkPoint(value.allocated.paths, "missing"), null);
    await assert.rejects(
      appendActivity(value.allocated.paths, {
        turnSequence: 1,
        event: { type: "note", text: "must not recreate" },
        at: "2026-08-08T00:00:00.000Z",
      }),
      HeartAbsentError,
    );
    assert.equal(existsSync(value.allocated.paths.heart), false);
  } finally {
    value.close();
  }
});

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

test("a born soul cannot later be sealed", async () => {
  const value = await fixture();
  try {
    const body = (await HeldAkumaLeash.try(value.allocated.paths))!;
    assert.equal(await body.birth(value.allocated.paths, value.soul), "born");
    assert.deepEqual((await readHeart(value.allocated.paths)).soul, value.soul);
    assert.equal(await probeLeash(value.allocated.paths), "held");
    body.release();
    const sealer = (await HeldAkumaLeash.try(value.allocated.paths))!;
    assert.equal(
      await sealer.sealIfUnborn(value.allocated.paths, { evidence: "late", at: value.soul.createdAt }),
      "born",
    );
    sealer.release();
  } finally {
    value.close();
  }
});

test("session admission survives before turn completion", async () => {
  const value = await fixture();
  try {
    const body = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await body.birth(value.allocated.paths, value.soul);
    const fact = await recordSession(value.allocated.paths, {
      provider: "claude",
      options: value.soul.options,
      coordinate: { sessionId: "native-session" },
      cwd: value.root,
      admittedAt: "2026-08-08T00:00:01.000Z",
    });
    body.release();
    assert.equal((await readHeart(value.allocated.paths)).latestSession?.sequence, fact.sequence);
    assert.deepEqual((await readHeart(value.allocated.paths)).latestSession?.coordinate, {
      sessionId: "native-session",
    });
    assert.deepEqual((await readHeart(value.allocated.paths)).latestSession?.options, value.soul.options);
  } finally {
    value.close();
  }
});

test("provider session cwd does not replace the Soul execution cwd", async () => {
  const value = await fixture();
  try {
    const body = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await body.birth(value.allocated.paths, value.soul);
    await recordSession(value.allocated.paths, {
      provider: value.soul.provider.name,
      options: value.soul.options,
      coordinate: { sessionId: "provider-cwd" },
      cwd: "/provider/selected",
      admittedAt: "2026-08-08T00:00:01.000Z",
    });
    body.release();
    assert.deepEqual(await turnRecipe(value.allocated.paths, value.soul), {
      cwd: value.soul.cwd,
      options: value.soul.options,
      session: { sessionId: "provider-cwd" },
    });
  } finally {
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
    assert.equal(admitted.kind, "recorded");
    if (admitted.kind !== "recorded") return;
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

test("Tell observes Body admission after spawning its child", async () => {
  const value = await fixture();
  let spawned = 0;
  let body: Promise<Awaited<ReturnType<HeldAkumaLeash["recordBody"]>>> | undefined;
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    const result = await tellAkumaWithId({
      worldPath: value.root,
      id: value.allocated.id,
      body: "continue",
      tellId: "tell-registered-body",
      recordedAt: value.soul.createdAt,
      runtime: {
        async spawn(): Promise<OwnedProcess> {
          spawned += 1;
          body = leash.recordBody(value.allocated.paths, { leashTakenAt: value.soul.createdAt });
          await body;
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
    assert.deepEqual(result.wake, { kind: "pursuing", bodySequence: (await body!).sequence });
    assert.equal(spawned, 1);
    leash.release();
  } finally {
    value.close();
  }
});

test("Tell reports spawn failure and leaves the Tell pending", async () => {
  const value = await fixture();
  let spawned = 0;
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    leash.release();
    const result = await tellAkumaWithId({
      worldPath: value.root,
      id: value.allocated.id,
      body: "continue",
      tellId: "tell-observation-denied",
      recordedAt: value.soul.createdAt,
      runtime: {
        async spawn(): Promise<OwnedProcess> {
          spawned += 1;
          throw new Error("spawn denied");
        },
      },
    });
    assert.deepEqual(result.wake, { kind: "failed", diagnostic: "spawn denied" });
    assert.equal(spawned, 1);
    assert.deepEqual(
      (await readHeart(value.allocated.paths)).pending.map((tell) => tell.id),
      ["tell-observation-denied"],
    );
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
    const result = await tellAkumaWithId({
      worldPath: value.root,
      id: value.allocated.id,
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

test("Tell lets a durably told successor win against a losing child exit", async () => {
  const value = await fixture();
  try {
    const born = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await born.birth(value.allocated.paths, value.soul);
    born.release();
    const result = await tellAkumaWithId({
      worldPath: value.root,
      id: value.allocated.id,
      body: "continue",
      tellId: "tell-won-before-exit",
      recordedAt: value.soul.createdAt,
      runtime: {
        async spawn(): Promise<OwnedProcess> {
          const winner = (await HeldAkumaLeash.try(value.allocated.paths))!;
          const body = await winner.recordBody(value.allocated.paths, { leashTakenAt: value.soul.createdAt });
          const turn = await beginTurn(value.allocated.paths, {
            bodySequence: body.sequence,
            startedAt: value.soul.createdAt,
          });
          await recordTellDeliveries(value.allocated.paths, [
            {
              tellId: "tell-won-before-exit",
              route: "launch",
              turnSequence: turn.sequence,
              fence: "winner",
              deliveredAt: value.soul.createdAt,
            },
          ]);
          await recordTellReceipt(value.allocated.paths, {
            tellId: "tell-won-before-exit",
            evidence: "exact",
            kind: "consumed",
            receivedAt: value.soul.createdAt,
          });
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
    assert.deepEqual(result.wake, { kind: "told" });
    assert.equal((await readHeart(value.allocated.paths)).pending.length, 0);
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
    const result = await tellAkumaWithId({
      worldPath: value.root,
      id: value.allocated.id,
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

test("Tell gives a selected child exit one final Heart adjudication", async () => {
  const value = await fixture();
  let winnerSequence: number | undefined;
  try {
    const born = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await born.birth(value.allocated.paths, value.soul);
    born.release();
    const result = await tellAkumaWithId({
      worldPath: value.root,
      id: value.allocated.id,
      body: "continue",
      tellId: "tell-final-heart-after-exit",
      recordedAt: value.soul.createdAt,
      runtime: {
        async spawn(): Promise<OwnedProcess> {
          const exit = Promise.resolve({
            code: 7,
            signal: null,
            log: { path: value.allocated.paths.log, from: 0, to: 0 },
          });
          void exit.then(async () => {
            const winner = (await HeldAkumaLeash.try(value.allocated.paths))!;
            const body = await winner.recordBody(value.allocated.paths, { leashTakenAt: value.soul.createdAt });
            winnerSequence = body.sequence;
            winner.release();
          });
          return {
            pid: 1,
            exited: exit,
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

test("a Heart re-read cannot hide pre-admission child exit", async () => {
  const value = await fixture();
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    leash.release();
    const result = await tellAkumaWithId({
      worldPath: value.root,
      id: value.allocated.id,
      body: "continue",
      tellId: "tell-pre-admission-exit",
      recordedAt: value.soul.createdAt,
      runtime: {
        async spawn(): Promise<OwnedProcess> {
          return {
            pid: 1,
            exited: Promise.resolve({
              code: 7,
              signal: null,
              log: { path: value.allocated.paths.log, from: 12, to: 34 },
            }),
            async terminate() {},
            release() {},
          };
        },
      },
    });
    assert.deepEqual(result.wake, {
      kind: "failed",
      diagnostic: "pre-admission exit 7",
      child: { code: 7, signal: null, log: { path: value.allocated.paths.log, from: 12, to: 34 } },
    });
    assert.deepEqual(
      (await readHeart(value.allocated.paths)).pending.map((tell) => tell.id),
      ["tell-pre-admission-exit"],
    );
  } finally {
    value.close();
  }
});

test("tell admission refuses an unborn heart without writing its timeline", async () => {
  const value = await fixture();
  try {
    assert.deepEqual(
      await recordTell(value.allocated.paths, {
        id: "tell-unborn",
        body: "future input",
        recordedAt: "2026-08-08T00:00:01.000Z",
      }),
      { kind: "not-born" },
    );
    assert.deepEqual((await activitySlice(value.allocated.paths)).rows, []);
    assert.deepEqual((await readHeart(value.allocated.paths)).pending, []);
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
    let recoveryFinished!: () => void;
    const recoveryDone = new Promise<void>((resolve) => {
      recoveryFinished = resolve;
    });
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
      "already-stopped",
    );
    assert.equal(recoveries, 1);
    await recoveryDone;
  } finally {
    value.close();
  }
});

test("retention uses a bounded settled buffer while pending tells remain pinned", async () => {
  const value = await fixture();
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    const body = await leash.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    const admitted = await recordTell(value.allocated.paths, {
      id: "tell-pinned",
      body: "keep me",
      recordedAt: "2026-08-08T00:00:00.000Z",
    });
    assert.equal(admitted.kind, "recorded");
    const turn = await beginTurn(value.allocated.paths, {
      bodySequence: body.sequence,
      startedAt: "2026-08-08T00:00:00.000Z",
    });
    const heart = new DatabaseSync(value.allocated.paths.heart);
    try {
      heart.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      heart
        .prepare(
          `WITH RECURSIVE rows(value) AS (
        VALUES(1) UNION ALL SELECT value + 1 FROM rows WHERE value < 5501
      ) INSERT INTO timeline(kind) SELECT 'activity' FROM rows`,
        )
        .run();
      heart
        .prepare(
          `INSERT INTO activity(sequence, turn_sequence, event_json, at)
        SELECT sequence, ?, '{"type":"note","text":"buffered"}', '2026-08-08T00:00:01.000Z'
        FROM timeline WHERE kind = 'activity'`,
        )
        .run(turn.sequence);
      heart.exec("COMMIT");
    } catch (error) {
      heart.exec("ROLLBACK");
      throw error;
    } finally {
      heart.close();
    }

    await appendActivity(value.allocated.paths, {
      turnSequence: turn.sequence,
      event: { type: "note", text: "trigger compaction" },
      at: "2026-08-08T00:00:02.000Z",
    });
    let retained = await activitySlice(value.allocated.paths);
    assert.equal(
      retained.rows.some((fact) => "id" in fact && fact.id === "tell-pinned"),
      true,
    );
    assert.equal(retained.rows.filter((fact) => fact.kind === "activity").length, 5_000);

    await recordTellReceipt(value.allocated.paths, {
      evidence: "exact",
      tellId: "tell-pinned",
      kind: "consumed",
      receivedAt: "2026-08-08T00:00:03.000Z",
    });
    for (let index = 0; index < 501; index += 1) {
      await appendActivity(value.allocated.paths, {
        turnSequence: turn.sequence,
        event: { type: "note", text: `after-${index}` },
        at: "2026-08-08T00:00:04.000Z",
      });
    }
    retained = await activitySlice(value.allocated.paths);
    assert.equal(
      retained.rows.some((fact) => "id" in fact && fact.id === "tell-pinned"),
      false,
    );
    assert.ok(retained.rows.length >= 5_000 && retained.rows.length <= 5_500);
    leash.release();
  } finally {
    value.close();
  }
});

test("Body Request facts have one idempotent monotonic authority", async () => {
  const value = await fixture();
  const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
  try {
    await leash.birth(value.allocated.paths, value.soul);
    const input = {
      id: "00000000-0000-4000-8000-000000000001",
      action: "akuma.call" as const,
      payloadJson: JSON.stringify({ body: "build" }),
      admittedAt: "2026-08-08T00:00:01.000Z",
      permitted: true,
    };
    assert.equal((await admitRequest(value.allocated.paths, input)).state, "admitted");
    assert.equal(
      (await admitRequest(value.allocated.paths, { ...input, admittedAt: "later" })).admittedAt,
      input.admittedAt,
    );
    assert.deepEqual(
      (await readNonterminalRequests(value.allocated.paths)).map((request) => request.id),
      [input.id],
    );

    const child = await allocateAkumaDirectory({ worldRoot: value.root, archetype: "claude", draw: () => "deadbeef" });
    assert.equal((await reserveRequest(value.allocated.paths, input.id, child.id)).state, "reserved");
    assert.equal((await serveRequest(value.allocated.paths, input.id, child.id)).state, "served");
    assert.equal((await readRequest(value.allocated.paths, input.id))?.state, "served");
    assert.deepEqual(await readNonterminalRequests(value.allocated.paths), []);

    const refused = await admitRequest(value.allocated.paths, {
      ...input,
      id: "00000000-0000-4000-8000-000000000002",
      payloadJson: JSON.stringify({ body: "refuse" }),
    });
    assert.equal((await refuseRequest(value.allocated.paths, refused.id, "unknown Archetype")).state, "refused");
    const voided = await admitRequest(value.allocated.paths, {
      ...input,
      id: "00000000-0000-4000-8000-000000000003",
      payloadJson: JSON.stringify({ body: "void" }),
    });
    assert.equal((await voidRequest(value.allocated.paths, voided.id, "caller gone")).state, "voided");

    assert.deepEqual(await readNonterminalRequests(value.allocated.paths), []);
  } finally {
    leash.release();
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

test("heart schema version 23 and leash schema version 4 hard-refuse old authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-schema-cut-"));
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "30000000" });
  try {
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
    await assert.rejects(readHeart(allocated.paths), /heart schema version must be 23/u);
    await assert.rejects(HeldAkumaLeash.try(allocated.paths), /leash schema version must be 4/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("answered Turns persist without a provider fork point", async () => {
  const value = await fixture();
  try {
    const claim = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await claim.birth(value.allocated.paths, value.soul);
    const body = await claim.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    const turn = await beginTurn(value.allocated.paths, {
      bodySequence: body.sequence,
      startedAt: "2026-08-08T00:00:01.000Z",
    });
    await endTurn(value.allocated.paths, {
      turnSequence: turn.sequence,
      outcome: {
        kind: "answered",
        session: { sessionId: "native-session" },
        answer: "complete answer",
      },
      completedAt: "2026-08-08T00:00:02.000Z",
    });
    claim.release();

    assert.deepEqual(
      (await activitySlice(value.allocated.paths)).rows
        .filter((fact) => fact.kind === "turn-end")
        .map((fact) => fact.outcome),
      [
        {
          kind: "answered",
          session: { sessionId: "native-session" },
          answer: "complete answer",
        },
      ],
    );
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

test("soul codec ignores additional object members", () => {
  const soul = codecSoul();
  const extended = {
    ...soul,
    retired: { value: true },
    options: { ...soul.options, access: "read" },
    readonly: { ...soul.readonly, explanation: "legacy" },
    provider: { ...soul.provider, process: 42 },
    origin: { ...soul.origin, note: "legacy" },
  };
  assert.deepEqual(decodeSoul(extended), soul);
  assert.deepEqual(decodeSoulRow({ soul_json: JSON.stringify(extended) }), soul);
  assert.deepEqual(JSON.parse(encodeSoul(decodeSoul(extended))), soul);
});

test("soul codec decodes canonically, deep-freezes, and round-trips", () => {
  const encoded = encodeSoulRow(codecSoul());
  assert.deepEqual(decodeSoulRow({ soul_json: encoded[0]! }), codecSoul());
  const decoded = decodeSoulRow({ soul_json: encoded[0]! });
  assert.equal(Object.isFrozen(decoded), true);
  assert.equal(Object.isFrozen(decoded.options), true);
  assert.equal(Object.isFrozen(decoded.provider), true);
  assert.equal(Object.isFrozen(decoded.provider.config), true);
  assert.equal(Object.isFrozen(decoded.provider.env), true);
  assert.equal(Object.isFrozen(decoded.readonly), true);
  assert.equal(Object.isFrozen(decoded.origin), true);
  assert.equal(Object.isFrozen(decoded.provider.config!.flag), true);

  const none: Soul = {
    ...codecSoul(),
    readonly: { enforcement: "none", diagnostic: "ACP cannot remove task-surface mutation capabilities" },
  };
  assert.deepEqual(decodeSoul(JSON.parse(encodeSoul(none))), none);

  const reordered = JSON.parse(JSON.stringify(codecSoul())) as Record<string, unknown>;
  const keys = Object.keys(reordered);
  for (const key of keys.reverse()) {
    const value = reordered[key];
    delete reordered[key];
    (reordered as Record<string, unknown>)[key] = value;
  }
  assert.deepEqual(
    encodeSoulRow(codecSoul()),
    encodeSoulRow(reordered as unknown as Soul),
    "canonical serialization ignores input key order",
  );
  assert.deepEqual(Object.keys(JSON.parse(encoded[0]!)), [
    "id",
    "archetype",
    "description",
    "provider",
    "options",
    "readonly",
    "cwd",
    "origin",
    "allowed",
    "createdAt",
  ]);

  const preFeature = JSON.parse(encoded[0]!) as Record<string, unknown>;
  delete preFeature.allowed;
  assert.deepEqual(decodeSoul(preFeature).allowed, ALLOWED_ACTIONS);
  assert.deepEqual(JSON.parse(encodeSoul(decodeSoul(preFeature))).allowed, ALLOWED_ACTIONS);

  assert.throws(
    () => encodeSoulRow({ ...codecSoul(), options: { readonly: true }, readonly: undefined } as unknown as Soul),
    undefined as never,
    "encode validates the consistency rule",
  );
  assert.equal(
    encodeSoulRow(codecSoul())[0] === encodeSoulRow(codecSoul())[0],
    true,
    "canonical encoding is deterministic",
  );

  const historical = codecSoul();
  assert.equal(historical.options.systemPromptMode, undefined);
  assert.deepEqual(decodeSoul(JSON.parse(encodeSoul(historical))).options, historical.options);
  const withMode: Soul = {
    ...historical,
    options: { ...historical.options, systemPromptMode: "replace" },
  };
  assert.deepEqual(decodeSoul(JSON.parse(encodeSoul(withMode))), withMode);
});

function afterSnapshotQuery(after: () => void): () => void {
  const proto = DatabaseSync.prototype;
  const originalPrepare = proto.prepare;
  let fired = false;
  proto.prepare = function (this: DatabaseSync, ...args: Parameters<typeof originalPrepare>) {
    const statement = originalPrepare.apply(this, args);
    const get = statement.get;
    const all = statement.all;
    const fire = () => {
      if (fired) return;
      fired = true;
      after();
    };
    statement.get = function (this: typeof statement, ...args: unknown[]) {
      const result = Reflect.apply(get, this, args);
      fire();
      return result;
    } as unknown as typeof statement.get;
    statement.all = function (this: typeof statement, ...args: unknown[]) {
      const result = Reflect.apply(all, this, args);
      fire();
      return result;
    } as unknown as typeof statement.all;
    return statement;
  };
  return () => {
    proto.prepare = originalPrepare;
  };
}

function writeHeart(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL");
  return database;
}

function claimLeashSeat(path: string): DatabaseSync | null {
  const uri = pathToFileURL(path);
  uri.searchParams.set("mode", "rw");
  const database = new DatabaseSync(uri.href, { timeout: 0 });
  try {
    database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    return database;
  } catch {
    database.close();
    return null;
  }
}

test("activitySlice returns one retained-bound and row epoch", async () => {
  const value = await fixture();
  try {
    const body = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await body.birth(value.allocated.paths, value.soul);
    const firstBody = await body.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    assert.equal((await readHeart(value.allocated.paths)).lastActivityAt, null);
    const turn = await beginTurn(value.allocated.paths, {
      bodySequence: firstBody.sequence,
      startedAt: "2026-08-08T00:00:00.000Z",
    });
    const first = await appendActivity(value.allocated.paths, {
      turnSequence: turn.sequence,
      event: { type: "note", text: "before-commit" },
      at: "2026-08-08T00:00:01.000Z",
    });
    const writer = writeHeart(value.allocated.paths.heart);
    let committed: number | undefined;
    const restore = afterSnapshotQuery(() => {
      if (committed !== undefined) return;
      writer.exec("BEGIN IMMEDIATE");
      committed = insertActivityFact(writer, {
        turnSequence: turn.sequence,
        event: { type: "note", text: "after-commit" },
        at: "2026-08-08T00:00:02.000Z",
      });
      writer.exec("COMMIT");
    });
    try {
      const slice = await activitySlice(value.allocated.paths);
      const sequences = slice.rows.map((row) => row.sequence);
      const pre = slice.highest === first && !sequences.includes(committed!);
      const post = slice.highest === committed && sequences.includes(committed!);
      assert.equal(pre || post, true);
      assert.equal(slice.lowestRetained === 1, true);
    } finally {
      restore();
      writer.close();
    }
    body.release();
  } finally {
    value.close();
  }
});

test("Heart reads lastActivityAt from the final retained timeline row", async () => {
  const value = await fixture();
  try {
    const body = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await body.birth(value.allocated.paths, value.soul);
    const firstBody = await body.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    const turn = await beginTurn(value.allocated.paths, {
      bodySequence: firstBody.sequence,
      startedAt: "2026-08-08T00:00:01.000Z",
    });
    await appendActivity(value.allocated.paths, {
      turnSequence: turn.sequence,
      event: { type: "note", text: "latest" },
      at: "2026-08-08T00:00:02.000Z",
    });
    await endTurn(value.allocated.paths, {
      turnSequence: turn.sequence,
      outcome: { kind: "failed", diagnostic: "done" },
      completedAt: "2026-08-08T00:00:03.000Z",
    });
    assert.equal((await readHeart(value.allocated.paths)).lastActivityAt, "2026-08-08T00:00:03.000Z");
    body.release();
  } finally {
    value.close();
  }
});

test("pending Tell disposition rejects a missing Tell as authority corruption", async () => {
  const value = await fixture();
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    const body = await leash.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    leash.release();
    await recordTell(value.allocated.paths, {
      id: "tell-corrupt-disposition",
      body: "continue",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    const disposition = await decidePendingTellDisposition(value.allocated.paths, {
      bodySequence: body.sequence,
      at: "2026-08-08T00:00:02.000Z",
      handoff: true,
    });
    assert.deepEqual(disposition, { bodySequence: body.sequence, tellIds: ["tell-corrupt-disposition"] });

    const database = writeHeart(value.allocated.paths.heart);
    database.exec("PRAGMA foreign_keys=OFF");
    database.prepare("DELETE FROM tells WHERE id = ?").run("tell-corrupt-disposition");
    database.close();

    await assert.rejects(
      provePendingTellDispositionCustody(value.allocated.paths, disposition!),
      (error: unknown) => error instanceof AuthorityCorruptionError && /missing tell/u.test(String(error)),
    );
  } finally {
    value.close();
  }
});

test("readHeart returns one related Heart-fact epoch", async () => {
  const value = await fixture();
  try {
    const body = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await body.birth(value.allocated.paths, value.soul);
    const firstBody = await body.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    body.release();
    const writer = writeHeart(value.allocated.paths.heart);
    let wrote = false;
    let claimed = false;
    const restore = afterSnapshotQuery(() => {
      if (wrote) return;
      wrote = true;
      const leash = claimLeashSeat(value.allocated.paths.leash);
      claimed = leash !== null;
      writer.exec("BEGIN IMMEDIATE");
      insertSessionFact(writer, {
        provider: "claude",
        options: value.soul.options,
        coordinate: { sessionId: "concurrent-session" },
        cwd: value.root,
        admittedAt: "2026-08-08T00:00:01.000Z",
      });
      insertTellFact(writer, {
        kind: "tell",
        id: "tell-concurrent",
        body: "concurrent",
        recordedAt: "2026-08-08T00:00:02.000Z",
      });
      insertKillFact(writer, firstBody.sequence, "2026-08-08T00:00:03.000Z");
      insertStopControl(writer, firstBody.sequence, "2026-08-08T00:00:04.000Z");
      writer.exec("COMMIT");
      if (leash !== null) {
        leash.exec("ROLLBACK");
        leash.close();
      }
    });
    try {
      const snapshot = await readHeart(value.allocated.paths);
      const pre =
        snapshot.latestSession === null &&
        snapshot.pending.length === 0 &&
        snapshot.latestKill === null &&
        snapshot.stop === null;
      const post =
        snapshot.latestSession?.coordinate.sessionId === "concurrent-session" &&
        snapshot.pending.map((tell) => tell.id).join() === "tell-concurrent" &&
        snapshot.latestKill?.bodySequence === firstBody.sequence &&
        snapshot.stop?.bodySequence === firstBody.sequence;
      assert.equal(wrote, true);
      assert.equal(claimed, true);
      assert.equal(pre || post, true);
      assert.deepEqual(snapshot.soul, value.soul);
      assert.equal(snapshot.latestBody?.sequence, firstBody.sequence);
    } finally {
      restore();
      writer.close();
    }
  } finally {
    value.close();
  }
});
