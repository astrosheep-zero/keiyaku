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
import { providerTurn } from "../turn.js";
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
function ownRuntime(
  custody: AttemptCustody,
  runtime: OpencodeRuntime,
): Readonly<{
  close(control?: Promise<unknown>): Promise<void>;
  setControls(controls: Readonly<{ abort(): Promise<void>; forceDispose(): Promise<void> }>): void;
}> {
  let closing: Promise<void> | undefined;
  let retainClosure!: (operation: Promise<void>) => void;
  const closed = new Promise<void>((resolve) => {
    retainClosure = resolve;
  });
  const close = (control?: Promise<unknown>) => {
    if (closing === undefined) {
      // A terminal broadcast may precede the explicit interrupt response.
      closing = Promise.resolve(control).then(runtime.close, async (error: unknown) => {
        try {
          await runtime.close();
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], "OpenCode interrupt and runtime retirement failed");
        }
        throw error;
      });
      retainClosure(closing);
    }
    return closing;
  };
  let abort: () => Promise<void> = close;
  let forceDispose: () => Promise<void> = close;
  custody.own({ closed, abort: () => abort(), forceDispose: () => forceDispose() });
  return {
    close,
    setControls(controls) {
      abort = controls.abort;
      forceDispose = controls.forceDispose;
    },
  };
}
function liveAdmission(initial: string) {
  let latest = initial;
  const submitted = new Set([initial]);
  const tells = tellRegistry<string>();
  const wait = (id: string) => {
    submitted.add(id);
    return tells.register(id, id);
  };
  return {
    initial: wait(initial),
    latest: () => latest,
    owns: (id: string) => submitted.has(id),
    wait,
    admit(id: string) {
      if (tells.accept(id)) latest = id;
    },
    fail: tells.fail,
    end: tells.end,
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
type ObservationInput = Readonly<{
  runtime: OpencodeRuntime;
  stream: OwnedEventStream;
  id: string;
  admission: ReturnType<typeof liveAdmission>;
  turn: ReturnType<typeof providerTurn>;
}>;
type ObservationState = {
  narration: ReturnType<typeof createEventState>;
  delivered: string | undefined;
  step: { id: string; input: string; ended: boolean } | undefined;
};
function executionResult(
  input: ObservationInput,
  state: ObservationState,
  event: Record<string, unknown> | undefined,
  data: Record<string, unknown>,
): TurnResult | Promise<TurnResult> | undefined {
  const type = event?.type;
  if (type === "session.step.failed" || type === "session.execution.failed") {
    return { kind: "failed", diagnostic: diagnostic(data.error) };
  }
  if (type === "session.execution.interrupted")
    return { kind: "failed", diagnostic: "OpenCode native execution interrupted" };
  if (type !== "session.execution.succeeded" || state.delivered === undefined) return;
  const step = state.step;
  if (step === undefined || !step.ended || step.input !== input.admission.latest()) {
    return { kind: "failed", diagnostic: "OpenCode completed without an assistant for the admitted input" };
  }
  const terminalID = nonblank(event?.id);
  if (terminalID === undefined || !terminalID.startsWith("evt_"))
    return { kind: "failed", diagnostic: "OpenCode terminal identity missing" };
  return answer(input.runtime, input.id, step.id, terminalID);
}
function observeEvent(
  input: ObservationInput,
  state: ObservationState,
  event: Record<string, unknown> | undefined,
  data: Record<string, unknown>,
): TurnResult | Promise<TurnResult> | undefined {
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
    state.delivered = data.inboxID;
  }
  if (type === "session.step.started" && state.delivered !== undefined && typeof data.assistantMessageID === "string") {
    state.step = { id: data.assistantMessageID, input: state.delivered, ended: false };
  }
  if (data.assistantMessageID !== undefined && data.assistantMessageID !== state.step?.id) return;
  if (state.delivered !== undefined) mapEvent(event, input.turn.events, state.narration);
  if (type === "session.step.ended" && state.step !== undefined) state.step.ended = true;
  return executionResult(input, state, event, data);
}
async function observe(input: ObservationInput): Promise<TurnResult | undefined> {
  const state: ObservationState = { narration: createEventState(input.id), delivered: undefined, step: undefined };
  while (!input.turn.terminal) {
    const next = await input.stream.next();
    if (input.turn.terminal) return;
    if (next.done) return { kind: "failed", diagnostic: "OpenCode event stream ended before Turn completion" };
    const event = object(next.value);
    const data = object(event?.data);
    if (data?.sessionID !== input.id) continue;
    const result = observeEvent(input, state, event, data);
    if (result !== undefined) return await result;
  }
  return undefined;
}
type NativeModel = ReturnType<typeof parseModel> & Readonly<{ variant?: string }>;
async function configureSession(
  runtime: OpencodeRuntime,
  input: Input,
  id: string,
  info: Record<string, unknown> | undefined,
  model: NativeModel | undefined,
): Promise<void> {
  const session = runtime.client.session;
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
  if (input.runtimeInstructions === undefined) {
    // Native forks copy current entries. Absence must remove the inherited
    // runtime entry, not leave the source identity active in a bare child.
    await session.removeInstruction({ id, key: "keiyaku.runtime" });
  } else {
    await session.instructions({ id, key: "keiyaku.runtime", text: input.runtimeInstructions });
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
  await configureSession(runtime, input, id, info, model);
  return id;
}
async function openResources(
  execution: ProviderExecution,
  input: Input,
  loader: OpencodeSdkLoader | undefined,
  custody: AttemptCustody,
) {
  let runtimeOwner!: ReturnType<typeof ownRuntime>;
  const runtime = await loadOpencode({
    execution,
    cwd: input.cwd,
    signal: custody.signal,
    ...(loader === undefined ? {} : { loader }),
    onRuntime: (ready) => {
      runtimeOwner = ownRuntime(custody, ready);
    },
    ...(input.execution === undefined ? {} : { executionCoordinate: input.execution }),
  });
  const stream = ownEventStream({
    directory: input.cwd,
    signal: custody.signal,
    custody,
    subscribe: runtime.client.event.subscribe,
  });
  const close = async (control?: Promise<unknown>) => {
    await Promise.all([stream.retire(), runtimeOwner.close(control)]);
  };
  return { runtime, stream, runtimeOwner, close };
}
async function submitPrompt(runtime: OpencodeRuntime, id: string, nativeID: string, text: string): Promise<void> {
  const response = object(object(await runtime.client.session.prompt({ id, body: { id: nativeID, text } }))?.data);
  if (response?.id !== nativeID || response.sessionID !== id || response.type !== "user") {
    throw new Error("OpenCode returned no exact native inbox admission");
  }
}
function liveTell(
  admission: ReturnType<typeof liveAdmission>,
  turn: ReturnType<typeof providerTurn>,
  signal: AbortSignal,
  prompt: (id: string, text: string) => Promise<void>,
): NonNullable<Session["tell"]> {
  let submissions: Promise<void> = admission.initial.then(() => undefined);
  return (tell) => {
    const next = submissions.then(async () => {
      if (turn.terminal || signal.aborted) return { kind: "turn-ended" } as const;
      const nativeID = messageId();
      const receipt = admission.wait(nativeID);
      void prompt(nativeID, tell.text).catch((error: unknown) => admission.fail(nativeID, error));
      return await receipt;
    });
    submissions = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
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
  const { signal } = custody;
  const initial = messageId();
  const admission = liveAdmission(initial);
  const turn = providerTurn(new AgentEventChannel(), admission.end);
  const { runtime, stream, runtimeOwner, close } = await openResources(execution, input, loader, custody).catch(
    (error: unknown) => {
      turn.fail(error);
      throw error;
    },
  );
  let control: Promise<unknown> | undefined;
  const retire = () => close(control);
  try {
    const id = await openSession(runtime, input);
    await stream.ready;
    signal.throwIfAborted();
    turn.events.emit({ type: "session", coordinate: coordinate(id) });
    const prompt = (nativeID: string, text: string) => submitPrompt(runtime, id, nativeID, text);
    // Observe before submission, but keep the connection until its HTTP admission response.
    let admitted = false;
    const retireAdmitted = () => {
      if (admitted) void retire().catch(() => undefined);
    };
    void observe({ runtime, stream, id, admission, turn }).then(
      (result) => {
        if (result !== undefined && turn.finish(result)) retireAdmitted();
      },
      (error: unknown) => {
        if (turn.fail(error)) retireAdmitted();
      },
    );
    await prompt(initial, launchPrompt(input.body, input.launchTells));
    signal.throwIfAborted();
    admitted = true;
    if (turn.terminal) retireAdmitted();
    runtimeOwner.setControls({
      async abort() {
        if (!turn.terminal) {
          admission.end();
          control ??= Promise.resolve().then(() => runtime.client.session.interrupt({ id }));
          try {
            await control;
          } finally {
            turn.finish({ kind: "failed", diagnostic: "OpenCode session interrupted" });
            await retire();
          }
        } else await retire();
      },
      forceDispose() {
        turn.finish({ kind: "failed", diagnostic: "OpenCode session force-disposed" });
        return retire();
      },
    });
    return {
      admission: { fence: initial },
      events: turn.events,
      completion: turn.completion,
      tell: liveTell(admission, turn, signal, prompt),
    };
  } catch (error) {
    turn.fail(error);
    void retire().catch(() => undefined);
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
        let runtimeOwner!: ReturnType<typeof ownRuntime>;
        const runtime = await loadOpencode({
          execution,
          cwd: input.cwd,
          signal: custody.signal,
          ...(loader === undefined ? {} : { loader }),
          onRuntime: (ready) => {
            runtimeOwner = ownRuntime(custody, ready);
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
          await runtimeOwner.close();
        }
      }),
  };
}
