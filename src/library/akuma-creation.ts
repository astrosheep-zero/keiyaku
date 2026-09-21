/** @architectureCompositionRoot */
import { appendFile } from "node:fs/promises";
import { moveAlias, type AliasBinding } from "../alias/index.js";
import { defaultWaitComplete, type AkumaStatus, type ForkReceipt, type ReadonlyRestraint } from "../akuma/akuma.js";
import { createAkumaProduct, type AkumaBornCall } from "../akuma/akuma-product.js";
import { pathsForAkuId, type AkumaPaths, type AkuId } from "../akuma/identity.js";
import { readSoul } from "../akuma/heart/index.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import type { ContractId } from "../core/facts/types.js";
import { publishDispatch, readDispatch, type Dispatch, type DispatchFailure } from "../dispatch/index.js";
import type { PrivateStateSeatCloseLag } from "../git/private-state-seat.js";
import { parseAkumaAlias, type AkumaAlias } from "../identity/selector.js";
import { emitCalledPluginSignal } from "../plugin/akuma-signals.js";
import { readManagedWorktreeAppointment } from "../workspace-place.js";
import type { Settings } from "../settings.js";
import { World, type WorldRoot } from "../world.js";
import type { AllowedAction } from "../akuma/allowed.js";
import type { Schema } from "../akuma/schema.js";
import { Akuma as PublicAkuma } from "../akuma/akuma-instance.js";
import { requestForwardedFleetTellAnswer } from "../akuma/fleet-request.js";
import { localExecutionContext, type ExecutionContext } from "../akuma/requests.js";
import { callReadonly, canonicalBirthCwd } from "../akuma/call-input.js";
import { requireInput } from "./input.js";
import { addressAkuma } from "./address.js";
import { KeiyakuRefused, type Keiyaku } from "./contract.js";
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
}>;

export type CallObservation =
  | Readonly<{ kind: "detached" }>
  | Readonly<{ kind: "observed"; reason: "completed" | "deadline"; status: AkumaStatus }>
  | Readonly<{ kind: "failed"; failure: IntegrationFailure }>;

export type CallResult = Readonly<{
  kind: "called";
  akuma: AkuId;
  readonly?: ReadonlyRestraint;
  execution: Readonly<{
    cwd: string;
    source: "input" | "contract-worktree" | "caller" | "process" | "world";
  }>;
  dispatch: DispatchStage;
  alias: AliasStage;
  observation: CallObservation;
  schemaAnswer?: unknown;
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
  schemaTell?: Readonly<{ body: string; schema: Schema<unknown>; initiator?: string }>;
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
  if (value === undefined || value === "wait") return "wait";
  if (value === "detach") return "detach";
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

async function observeCall(
  handle: ReturnType<ReturnType<typeof createAkumaProduct>["selectHandle"]>,
  mode: "wait" | "detach",
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CallObservation> {
  if (mode === "detach") {
    return { kind: "detached" };
  }
  try {
    const observed = await handle.waitReceipt(undefined, { timeoutMs, ...(signal === undefined ? {} : { signal }) });
    return { kind: "observed", reason: observed.reason, status: observed.status };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { kind: "failed", failure: integrationFailure(error) };
  }
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
    call: Parameters<ReturnType<typeof createAkumaProduct>["invoke"]>[0];
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

function unavailableWorkspace(contractId: ContractId, detail: string): Error {
  return new Error(`Contract workspace is unavailable: ${contractId} ${detail}`);
}

async function currentManagedContract(contract: Keiyaku, contractId: ContractId) {
  let state: Awaited<ReturnType<Keiyaku["state"]>>;
  try {
    state = await contract.state();
  } catch (error) {
    if (error instanceof Error && error.message === `contract does not exist: ${contractId}`) {
      throw new KeiyakuRefused({ kind: "contract-missing", contractId });
    }
    throw error;
  }
  if (state.terminal !== null) throw new KeiyakuRefused({ kind: "terminal", contractId: state.id });
  return state;
}

async function resolveCallExecution(
  input: Readonly<{
    path: WorldRoot;
    cwd?: string;
    contract?: Keiyaku;
  }>,
): Promise<CallExecution | undefined> {
  if (input.cwd !== undefined) {
    return {
      cwd: await canonicalBirthCwd(input.cwd),
      source: "input",
    };
  }
  if (input.contract !== undefined) {
    const seat = seatForKeiyaku(input.contract);
    if (seat === null) throw new TypeError("contract must be a Keiyaku");
    const state = await currentManagedContract(input.contract, seat.id);
    const appointment = await readManagedWorktreeAppointment(seat.scope, state.id);
    if (appointment.kind === "unappointed") {
      throw unavailableWorkspace(state.id, "is unappointed; use reconcile");
    }
    if (appointment.kind === "failed") {
      throw new Error(`${appointment.diagnostic}; use reconcile`);
    }
    return {
      cwd: await canonicalBirthCwd(appointment.path, `Contract workspace is unavailable: ${appointment.path}`),
      source: "contract-worktree",
    };
  }
  return undefined;
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
  };
}

function callAdmissionInput(input: ParsedCallInput, execution: CallExecution | undefined) {
  return {
    archetype: input.archetype,
    ...(input.values.schema === undefined ? { body: input.body } : {}),
    ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
    ...(input.readonlyRequested === undefined ? {} : { readonly: input.readonlyRequested }),
    ...(input.values.allowed === undefined ? {} : { allowed: input.values.allowed as readonly AllowedAction[] }),
    ...(input.values.schema === undefined ? {} : { schema: input.values.schema as Schema<unknown> }),
    ...(execution === undefined ? {} : { cwd: execution.cwd }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

function schemaTell(input: ParsedCallInput): BornCall["schemaTell"] {
  if (input.values.schema === undefined) return undefined;
  return {
    body: input.body,
    schema: input.values.schema as Schema<unknown>,
    ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
  };
}

async function prepareCall(input: CallInput, context: ExecutionContext): Promise<BornCall> {
  const parsed = await parseCallInput(input);
  const execution = await resolveCallExecution({
    path: parsed.path,
    ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
    ...(parsed.seat === undefined ? {} : { contract: parsed.values.contract as Keiyaku }),
  });
  const world = akumaWorld(parsed.path, parsed.home, parsed.settings, context);
  const { born, akuma } = await admitCall({
    path: parsed.path,
    world,
    call: callAdmissionInput(parsed, execution) as Parameters<ReturnType<typeof createAkumaProduct>["invoke"]>[0],
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
  const initialSchemaTell = schemaTell(parsed);
  return {
    path: parsed.path,
    born,
    execution: completedExecution,
    mode: parsed.mode,
    timeoutMs: parsed.timeoutMs,
    ...(parsed.signal === undefined ? {} : { signal: parsed.signal }),
    dispatch,
    alias: aliasStage,
    ...(initialSchemaTell === undefined ? {} : { schemaTell: initialSchemaTell }),
  };
}

async function publishCall(born: BornCall, execution: ExecutionContext): Promise<CallResult> {
  const world = akumaWorld(born.path);
  const contractId = born.dispatch.kind === "dispatched" ? born.dispatch.dispatch.contractId : undefined;
  const handle = await world.publish(
    born.born,
    {
      ...(contractId === undefined ? {} : { contractId }),
    },
    born.signal,
  );
  const deadline = born.mode === "wait" ? performance.now() + born.timeoutMs : undefined;
  const remaining = (): number => (deadline === undefined ? born.timeoutMs : Math.max(0, deadline - performance.now()));
  const schemaSignal = (): AbortSignal | undefined => {
    if (deadline === undefined) return born.signal;
    const timeout = AbortSignal.timeout(Math.ceil(remaining()));
    return born.signal === undefined ? timeout : AbortSignal.any([born.signal, timeout]);
  };
  const readonly = (await handle.status()).readonly;
  let schemaAnswer: unknown;
  if (born.schemaTell !== undefined) {
    const tell = born.schemaTell;
    // Birth publishes Soul before its prompt-free Body has necessarily settled.
    // Schema admission still belongs to Tell, after that initial Body is idle.
    const pending = handle
      .wait(undefined, {
        timeoutMs: remaining(),
        ...(born.signal === undefined ? {} : { signal: born.signal }),
      })
      .then(async (initial) => {
        if (initial.life !== "asleep" || !defaultWaitComplete(initial) || (deadline !== undefined && remaining() <= 0))
          return undefined;
        const signal = schemaSignal();
        try {
          return execution.channel.kind === "body-request"
            ? await requestForwardedFleetTellAnswer({
                directory: execution.channel.directory,
                target: handle.id,
                body: tell.body,
                schema: tell.schema,
                ...(tell.initiator === undefined ? {} : { initiator: tell.initiator }),
                ...(signal === undefined ? {} : { signal }),
              })
            : await PublicAkuma.select(born.path, handle.id).tell(tell.body, {
                schema: tell.schema,
                ...(tell.initiator === undefined ? {} : { initiator: tell.initiator }),
                ...(signal === undefined ? {} : { signal }),
              });
        } catch (error) {
          if (born.signal?.aborted || deadline === undefined || remaining() > 0) throw error;
          return undefined;
        }
      });
    if (born.mode === "detach") void pending.catch(() => undefined);
    else schemaAnswer = await pending;
  }
  const observation = await observeCall(handle, born.mode, remaining(), born.signal);
  return {
    kind: "called",
    akuma: handle.id,
    ...(readonly === undefined ? {} : { readonly }),
    execution: born.execution,
    dispatch: born.dispatch,
    alias: born.alias,
    ...(schemaAnswer === undefined ? {} : { schemaAnswer }),
    observation,
  };
}

export async function callKeiyaku(
  input: CallInput,
  execution: ExecutionContext = localExecutionContext(),
): Promise<CallResult> {
  return await publishCall(await prepareCall(input, execution), execution);
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
