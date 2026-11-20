import { abortableDelay } from "./abort.js";
import {
  appendActivity,
  beginTurn,
  bindTellsToTurn,
  BodyControlledError,
  breakBody,
  drainPendingTells,
  endTurn,
  heartExists,
  readHeart,
  recordCurrentModel,
  recordSession,
  recordTellDeliveries,
  recordTellReceipt,
  type BodyControlSnapshot,
  type ResumeCoordinate,
  type Soul,
  type TellFact,
  type TurnOutcome,
} from "./heart/index.js";
import type { AkumaPaths } from "./identity.js";
import { keiyakuExecutionInstructions, type ExecutionAssociationReader } from "./execution-instructions.js";
import { withoutModel } from "./provider-recipe.js";
import {
  encodeAgentEvent,
  type AgentEvent,
  type ProviderAdapter,
  type ProviderAttempt,
  type Session,
  type TurnResult,
} from "./provider.js";
import { BodySupervisor, CONTROL_RESPONSE_MS } from "./body-supervisor.js";

type EffectSerializer = {
  <T>(effect: () => Promise<T> | T): Promise<T>;
  drain(seal: () => void): Promise<void>;
};

function serializeEffects(): EffectSerializer {
  let tail = Promise.resolve();
  let failed = false;
  let failure: unknown;
  const serialize = async <T>(effect: () => Promise<T> | T): Promise<T> => {
    const result = tail.then(effect);
    tail = result.then(
      () => undefined,
      (error: unknown) => {
        if (!failed) failure = error;
        failed = true;
      },
    );
    return await result;
  };
  serialize.drain = async (seal: () => void) => {
    // A receipt can enter the serializer while an earlier effect is still draining.
    for (;;) {
      const admitted = tail;
      await admitted;
      if (admitted !== tail) continue;
      seal();
      if (failed) throw failure;
      return;
    }
  };
  return serialize;
}

export async function turnRecipe(
  paths: AkumaPaths,
  soul: Soul,
): Promise<Readonly<{ cwd: string; options: Soul["options"]; session?: ResumeCoordinate }>> {
  const heart = await readHeart(paths);
  const latest = heart.latestSession;
  const admitted = latest?.provider === soul.provider.name ? latest : undefined;
  const session = admitted?.coordinate;
  // The current model is the one mutable member of the recipe and lives only
  // in the Soul, so every Turn reads it freshly and no session copy, cached
  // birth Soul, or stale option can re-admit a model that already moved.
  const current = heart.soul?.options.model;
  return {
    cwd: soul.cwd,
    options: {
      ...withoutModel(admitted?.options ?? soul.options),
      ...(current === undefined ? {} : { model: current }),
    },
    ...(session === undefined ? {} : { session }),
  };
}

export type DriveTurnInput = Readonly<{
  paths: AkumaPaths;
  soul: Soul;
  adapter: ProviderAdapter;
  bodySequence: number;
  launchTells: readonly TellFact[];
  supervisor: BodySupervisor;
  world: import("../world.js").WorldRoot;
  executionAssociation?: ExecutionAssociationReader;
  turnStarted: Readonly<{ emit(turnSequence: number): Promise<void> }>;
  turnOutcome: Readonly<{ emit(turnSequence: number, caller: AbortSignal): Promise<void> }>;
  now(): string;
}>;

type TurnWriters = Readonly<{
  input: DriveTurnInput;
  turnSequence: number;
  drive: Session;
  writeWitness: EffectSerializer;
  mayWrite(): boolean;
}>;

type TurnDriveResult =
  | Extract<TurnResult, { kind: "failed" }>
  | Readonly<{ kind: "continue" | "stopped" | "hung" | "resume-unsupported" }>;
type TerminalOutcome = Exclude<TurnOutcome, { kind: "canceled" }>;

function outcomeForTell(
  result: TurnResult,
  session: ResumeCoordinate | undefined,
  schemaJson?: string,
): TerminalOutcome {
  if (result.kind === "failed") return result;
  if (session === undefined) return { kind: "failed", diagnostic: "Provider answered without a resumable session" };
  const evidence = { ...result, session };
  if (schemaJson === undefined) return evidence;
  try {
    JSON.parse(result.answer);
  } catch (error) {
    return { ...evidence, kind: "invalid-output", diagnostic: diagnostic(error) };
  }
  return { ...evidence, answerJson: result.answer };
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The runtime model one attempt has already observed. Equal observations
 * coalesce inside the attempt; a successor attempt starts empty, so its own
 * first observation always reaches the Soul.
 */
type ModelWitness = { written: boolean; model: string | undefined };

async function writeProviderEvent(
  input: DriveTurnInput,
  turnSequence: number,
  recipe: Pick<Soul, "cwd" | "options">,
  event: AgentEvent,
  witness: ModelWitness,
): Promise<ResumeCoordinate | undefined> {
  const at = input.now();
  if (event.type === "session") {
    await recordSession(input.paths, {
      provider: input.soul.provider.name,
      coordinate: event.coordinate,
      cwd: recipe.cwd,
      options: recipe.options,
      admittedAt: at,
    });
  }
  if (event.type === "model") {
    // Native model evidence is authoritative current state, not narration: it
    // moves the Soul's one model and is never appended to activity.
    if (witness.written && witness.model === event.model) return;
    witness.written = true;
    witness.model = event.model;
    await recordCurrentModel(input.paths, { bodySequence: input.bodySequence, model: event.model });
    return;
  }
  if (!input.supervisor.signal.aborted)
    await appendActivity(input.paths, { turnSequence, event: encodeAgentEvent(event), at });
  return event.type === "session" ? event.coordinate : undefined;
}

async function retireProviderCustody(
  input: DriveTurnInput,
  turnSequence: number,
  attempt: ProviderAttempt<Session>,
): Promise<boolean> {
  const dispose = async (operation: () => Promise<void>): Promise<void> => {
    const deadline = new AbortController();
    try {
      await Promise.race([
        operation().then(() => attempt.closed),
        abortableDelay(CONTROL_RESPONSE_MS, deadline.signal).then(() => {
          throw new Error(`provider custody remained live after ${CONTROL_RESPONSE_MS}ms`);
        }),
      ]);
    } finally {
      deadline.abort();
    }
  };
  try {
    await dispose(input.supervisor.forceSignal?.aborted ? attempt.forceDispose : attempt.abort).catch(() =>
      dispose(attempt.forceDispose),
    );
    return true;
  } catch (error) {
    if (await heartExists(input.paths)) {
      const cause = diagnostic(error);
      const at = input.now();
      try {
        await input.supervisor.recordHung(cause, at);
        await appendActivity(input.paths, {
          turnSequence,
          event: encodeAgentEvent({ type: "note", text: `Provider custody was not retired: ${cause}` }),
          at,
        });
      } catch {
        /* Undisposed provider custody still owns the leash. */
      }
      await breakBody(input.paths, { sequence: input.bodySequence, end: "broke-off", at: input.now() });
    }
    return false;
  }
}

async function pumpReceipts(writers: TurnWriters): Promise<void> {
  const { input, turnSequence, drive, writeWitness, mayWrite } = writers;
  if (drive.receipts === undefined) return;
  for await (const receipt of drive.receipts) {
    if (!mayWrite()) return;
    await writeWitness(async () => {
      if (!mayWrite()) return;
      const witness = { ...receipt, turnSequence, receivedAt: input.now() };
      await recordTellReceipt(input.paths, witness);
    });
  }
}

async function submitPendingLiveTells(
  writers: TurnWriters,
  pending: readonly TellFact[],
  attempted: Set<string>,
  tellLive: NonNullable<Session["tell"]>,
): Promise<"live" | "turn-ended"> {
  const { input, turnSequence, drive, writeWitness, mayWrite } = writers;
  for (const tell of pending) {
    if (attempted.has(tell.id) || tell.schemaJson !== undefined) continue;
    if (!mayWrite()) return "turn-ended";
    attempted.add(tell.id);
    const outcome = await writeWitness(async () => {
      if (!mayWrite()) return "turn-ended" as const;
      await bindTellsToTurn(input.paths, { turnSequence, tellIds: [tell.id], boundAt: input.now() });
      if (!mayWrite()) return "turn-ended" as const;
      const submission = await tellLive({ id: tell.id, text: tell.body });
      if (!mayWrite() || submission.kind === "turn-ended") return "turn-ended" as const;
      await recordTellDeliveries(input.paths, [
        {
          tellId: tell.id,
          route: "live",
          turnSequence,
          fence: submission.fence,
          receipt: drive.receipts === undefined ? "unavailable" : "required",
          deliveredAt: input.now(),
        },
      ]);
      return "accepted" as const;
    });
    if (outcome === "turn-ended") return outcome;
  }
  return "live";
}

type TurnSources = {
  admission: Session;
  event: IteratorResult<AgentEvent>;
  heart: BodyControlSnapshot;
  tell: "live" | "turn-ended";
  completion: TurnResult;
  closed: boolean;
  drained: void;
  "receipt-failure": void;
};
type TurnSource = keyof TurnSources;
type TurnWake = { [S in TurnSource]: { kind: S; value: TurnSources[S] } }[TurnSource];
type TurnWakeup = TurnWake | { kind: "failed"; source: TurnSource; error: unknown };
type TurnArm = { [S in TurnSource]: [kind: S, source: Promise<TurnSources[S]>] }[TurnSource];

/** Keep a stalled pull's original reaction, not one reaction per intervening Heart observation. */
function createTurnWakeups(signal: AbortSignal) {
  const queue: TurnWakeup[] = [];
  const armed = new Set<TurnSource>();
  let waiter: (() => void) | undefined;
  let failedSource: TurnSource | undefined;
  let stopped = false;
  let writesOpen = true;
  const publish = (wake: TurnWakeup): void => {
    if (stopped) return;
    queue.push(wake);
    waiter?.();
    waiter = undefined;
  };
  return {
    arm(...[kind, source]: TurnArm): void {
      if (armed.has(kind)) throw new Error(`Turn source already armed: ${kind}`);
      armed.add(kind);
      void source.then(
        (value) => {
          // The tuple checks the source/value pairing before this callback.
          if (kind !== "receipt-failure") publish({ kind, value } as TurnWake);
        },
        (error: unknown) => publish({ kind: "failed", source: kind, error }),
      );
    },
    async next(): Promise<TurnWake> {
      if (queue.length === 0)
        await new Promise<void>((resolve) => {
          waiter = resolve;
        });
      const first = queue[0]!;
      // Retirement rejection cannot preempt admission or completion already ready to consume.
      const native =
        first.kind === "failed" && first.source === "closed"
          ? queue.findIndex(({ kind }) => kind === "admission" || kind === "completion")
          : -1;
      const wake = native > 0 ? queue.splice(native, 1)[0]! : queue.shift()!;
      if (wake.kind === "failed") {
        if (wake.source === "closed") return { kind: "closed", value: false };
        failedSource = wake.source;
        throw wake.error;
      }
      armed.delete(wake.kind);
      return wake;
    },
    get failedSource() {
      return failedSource;
    },
    mayWrite: (): boolean => writesOpen && !signal.aborted,
    closeWrites(): void {
      writesOpen = false;
    },
    stop(): void {
      writesOpen = false;
      stopped = true;
      waiter = undefined;
      queue.length = 0;
    },
  };
}

async function prepareTurn(input: DriveTurnInput, recipe: Awaited<ReturnType<typeof turnRecipe>>) {
  const [opening] = input.launchTells;
  if (opening === undefined) throw new Error("Cannot start a Turn without an admitted Tell");
  const { initiator, schemaJson } = opening;
  const schema = schemaJson === undefined ? {} : { schemaJson };
  const runtimeInstructions = keiyakuExecutionInstructions(
    input.soul,
    input.soul.bare !== false ? undefined : await input.executionAssociation?.(),
  );
  const { sequence: turnSequence } = await beginTurn(input.paths, {
    ...(initiator === undefined ? {} : { initiator }),
    bodySequence: input.bodySequence,
    startedAt: input.now(),
    ...schema,
  });
  const launchTells = input.launchTells.map((tell) => ({ id: tell.id, text: tell.body }));
  const tellIds = launchTells.map((tell) => tell.id);
  await bindTellsToTurn(input.paths, { turnSequence, tellIds, boundAt: input.now() });
  await input.turnStarted.emit(turnSequence);
  const providerInput = {
    launchTells,
    cwd: recipe.cwd,
    options: recipe.options,
    signal: input.supervisor.signal,
    execution: {
      akumaId: input.soul.id,
      world: input.world,
    },
    ...(runtimeInstructions === undefined ? {} : { runtimeInstructions }),
    ...schema,
  };
  return { turnSequence, tellIds, providerInput, recipe };
}

async function openAdmittedSession(
  writers: TurnWriters,
  tellIds: readonly string[],
  wakeups: ReturnType<typeof createTurnWakeups>,
): Promise<AsyncIterator<AgentEvent> | undefined> {
  const { input, turnSequence, drive, mayWrite } = writers;
  wakeups.arm("completion", drive.completion);
  await recordTellDeliveries(
    input.paths,
    tellIds.map((tellId) => ({
      tellId,
      route: "launch",
      turnSequence,
      fence: drive.admission.fence,
      deliveredAt: input.now(),
    })),
  );
  if (!mayWrite()) return undefined;
  wakeups.arm("receipt-failure", pumpReceipts(writers));
  const iterator = drive.events[Symbol.asyncIterator]();
  wakeups.arm("event", iterator.next());
  return iterator;
}

async function consumeTurn(
  input: DriveTurnInput,
  { turnSequence, tellIds, providerInput, recipe }: Awaited<ReturnType<typeof prepareTurn>>,
  heart: BodyControlSnapshot,
  wakeups: ReturnType<typeof createTurnWakeups>,
  sealOutcome: (outcome: TerminalOutcome) => Promise<void>,
): Promise<boolean> {
  const { supervisor } = input;
  const { mayWrite, closeWrites } = wakeups;
  let turnSession = recipe.session;
  let writers: TurnWriters | undefined;
  let iterator: AsyncIterator<AgentEvent> | undefined;
  const attempted = new Set(tellIds);
  const writeWitness = serializeEffects();
  const witness: ModelWitness = { written: false, model: undefined };
  let tellLive: Session["tell"];
  let submitting = false;
  let eventsEnded = false;
  let result: TurnResult | undefined;
  let closed: boolean | undefined;
  let draining = false;
  let committed = false;
  const submitIfReady = (): void => {
    if (writers === undefined || tellLive === undefined || submitting) return;
    const pending = drainPendingTells(heart.pending);
    if (!pending.some((tell) => !attempted.has(tell.id) && tell.schemaJson === undefined)) return;
    submitting = true;
    wakeups.arm("tell", submitPendingLiveTells(writers, pending, attempted, tellLive));
  };
  const drainIfReady = (): void => {
    if (draining || !eventsEnded || result === undefined || submitting || !mayWrite()) return;
    draining = true;
    wakeups.arm("drained", writeWitness.drain(closeWrites));
  };

  while (!supervisor.signal.aborted) {
    submitIfReady();
    const wake = await wakeups.next();
    if (supervisor.signal.aborted) break;
    switch (wake.kind) {
      case "admission":
        writers = { input, turnSequence, drive: wake.value, writeWitness, mayWrite };
        iterator = await openAdmittedSession(writers, tellIds, wakeups);
        if (iterator !== undefined && providerInput.schemaJson === undefined) tellLive = wake.value.tell;
        break;
      case "event":
        if (wake.value.done) {
          eventsEnded = true;
          break;
        }
        turnSession = (await writeProviderEvent(input, turnSequence, recipe, wake.value.value, witness)) ?? turnSession;
        if (mayWrite()) wakeups.arm("event", iterator!.next());
        break;
      case "heart":
        heart = wake.value;
        wakeups.arm("heart", supervisor.next(heart));
        break;
      case "tell":
        submitting = false;
        if (wake.value === "turn-ended") tellLive = undefined;
        break;
      case "completion":
        result = wake.value;
        tellLive = undefined;
        break;
      case "closed":
        closed = wake.value;
        if (committed || (!closed && result === undefined)) return closed;
        // A rejected closure cannot fence ordered writes for a witnessed terminal.
        break;
      case "drained":
        await sealOutcome(outcomeForTell(result!, turnSession, providerInput.schemaJson));
        committed = true;
        if (closed !== undefined) return closed;
        break;
    }
    drainIfReady();
  }
  return false;
}

export async function driveTurn(input: DriveTurnInput): Promise<TurnDriveResult> {
  const { supervisor } = input;
  if (supervisor.signal.aborted) return { kind: "stopped" };
  const wakeups = createTurnWakeups(supervisor.signal);
  let startingTurn: number | undefined;
  let attempt: ProviderAttempt<Session> | undefined;
  let retired = false;
  let admissionAttempted = false;
  let ending: TurnDriveResult = { kind: "stopped" };
  const commit = async (outcome: TerminalOutcome): Promise<void> => {
    admissionAttempted = true;
    await endTurn(input.paths, { turnSequence: startingTurn!, outcome, completedAt: input.now() });
    await input.turnOutcome.emit(startingTurn!, supervisor.signal);
    ending = outcome.kind === "answered" ? { kind: "continue" } : { kind: "failed", diagnostic: outcome.diagnostic };
  };
  try {
    const recipe = await turnRecipe(input.paths, input.soul);
    const { session } = recipe;
    if (session !== undefined && input.adapter.resume === undefined) return { kind: "resume-unsupported" };
    const prepared = await prepareTurn(input, recipe);
    if (supervisor.signal.aborted) return ending;
    const heart = supervisor.current();
    startingTurn = prepared.turnSequence;
    const { providerInput } = prepared;
    attempt =
      session === undefined
        ? input.adapter.start({ ...providerInput, session: { kind: "fresh" } })
        : input.adapter.resume!({ ...providerInput, session: { kind: "resume", coordinate: session } });
    wakeups.arm("admission", attempt.result);
    wakeups.arm(
      "closed",
      attempt.closed.then<boolean>(() => true),
    );
    wakeups.arm("heart", supervisor.next(heart));
    retired = await consumeTurn(input, prepared, heart, wakeups, commit);
  } catch (error) {
    wakeups.closeWrites();
    if (admissionAttempted && ending.kind === "stopped") throw error;
    if (startingTurn === undefined) {
      if (supervisor.reason === "heart-gone") return ending;
      throw error;
    }
    if (error instanceof BodyControlledError) supervisor.cancel("control");
    if (!supervisor.signal.aborted) {
      if (wakeups.failedSource !== "heart" && !(await heartExists(input.paths).catch(() => true)))
        supervisor.cancel("heart-gone");
      else ending = { kind: "failed", diagnostic: diagnostic(error) };
    }
  } finally {
    wakeups.stop();
    if (attempt !== undefined && !retired && !(await retireProviderCustody(input, startingTurn!, attempt)))
      ending = { kind: "hung" };
  }
  if (!admissionAttempted && ending.kind === "failed") await commit(ending);
  return ending;
}
