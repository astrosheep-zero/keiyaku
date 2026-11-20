import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import * as root from "../src/index.js";
import { activityStreamSnapshotSchema } from "../src/akuma/projection.js";
import { akumaStatusSchema } from "../src/akuma/akuma.js";
import { akumaHistoryResultSchema } from "../src/library/selection.js";
import { akumaIdleResultSchema } from "../src/akuma/akuma-instance.js";
import { appendActivity, beginTurn, endTurn } from "../src/akuma/heart/index.js";
import { AkumaOwner } from "../src/akuma/akuma-owner.js";
import { bornBody } from "./support/akuma-fixtures.js";
import { temporaryDirectory } from "./support/process.js";
import { assertWireRoundTrip } from "./support/schema-parity.js";
import { isolateUserHome } from "./support/user-home.js";

isolateUserHome();

test("standalone public status shares one direct current-work observation and keeps only the latest three rows", async (context) => {
  const directory = temporaryDirectory(context, "akuma-standalone-compact-");
  const world = await root.World.at(directory);
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
  const born = await bornBody(directory, "feed0020", "2026-10-30T00:00:00.000Z");
  const aku = root.Akuma.select(world, born.allocated.id);
  const owner = new AkumaOwner(born.allocated.id, world);
  try {
    const turn = await beginTurn(born.allocated.paths, { bodySequence: born.body.sequence, startedAt: "2026-10-30T00:00:01.000Z" });
    const activeId = await appendActivity(born.allocated.paths, {
      turnSequence: turn.sequence, at: "2026-10-30T00:00:02.000Z",
      event: { type: "tool", phase: "started", id: "native-long-tool", name: "bash", call: { kind: "run", command: `npm test ${"🙂".repeat(400)}` } },
    });
    for (let index = 0; index < 12; index += 1)
      await appendActivity(born.allocated.paths, { turnSequence: turn.sequence, at: "2026-10-30T00:00:03.000Z", event: { type: "note", text: `detail ${index} ${"🙂".repeat(400)}` } });
    const native = await owner.status();
    const active = await aku.status();
    assert.deepEqual(active, native, "the standalone face serves the owner's one native observation");
    assertWireRoundTrip(akumaStatusSchema, active);
    assert.deepEqual(active.recent, (await aku.history({ limit: 3 })).rows);
    assert.ok(active.work.summary?.id === activeId && active.work.summary.clipped);
    assert.match(active.work.summary.text, /^run \$ npm test 🙂+…$/u);
    assert.equal(Array.from(active.work.summary.text).length, 300);
    const exact = await root.Akumas.of(world).history({ akuma: aku.id, id: String(activeId) });
    assertWireRoundTrip(akumaHistoryResultSchema, exact);
    assert.ok(exact.kind === "akuma-activity" && exact.row.kind === "tool");
    assert.equal(exact.row.toolId, "native-long-tool");
    const running = await aku.idle({ timeoutMs: 0 });
    assert.equal(running.reason, "deadline");
    assert.equal(running.status.state, "running");
    assert.ok(running.status.state === "running");
    assert.equal(running.status.turn, `turn/${turn.sequence}`);

    const resource = `/outside/${"nested/".repeat(28)}target.txt`;
    const request = { id: "per_read", action: "external_directory", tool: "read", resources: [resource] };
    const approval = await appendActivity(born.allocated.paths, {
      turnSequence: turn.sequence, at: "2026-10-30T00:00:03.000Z", event: { type: "permission", requests: [request] },
    });
    const pending = await aku.status();
    assert.deepEqual(pending.work.awaiting?.requests, [request]);
    const preview = pending.recent?.at(-1);
    assert.ok(preview?.id === approval);
    assert.match(preview.text, /Awaiting approval:.*external_directory.*read.*…$/u);
    assert.ok(!preview.text.includes(resource));
    const exactApproval = await root.Akumas.of(world).history({ akuma: aku.id, id: String(approval) });
    assert.ok(exactApproval.kind === "akuma-activity" && exactApproval.row.kind === "permission");
    assert.deepEqual(exactApproval.row.requests, [request]);
    const answer = `answer ${"🙂".repeat(600)}`;
    await endTurn(born.allocated.paths, { turnSequence: turn.sequence, completedAt: "2026-10-30T00:00:04.000Z", outcome: { kind: "answered", answer, session: { sessionId: "compact-status" } } });
    const idle = await aku.status();
    assertWireRoundTrip(akumaStatusSchema, idle);
    assert.equal(idle.work.kind, "idle");
    const outcome = { state: "done", turn: `turn/${turn.sequence}`, at: "2026-10-30T00:00:04.000Z", answer };
    assert.deepEqual(idle.work.outcome, outcome);
    const waited = await aku.idle({ timeoutMs: 0 });
    assertWireRoundTrip(akumaIdleResultSchema, waited);
    const betweenTurns = waited.status;
    assert.ok(betweenTurns.state === "running");
    assert.equal(betweenTurns.akuma, born.allocated.id);
    assert.equal(betweenTurns.turn, undefined);
    assert.deepEqual(betweenTurns.last, outcome);
    const stream = aku.stream()[Symbol.asyncIterator]();
    try {
      const window = activityStreamSnapshotSchema.parse((await stream.next()).value);
      assert.ok(window.rows.some(row => row.kind === "tool" && row.toolId === "native-long-tool"));
      assert.ok(window.rows.some(row => row.kind === "outcome" && row.outcome.kind === "answered" && row.outcome.answer === answer));
    } finally { await stream.return?.(); }
  } finally { born.holder.release(); }
});
