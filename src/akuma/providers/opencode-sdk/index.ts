import type { ModelRef, V2Event } from "@opencode/client";
import { SessionMessage } from "@opencode/schema/session-message";
import {
  AgentEventChannel,
  createProviderAttempt,
  launchPrompt,
  tellRegistry,
  type ProviderAdapter,
  type Session,
  type TurnResult,
} from "../../provider.js";
import type { ResumeCoordinate } from "../../heart/index.js";
import type { ProviderExecution, ProviderOptions } from "../../provider-recipe.js";
import { nonblank, object } from "../decode.js";
import { providerLifecycle } from "../lifecycle.js";
import { providerTurn } from "../turn.js";
import { createEventState, diagnostic, mapEvent } from "./events.js";
import { NativeOpencodeRuntime, type RuntimeOpener } from "./session.js";

type Input = Parameters<ProviderAdapter["start"]>[0] | Parameters<NonNullable<ProviderAdapter["resume"]>>[0];

function sessionId(value: ResumeCoordinate): string {
  if (!("sessionId" in value) || value.sessionId === undefined) throw new Error("OpenCode resume requires sessionId");
  return value.sessionId;
}

function parseModel(model: string) {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) throw new Error("OpenCode model must be <provider>/<model>");
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
}

function admit(options: ProviderOptions): void {
  if (options.network !== undefined) throw new Error("OpenCode does not support explicit network");
  if (options.systemPromptMode === "replace")
    throw new Error("OpenCode v2 does not support replacing the native system prompt per Turn");
  if (options.model !== undefined) parseModel(options.model);
  if (options.effort !== undefined && options.model === undefined)
    throw new Error("OpenCode effort requires an explicit model");
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

async function successfulBoundary(
  runtime: NativeOpencodeRuntime,
  sessionID: string,
  messageID: string,
): Promise<boolean> {
  const point = await runtime.client.session.message.get({ sessionID, messageID }, runtime.options);
  return point?.id === messageID && point.type === "idle" && point.outcome === "succeeded";
}

async function answer(
  runtime: NativeOpencodeRuntime,
  sessionID: string,
  messageID: string,
  terminal: string,
): Promise<TurnResult> {
  const message = await runtime.client.session.message.get({ sessionID, messageID }, runtime.options);
  if (message?.id !== messageID || message.type !== "assistant" || message.time?.completed === undefined) {
    return { kind: "failed", diagnostic: "OpenCode completed without its exact completed assistant message" };
  }
  if (message.error !== undefined) return { kind: "failed", diagnostic: diagnostic(message.error) };
  if (!Array.isArray(message.content)) return { kind: "failed", diagnostic: "OpenCode assistant content missing" };
  const text = message.content
    .flatMap((part) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("\n\n");
  // Native fork excludes this projected idle message, preserving the answer but no later work.
  const boundary = terminal.replace(/^evt_/u, "msg_");
  return (await successfulBoundary(runtime, sessionID, boundary))
    ? { kind: "answered", answer: text, historyId: boundary }
    : { kind: "failed", diagnostic: "OpenCode terminal fork boundary was not projected" };
}

type ObservedStep = { id: string; input: string; ended: boolean };
type InboxDelivery = { id?: string };
type Admission = ReturnType<typeof liveAdmission>;

function observeInbox(event: V2Event, admission: Admission, delivery: InboxDelivery): boolean {
  if (
    event.type === "session.inbox.enqueued" &&
    typeof event.data.inboxID === "string" &&
    event.data.item?.type === "user"
  ) {
    admission.admit(event.data.inboxID);
  }
  if (event.type === "session.inbox.delivered" && typeof event.data.inboxID === "string") {
    if (!admission.owns(event.data.inboxID)) return false;
    admission.admit(event.data.inboxID);
    delivery.id = event.data.inboxID;
  }
  return true;
}

function observeStep(
  event: V2Event,
  step: ObservedStep | undefined,
  delivery: InboxDelivery,
): ObservedStep | undefined {
  if (
    event.type === "session.step.started" &&
    delivery.id !== undefined &&
    typeof event.data.assistantMessageID === "string"
  )
    return { id: event.data.assistantMessageID, input: delivery.id, ended: false };
  if (event.type === "session.step.ended" && step !== undefined && event.data.assistantMessageID === step.id)
    step.ended = true;
  return step;
}

function failureEvent(event: V2Event): TurnResult | undefined {
  if (event.type === "session.step.failed" || event.type === "session.execution.failed")
    return { kind: "failed", diagnostic: diagnostic(event.data.error) };
  if (event.type === "session.execution.interrupted")
    return { kind: "failed", diagnostic: "OpenCode native execution interrupted" };
  return undefined;
}

async function settledTurn(
  runtime: NativeOpencodeRuntime,
  sessionID: string,
  event: V2Event,
  step: ObservedStep | undefined,
  admission: Admission,
): Promise<TurnResult> {
  if (step === undefined || !step.ended || step.input !== admission.latest())
    return { kind: "failed", diagnostic: "OpenCode completed without an assistant for the admitted input" };
  if (typeof event.id !== "string" || !event.id.startsWith("evt_"))
    return { kind: "failed", diagnostic: "OpenCode terminal identity missing" };
  return await answer(runtime, sessionID, step.id, event.id);
}

async function observe(
  runtime: NativeOpencodeRuntime,
  sessionID: string,
  admission: Admission,
  turn: ReturnType<typeof providerTurn>,
): Promise<TurnResult | undefined> {
  const narration = createEventState(sessionID);
  const delivery: InboxDelivery = {};
  let step: ObservedStep | undefined;
  try {
    while (!turn.terminal) {
      const next = await runtime.next();
      if (turn.terminal) return undefined;
      if (next.done) return { kind: "failed", diagnostic: "OpenCode event stream ended before Turn completion" };
      const event = next.value;
      const data = event.data;
      if (!object(data) || !("sessionID" in data) || data.sessionID !== sessionID) continue;
      if (!observeInbox(event, admission, delivery)) {
        return {
          kind: "failed",
          diagnostic: "OpenCode consumed another writer's input; exact answer attribution unavailable",
        };
      }
      if (event.type === "session.step.ended" && typeof event.data.assistantMessageID !== "string")
        return { kind: "failed", diagnostic: "OpenCode step ended without assistantMessageID" };
      step = observeStep(event, step, delivery);
      if ("assistantMessageID" in data && data.assistantMessageID !== undefined && data.assistantMessageID !== step?.id)
        continue;
      if (delivery.id !== undefined) mapEvent(event, turn.events, narration);
      const failed = failureEvent(event);
      if (failed !== undefined) return failed;
      if (event.type !== "session.execution.succeeded" || delivery.id === undefined) continue;
      return await settledTurn(runtime, sessionID, event, step, admission);
    }
    return undefined;
  } catch (error) {
    throw new Error(`OpenCode observation failed: ${diagnostic(error)}`);
  }
}

async function acquireSession(
  runtime: NativeOpencodeRuntime,
  input: Input,
  resumeID: string | undefined,
  model: ModelRef | undefined,
): Promise<{ sessionID: string; info: Awaited<ReturnType<NativeOpencodeRuntime["client"]["session"]["get"]>> }> {
  const {
    options: request,
    client: { session },
  } = runtime;
  const info =
    resumeID === undefined
      ? await session.create({ location: { directory: input.cwd }, ...(model === undefined ? {} : { model }) }, request)
      : await session.get({ sessionID: resumeID }, request);
  const sessionID = nonblank(info?.id);
  if (sessionID === undefined) throw new Error("OpenCode did not return a session id");
  if (resumeID !== undefined && sessionID !== resumeID) throw new Error("OpenCode returned a different native session");
  const active = await session.active(request);
  if (!object(active)) throw new Error("OpenCode active execution response missing");
  if (active[sessionID] !== undefined) throw new Error("OpenCode native session is already busy");
  return { sessionID, info };
}

async function confirmModel(
  runtime: NativeOpencodeRuntime,
  sessionID: string,
  selected: ModelRef | undefined,
  resumeID: string | undefined,
  model: ModelRef,
): Promise<void> {
  const {
    options: request,
    client: { session },
  } = runtime;
  if (resumeID !== undefined) {
    await session.switchModel({ sessionID, model }, request);
    const updated = await session.get({ sessionID }, request);
    if (updated?.id !== sessionID) throw new Error("OpenCode returned a different native session");
    selected = updated.model;
  }
  if (
    selected?.providerID !== model.providerID ||
    selected.id !== model.id ||
    (selected.variant ?? "default") !== (model.variant ?? "default")
  )
    throw new Error("OpenCode did not select the requested model");
}

async function writeInstructions(
  runtime: NativeOpencodeRuntime,
  sessionID: string,
  systemPrompt: string | undefined,
  runtimeInstructions: string | undefined,
): Promise<void> {
  const { options: request } = runtime;
  const { entry } = runtime.client.session.instructions;
  if (systemPrompt !== undefined) await entry.put({ sessionID, key: "keiyaku.system", value: systemPrompt }, request);
  if (runtimeInstructions === undefined) {
    // A bare fork must not keep the inherited active runtime identity.
    await entry.remove({ sessionID, key: "keiyaku.runtime" }, request);
  } else {
    await entry.put({ sessionID, key: "keiyaku.runtime", value: runtimeInstructions }, request);
  }
}

async function openSession(
  runtime: NativeOpencodeRuntime,
  input: Input,
  resumeID: string | undefined,
): Promise<string> {
  const { model: requested, effort } = input.options;
  const model =
    requested === undefined
      ? undefined
      : { ...parseModel(requested), ...(effort === undefined ? {} : { variant: effort }) };
  const { sessionID, info } = await acquireSession(runtime, input, resumeID, model);
  if (model !== undefined) await confirmModel(runtime, sessionID, info.model, resumeID, model);
  await writeInstructions(runtime, sessionID, input.options.systemPrompt, input.runtimeInstructions);
  return sessionID;
}

async function openTurn(input: Input, runtime: NativeOpencodeRuntime, sessionID: string): Promise<Session> {
  const initial = SessionMessage.ID.create();
  const admission = liveAdmission(initial);
  const turn = providerTurn(new AgentEventChannel(), admission.end);
  runtime.onControl((kind) => {
    turn.finish({
      kind: "failed",
      diagnostic: kind === "abort" ? "OpenCode session interrupted" : "OpenCode session force-disposed",
    });
  });
  turn.events.emit({ type: "session", coordinate: { sessionId: sessionID } });
  const { signal } = input;
  const prompt = async (id: string, text: string): Promise<void> => {
    const reply = await runtime.client.session.prompt({ sessionID, id, text }, runtime.options);
    if (reply?.id !== id || reply.sessionID !== sessionID || reply.type !== "user")
      throw new Error("OpenCode returned no exact native inbox admission");
  };
  // Broadcasts may precede HTTP admission. Observe now, but don't retire the
  // connection to a fast terminal until that exact admission is confirmed.
  let admitted = false;
  let retirement: Promise<void> | undefined;
  const retire = (): Promise<void> => (retirement ??= runtime.finish().then(() => undefined));
  const retireAdmitted = (): void => {
    if (admitted) void retire().catch(() => undefined);
  };
  try {
    signal.throwIfAborted();
    signal.addEventListener("abort", admission.end, { once: true });
    const observed = observe(runtime, sessionID, admission, turn).finally(() =>
      signal.removeEventListener("abort", admission.end),
    );
    void observed.then(
      (result) => {
        if (result !== undefined && turn.finish(result)) retireAdmitted();
      },
      (error: unknown) => {
        if (turn.fail(error)) retireAdmitted();
      },
    );
    await prompt(initial, launchPrompt(input.launchTells));
    signal.throwIfAborted();
    runtime.sessionID = sessionID;
    admitted = true;
    if (turn.terminal) retireAdmitted();
  } catch (error) {
    turn.fail(error);
    void retire().catch(() => undefined);
    throw error;
  }
  let submissions: Promise<unknown> = admission.initial;
  return {
    admission: { fence: initial },
    events: turn.events,
    completion: turn.completion,
    tell(tell) {
      const next = submissions.then(async () => {
        if (turn.terminal || signal.aborted) return { kind: "turn-ended" } as const;
        const id = SessionMessage.ID.create();
        const receipt = admission.wait(id);
        void prompt(id, tell.text).catch((error: unknown) => admission.fail(id, error));
        return await receipt;
      });
      submissions = next.catch(() => undefined);
      return next;
    },
  };
}

export function createOpencodeProvider(
  execution: ProviderExecution = { name: "opencode-sdk", kind: "opencode-sdk" },
  openRuntime: RuntimeOpener = NativeOpencodeRuntime.open,
): ProviderAdapter {
  return {
    admitOptions(options) {
      try {
        admit(options);
        return { kind: "admitted", options: Object.freeze({ ...options }) };
      } catch (error) {
        return { kind: "refused", diagnostic: diagnostic(error) };
      }
    },
    ...providerLifecycle(async (input, custody) => {
      admit(input.options);
      if (input.schemaJson !== undefined)
        throw new Error("OpenCode v2 does not expose native structured answer schemas");
      const resumeID = input.session.kind === "resume" ? sessionId(input.session.coordinate) : undefined;
      const runtime = await openRuntime({
        execution,
        cwd: input.cwd,
        signal: custody.signal,
        custody,
        ...(input.execution === undefined ? {} : { executionCoordinate: input.execution }),
      });
      try {
        return await openTurn(input, runtime, await openSession(runtime, input, resumeID));
      } catch (error) {
        void runtime.finish().catch(() => undefined);
        throw error;
      }
    }),
    fork: (input) =>
      createProviderAttempt(undefined, async (custody) => {
        const sessionID = sessionId(input.session);
        const runtime = await openRuntime({ execution, cwd: input.cwd, signal: custody.signal, custody });
        let id: string | undefined;
        try {
          if (!(await successfulBoundary(runtime, sessionID, input.at)))
            throw new Error("OpenCode fork requires the retained successful native terminal boundary");
          const child = await runtime.client.session.fork({ sessionID, before: input.at }, runtime.options);
          id = nonblank(child?.id);
          const boundary = child?.fork?.boundary;
          if (
            id === undefined ||
            id === sessionID ||
            child.fork?.sessionID !== sessionID ||
            boundary?.type !== "before" ||
            boundary.messageID !== input.at
          )
            throw new Error("OpenCode fork did not preserve the exact native boundary");
        } finally {
          await runtime.retire();
        }
        custody.signal.throwIfAborted();
        return { session: { sessionId: id } };
      }),
  };
}
