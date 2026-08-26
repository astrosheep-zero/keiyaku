import { realpath, stat } from "node:fs/promises";
import { moveAlias, type AliasBinding } from "../alias/index.js";
import { Akuma, type AkumaStatus, type ForkReceipt, type ReadonlyRestraint } from "../akuma/akuma.js";
import { beginAkumaCall, finishAkumaCall, type AkumaBornCall } from "../akuma/akuma-product.js";
import type { AkuId } from "../akuma/identity.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import type { ContractId } from "../core/facts/types.js";
import { publishDispatch, readDispatch, type Dispatch, type DispatchFailure } from "../dispatch/index.js";
import { parseAkumaAlias, type AkumaAlias } from "../identity/selector.js";
import { readManagedWorktreeAppointment } from "../workspace-place.js";
import type { Settings } from "../settings.js";
import type { WorldRoot } from "../world.js";
import type { AllowedAction } from "../akuma/allowed.js";
import { requireInput } from "./input.js";
import { addressAkuma } from "./address.js";
import { KeiyakuRefused, seatForKeiyaku, type Keiyaku } from "./contract.js";
import { scopeForRepo, type Repo } from "./repo.js";

export type { AkumaStatus } from "../akuma/akuma.js";

export type IntegrationFailure = Readonly<{
  kind: "authority-corruption" | "infrastructure";
  diagnostic: string;
}>;

export type DispatchStage =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "dispatched"; dispatch: Dispatch }>
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
}>;

export type CallObservation =
  | Readonly<{ kind: "detached" }>
  | Readonly<{ kind: "observed"; status: AkumaStatus }>
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
}>;

type CallExecution = CallResult["execution"];

export type BornCall = Readonly<{
  path: WorldRoot;
  born: AkumaBornCall;
  execution: CallExecution;
  mode: "wait" | "detach";
  timeoutMs: number;
  dispatch: DispatchStage;
  alias: AliasStage;
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

function akumaWorld(path: WorldRoot, home?: string, settings?: Settings) {
  return Akuma.of(path, {
    ...(home === undefined ? {} : { home }),
    ...(settings === undefined ? {} : { settings }),
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

function callReadonly(value: unknown): true | undefined {
  if (value === undefined || value === true) return value;
  throw new TypeError("readonly must be true");
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

async function observeCall(
  handle: Awaited<ReturnType<Akuma["call"]>>,
  mode: "wait" | "detach",
  timeoutMs: number,
): Promise<CallObservation> {
  if (mode === "detach") {
    return { kind: "detached" };
  }
  try {
    return { kind: "observed", status: await handle.wait(undefined, { timeoutMs }) };
  } catch (error) {
    return { kind: "failed", failure: integrationFailure(error) };
  }
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
      ? { kind: "dispatched", dispatch: published.dispatch }
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

async function canonicalizeExistingDirectory(path: string, diagnostic: string): Promise<string> {
  try {
    const real = await realpath(path);
    if (!(await stat(real)).isDirectory()) throw new Error(diagnostic);
    return real;
  } catch (error) {
    if (error instanceof Error && error.message === diagnostic) throw error;
    throw new Error(diagnostic);
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
      cwd: await canonicalizeExistingDirectory(input.cwd, `cwd is not an existing directory: ${input.cwd}`),
      source: "input",
    };
  }
  if (input.contract !== undefined) {
    const seat = seatForKeiyaku(input.contract);
    const state = await currentManagedContract(input.contract, seat.id);
    const appointment = await readManagedWorktreeAppointment(seat.scope, state.id);
    if (appointment.kind === "unappointed") {
      throw unavailableWorkspace(state.id, "is unappointed; use reconcile");
    }
    if (appointment.kind === "failed") {
      throw new Error(`${appointment.diagnostic}; use reconcile`);
    }
    return {
      cwd: await canonicalizeExistingDirectory(
        appointment.path,
        `Contract workspace is unavailable: ${appointment.path}`,
      ),
      source: "contract-worktree",
    };
  }
  return undefined;
}

export async function beginCall(input: CallInput): Promise<BornCall> {
  const values = requireInput(input, "Keiyaku.call input");
  onlyKeys(
    values,
    [
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
    ],
    "Keiyaku.call input",
  );
  const path = nonblank(values.path, "path") as WorldRoot;
  const archetype = nonblank(values.archetype, "archetype");
  const body = text(values.body, "body");
  const readonlyRequested = callReadonly(values.readonly);
  const cwd = values.cwd === undefined ? undefined : nonblank(values.cwd, "cwd");
  const mode = callMode(values.mode);
  const timeoutMs = callTimeout(values.timeoutMs, mode);
  const home = homeOption(values.home);
  const settings = settingsOption(values.settings);
  const alias: AkumaAlias | undefined =
    values.alias === undefined ? undefined : parseAkumaAlias(nonblank(values.alias, "alias"));
  const seat = values.contract === undefined ? undefined : seatForKeiyaku(values.contract);
  const execution = await resolveCallExecution({
    path,
    ...(cwd === undefined ? {} : { cwd }),
    ...(seat === undefined ? {} : { contract: values.contract as Keiyaku }),
  });
  const world = akumaWorld(path, home, settings);
  const call = {
    archetype,
    body,
    ...(readonlyRequested === undefined ? {} : { readonly: readonlyRequested }),
    ...(values.allowed === undefined ? {} : { allowed: values.allowed as readonly AllowedAction[] }),
    ...(execution === undefined ? {} : { cwd: execution.cwd }),
  };
  const born = await beginAkumaCall(
    world,
    call as Parameters<Akuma["call"]>[0],
    execution === undefined ? {} : { cwdCanonical: true },
  );
  const akuma = born.kind === "requested" ? born.id : born.allocated.id;
  const completedExecution = execution ?? born.execution;
  const dispatch: DispatchStage =
    seat === undefined
      ? { kind: "none" }
      : await dispatchStage({ repository: seat.scope, akuId: akuma, contractId: seat.id });
  let aliasStage: AliasStage = { kind: "none" };
  if (alias !== undefined) {
    if (dispatch.kind === "failed") aliasStage = { kind: "skipped", reason: "dispatch-failed" };
    else {
      try {
        const moved = await moveAlias({ world: path, alias, akuId: akuma });
        aliasStage = { kind: "aliased", alias: moved.alias, previous: moved.previous };
      } catch (error) {
        aliasStage = { kind: "failed", failure: integrationFailure(error) };
      }
    }
  }
  return {
    path,
    born,
    execution: completedExecution,
    mode,
    timeoutMs,
    dispatch,
    alias: aliasStage,
  };
}

export async function finishCall(born: BornCall, participantName?: string): Promise<CallResult> {
  const world = akumaWorld(born.path);
  const contractId = born.dispatch.kind === "dispatched" ? born.dispatch.dispatch.contractId : undefined;
  const handle = await finishAkumaCall(world, born.born, {
    ...(participantName === undefined ? {} : { participantName }),
    ...(contractId === undefined ? {} : { contractId }),
  });
  const readonly = (await handle.status()).readonly;
  const observation = await observeCall(handle, born.mode, born.timeoutMs);
  return {
    kind: "called",
    akuma: handle.id,
    ...(readonly === undefined ? {} : { readonly }),
    execution: born.execution,
    dispatch: born.dispatch,
    alias: born.alias,
    observation,
  };
}

export async function callKeiyaku(input: CallInput): Promise<CallResult> {
  return await finishCall(await beginCall(input));
}

export async function forkKeiyaku(input: ForkInput): Promise<ForkResult> {
  const values = requireInput(input, "Keiyaku.fork input");
  onlyKeys(values, ["path", "akuma", "at", "repo"], "Keiyaku.fork input");
  const path = nonblank(values.path, "path") as WorldRoot;
  const at = nonblank(values.at, "at");
  const akuma = (
    await addressAkuma({
      path,
      akuma: nonblank(values.akuma, "akuma"),
    })
  ).id;
  const repository = values.repo === undefined ? undefined : scopeForRepo(values.repo);

  const receipt = await Akuma.of(path).of({ id: akuma }).fork({ at });
  if (receipt.kind !== "forked") return { ...receipt, parent: akuma };
  const dispatch =
    repository === undefined
      ? { kind: "none" as const }
      : await forkDispatchStage({ repository, parent: akuma, child: receipt.child });
  return { kind: "forked", parent: akuma, child: receipt.child, dispatch };
}
