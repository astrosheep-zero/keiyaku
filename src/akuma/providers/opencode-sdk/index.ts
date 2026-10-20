import {
  AgentEventChannel,
  createProviderAttempt,
  launchPrompt,
  tellRegistry,
  type AttemptCustody,
  type ProviderAdapter,
  type Session,
  type TurnResult,
} from "../../provider.js";
import type { ResumeCoordinate } from "../../heart/index.js";
import type { ProviderExecution, ProviderOptions } from "../../provider-recipe.js";
import { nonblank, object } from "../decode.js";
import { providerLifecycle } from "../lifecycle.js";
import { ownEventStream, type OwnedEventStream } from "./event-stream.js";
import { createEventState, diagnostic, mapEvent } from "./events.js";
import {
  coordinate,
  loadOpencode,
  messageId,
  OPENCODE_SDK_PROVIDER,
  parseModel,
  type OpencodeRuntime,
  type OpencodeSdkLoader,
} from "./session.js";

type Input = Parameters<ProviderAdapter["start"]>[0] | Parameters<NonNullable<ProviderAdapter["resume"]>>[0];
export type OpencodeProviderTestOptions = Readonly<{ loader?: OpencodeSdkLoader }>;
function sessionId(value: ResumeCoordinate): string {
  if (!("sessionId" in value) || value.sessionId === undefined) throw new Error("OpenCode resume requires sessionId");
  return value.sessionId;
}
function admit(options: ProviderOptions): void {
  if (options.network !== undefined) throw new Error("OpenCode does not support explicit network");
  if (options.systemPromptMode === "replace")
    throw new Error("OpenCode v2 does not support replacing the native system prompt per Turn");
  if (options.model !== undefined) parseModel(options.model);
  if (options.effort !== undefined && options.model === undefined)
    throw new Error("OpenCode effort requires an explicit model");
}
function ownRuntime(custody: AttemptCustody, runtime: OpencodeRuntime): () => Promise<void> {
  let closing: Promise<void> | undefined;
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const closed = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const close = () => {
    if (closing === undefined) {
      closing = runtime.close();
      void closing.then(resolve, reject);
    }
    return closing;
  };
  custody.own({ closed, abort: close, forceDispose: close });
  return close;
}
function liveAdmission(initial: string) {
  let latest = initial;
  let ended = false;
  const submitted = new Set([initial]);
  const tells = tellRegistry<string>();
  const wait = (id: string) => {
    submitted.add(id);
    return tells.register(id, id);
  };
  return {
    initial: wait(initial),
    latest: () => latest,
    open: () => !ended,
    owns: (id: string) => submitted.has(id),
    wait,
    admit(id: string) {
      if (tells.accept(id)) latest = id;
    },
    fail: tells.fail,
    end: () => {
      ended = true;
      tells.end();
    },
  };
}
async function answer(
  runtime: OpencodeRuntime,
  id: string,
  assistantID: string,
  terminalID: string,
): Promise<TurnResult> {
  const response = object(await runtime.client.session.message({ id, messageID: assistantID }));
  const message = object(response?.data);
  if (message?.id !== assistantID || message.type !== "assistant" || object(message.time)?.completed === undefined) {
    return { kind: "failed", diagnostic: "OpenCode completed without its exact completed assistant message" };
  }
  if (message.error !== undefined) return { kind: "failed", diagnostic: diagnostic(message.error) };
  if (!Array.isArray(message.content)) return { kind: "failed", diagnostic: "OpenCode assistant content missing" };
  const text = message.content
    .flatMap((item) => {
      const part = object(item);
      return part?.type === "text" && typeof part.text === "string" ? [part.text] : [];
    })
    .join("\n\n");
  // v2's terminal event projects a real idle message with this exact ID. Forking
  // BEFORE that message includes the answer, without copying later native work.
  const boundary = terminalID.replace(/^evt_/u, "msg_");
  const projected = object(object(await runtime.client.session.message({ id, messageID: boundary }))?.data);
  if (projected?.id !== boundary || projected.type !== "idle" || projected.outcome !== "succeeded") {
    return { kind: "failed", diagnostic: "OpenCode terminal fork boundary was not projected" };
  }
  return { kind: "answered", answer: text, historyId: boundary };
}
async function observe(
  input: Readonly<{
    runtime: OpencodeRuntime;
    stream: OwnedEventStream;
    id: string;
    admission: ReturnType<typeof liveAdmission>;
    events: AgentEventChannel;
  }>,
): Promise<TurnResult> {
  const state = createEventState(input.id);
  let delivered: string | undefined;
  let step: { id: string; input: string; ended: boolean } | undefined;
  try {
    for (;;) {
      const next = await input.stream.next();
      if (next.done) return { kind: "failed", diagnostic: "OpenCode event stream ended before Turn completion" };
      const event = object(next.value);
      const data = object(event?.data);
      if (data?.sessionID !== input.id) continue;
      const type = event?.type;
      if (type === "session.inbox.enqueued" && typeof data.inboxID === "string" && object(data.item)?.type === "user") {
        input.admission.admit(data.inboxID);
      }
      if (type === "session.inbox.delivered" && typeof data.inboxID === "string") {
        if (!input.admission.owns(data.inboxID)) {
          return {
            kind: "failed",
            diagnostic: "OpenCode consumed another writer's input; exact answer attribution unavailable",
          };
        }
        input.admission.admit(data.inboxID);
        delivered = data.inboxID;
      }
      if (type === "session.step.started" && delivered !== undefined && typeof data.assistantMessageID === "string") {
        step = { id: data.assistantMessageID, input: delivered, ended: false };
      }
      if (data.assistantMessageID !== undefined && data.assistantMessageID !== step?.id) continue;
      if (delivered !== undefined) mapEvent(event, input.events, state);
      if (type === "session.step.ended" && step !== undefined) step.ended = true;
      if (type === "session.step.failed" || type === "session.execution.failed") {
        return { kind: "failed", diagnostic: diagnostic(data.error) };
      }
      if (type === "session.execution.interrupted")
        return { kind: "failed", diagnostic: "OpenCode native execution interrupted" };
      if (type !== "session.execution.succeeded" || delivered === undefined) continue;
      if (step === undefined || !step.ended || step.input !== input.admission.latest()) {
        return { kind: "failed", diagnostic: "OpenCode completed without an assistant for the admitted input" };
      }
      const terminalID = nonblank(event?.id);
      if (terminalID === undefined || !terminalID.startsWith("evt_"))
        return { kind: "failed", diagnostic: "OpenCode terminal identity missing" };
      return await answer(input.runtime, input.id, step.id, terminalID);
    }
  } catch (error) {
    return { kind: "failed", diagnostic: `OpenCode observation failed: ${diagnostic(error)}` };
  } finally {
    input.admission.end();
  }
}
async function openSession(runtime: OpencodeRuntime, input: Input): Promise<string> {
  const model =
    input.options.model === undefined
      ? undefined
      : {
          ...parseModel(input.options.model),
          ...(input.options.effort === undefined ? {} : { variant: input.options.effort }),
        };
  const session = runtime.client.session;
  const response =
    input.session.kind === "fresh"
      ? await session.create({
          body: { location: { directory: input.cwd }, ...(model === undefined ? {} : { model }) },
        })
      : await session.get({ id: sessionId(input.session.coordinate) });
  const info = object(object(response)?.data);
  const id = nonblank(info?.id);
  if (id === undefined) throw new Error("OpenCode did not return a session id");
  const active = object(object(await session.active())?.data);
  if (active === undefined) throw new Error("OpenCode active execution response missing");
  if (active[id] !== undefined) throw new Error("OpenCode native session is already busy");
  let selected = object(info?.model);
  if (input.session.kind === "resume" && model !== undefined) {
    await session.switchModel({ id, model });
    selected = object(object(object(await session.get({ id }))?.data)?.model);
  }
  if (
    model !== undefined &&
    (selected?.providerID !== model.providerID ||
      selected.id !== model.id ||
      (selected.variant ?? "default") !== (input.options.effort ?? "default"))
  ) {
    throw new Error("OpenCode did not select the requested model");
  }
  if (input.options.systemPrompt !== undefined) {
    // Native instruction entries join the system transcript and survive resume
    // and fork. Updating the same entry announces an upstream instruction change.
    await session.instructions({ id, text: input.options.systemPrompt });
  }
  return id;
}
async function drive(
  execution: ProviderExecution,
  input: Input,
  loader: OpencodeSdkLoader | undefined,
  custody: AttemptCustody,
): Promise<Session> {
  admit(input.options);
  if (input.schemaJson !== undefined) throw new Error("OpenCode v2 does not expose native structured answer schemas");
  if (input.session.kind === "resume") sessionId(input.session.coordinate);
  let closeRuntime!: () => Promise<void>;
  const runtime = await loadOpencode({
    execution,
    cwd: input.cwd,
    signal: custody.signal,
    ...(loader === undefined ? {} : { loader }),
    onRuntime: (ready) => {
      closeRuntime = ownRuntime(custody, ready);
    },
    ...(input.requests === undefined ? {} : { requests: input.requests.dir }),
  });
  const stream = ownEventStream({
    directory: input.cwd,
    signal: custody.signal,
    custody,
    subscribe: runtime.client.event.subscribe,
  });
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= Promise.all([stream.retire(), closeRuntime()]).then(() => undefined));
  try {
    const id = await openSession(runtime, input);
    await stream.ready;
    custody.signal.throwIfAborted();
    const events = new AgentEventChannel();
    events.emit({ type: "session", coordinate: coordinate(id) });
    let sequence = 0;
    const initial = messageId(sequence++);
    const admission = liveAdmission(initial);
    let control: Promise<unknown> | undefined;
    let finishing = false;
    let finish!: (result: TurnResult) => Promise<void>;
    const completion = new Promise<TurnResult>((resolve) => {
      let settlement: Promise<void> | undefined;
      finish = (result) => {
        finishing = true;
        return (settlement ??= (async () => {
          await close();
          events.end();
          resolve(result);
        })());
      };
    });
    const observed = observe({ runtime, stream, id, admission, events });
    // Start observation before submission: admission broadcasts can precede HTTP completion.
    void observed
      .then(async (result) => {
        // Explicit interrupt owns its response too: a terminal broadcast can be
        // published before that response, and must not close its connection early.
        if (control !== undefined) await control;
        await finish(result);
      })
      .catch(() => undefined);
    const prompt = async (nativeID: string, text: string) => {
      const response = object(object(await runtime.client.session.prompt({ id, body: { id: nativeID, text } }))?.data);
      if (response?.id !== nativeID || response.sessionID !== id || response.type !== "user") {
        throw new Error("OpenCode returned no exact native inbox admission");
      }
    };
    await prompt(initial, launchPrompt(input.body, input.launchTells));
    custody.signal.throwIfAborted();
    let submissions: Promise<void> = admission.initial.then(() => undefined);
    return {
      admission: { fence: initial },
      events,
      completion,
      tell(tell) {
        const submit = async () => {
          if (!admission.open()) return { kind: "turn-ended" } as const;
          const nativeID = messageId(sequence++);
          const receipt = admission.wait(nativeID);
          void prompt(nativeID, tell.text).catch((error: unknown) => admission.fail(nativeID, error));
          return await receipt;
        };
        const next = submissions.then(submit);
        submissions = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
      abort: async () => {
        admission.end();
        if (finishing) {
          await close();
          return;
        }
        // The v2 interrupt response follows execution settlement. Do not hide its
        // refusal; server and connection retirement must still run on failure.
        control ??= runtime.client.session.interrupt({ id });
        try {
          await control;
        } finally {
          await finish({ kind: "failed", diagnostic: "OpenCode session interrupted" });
        }
      },
      forceDispose: async () => {
        admission.end();
        await finish({ kind: "failed", diagnostic: "OpenCode session force-disposed" });
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
export function createOpencodeProvider(
  input: ProviderExecution | OpencodeProviderTestOptions = { name: OPENCODE_SDK_PROVIDER, kind: "opencode-sdk" },
): ProviderAdapter {
  const execution: ProviderExecution = "kind" in input ? input : { name: OPENCODE_SDK_PROVIDER, kind: "opencode-sdk" };
  const loader = "loader" in input ? input.loader : undefined;
  return {
    admitOptions(options) {
      try {
        admit(options);
        return { kind: "admitted", options: Object.freeze({ ...options }) };
      } catch (error) {
        return { kind: "refused", diagnostic: diagnostic(error) };
      }
    },
    ...providerLifecycle((input, custody) => drive(execution, input, loader, custody)),
    fork: (input) =>
      createProviderAttempt(new AbortController().signal, async (custody) => {
        const id = sessionId(input.session);
        let close!: () => Promise<void>;
        const runtime = await loadOpencode({
          execution,
          cwd: input.cwd,
          signal: custody.signal,
          ...(loader === undefined ? {} : { loader }),
          onRuntime: (ready) => {
            close = ownRuntime(custody, ready);
          },
        });
        try {
          custody.signal.throwIfAborted();
          const point = object(object(await runtime.client.session.message({ id, messageID: input.at }))?.data);
          if (point?.id !== input.at || point.type !== "idle" || point.outcome !== "succeeded") {
            throw new Error("OpenCode fork requires the retained successful native terminal boundary");
          }
          const response = object(object(await runtime.client.session.fork({ id, before: input.at }))?.data);
          const child = nonblank(response?.id);
          const fork = object(response?.fork);
          const boundary = object(fork?.boundary);
          if (
            child === undefined ||
            child === id ||
            fork?.sessionID !== id ||
            boundary?.type !== "before" ||
            boundary.messageID !== input.at
          ) {
            throw new Error("OpenCode fork did not preserve the exact native boundary");
          }
          return { session: coordinate(child) };
        } finally {
          await close();
        }
      }),
  };
}
