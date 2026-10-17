import type { OpencodeSdkLoader, OpencodeSdkSession } from "../../src/akuma/providers/opencode-sdk/session.js";

export function opencodeFixture() {
  const id = "ses_fixture";
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  const prompts: { id: string; body: { id: string; text: string } }[] = [];
  const calls: { method: string; value?: unknown }[] = [];
  const messages = new Map<string, Record<string, unknown>>();
  let closed = 0;
  let failPrompt: Error | undefined;
  let selected: Record<string, unknown> | undefined;
  const push = (type: string, data: Record<string, unknown> = {}, eventID = "evt_event") => {
    queue.push({ id: eventID, type, data: { sessionID: id, ...data } });
    wake?.();
    wake = undefined;
  };
  const session: OpencodeSdkSession = {
    async create(value) {
      calls.push({ method: "create", value });
      selected = value.body.model as typeof selected;
      return { data: { id, model: selected } };
    },
    async get(value) {
      calls.push({ method: "get", value });
      return { data: { id: value.id, model: selected } };
    },
    async switchModel(value) {
      calls.push({ method: "switchModel", value });
      selected = value.model;
    },
    async instructions(value) {
      calls.push({ method: "instructions", value });
    },
    async active() {
      return { data: {} };
    },
    async prompt(value) {
      if (failPrompt !== undefined) throw failPrompt;
      prompts.push(value);
      return { data: { id: value.body.id, sessionID: value.id, type: "user" } };
    },
    async message(value) {
      calls.push({ method: "message", value });
      return { data: messages.get(value.messageID) };
    },
    async interrupt(value) {
      calls.push({ method: "interrupt", value });
      return { interrupted: true };
    },
    async fork(value) {
      calls.push({ method: "fork", value });
      return {
        data: { id: "ses_child", fork: { sessionID: value.id, boundary: { type: "before", messageID: value.before } } },
      };
    },
  };
  const loader: OpencodeSdkLoader = async () => ({
    client: {
      session,
      event: {
        async subscribe({ signal }) {
          return {
            stream: (async function* () {
              const abort = () => {
                wake?.();
                wake = undefined;
              };
              signal.addEventListener("abort", abort, { once: true });
              try {
                for (;;) {
                  if (signal.aborted) return;
                  if (queue.length === 0)
                    await new Promise<void>((resolve) => {
                      wake = resolve;
                    });
                  if (signal.aborted) return;
                  while (queue.length > 0) yield queue.shift();
                }
              } finally {
                signal.removeEventListener("abort", abort);
              }
            })(),
          };
        },
      },
    },
    close: () => {
      closed += 1;
    },
  });
  const admitted = (nativeID: string) =>
    push("session.inbox.enqueued", {
      inboxID: nativeID,
      item: { type: "user", payload: { text: "input" }, delivery: "steer" },
    });
  const delivered = (nativeID: string) => push("session.inbox.delivered", { inboxID: nativeID });
  const step = (assistantMessageID = "msg_assistant") =>
    push("session.step.started", { assistantMessageID, model: { providerID: "vendor", id: "model" }, agent: "build" });
  const complete = (text = "answer", assistantID = "msg_assistant", terminalID = "evt_terminal") => {
    messages.set(assistantID, {
      id: assistantID,
      type: "assistant",
      time: { completed: 2 },
      content: [{ type: "text", text }],
    });
    messages.set(terminalID.replace(/^evt_/u, "msg_"), {
      id: terminalID.replace(/^evt_/u, "msg_"),
      type: "idle",
      outcome: "succeeded",
    });
    push("session.text.ended", { assistantMessageID: assistantID, ordinal: 0, text });
    push("session.step.ended", { assistantMessageID: assistantID, finish: "stop" });
    push("session.execution.succeeded", {}, terminalID);
  };
  return {
    id,
    session,
    loader,
    prompts,
    calls,
    messages,
    push,
    admitted,
    delivered,
    step,
    complete,
    rejectPrompt: (error: Error) => {
      failPrompt = error;
    },
    closed: () => closed,
    input: {
      body: "launch",
      launchTells: [],
      cwd: "/tmp",
      options: {},
      signal: new AbortController().signal,
      requests: { dir: "/tmp/requests" },
      session: { kind: "fresh" as const },
    },
  };
}
export async function until(check: () => boolean) {
  for (let n = 0; n < 100; n += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("native event was not observed");
}
