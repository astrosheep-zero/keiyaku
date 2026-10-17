import assert from "node:assert/strict";
import test from "node:test";
import { createOpencodeProvider } from "../src/akuma/providers/opencode-sdk/index.js";
import { opencodeFixture, until } from "./support/opencode-v2.js";

test("OpenCode v2 correlates native enqueue, delivery, assistant and terminal boundary", async () => {
  const native = opencodeFixture();
  const provider = createOpencodeProvider({ loader: native.loader });
  const attempt = provider.start({ ...native.input, options: { model: "vendor/model", effort: "high" } });
  const drive = await attempt.result;
  const first = native.prompts[0]!.body.id;
  assert.equal(drive.admission.fence, first);
  assert.deepEqual(native.calls[0], {
    method: "create",
    value: { body: { location: { directory: "/tmp" }, model: { providerID: "vendor", id: "model", variant: "high" } } },
  });
  native.admitted(first);
  native.delivered(first);
  native.step("msg_opening");
  const tell = drive.tell!({ id: "tell", text: "steer" });
  await until(() => native.prompts.length === 2);
  const next = native.prompts[1]!.body.id;
  assert.notEqual(next, first);
  assert.equal(native.prompts[1]!.body.text, "steer");
  let accepted = false;
  void tell.then(() => {
    accepted = true;
  });
  native.push("session.inbox.enqueued", { sessionID: "ses_other", inboxID: next, item: { type: "user" } });
  native.admitted("msg_other");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(accepted, false, "HTTP acknowledgement and unrelated admissions are not receipts");
  native.admitted(next);
  assert.deepEqual(await tell, { kind: "accepted", fence: next });
  native.delivered(next);
  native.step();
  native.complete("OK");
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "OK", historyId: "msg_terminal" });
  await attempt.closed;
  assert.equal(native.closed(), 1);
  assert.deepEqual(
    await provider.fork!({ session: { sessionId: native.id }, at: "msg_terminal", cwd: "/tmp" }).result,
    { session: { sessionId: "ses_child" } },
  );
  assert.deepEqual(native.calls.at(-1), { method: "fork", value: { id: native.id, before: "msg_terminal" } });
});

test("OpenCode v2 refuses to attribute another writer's consumed input", async () => {
  const native = opencodeFixture();
  const drive = await createOpencodeProvider({ loader: native.loader }).start(native.input).result;
  native.admitted(native.prompts[0]!.body.id);
  native.delivered("msg_human");
  native.step();
  native.complete("human answer");
  assert.match(((await drive.completion) as { diagnostic: string }).diagnostic, /another writer/u);
});

test("OpenCode v2 cannot complete from unrelated idle or an assistant before the latest Tell", async () => {
  const native = opencodeFixture();
  const drive = await createOpencodeProvider({ loader: native.loader }).start(native.input).result;
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

test("OpenCode v2 terminal errors and feed loss fail honestly", async () => {
  const native = opencodeFixture();
  const drive = await createOpencodeProvider({ loader: native.loader }).start(native.input).result;
  native.admitted(native.prompts[0]!.body.id);
  native.push("session.execution.failed", { error: { message: "model unavailable" } });
  assert.deepEqual(await drive.completion, { kind: "failed", diagnostic: "model unavailable" });
  const lost = opencodeFixture();
  const loader: typeof lost.loader = async (...args) => {
    const loaded = await lost.loader(...args);
    return {
      ...loaded,
      client: {
        ...loaded.client,
        event: {
          async subscribe() {
            return { stream: (async function* () {})() };
          },
        },
      },
    };
  };
  const broken = await createOpencodeProvider({ loader }).start(lost.input).result;
  assert.deepEqual(await broken.completion, {
    kind: "failed",
    diagnostic: "OpenCode event stream ended before Turn completion",
  });
});

test("OpenCode v2 cancellation interrupts once and retires queued live admissions", async () => {
  const native = opencodeFixture();
  const attempt = createOpencodeProvider({ loader: native.loader }).start(native.input);
  const drive = await attempt.result;
  const pending = drive.tell!({ id: "tell", text: "queued" });
  await drive.abort();
  await attempt.closed;
  assert.deepEqual(await pending, { kind: "turn-ended" });
  assert.deepEqual(native.calls.at(-1), { method: "interrupt", value: { id: native.id } });
  assert.equal(native.closed(), 1);
  assert.equal((await drive.completion).kind, "failed");
});

test("OpenCode v2 resume selects the model before its first prompt, never freshens a native promise", async () => {
  const native = opencodeFixture();
  const attempt = createOpencodeProvider({ loader: native.loader }).resume!({
    ...native.input,
    session: { kind: "resume", coordinate: { sessionId: native.id } },
    options: { model: "vendor/model", effort: "high", systemPrompt: "follow these rules" },
  });
  const drive = await attempt.result;
  assert.deepEqual(native.calls.slice(0, 3), [
    { method: "get", value: { id: native.id } },
    { method: "switchModel", value: { id: native.id, model: { providerID: "vendor", id: "model", variant: "high" } } },
    { method: "get", value: { id: native.id } },
  ]);
  assert.deepEqual(native.calls[3], { method: "instructions", value: { id: native.id, text: "follow these rules" } });
  await drive.forceDispose();
  await attempt.closed;
});

test("OpenCode v2 refuses observed busy sessions before native submission", async () => {
  const native = opencodeFixture();
  const provider = createOpencodeProvider({
    loader: async (...args) => {
      const loaded = await native.loader(...args);
      return {
        ...loaded,
        client: {
          ...loaded.client,
          session: {
            ...loaded.client.session,
            active: async () => ({ data: { [native.id]: { type: "running" } } }),
          },
        },
      };
    },
  });
  const attempt = provider.resume!({
    ...native.input,
    session: { kind: "resume", coordinate: { sessionId: native.id } },
  });
  await assert.rejects(attempt.result, /already busy/u);
  await attempt.closed;
  assert.equal(native.prompts.length, 0);
  assert.equal(native.closed(), 1);
});

test("OpenCode v2 never forks before an assistant and silently drops its answer", async () => {
  const native = opencodeFixture();
  native.messages.set("msg_old", { id: "msg_old", type: "assistant" });
  const attempt = createOpencodeProvider({ loader: native.loader }).fork!({
    session: { sessionId: native.id },
    at: "msg_old",
    cwd: "/tmp",
  });
  await assert.rejects(attempt.result, /successful native terminal boundary/u);
  await attempt.closed;
  assert.equal(
    native.calls.some((call) => call.method === "fork"),
    false,
  );
});

test("OpenCode v2 refuses unsupported native options instead of dropping them", async () => {
  const native = opencodeFixture();
  const provider = createOpencodeProvider({ loader: native.loader });
  assert.equal(provider.admitOptions({ systemPrompt: "rules", systemPromptMode: "replace" }).kind, "refused");
  assert.equal(provider.admitOptions({ systemPrompt: "rules", systemPromptMode: "append" }).kind, "admitted");
  assert.equal(provider.admitOptions({ network: "enabled" }).kind, "refused");
  assert.equal(provider.admitOptions({ effort: "high" }).kind, "refused");
  const attempt = provider.start({ ...native.input, schemaJson: "{}" });
  await assert.rejects(attempt.result, /structured answer/u);
  await attempt.closed;
  assert.equal(native.calls.length, 0);
});
