import { moveAlias, type AliasBinding } from "../alias/index.js";
import {
  Akuma,
  type AkumaStatus,
  type ForkReceipt,
  type ReadonlyRestraint,
} from "../akuma/akuma.js";
import type { AkuId } from "../akuma/identity.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import {
  publishDispatch,
  readDispatch,
  type Dispatch,
  type DispatchFailure,
} from "../dispatch/index.js";
import { parseAkumaAlias, type AkumaAlias } from "../identity/selector.js";
import type { Settings } from "../settings.js";
import type { WorldRoot } from "../world.js";
import { requireInput } from "./input.js";
import { addressAkuma } from "./address.js";
import { seatForKeiyaku, type Keiyaku } from "./contract.js";
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
  mode?: "wait" | "detach";
  timeoutMs?: number;
  settings?: Settings;
  contract?: Keiyaku;
  alias?: AkumaAlias;
}>;

export type CallObservation =
  | Readonly<{ kind: "detached" }>
  | Readonly<{ kind: "observed"; status: AkumaStatus }>
  | Readonly<{ kind: "failed"; failure: IntegrationFailure }>;

export type CallResult = Readonly<{
  kind: "called";
  akuma: AkuId;
  readonly?: ReadonlyRestraint;
  dispatch: DispatchStage;
  alias: AliasStage;
  observation: CallObservation;
}>;

export type ForkInput = Readonly<{
  path: WorldRoot;
  akuma: string;
  at: string;
  settings?: Settings;
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
  if (typeof value !== "object" || value === null || typeof (value as { namespace?: unknown }).namespace !== "function") {
    throw new TypeError("settings must be a Settings");
  }
  return value as Settings;
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

async function observeCall(
  handle: Awaited<ReturnType<Akuma["call"]>>,
  mode: "wait" | "detach",
  timeoutMs: number,
): Promise<CallObservation> {
  if (mode === "detach") return { kind: "detached" };
  try {
    return { kind: "observed", status: await handle.wait(undefined, { timeoutMs }) };
  } catch (error) {
    return { kind: "failed", failure: integrationFailure(error) };
  }
}

async function dispatchStage(input: Readonly<{
  repository: Parameters<typeof publishDispatch>[0]["repository"];
  akuId: AkuId;
  contractId: Parameters<typeof publishDispatch>[0]["contractId"];
}>): Promise<DispatchStage> {
  try {
    const published = await publishDispatch(input);
    return published.kind === "dispatched"
      ? { kind: "dispatched", dispatch: published.dispatch }
      : { kind: "failed", failure: published.failure };
  } catch (error) {
    return { kind: "failed", failure: integrationFailure(error) };
  }
}

async function forkDispatchStage(input: Readonly<{
  repository: Parameters<typeof readDispatch>[0];
  parent: AkuId;
  child: AkuId;
}>): Promise<DispatchStage> {
  try {
    const parent = await readDispatch(input.repository, input.parent);
    return parent === null
      ? { kind: "none" }
      : await dispatchStage({ repository: input.repository, akuId: input.child, contractId: parent.contractId });
  } catch (error) {
    return { kind: "failed", failure: integrationFailure(error) };
  }
}

export async function callKeiyaku(input: CallInput): Promise<CallResult> {
  const values = requireInput(input, "Keiyaku.call input");
  onlyKeys(
    values,
    ["path", "archetype", "body", "cwd", "mode", "timeoutMs", "settings", "contract", "alias"],
    "Keiyaku.call input",
  );
  const path = nonblank(values.path, "path") as WorldRoot;
  const archetype = nonblank(values.archetype, "archetype");
  const body = text(values.body, "body");
  const cwd = values.cwd === undefined ? undefined : nonblank(values.cwd, "cwd");
  const mode = callMode(values.mode);
  const timeoutMs = callTimeout(values.timeoutMs, mode);
  const settings = settingsOption(values.settings);
  const alias: AkumaAlias | undefined = values.alias === undefined
    ? undefined
    : parseAkumaAlias(nonblank(values.alias, "alias"));
  const seat = values.contract === undefined ? undefined : seatForKeiyaku(values.contract);

  const handle = await Akuma.of(path, settings).call({
    archetype,
    body,
    ...(cwd === undefined ? {} : { cwd }),
  });
  const readonly = handle.status().readonly;
  const dispatch: DispatchStage = seat === undefined
    ? { kind: "none" }
    : await dispatchStage({ repository: seat.scope, akuId: handle.id, contractId: seat.id });
  let aliasStage: AliasStage = { kind: "none" };
  if (alias !== undefined) {
    if (dispatch.kind === "failed") aliasStage = { kind: "skipped", reason: "dispatch-failed" };
    else {
      try {
        const moved = await moveAlias({ world: path, alias, akuId: handle.id });
        aliasStage = { kind: "aliased", alias: moved.alias, previous: moved.previous };
      } catch (error) {
        aliasStage = { kind: "failed", failure: integrationFailure(error) };
      }
    }
  }
  const observation = await observeCall(handle, mode, timeoutMs);
  return {
    kind: "called",
    akuma: handle.id,
    ...(readonly === undefined ? {} : { readonly }),
    dispatch,
    alias: aliasStage,
    observation,
  };
}

export async function forkKeiyaku(input: ForkInput): Promise<ForkResult> {
  const values = requireInput(input, "Keiyaku.fork input");
  onlyKeys(values, ["path", "akuma", "at", "settings", "repo"], "Keiyaku.fork input");
  const path = nonblank(values.path, "path") as WorldRoot;
  const at = nonblank(values.at, "at");
  const settings = settingsOption(values.settings);
  const akuma = addressAkuma({
    path,
    akuma: nonblank(values.akuma, "akuma"),
    ...(settings === undefined ? {} : { settings }),
  }).id;
  const repository = values.repo === undefined ? undefined : scopeForRepo(values.repo);

  const receipt = await Akuma.of(path, settings)
    .of({ id: akuma })
    .fork({ at });
  if (receipt.kind !== "forked") return { ...receipt, parent: akuma };
  const dispatch = repository === undefined
    ? { kind: "none" as const }
    : await forkDispatchStage({ repository, parent: akuma, child: receipt.child });
  return { kind: "forked", parent: akuma, child: receipt.child, dispatch };
}
