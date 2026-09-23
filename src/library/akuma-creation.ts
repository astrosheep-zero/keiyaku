/** @architectureCompositionRoot */
import { appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { moveAlias, type AliasBinding } from "../alias/index.js";
import { type AkumaStatus, type ForkReceipt, type ReadonlyRestraint } from "../akuma/akuma.js";
import { createAkumaProduct, type AkumaBornCall, type InitialCallTell } from "../akuma/akuma-product.js";
import { pathsForAkuId, type AkumaPaths, type AkuId } from "../akuma/identity.js";
import { readSoul } from "../akuma/heart/index.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import type { ContractId } from "../core/facts/types.js";
import { publishDispatch, readDispatch, type Dispatch, type DispatchFailure } from "../dispatch/index.js";
import type { PrivateStateSeatCloseLag } from "../git/private-state-seat.js";
import { parseAkumaAlias, type AkumaAlias } from "../identity/selector.js";
import { emitCalledPluginSignal } from "../plugin/akuma-signals.js";
import type { Settings } from "../settings.js";
import { World, type WorldRoot } from "../world.js";
import type { AllowedAction } from "../akuma/allowed.js";
import { schemaJsonText, type Schema } from "../akuma/schema.js";
import {
  decodeTellWaitObservation,
  observeAdmittedTellWaitAkuma,
  type TellWaitObserver,
} from "../akuma/fleet-execution.js";
import type { AkumaTellWaitResult } from "../akuma/fleet-observation.js";
import type { TellResult } from "../akuma/body.js";
import { localExecutionContext, type ExecutionContext } from "../akuma/requests.js";
import { callReadonly, canonicalBirthCwd } from "../akuma/call-input.js";
import { requireInput } from "./input.js";
import { addressAkuma } from "./address.js";
import { type Keiyaku } from "./contract.js";
import { seatForKeiyaku } from "./contract-handle.js";
import { scopeForRepo, type Repo } from "./repo.js";

export type { AkumaStatus } from "../akuma/akuma.js";

export type IntegrationFailure = Readonly<{
  kind: "authority-corruption" | "infrastructure";
  diagnostic: string;
}>;

export type DispatchStage =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "dispatched"; dispatch: Dispatch; seatClose?: readonly PrivateStateSeatCloseLag[] }>
  | Readonly<{ kind: "failed"; failure: DispatchFailure | IntegrationFailure }>;

export type AliasStage =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "aliased"; alias: AliasBinding; previous: AkuId | null }>
  | Readonly<{ kind: "skipped"; reason: "dispatch-failed" }>
  | Readonly<{ kind: "failed"; failure: IntegrationFailure }>;

export type CallWaitHead = Readonly<{
  dispatch: DispatchStage;
  alias: AliasStage;
  readonly?: ReadonlyRestraint;
}>;

export type CallWaitObserver = Readonly<{
  admitted?: (tell: TellResult, id: AkumaStatus["id"], head: CallWaitHead) => void | Promise<void>;
  observe?: TellWaitObserver["observe"];
}>;

export type CallInput = Readonly<{
  path: WorldRoot;
  archetype: string;
  body: string;
  cwd?: string;
  readonly?: true;
  mode?: "wait" | "detach";
  timeoutMs?: number;
  home?: string;
  settings?: Settings;
  contract?: Keiyaku;
  alias?: AkumaAlias;
  allowed?: readonly AllowedAction[];
  schema?: Schema<unknown>;
  initiator?: string;
  signal?: AbortSignal;
  observe?: CallWaitObserver;
}>;

export type CallObservation =
  | Readonly<{ kind: "detached"; tell: TellResult }>
  | Readonly<{
      kind: "observed";
      tell: TellResult;
      observation: AkumaTellWaitResult["observation"];
      completedAt?: string | null;
    }>
  | Readonly<{ kind: "failed"; tellId: string; tell?: TellResult; failure: IntegrationFailure }>;

export type CallResult = Readonly<{
  kind: "called";
  akuma: AkuId;
  readonly?: ReadonlyRestraint;
  execution: Readonly<{
    cwd: string;
    source: "input" | "caller" | "process" | "world";
  }>;
  dispatch: DispatchStage;
  alias: AliasStage;
  structured?: true;
  observation: CallObservation;
}>;

type CallExecution = CallResult["execution"];

export type BornCall = Readonly<{
  path: WorldRoot;
  born: AkumaBornCall;
  execution: CallExecution;
  mode: "wait" | "detach";
  timeoutMs: number;
  signal?: AbortSignal;
  dispatch: DispatchStage;
  alias: AliasStage;
  initialTell: InitialCallTell & Readonly<{ schema?: Schema<unknown> }>;
  observe?: CallWaitObserver;
}>;

export type ForkInput = Readonly<{
  path: WorldRoot;
  akuma: string;
  at: string;
  repo?: Repo;
}>;

export type ForkResult =
  | Readonly<{ kind: "forked"; parent: AkuId; child: AkuId; dispatch: DispatchStage }>
  | (Exclude<ForkReceipt, Readonly<{ kind: "forked"; child: AkuId }>> & Readonly<{ parent: AkuId }>);

function nonblank(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a nonblank string`);
  }
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

function settingsOption(value: unknown): Settings | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { namespace?: unknown }).namespace !== "function"
  ) {
    throw new TypeError("settings must be a Settings");
  }
  return value as Settings;
}

function homeOption(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return nonblank(value, "home");
}

function akumaWorld(path: WorldRoot, home?: string, settings?: Settings, execution?: ExecutionContext) {
  return createAkumaProduct(path, {
    ...(home === undefined ? {} : { home }),
    ...(settings === undefined ? {} : { settings }),
    ...(execution === undefined ? {} : { execution }),
  });
}

function onlyKeys(values: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(values)) {
    if (!accepted.has(key)) throw new TypeError(`${label} has unknown field: ${key}`);
  }
}

function integrationFailure(error: unknown): IntegrationFailure {
  return {
    kind: error instanceof AuthorityCorruptionError ? "authority-corruption" : "infrastructure",
    diagnostic: error instanceof Error ? error.message : String(error),
  };
}

function callMode(value: unknown): "wait" | "detach" {
  if (value === undefined || value === "detach") return "detach";
  if (value === "wait") return "wait";
  throw new TypeError("mode must be wait or detach");
}

function callTimeout(value: unknown, mode: "wait" | "detach"): number {
  if (mode === "detach" && value !== undefined) {
    throw new TypeError("timeoutMs is not valid in detach mode");
  }
  if (value === undefined) return 300_000;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError("timeoutMs must be a nonnegative finite number");
  }
  return value;
}

function callSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal");
  return value;
}

function callSeat(contract: unknown) {
  if (contract === undefined) return undefined;
  const seat = seatForKeiyaku(contract);
  if (seat === null) throw new TypeError("contract must be a Keiyaku");
  return seat;
}

async function callerAkuId(path: WorldRoot, born: AkumaBornCall): Promise<AkuId | undefined> {
  if (born.kind !== "requested") return undefined;
  const soul = await readSoul(pathsForAkuId(path, born.id));
  return soul?.origin.kind === "request" ? soul.origin.parent : undefined;
}

function pluginDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 500 ? message : `${message.slice(0, 500)}...`;
}

async function recordPluginDiagnostic(paths: AkumaPaths, error: unknown): Promise<void> {
  try {
    await appendFile(paths.log, `plugin call admission failed: ${pluginDiagnostic(error)}\n`);
  } catch {
    // Plugin diagnostic loss must not change an already admitted call.
  }
}

async function emitCalledSignal(
  input: Readonly<{
    path: WorldRoot;
    settings?: Settings;
    born: AkumaBornCall;
    akumaId: AkuId;
    contractId?: ContractId;
  }>,
): Promise<void> {
  try {
    const callerAkumaId = await callerAkuId(input.path, input.born);
    const paths =
      input.born.kind === "requested" ? pathsForAkuId(input.path, input.akumaId) : input.born.allocated.paths;
    const reportDiagnostic = (message: string): void => {
      void recordPluginDiagnostic(paths, message);
    };
    try {
      await emitCalledPluginSignal({
        world: input.path,
        ...(input.settings === undefined ? {} : { settings: input.settings }),
        reportDiagnostic,
        akumaId: input.akumaId,
        ...(callerAkumaId === undefined ? {} : { callerAkumaId }),
        ...(input.contractId === undefined ? {} : { contractId: input.contractId }),
      });
    } catch (error) {
      await recordPluginDiagnostic(paths, error);
    }
  } catch {
    // Plugin delivery must not change an already admitted call.
  }
}

async function admitCall(
  input: Readonly<{
    path: WorldRoot;
    world: ReturnType<typeof createAkumaProduct>;
    call: Parameters<ReturnType<typeof createAkumaProduct>["admit"]>[0];
    context: Readonly<{ cwdCanonical?: true }>;
    settings?: Settings;
    contractId?: ContractId;
  }>,
): Promise<Readonly<{ born: AkumaBornCall; akuma: AkuId }>> {
  const born = await input.world.admit(input.call, input.context);
  const akuma = born.kind === "requested" ? born.id : born.allocated.id;
  await emitCalledSignal({
    path: input.path,
    ...(input.settings === undefined ? {} : { settings: input.settings }),
    born,
    akumaId: akuma,
    ...(input.contractId === undefined ? {} : { contractId: input.contractId }),
  });
  return { born, akuma };
}

async function dispatchStage(
  input: Readonly<{
    repository: Parameters<typeof publishDispatch>[0]["repository"];
    akuId: AkuId;
    contractId: Parameters<typeof publishDispatch>[0]["contractId"];
  }>,
): Promise<DispatchStage> {
  try {
    const published = await publishDispatch(input);
    return published.kind === "dispatched"
      ? {
          kind: "dispatched",
          dispatch: published.dispatch,
          ...(published.seatClose === undefined || published.seatClose.length === 0
            ? {}
            : { seatClose: published.seatClose }),
        }
      : { kind: "failed", failure: published.failure };
  } catch (error) {
    return { kind: "failed", failure: integrationFailure(error) };
  }
}

async function forkDispatchStage(
  input: Readonly<{
    repository: Parameters<typeof readDispatch>[0];
    parent: AkuId;
    child: AkuId;
  }>,
): Promise<DispatchStage> {
  try {
    const parent = await readDispatch(input.repository, input.parent);
    return parent === null
      ? { kind: "none" }
      : await dispatchStage({ repository: input.repository, akuId: input.child, contractId: parent.contractId });
  } catch (error) {
    return { kind: "failed", failure: integrationFailure(error) };
  }
}

async function resolveCallExecution(input: Readonly<{ cwd?: string }>): Promise<CallExecution | undefined> {
  if (input.cwd === undefined) return undefined;
  return {
    cwd: await canonicalBirthCwd(input.cwd),
    source: "input",
  };
}

async function resolveAliasStage(
  path: WorldRoot,
  alias: AkumaAlias | undefined,
  dispatch: DispatchStage,
  akuma: AkuId,
): Promise<AliasStage> {
  if (alias === undefined) return { kind: "none" };
  if (dispatch.kind === "failed") return { kind: "skipped", reason: "dispatch-failed" };
  try {
    const moved = await moveAlias({ world: path, alias, akuId: akuma });
    return { kind: "aliased", alias: moved.alias, previous: moved.previous };
  } catch (error) {
    return { kind: "failed", failure: integrationFailure(error) };
  }
}

const CALL_INPUT_KEYS = [
  "path",
  "archetype",
  "body",
  "cwd",
  "readonly",
  "mode",
  "timeoutMs",
  "home",
  "settings",
  "contract",
  "alias",
  "allowed",
  "schema",
  "initiator",
  "signal",
  "observe",
] as const;

type ParsedCallInput = Readonly<{
  values: Record<string, unknown>;
  path: WorldRoot;
  archetype: string;
  body: string;
  initiator?: string;
  readonlyRequested?: true;
  cwd?: string;
  mode: "wait" | "detach";
  timeoutMs: number;
  signal?: AbortSignal;
  home?: string;
  settings?: Settings;
  alias?: AkumaAlias;
  seat: ReturnType<typeof callSeat>;
  initialTell: InitialCallTell & Readonly<{ schema?: Schema<unknown> }>;
  observe?: CallWaitObserver;
}>;

async function parseCallInput(input: CallInput): Promise<ParsedCallInput> {
  const values = requireInput(input, "Keiyaku.call input");
  onlyKeys(values, CALL_INPUT_KEYS, "Keiyaku.call input");
  const path = await World.prove(nonblank(values.path, "path"));
  const archetype = nonblank(values.archetype, "archetype");
  const body = text(values.body, "body");
  const initiator = values.initiator === undefined ? undefined : text(values.initiator, "initiator");
  const readonlyRequested = callReadonly(values.readonly, "readonly must be true").readonly;
  const cwd = values.cwd === undefined ? undefined : nonblank(values.cwd, "cwd");
  const mode = callMode(values.mode);
  const timeoutMs = callTimeout(values.timeoutMs, mode);
  const signal = callSignal(values.signal);
  const home = homeOption(values.home);
  const settings = settingsOption(values.settings);
  const alias: AkumaAlias | undefined =
    values.alias === undefined ? undefined : parseAkumaAlias(nonblank(values.alias, "alias"));
  const seat = callSeat(values.contract);
  const schema = values.schema as Schema<unknown> | undefined;
  const schemaJson = schema === undefined ? undefined : schemaJsonText(schema);
  const observe = values.observe as TellWaitObserver | undefined;
  const initialTell = {
    tellId: randomUUID(),
    body,
    ...(schemaJson === undefined ? {} : { schemaJson }),
    ...(schema === undefined ? {} : { schema }),
    ...(initiator === undefined ? {} : { initiator }),
  };
  return {
    values,
    path,
    archetype,
    body,
    ...(initiator === undefined ? {} : { initiator }),
    ...(readonlyRequested === undefined ? {} : { readonlyRequested }),
    ...(cwd === undefined ? {} : { cwd }),
    mode,
    timeoutMs,
    ...(signal === undefined ? {} : { signal }),
    ...(home === undefined ? {} : { home }),
    ...(settings === undefined ? {} : { settings }),
    ...(alias === undefined ? {} : { alias }),
    seat,
    initialTell,
    ...(observe === undefined ? {} : { observe }),
  };
}

function callAdmissionInput(input: ParsedCallInput, execution: CallExecution | undefined) {
  return {
    archetype: input.archetype,
    initialTell: {
      tellId: input.initialTell.tellId,
      body: input.initialTell.body,
      ...(input.initialTell.schemaJson === undefined ? {} : { schemaJson: input.initialTell.schemaJson }),
      ...(input.initialTell.initiator === undefined ? {} : { initiator: input.initialTell.initiator }),
    },
    ...(input.readonlyRequested === undefined ? {} : { readonly: input.readonlyRequested }),
    ...(input.values.allowed === undefined ? {} : { allowed: input.values.allowed as readonly AllowedAction[] }),
    ...(execution === undefined ? {} : { cwd: execution.cwd }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

async function prepareCall(input: CallInput, context: ExecutionContext): Promise<BornCall> {
  const parsed = await parseCallInput(input);
  const execution = await resolveCallExecution(parsed.cwd === undefined ? {} : { cwd: parsed.cwd });
  const world = akumaWorld(parsed.path, parsed.home, parsed.settings, context);
  const { born, akuma } = await admitCall({
    path: parsed.path,
    world,
    call: callAdmissionInput(parsed, execution),
    context: execution === undefined ? {} : { cwdCanonical: true },
    ...(parsed.settings === undefined ? {} : { settings: parsed.settings }),
    ...(parsed.seat === undefined ? {} : { contractId: parsed.seat.id }),
  });
  const completedExecution = execution ?? born.execution;
  const dispatch: DispatchStage =
    parsed.seat === undefined
      ? { kind: "none" }
      : await dispatchStage({ repository: parsed.seat.scope, akuId: akuma, contractId: parsed.seat.id });
  const aliasStage = await resolveAliasStage(parsed.path, parsed.alias, dispatch, akuma);
  return {
    path: parsed.path,
    born,
    execution: completedExecution,
    mode: parsed.mode,
    timeoutMs: parsed.timeoutMs,
    ...(parsed.signal === undefined ? {} : { signal: parsed.signal }),
    dispatch,
    alias: aliasStage,
    initialTell: parsed.initialTell,
    ...(parsed.observe === undefined ? {} : { observe: parsed.observe }),
  };
}

type PublishedCallHandle = Awaited<ReturnType<ReturnType<typeof createAkumaProduct>["publish"]>>;
type PublishedCall = Readonly<{
  born: BornCall;
  handle: PublishedCallHandle;
  result: Omit<CallResult, "observation">;
}>;
type AdmittedCallTell = Readonly<{ kind: "admitted"; wake?: Promise<TellResult> }>;
type CallTellAdmission = AdmittedCallTell | Readonly<{ kind: "failed"; result: CallResult }>;

async function publishCallTarget(born: BornCall): Promise<PublishedCall> {
  const world = akumaWorld(born.path);
  const contractId = born.dispatch.kind === "dispatched" ? born.dispatch.dispatch.contractId : undefined;
  const handle = await world.publish(born.born, { ...(contractId === undefined ? {} : { contractId }) }, born.signal);
  const readonly = (await handle.status()).readonly;
  return {
    born,
    handle,
    result: {
      kind: "called",
      akuma: handle.id,
      execution: born.execution,
      dispatch: born.dispatch,
      alias: born.alias,
      ...(readonly === undefined ? {} : { readonly }),
      ...(born.initialTell.schema === undefined ? {} : { structured: true }),
    },
  };
}

function failedCall(call: PublishedCall, error: unknown, tell?: TellResult): CallResult {
  return {
    ...call.result,
    observation: {
      kind: "failed",
      tellId: call.born.initialTell.tellId,
      ...(tell === undefined ? {} : { tell }),
      failure: integrationFailure(error),
    },
  };
}

async function admitCallTell(call: PublishedCall): Promise<CallTellAdmission> {
  const { born, handle } = call;
  if (born.born.kind === "requested") return { kind: "admitted" };
  let admitted: Awaited<ReturnType<typeof handle.admitInitialTell>>;
  try {
    admitted = await handle.admitInitialTell(born.initialTell, {
      ...(born.signal === undefined ? {} : { signal: born.signal }),
    });
  } catch (error) {
    if (born.signal?.aborted) throw error;
    return { kind: "failed", result: failedCall(call, error) };
  }
  if (admitted.kind === "birth-failed")
    return { kind: "failed", result: failedCall(call, new Error(admitted.diagnostic)) };
  if (admitted.kind === "not-born")
    return {
      kind: "failed",
      result: failedCall(call, new Error(`Akuma ${handle.id} was not born for its initial Tell`)),
    };
  const wake = admitted.wake;
  void wake.catch(() => undefined);
  return { kind: "admitted", wake };
}

async function detachCall(call: PublishedCall, admission: AdmittedCallTell): Promise<CallResult> {
  let tell: TellResult | undefined;
  try {
    tell =
      admission.wake === undefined
        ? await call.handle.admittedReceipt(call.born.initialTell.tellId)
        : await admission.wake;
    return { ...call.result, observation: { kind: "detached", tell } };
  } catch (error) {
    if (admission.wake !== undefined)
      tell = await call.handle.admittedReceipt(call.born.initialTell.tellId).catch(() => undefined);
    return failedCall(call, error, tell);
  }
}

async function observeCall(call: PublishedCall, admission: AdmittedCallTell): Promise<CallResult> {
  const { born, handle } = call;
  let tell: TellResult | undefined;
  const onObserve: TellWaitObserver = {
    admitted: async (receipt, id) => {
      tell = receipt;
      await born.observe?.admitted?.(receipt, id, {
        dispatch: born.dispatch,
        alias: born.alias,
        ...(call.result.readonly === undefined ? {} : { readonly: call.result.readonly }),
      });
    },
    ...(born.observe?.observe === undefined ? {} : { observe: born.observe.observe }),
  };
  try {
    const observed = await observeAdmittedTellWaitAkuma({
      path: born.path,
      id: handle.id,
      tellId: born.initialTell.tellId,
      timeoutMs: born.timeoutMs,
      ...(admission.wake === undefined ? {} : { wake: admission.wake }),
      ...(born.signal === undefined ? {} : { signal: born.signal }),
      onObserve,
    });
    return {
      ...call.result,
      observation: {
        kind: "observed",
        tell: observed.tell,
        observation:
          born.initialTell.schema === undefined
            ? observed.observation
            : decodeTellWaitObservation(observed.observation, born.initialTell.schema),
        ...(observed.completedAt === undefined ? {} : { completedAt: observed.completedAt }),
      },
    };
  } catch (error) {
    if (born.signal?.aborted) throw error;
    return failedCall(call, error, tell);
  }
}

async function publishCall(born: BornCall): Promise<CallResult> {
  const call = await publishCallTarget(born);
  const admission = await admitCallTell(call);
  if (admission.kind === "failed") return admission.result;
  return born.mode === "detach" ? await detachCall(call, admission) : await observeCall(call, admission);
}

export async function callKeiyaku(
  input: CallInput,
  execution: ExecutionContext = localExecutionContext(),
): Promise<CallResult> {
  return await publishCall(await prepareCall(input, execution));
}

export async function forkKeiyaku(input: ForkInput): Promise<ForkResult> {
  const values = requireInput(input, "Keiyaku.fork input");
  onlyKeys(values, ["path", "akuma", "at", "repo"], "Keiyaku.fork input");
  const at = nonblank(values.at, "at");
  const addressed = await addressAkuma({ path: values.path, akuma: nonblank(values.akuma, "akuma") });
  const { path, id: akuma } = addressed;
  const repository = values.repo === undefined ? undefined : scopeForRepo(values.repo);

  const receipt = await createAkumaProduct(path).selectHandle({ id: akuma }).fork({ at });
  if (receipt.kind !== "forked") return { ...receipt, parent: akuma };
  const dispatch =
    repository === undefined
      ? { kind: "none" as const }
      : await forkDispatchStage({ repository, parent: akuma, child: receipt.child });
  return { kind: "forked", parent: akuma, child: receipt.child, dispatch };
}
