import assert from "node:assert/strict";
import test from "node:test";
import { createOpencodeProvider } from "../src/akuma/providers/opencode-sdk/index.js";
import { opencodeFixture, until } from "./support/opencode-v2.js";
import { deferred } from "./support/process.js";

test("OpenCode v2 submits distinct native message identities and correlates enqueue, delivery, assistant and terminal", async (t) => {
  const native = opencodeFixture(t);
  const provider = createOpencodeProvider(undefined, native.open);
  const attempt = provider.start({ ...native.input, options: { model: "vendor/model", effort: "high" } });
  const drive = await attempt.result;
  const first = native.prompts[0]!.body.id;
  assert.match(first, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/u);
  assert.equal(drive.admission.fence, first);
  assert.deepEqual(native.calls[0], {
    method: "POST",
    path: "/api/session",
    body: { location: { directory: "/tmp" }, model: { providerID: "vendor", id: "model", variant: "high" } },
  });
  native.admitted(first);
  native.delivered(first);
  native.step("msg_opening");
  const tell = drive.tell!({ id: "tell", text: "steer" });
  await until(() => native.prompts.length === 2);
  const next = native.prompts[1]!.body.id;
  assert.match(next, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/u);
  assert.notEqual(next, first);
  assert.equal(native.prompts[1]!.body.text, "steer");
  let accepted = false;
  void tell.then(() => {
    accepted = true;
  });
  native.push("session.inbox.enqueued", { sessionID: "ses_other", inboxID: next, item: { type: "user" } });
  native.admitted("msg_other");
  // Read a later model observation as a barrier past both unrelated admissions.
  native.push("session.step.started", {
    assistantMessageID: "msg_opening",
    model: { providerID: "vendor", id: "later" },
  });
  for await (const event of drive.events) {
    if (event.type === "model" && event.model === "vendor/later") break;
  }
  assert.equal(accepted, false, "HTTP acknowledgement and unrelated admissions are not receipts");
  native.admitted(next);
  assert.deepEqual(await tell, { kind: "accepted", fence: next });
  native.delivered(next);
  native.step();
  native.complete("OK");
  const result = await drive.completion;
  assert.deepEqual(result, { kind: "answered", answer: "OK", historyId: "msg_terminal" });
  await attempt.closed;
  await native.retired();
  assert.ok(result.kind === "answered" && result.historyId);
  assert.deepEqual(
    await provider.fork!({ session: { sessionId: native.id }, at: result.historyId, cwd: "/tmp" }).result,
    {
      session: { sessionId: "ses_child" },
    },
  );
  assert.deepEqual(native.calls.slice(-2), [
    { method: "GET", path: `${native.sessionPath}/message/msg_terminal` },
    { method: "POST", path: `${native.sessionPath}/fork`, body: { before: "msg_terminal" } },
  ]);
  await native.retired();
});

test("OpenCode v2 refuses to attribute another writer's consumed input", async (t) => {
  const native = opencodeFixture(t);
  const drive = await createOpencodeProvider(undefined, native.open).start(native.input).result;
  native.admitted(native.prompts[0]!.body.id);
  native.delivered("msg_human");
  native.step();
  native.complete("human answer");
  assert.match(((await drive.completion) as { diagnostic: string }).diagnostic, /another writer/u);
});

test("OpenCode v2 cannot complete from unrelated idle or an assistant before the latest Tell", async (t) => {
  const native = opencodeFixture(t);
  const drive = await createOpencodeProvider(undefined, native.open).start(native.input).result;
  native.push("session.execution.succeeded");
  const first = native.prompts[0]!.body.id;
  native.admitted(first);
  native.delivered(first);
  native.step("msg_old");
  const tell = drive.tell!({ id: "tell", text: "new" });
  await until(() => native.prompts.length === 2);
  const next = native.prompts[1]!.body.id;
  native.admitted(next);
  await tell;
  native.delivered(next);
  native.complete("old", "msg_old");
  assert.deepEqual(await drive.completion, {
    kind: "failed",
    diagnostic: "OpenCode completed without an assistant for the admitted input",
  });
});

test("OpenCode v2 feed loss fails the Turn without reconnecting or replaying the prompt", async (t) => {
  const native = opencodeFixture(t);
  const attempt = createOpencodeProvider(undefined, native.open).start(native.input);
  const drive = await attempt.result;
  native.disconnect();
  assert.deepEqual(await drive.completion, {
    kind: "failed",
    diagnostic: "OpenCode event stream ended before Turn completion",
  });
  await attempt.closed;
  await native.retired();
  assert.equal(native.subscriptions, 1);
  assert.equal(native.prompts.length, 1);
});

test("OpenCode v2 refuses a native step end without assistantMessageID", async (t) => {
  const native = opencodeFixture(t);
  const drive = await createOpencodeProvider(undefined, native.open).start(native.input).result;
  native.admitted(drive.admission.fence);
  native.delivered(drive.admission.fence);
  native.push("session.step.ended", {});
  assert.deepEqual(await drive.completion, {
    kind: "failed",
    diagnostic: "OpenCode step ended without assistantMessageID",
  });
  await native.retired();
});

test("OpenCode v2 cancellation fences queued Tells, force-disposes during its interrupt, and waits for that one native response", { timeout: 5_000 }, async (t) => {
  const native = opencodeFixture(t);
  const attempt = createOpencodeProvider(undefined, native.open).start(native.input);
  const drive = await attempt.result;
  native.admitted(drive.admission.fence);
  const pending = drive.tell!({ id: "tell", text: "queued" });
  const sent = deferred<void>();
  const response = deferred<void>();
  native.controls.onInterrupt = async () => {
    native.push("session.execution.interrupted", { reason: "user" });
    sent.resolve();
    await response.promise;
  };
  const aborting = attempt.abort();
  await sent.promise;
  const forcing = attempt.forceDispose();
  try {
    assert.equal((await drive.completion).kind, "failed");
    assert.deepEqual(await pending, { kind: "turn-ended" });
    assert.deepEqual(await drive.tell!({ id: "late", text: "new" }), { kind: "turn-ended" });
    assert.equal(native.prompts.length, 1, "cancellation bars later native submission");
    assert.ok(
      [...native.sockets].some((socket) => !socket.destroyed),
      "terminal result and force disposal must not drop the control response",
    );
  } finally {
    response.resolve();
    await Promise.all([aborting, forcing]);
  }
  await attempt.closed;
  assert.deepEqual(await drive.completion, { kind: "failed", diagnostic: "OpenCode session interrupted" });
  assert.deepEqual(
    native.calls.filter((call) => call.path.includes("/interrupt")),
    [{ method: "POST", path: `${native.sessionPath}/interrupt?resume=false` }],
  );
  await native.retired();
});

test("OpenCode v2 resume selects the model before its first prompt, never freshens a native promise", async (t) => {
  const native = opencodeFixture(t);
  const attempt = createOpencodeProvider(undefined, native.open).resume!({
    ...native.input,
    session: { kind: "resume", coordinate: { sessionId: native.id } },
    options: { model: "vendor/model", effort: "high", systemPrompt: "follow these rules" },
  });
  const drive = await attempt.result;
  assert.deepEqual(native.calls.slice(0, 5), [
    { method: "GET", path: native.sessionPath },
    { method: "GET", path: "/api/session/active" },
    {
      method: "POST",
      path: `${native.sessionPath}/model`,
      body: { model: { providerID: "vendor", id: "model", variant: "high" } },
    },
    { method: "GET", path: native.sessionPath },
    { method: "PUT", path: `${native.instructionsPath}/keiyaku.system`, body: { value: "follow these rules" } },
  ]);
  native.admitted(native.prompts[0]!.body.id);
  native.push("session.execution.failed", { error: { message: "model unavailable" } });
  assert.deepEqual(await drive.completion, { kind: "failed", diagnostic: "model unavailable" });
  await attempt.closed;
  await native.retired();
});

test("OpenCode v2 refuses an observed busy or mismatched session before native submission", async (t) => {
  const native = opencodeFixture(t);
  const provider = createOpencodeProvider(undefined, native.open);
  const resume = () =>
    provider.resume!({ ...native.input, session: { kind: "resume", coordinate: { sessionId: native.id } } });
  native.controls.busy = true;
  const busy = resume();
  await assert.rejects(busy.result, /already busy/u);
  await busy.closed;
  await native.retired();
  native.controls.busy = false;
  native.controls.resumeID = "ses_other";
  const wrong = resume();
  await assert.rejects(wrong.result, /different native session/u);
  await wrong.closed;
  await native.retired();
  assert.equal(native.prompts.length, 0);
});

test("OpenCode v2 never forks before an assistant and silently drops its answer", async (t) => {
  const native = opencodeFixture(t);
  native.messages.set("msg_old", { id: "msg_old", type: "assistant" });
  const attempt = createOpencodeProvider(undefined, native.open).fork!({
    session: { sessionId: native.id },
    at: "msg_old",
    cwd: "/tmp",
  });
  await assert.rejects(attempt.result, /successful native terminal boundary/u);
  await attempt.closed;
  assert.equal(
    native.calls.some((call) => call.path.endsWith("/fork")),
    false,
  );
  await native.retired();
});

test("OpenCode v2 refuses unsupported native options instead of dropping them", async (t) => {
  const native = opencodeFixture(t);
  const provider = createOpencodeProvider(undefined, native.open);
  assert.equal(provider.admitOptions({ systemPrompt: "rules", systemPromptMode: "replace" }).kind, "refused");
  assert.equal(provider.admitOptions({ systemPrompt: "rules", systemPromptMode: "append" }).kind, "admitted");
  assert.equal(provider.admitOptions({ network: "enabled" }).kind, "refused");
  assert.equal(provider.admitOptions({ effort: "high" }).kind, "refused");
  const attempt = provider.start({ ...native.input, schemaJson: "{}" });
  await assert.rejects(attempt.result, /structured answer/u);
  await attempt.closed;
  assert.equal(native.calls.length, 0);
});
