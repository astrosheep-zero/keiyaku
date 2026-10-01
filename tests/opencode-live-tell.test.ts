import assert from "node:assert/strict";
import test from "node:test";
import { createOpencodeProvider } from "../src/akuma/providers/opencode-sdk/index.js";
import type { OpencodeSdkLoader, OpencodeSdkSession } from "../src/akuma/providers/opencode-sdk/session.js";

function fixture() {
  const queued: unknown[] = [];
  let wake: (() => void) | undefined;
  const prompts: {
    body: { messageID: string; parts: { text: string }[]; model?: unknown; variant?: string; system?: string };
  }[] = [];
  const rows: { info: Record<string, unknown>; parts: unknown[] }[] = [];
  const held = new Map<string, { resolve(): void; reject(error: Error): void }>();
  let closed = 0;
  const push = (event: unknown) => {
    queued.push(event);
    wake?.();
    wake = undefined;
  };
  const user = (id: string, sessionID = "session-1") =>
    push({ type: "message.updated", properties: { info: { id, sessionID, role: "user" } } });
  const busy = () => push({ type: "session.status", properties: { sessionID: "session-1", status: { type: "busy" } } });
  const idle = () => push({ type: "session.status", properties: { sessionID: "session-1", status: { type: "idle" } } });
  const fail = () =>
    push({ type: "session.error", properties: { sessionID: "session-1", error: { message: "launch failed" } } });
  const session = {
    async create() {
      return { data: { id: "session-1" } };
    },
    async get() {
      return { data: { id: "session-1" } };
    },
    async promptAsync(value: (typeof prompts)[number]) {
      prompts.push(value);
      rows.push({
        info: { id: value.body.messageID, sessionID: "session-1", role: "user", time: { created: Date.now() } },
        parts: [],
      });
      if (prompts.length > 1)
        await new Promise<void>((resolve, reject) => held.set(value.body.messageID, { resolve, reject }));
      return { data: undefined };
    },
    async messages() {
      return { data: rows };
    },
    async abort() {
      return { data: true };
    },
  } as unknown as OpencodeSdkSession;
  const loader: OpencodeSdkLoader = async () => ({
    client: {
      session,
      event: {
        // The adapter's port carries a cancellation signal; a native event
        // stream honors it, so this fixture models an abortable pending read.
        async subscribe(request: { signal: AbortSignal }) {
          const cancelled = () =>
            new Promise<void>((resolve) => {
              if (request.signal.aborted) resolve();
              else request.signal.addEventListener("abort", () => resolve(), { once: true });
            });
          return {
            stream: (async function* () {
              for (;;) {
                if (queued.length === 0) await Promise.race([cancelled(), new Promise<void>((r) => (wake = r))]);
                if (request.signal.aborted) return;
                while (queued.length > 0) yield queued.shift();
              }
            })(),
          };
        },
      } as never,
    },
    close: () => {
      closed += 1;
    },
  });
  const input = {
    body: "launch",
    launchTells: [],
    cwd: "/tmp",
    options: { model: "vendor/model", effort: "high", systemPrompt: "rules" },
    signal: new AbortController().signal,
    requests: { dir: "/tmp/requests" },
    session: { kind: "fresh" as const },
  };
  const answer = (parentID: string, text: string, summary = false) =>
    rows.push({
      info: {
        id: `msg-answer-${rows.length}`,
        sessionID: "session-1",
        role: "assistant",
        parentID,
        summary,
        time: { created: Date.now() },
      },
      parts: [{ type: "text", text }],
    });
  return { loader, input, prompts, held, user, busy, idle, fail, answer, closed: () => closed };
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("native event was not observed");
}

test("OpenCode matches only own session user admission and attributes final answer to latest Tell", async () => {
  const native = fixture();
  const drive = await createOpencodeProvider({ loader: native.loader }).start(native.input).result;
  const launch = native.prompts[0]!.body.messageID;
  native.user(launch);
  native.busy();
  native.answer(launch, "old answer");
  const first = drive.tell!({ id: "tell-1", text: "same text" });
  await until(() => native.prompts.length === 2);
  const id = native.prompts[1]!.body.messageID;
  assert.ok(id > launch, "native IDs sort after the launch message");
  assert.deepEqual(native.prompts[1]!.body.parts, [{ type: "text", text: "same text" }]);
  assert.deepEqual(
    {
      model: native.prompts[1]!.body.model,
      variant: native.prompts[1]!.body.variant,
      system: native.prompts[1]!.body.system,
    },
    { model: { providerID: "vendor", modelID: "model" }, variant: "high", system: "rules" },
  );
  native.user(id, "wrong-session");
  native.user("other");
  let settled = false;
  void first.then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  native.user(id);
  assert.deepEqual(await first, { kind: "accepted", fence: id });
  native.answer(id, "new answer");
  native.idle();
  assert.deepEqual((await drive.completion).kind, "answered");
  assert.equal(((await drive.completion) as { kind: string; answer: string }).answer, "new answer");
  assert.equal(native.closed(), 1);
  native.held.get(id)?.resolve();
});

test("OpenCode terminal before admission settles pending Tells without accepting old answers", async () => {
  const native = fixture();
  const drive = await createOpencodeProvider({ loader: native.loader }).start(native.input).result;
  const launch = native.prompts[0]!.body.messageID;
  native.user(launch);
  native.busy();
  native.answer(launch, "old answer");
  const pending = drive.tell!({ id: "tell", text: "new" });
  await until(() => native.prompts.length === 2);
  native.idle();
  assert.deepEqual(await pending, { kind: "turn-ended" });
  assert.equal((await drive.completion).kind, "answered");
  native.held.get(native.prompts[1]!.body.messageID)?.resolve();
});

test("OpenCode admission before idle requires its own assistant; abort closes outstanding waits", async () => {
  const native = fixture();
  const drive = await createOpencodeProvider({ loader: native.loader }).start(native.input).result;
  native.user(native.prompts[0]!.body.messageID);
  native.busy();
  const pending = drive.tell!({ id: "tell", text: "new" });
  await until(() => native.prompts.length === 2);
  const id = native.prompts[1]!.body.messageID;
  native.user(id);
  native.idle();
  assert.deepEqual(await pending, { kind: "accepted", fence: id });
  assert.deepEqual(await drive.completion, {
    kind: "failed",
    diagnostic: "OpenCode completed without a native assistant answer",
  });
  native.held.get(id)?.resolve();

  const second = fixture();
  const interrupted = await createOpencodeProvider({ loader: second.loader }).start(second.input).result;
  second.user(second.prompts[0]!.body.messageID);
  const wait = interrupted.tell!({ id: "tell", text: "new" });
  await until(() => second.prompts.length === 2);
  await interrupted.abort();
  assert.deepEqual(await wait, { kind: "turn-ended" });
  assert.equal((await interrupted.completion).kind, "failed");
  second.held.get(second.prompts[1]!.body.messageID)?.resolve();
});

test("OpenCode HTTP response alone cannot receipt; equal text is ordered by distinct native IDs", async () => {
  const native = fixture();
  const drive = await createOpencodeProvider({ loader: native.loader }).start(native.input).result;
  native.user(native.prompts[0]!.body.messageID);
  native.busy();
  const first = drive.tell!({ id: "one", text: "same text" });
  const second = drive.tell!({ id: "two", text: "same text" });
  await until(() => native.prompts.length === 2);
  const firstId = native.prompts[1]!.body.messageID;
  native.held.get(firstId)!.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(native.prompts.length, 2, "the next submission waits for exact native admission");
  let firstSettled = false;
  void first.then(() => {
    firstSettled = true;
  });
  assert.equal(firstSettled, false, "HTTP acknowledgement does not settle the Tell");
  native.user(firstId);
  assert.deepEqual(await first, { kind: "accepted", fence: firstId });
  await until(() => native.prompts.length === 3);
  const secondId = native.prompts[2]!.body.messageID;
  assert.notEqual(firstId, secondId);
  native.user(firstId);
  await new Promise<void>((resolve) => setImmediate(resolve));
  let secondSettled = false;
  void second.then(() => {
    secondSettled = true;
  });
  assert.equal(secondSettled, false, "duplicate first ID cannot receipt second equal-text Tell");
  native.user(secondId);
  assert.deepEqual(await second, { kind: "accepted", fence: secondId });
  native.user(firstId);
  native.answer(firstId, "stale");
  native.answer(secondId, "latest");
  native.idle();
  assert.deepEqual(((await drive.completion) as { kind: string; answer: string }).answer, "latest");
  native.held.get(secondId)?.resolve();
});

test("OpenCode transport rejection without admission is not a receipt", async () => {
  const native = fixture();
  const drive = await createOpencodeProvider({ loader: native.loader }).start(native.input).result;
  native.user(native.prompts[0]!.body.messageID);
  native.busy();
  const failed = drive.tell!({ id: "failed", text: "first" });
  await until(() => native.prompts.length === 2);
  native.held.get(native.prompts[1]!.body.messageID)!.reject(new Error("native request rejected"));
  await assert.rejects(failed, /native request rejected/u);
  native.answer(native.prompts[0]!.body.messageID, "launch answer");
  native.idle();
  assert.deepEqual(((await drive.completion) as { kind: string; answer: string }).answer, "launch answer");
});

test("OpenCode force disposal ends pending Tell and prevents post-terminal submission", async () => {
  const native = fixture();
  const drive = await createOpencodeProvider({ loader: native.loader }).start(native.input).result;
  native.user(native.prompts[0]!.body.messageID);
  const pending = drive.tell!({ id: "pending", text: "new" });
  await until(() => native.prompts.length === 2);
  await drive.forceDispose();
  assert.deepEqual(await pending, { kind: "turn-ended" });
  assert.deepEqual(await drive.tell!({ id: "late", text: "late" }), { kind: "turn-ended" });
  assert.equal(native.prompts.length, 2);
  assert.equal(native.closed(), 1);
  native.held.get(native.prompts[1]!.body.messageID)?.resolve();
});

test("OpenCode waits for exact opening admission before submitting the first live Tell", async () => {
  const native = fixture();
  const drive = await createOpencodeProvider({ loader: native.loader }).start(native.input).result;
  const launch = native.prompts[0]!.body.messageID;
  const pending = drive.tell!({ id: "first", text: "steer" });
  native.user(launch, "other-session");
  native.user("other-message");
  native.busy();
  native.idle();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(native.prompts.length, 1, "HTTP launch acknowledgement and unrelated events cannot release submission");
  native.user(launch);
  native.busy();
  await until(() => native.prompts.length === 2);
  const id = native.prompts[1]!.body.messageID;
  native.user(id);
  assert.deepEqual(await pending, { kind: "accepted", fence: id });
  native.user(launch);
  native.answer(id, "steered answer");
  native.idle();
  assert.equal(((await drive.completion) as { answer: string }).answer, "steered answer");
  native.held.get(id)?.resolve();
});

test("OpenCode ends queued live Tells when the opening message is never admitted", async () => {
  for (const terminal of ["failure", "abort", "dispose"] as const) {
    const native = fixture();
    const drive = await createOpencodeProvider({ loader: native.loader }).start(native.input).result;
    const first = drive.tell!({ id: "first", text: "steer" });
    const second = drive.tell!({ id: "second", text: "steer again" });
    if (terminal === "failure") native.fail();
    else if (terminal === "abort") await drive.abort();
    else await drive.forceDispose();
    assert.deepEqual(await first, { kind: "turn-ended" });
    assert.deepEqual(await second, { kind: "turn-ended" });
    assert.equal((await drive.completion).kind, "failed");
    native.user(native.prompts[0]!.body.messageID);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(native.prompts.length, 1, "terminal settlement never releases a native live submission");
  }
});
