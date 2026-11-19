import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Akuma } from "../src/akuma/index.js";
import { akumaStatusSchema } from "../src/akuma/akuma.js";
import { activitySlice, appendActivity, beginTurn } from "../src/akuma/heart/index.js";
import { withHeartTransaction } from "../src/akuma/heart/storage.js";
import { pruneActivityFacts } from "../src/akuma/heart/timeline.js";
import { AgentEventChannel, AGENT_EVENT_QUEUE_LIMIT, decodeAgentEvent, encodeAgentEvent, type AgentEvent } from "../src/akuma/provider.js";
import { createOpencodeProvider } from "../src/akuma/providers/opencode-sdk/index.js";
import { currentWorkLines } from "../src/cli/render/akuma-activity.js";
import { World } from "../src/world.js";
import { allocatedHeart, bornDirectAkuma, driveWithTell } from "./support/akuma-fixtures.js";
import { opencodeFixture } from "./support/opencode-v2.js";
import { temporaryDirectory, waitForCondition } from "./support/process.js";
import { isolateUserHome } from "./support/user-home.js";

isolateUserHome();

test("native permission waits reach public status, clear on reply, and end with their Turn", { timeout: 30_000 }, async (t) => {
  const root = temporaryDirectory(t, "keiyaku-permission-status-");
  mkdirSync(join(root, ".keiyaku"), { recursive: true });
  writeFileSync(join(root, ".keiyaku", "settings.json"), JSON.stringify({
    plugins: { square: { package: "@astrosheep/keiyaku-plugin-square", enabled: false } },
  }));
  const world = await World.at(root);
  const allocated = await allocatedHeart(root, "opencode", "99840001");
  const native = opencodeFixture(t);
  const controller = new AbortController();
  const body = driveWithTell({
    paths: allocated.paths,
    seed: { id: allocated.id, akumaName: "opencode", provider: { name: "opencode", kind: "opencode-sdk" },
      options: {}, cwd: root, origin: { kind: "direct" } },
  }, "read outside the working directory", createOpencodeProvider(undefined, native.open), { world, signal: controller.signal });
  const handle = Akuma.select(world, allocated.id);
  const path = "/outside/work/secret.txt";
  try {
    await waitForCondition("native prompt admission", () => native.prompts.length === 1);
    native.admitted(native.prompts[0]!.body.id);
    native.delivered(native.prompts[0]!.body.id);
    native.step();
    native.push("session.tool.input.started", { id: "tool-read", name: "read", assistantMessageID: "msg_assistant" });
    native.push("session.tool.called", { id: "tool-read", input: { filePath: path }, assistantMessageID: "msg_assistant" });
    const ask = () => native.push("permission.asked", {
      id: "per_read", action: "external_directory", resources: [path],
      source: { type: "tool", id: "tool-read", messageID: "msg_assistant" },
    });
    ask();
    await waitForCondition("public pending permission", async () => (await handle.status()).work.awaiting !== undefined);
    const status = akumaStatusSchema.parse(await handle.status());
    assert.equal(status.life, "running", "an approval wait is work evidence, not a new lifecycle state");
    assert.deepEqual(status.work.awaiting?.requests, [{ id: "per_read", action: "external_directory", resources: [path], tool: "read" }]);
    assert.ok(status.work.awaiting!.id > 0);
    assert.match(currentWorkLines(status.work).join("\n"), /Awaiting approval:.*external_directory.*read.*\/outside\/work\/secret\.txt/u);
    const longResource = `/outside/${"nested/".repeat(28)}target.txt`;
    const awaiting = { ...status.work.awaiting!, requests: [{ ...status.work.awaiting!.requests[0]!, resources: [longResource] }] };
    assert.ok(currentWorkLines({ ...status.work, awaiting }).some((line) => line.endsWith(longResource)));

    // Ordinary narration does not displace the pending state from the small status window.
    for (let index = 0; index < 8; index += 1) native.push("session.compaction.ended");
    await waitForCondition("later narration", async () => (await activitySlice(allocated.paths)).rows.filter((fact) => fact.kind === "activity" && fact.event.type === "note").length === 8);
    assert.deepEqual((await handle.status()).work.awaiting, status.work.awaiting);

    native.push("permission.replied", { requestID: "per_read", reply: "once" });
    await waitForCondition("cleared public permission", async () => (await handle.status()).work.awaiting === undefined);
    assert.match((await handle.status()).work.summary!.text, /read.*\/outside\/work\/secret\.txt/u);

    ask();
    await waitForCondition("another pending permission", async () => (await handle.status()).work.awaiting !== undefined);
    native.complete("finished");
    await body;
    const ended = await handle.status();
    assert.equal(ended.life, "asleep");
    assert.equal(ended.work.kind, "idle");
    assert.equal(ended.work.awaiting, undefined, "a terminal Turn clears an unanswered observation too");
    const retained = (await activitySlice(allocated.paths)).rows.flatMap((fact) => fact.kind === "activity" && fact.event.type === "permission" ? [fact.event] : []);
    assert.deepEqual(retained.map((event) => event.requests.length), [1, 0, 1]);
  } finally {
    controller.abort();
    await body;
  }
});

test("open-work retention keeps the latest permission state, including its clear", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-permission-retention-");
  const world = await World.at(root);
  const at = new Date().toISOString();
  const born = await bornDirectAkuma({ root, akumaName: "fixture", draw: "99840002", createdAt: at });
  try {
    const body = await born.leash.recordBody(born.paths, { leashTakenAt: at });
    const turn = await beginTurn(born.paths, { bodySequence: body.sequence, startedAt: at });
    const handle = Akuma.select(world, born.id);
    const retain = async (requests: Extract<AgentEvent, { type: "permission" }>["requests"]) => {
      await appendActivity(born.paths, { turnSequence: turn.sequence, at, event: { type: "permission", requests } });
      for (let index = 0; index < 8; index += 1)
        await appendActivity(born.paths, { turnSequence: turn.sequence, at, event: { type: "note", text: `later ${index}` } });
      await withHeartTransaction(born.paths, (database) => pruneActivityFacts(database, 3, true));
    };
    await retain([{ id: "per_retained", action: "read", resources: ["/outside/file"] }]);
    assert.equal((await handle.status()).work.awaiting?.requests[0]?.id, "per_retained");
    await retain([]);
    assert.equal((await handle.status()).work.awaiting, undefined);
    const permissions = (await activitySlice(born.paths)).rows.filter((fact) => fact.kind === "activity" && fact.event.type === "permission");
    assert.equal(permissions.length, 1, "only the current snapshot is protected, not obsolete requests");
  } finally {
    born.leash.release();
  }
});

test("permission snapshot admission keeps the latest clear through narration overflow", async () => {
  const channel = new AgentEventChannel();
  const asked: AgentEvent = { type: "permission", requests: [{ id: "per_pending", action: "read", resources: ["/outside/file"], tool: "read" }] };
  assert.deepEqual(decodeAgentEvent(encodeAgentEvent(asked)), asked);
  channel.emit(asked);
  for (let index = 0; index < AGENT_EVENT_QUEUE_LIMIT * 2; index += 1) channel.emit({ type: "note", text: `note ${index}` });
  channel.emit({ type: "permission", requests: [] });
  channel.end();
  const events: AgentEvent[] = [];
  for await (const event of channel) events.push(event);
  assert.deepEqual(events.filter((event) => event.type === "permission"), [{ type: "permission", requests: [] }]);
});
