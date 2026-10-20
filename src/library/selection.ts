/** @architectureCompositionRoot */
import { withoutReportedChanges } from "../akuma/projection.js";
import { AkumaNotBornError, AkumaObservationError } from "../akuma/akuma-errors.js";
import { AkumaOwner } from "../akuma/akuma-owner.js";
import {
  decodeAskObservation,
  executeAskAkuma,
  executeKillAkuma,
  executeTellAkuma,
  type AskObserver,
} from "../akuma/akuma-selection-execution.js";
import { executeWaitAkuma, type NativeWaitResult } from "../akuma/akuma-wait.js";
import { type AkumaStatus } from "../akuma/akuma.js";
import { parsePublicHistoryId } from "../akuma/identity.js";
import { type ActivityHistory, type OutcomeRow } from "../akuma/projection.js";
import { executionChannel, type ExecutionContext } from "../akuma/requests.js";
import { schemaJsonText, type Schema } from "../akuma/schema.js";
import type {
  AkumaAskResult,
  AkumaKillResult,
  AkumaObservation,
  AkumaTellResult,
  AkumaWaitResult,
} from "../akuma/selection-observation.js";
import {
  requestForwardedSelectionAsk,
  requestForwardedSelectionKill,
  requestForwardedSelectionTell,
  requestForwardedSelectionWait,
} from "../akuma/selection-request.js";
import type { DispatchAssociation } from "../akuma/dispatch-association.js";
import { observeDispatchAssociations } from "../dispatch/index.js";
import { observeContractAt } from "../git/observe.js";
import { withGitDecodeChannel } from "../git/read-observation.js";
import { observeCreatedDebtObservations, type CreatedDebtObservation } from "../debt/created-observation.js";
import type { WorldRoot } from "../world.js";
import { outcomePluginObserver, stderrPluginDiagnostic } from "../plugin/akuma-signals.js";
import {
  addressAkuma,
  addressAkumaSet,
  resolveAkuma,
  resolveAkumaSet,
  type AkumaAddressInput,
  type AkumaSetAddressInput,
} from "./address.js";
import { requireInput } from "./input.js";
import { scopeForRepo, type Repo } from "./repo.js";

type AddressedAkuma = Awaited<ReturnType<typeof addressAkuma>>;
type AddressedAkumaSet = Awaited<ReturnType<typeof addressAkumaSet>>;
type UncheckedSelectionAddress = Parameters<typeof addressAkuma>[0];

type SelectionWaitMode = Readonly<{
  completion: "any" | "all";
  timeoutMs?: number;
  signal?: AbortSignal;
  repo?: Repo;
}>;

/**
 * The one typed selection seam captured per execution. Selector resolution is
 * bound once: local execution addresses and proves birth in this process, while
 * a forwarded operation resolves coordinates only because the serving parent
 * owns the target and its admission probes. Each verb's local or forwarded
 * ability is likewise chosen once here, so no operation repeats a route branch.
 */
export type SelectionSeam = Readonly<{
  addressOne(input: UncheckedSelectionAddress): Promise<AddressedAkuma>;
  addressSet(input: UncheckedSelectionAddress): Promise<AddressedAkumaSet>;
  wait(addressed: AddressedAkumaSet, mode: SelectionWaitMode): Promise<AkumaWaitResult>;
  kill(addressed: AddressedAkumaSet, signal?: AbortSignal): Promise<AkumaKillResult>;
  tell(addressed: AddressedAkuma, input: AkumaTellInput, signal?: AbortSignal): Promise<AkumaTellResult>;
  ask<T>(addressed: AddressedAkuma, input: AkumaAskInput<T>, signal?: AbortSignal): Promise<AkumaAskResult<T>>;
}>;

export function selectionSeam(
  execution: ExecutionContext,
  reportDiagnostic: (message: string) => void = stderrPluginDiagnostic,
): SelectionSeam {
  const channel = executionChannel(execution);
  return channel.kind === "body-request" ? forwardedSelection(channel.directory) : localSelection(reportDiagnostic);
}

function forwardedSelection(directory: string): SelectionSeam {
  return {
    addressOne: resolveAkuma,
    addressSet: resolveAkumaSet,
    wait: async (addressed, mode) => await forwardedWait(addressed, { ...mode, directory }),
    kill: async (addressed, abort) =>
      await requestForwardedSelectionKill({
        directory,
        targets: addressed.orderedIds,
        ...(abort === undefined ? {} : { signal: abort }),
      }),
    tell: async (addressed, input, abort) =>
      await requestForwardedSelectionTell({
        directory,
        target: addressed.id,
        body: input.body,
        ...(input.interrupt === true ? { interrupt: true } : {}),
        ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
        ...(abort === undefined ? {} : { signal: abort }),
      }),
    ask: async <T>(addressed: AddressedAkuma, input: AkumaAskInput<T>, abort: AbortSignal | undefined) => {
      const result = await requestForwardedSelectionAsk({
        directory,
        target: addressed.id,
        body: input.body,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.schema === undefined ? {} : { schema: input.schema as Schema<unknown> }),
        ...(input.interrupt === true ? { interrupt: true } : {}),
        ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
        ...(abort === undefined ? {} : { signal: abort }),
      });
      return (
        input.schema === undefined
          ? result
          : { ...result, observation: decodeAskObservation(result.observation, input.schema) }
      ) as AkumaAskResult<T>;
    },
  };
}

function localSelection(reportDiagnostic: (message: string) => void): SelectionSeam {
  return {
    addressOne: addressAkuma,
    addressSet: addressAkumaSet,
    wait: async (addressed, mode) => await localWait(addressed, mode, reportDiagnostic),
    kill: async (addressed, abort) =>
      await executeKillAkuma({
        path: addressed.path,
        ids: addressed.orderedIds,
        ...(abort === undefined ? {} : { signal: abort }),
      }),
    tell: async (addressed, input, abort) =>
      await executeTellAkuma({
        path: addressed.path,
        id: addressed.id,
        body: input.body,
        ...(input.interrupt === true ? { interrupt: true } : {}),
        ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
        ...(abort === undefined ? {} : { signal: abort }),
      }),
    ask: async <T>(addressed: AddressedAkuma, input: AkumaAskInput<T>, abort: AbortSignal | undefined) => {
      const result = await executeAskAkuma({
        path: addressed.path,
        id: addressed.id,
        outcomeObserved: outcomePluginObserver({ world: addressed.path, reportDiagnostic }),
        body: input.body,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.schema === undefined ? {} : { schemaJson: schemaJsonText(input.schema) }),
        ...(input.interrupt === true ? { interrupt: true } : {}),
        ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
        ...(input.observe === undefined ? {} : { onObserve: input.observe }),
        ...(abort === undefined ? {} : { signal: abort }),
      });
      return (
        input.schema === undefined
          ? result
          : { ...result, observation: decodeAskObservation(result.observation, input.schema) }
      ) as AkumaAskResult<T>;
    },
  };
}

export type AkumaWaitInput = AkumaSetAddressInput &
  Readonly<{
    completion?: "any" | "all";
    timeoutMs?: number;
    signal?: AbortSignal;
  }>;

export type AkumaTellInput = AkumaAddressInput &
  Readonly<{ body: string; interrupt?: boolean; initiator?: string; signal?: AbortSignal }>;
export type AkumaAskInput<T = string> = AkumaAddressInput &
  Readonly<{
    body: string;
    timeoutMs?: number;
    schema?: Schema<T>;
    interrupt?: boolean;
    initiator?: string;
    signal?: AbortSignal;
    observe?: AskObserver;
  }>;
export type {
  AkumaAskResult,
  AkumaKillResult,
  AkumaObservation,
  AkumaObservationStage,
  AkumaTellResult,
  AkumaWaitResult,
} from "../akuma/selection-observation.js";
export type AkumaKillInput = AkumaSetAddressInput & Readonly<{ signal?: AbortSignal }>;
export type AkumaHistoryInput = AkumaAddressInput &
  Readonly<{
    id?: string;
    before?: number;
    since?: number;
    limit?: number;
    last?: boolean;
  }>;
export type AkumaHistoryResult =
  | Readonly<{ kind: "history"; id: AkumaStatus["id"]; history: ActivityHistory; contract: DispatchAssociation }>
  | Readonly<{ kind: "exact"; id: AkumaStatus["id"]; outcome: OutcomeRow; contract: DispatchAssociation }>
  | Readonly<{
      kind: "unknown-history";
      id: AkumaStatus["id"];
      historyId: string;
      contract: DispatchAssociation;
    }>
  | Readonly<{ kind: "last"; id: AkumaStatus["id"]; answer: string; contract: DispatchAssociation }>
  | Readonly<{ kind: "no-answer"; id: AkumaStatus["id"]; contract: DispatchAssociation }>;

function observationDiagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function observationError(id: AkumaStatus["id"], error: unknown): Error {
  if (error instanceof AkumaNotBornError || error instanceof AkumaObservationError) return error;
  return new AkumaObservationError(id, observationDiagnostic(error));
}

async function dispatchAssociations(
  repo: Repo | undefined,
  ids: readonly AkumaStatus["id"][],
): Promise<ReadonlyMap<AkumaStatus["id"], DispatchAssociation>> {
  return await observeDispatchAssociations(repo === undefined ? undefined : scopeForRepo(repo), ids);
}

/**
 * Read-time placement discharge. Reported changes describe a candidate that a
 * claimed Contract has already placed in Git, so once the associated Contract
 * is claimed the composed observation no longer presents them as pending. The
 * judgment derives only from existing facts — the Dispatch association and the
 * Contract journal's terminal — and writes none. An unassociated Akuma, an
 * active or abandoned Contract, and an unproven Contract read all keep the
 * reported changes: unplaced work still matters.
 */
function placementDischarged(repo: Repo | undefined): (contract: DispatchAssociation) => Promise<boolean> {
  const cache = new Map<string, boolean>();
  return async (contract) => {
    if (repo === undefined || contract.kind !== "associated") return false;
    const known = cache.get(contract.contractId);
    if (known !== undefined) return known;
    let claimed = false;
    try {
      const scope = scopeForRepo(repo);
      claimed = await withGitDecodeChannel(
        scope,
        async (channel) =>
          (await observeContractAt(scope, channel, contract.contractId)).state?.terminal?.kind === "claimed",
      );
    } catch {
      claimed = false;
    }
    cache.set(contract.contractId, claimed);
    return claimed;
  };
}

async function composeObservation(
  status: AkumaStatus,
  contract: DispatchAssociation,
  discharged: (contract: DispatchAssociation) => Promise<boolean>,
): Promise<AkumaStatus> {
  return (await discharged(contract)) ? { ...status, timeline: withoutReportedChanges(status.timeline) } : status;
}

async function createdDebtsFor(
  path: WorldRoot,
  statuses: readonly AkumaStatus[],
): Promise<readonly CreatedDebtObservation[]> {
  return await observeCreatedDebtObservations(
    path,
    statuses.map((status) => status.id),
  );
}

async function observeAkuma(status: AkumaStatus, path: WorldRoot, repo?: Repo): Promise<AkumaObservation> {
  return (await composeAkumaAssociations([status], path, repo))[0]!;
}

/**
 * The one upper composition of association-free native status evidence into its
 * public observation shape. It reads Alias-independent Dispatch and Debt
 * associations after the lower values, never before or inside them.
 */
async function composeAkumaAssociations(
  statuses: readonly AkumaStatus[],
  path: WorldRoot,
  repo?: Repo,
): Promise<readonly AkumaObservation[]> {
  const created = await createdDebtsFor(path, statuses);
  const discharged = placementDischarged(repo);
  const contracts = await dispatchAssociations(
    repo,
    statuses.map((status) => status.id),
  );
  return await Promise.all(
    statuses.map(async (status, index) => {
      const contract = contracts.get(status.id)!;
      return {
        status: await composeObservation(status, contract, discharged),
        contract,
        createdDebts: created[index]!,
      };
    }),
  );
}

function timeout(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError("timeoutMs must be a nonnegative finite number");
  }
  return value;
}

function signal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal");
  return value;
}

/**
 * Compose one wait's association-free native evidence into its public
 * observation shape, attaching the same upper associations as a single-status
 * observation.
 */
async function composeWaitResult(
  path: WorldRoot,
  repo: Repo | undefined,
  result: NativeWaitResult,
): Promise<AkumaWaitResult> {
  return {
    mode: result.mode,
    reason: result.reason,
    observations: await composeAkumaAssociations(result.observations, path, repo),
    unobserved: result.unobserved,
  };
}

/**
 * Re-attach upper associations after a wait result crosses a forwarded
 * boundary; the serving side must observe its own Dispatch and Debt state.
 */
async function attachWaitAssociations(
  path: WorldRoot,
  repo: Repo | undefined,
  result: AkumaWaitResult,
): Promise<AkumaWaitResult> {
  return await composeWaitResult(path, repo, {
    mode: result.mode,
    reason: result.reason,
    observations: result.observations.map((observation) => observation.status),
    unobserved: result.unobserved,
  });
}

function directAddress(values: Record<string, unknown>): Parameters<typeof addressAkuma>[0] {
  return {
    path: values.path,
    akuma: values.akuma,
    ...(values.repo === undefined ? {} : { repo: values.repo }),
  };
}

function setAddress(values: Record<string, unknown>): Parameters<typeof addressAkumaSet>[0] {
  return {
    path: values.path,
    akuma: values.akuma,
    ...(values.repo === undefined ? {} : { repo: values.repo }),
  };
}

export async function statusAkuma(
  input: AkumaAddressInput & Readonly<{ path: WorldRoot }>,
  reportDiagnostic: (message: string) => void = stderrPluginDiagnostic,
): Promise<AkumaObservation> {
  const addressed = await addressAkuma(input);
  try {
    return await observeAkuma(
      await new AkumaOwner(
        addressed.id,
        addressed.path,
        outcomePluginObserver({ world: addressed.path, reportDiagnostic }),
      ).status(),
      addressed.path,
      input.repo,
    );
  } catch (error) {
    throw observationError(addressed.id, error);
  }
}

function completionMode(value: unknown): "any" | "all" {
  // An omitted mode is any: a plural wait returns when any selected Akuma is complete.
  if (value === undefined) return "any";
  if (value !== "any" && value !== "all") throw new TypeError("completion must be any or all");
  return value;
}

async function forwardedWait(
  addressed: Awaited<ReturnType<typeof addressAkumaSet>>,
  input: Readonly<{
    directory: string;
    completion: "any" | "all";
    timeoutMs?: number;
    signal?: AbortSignal;
    repo?: Repo;
  }>,
): Promise<AkumaWaitResult> {
  return await attachWaitAssociations(
    addressed.path,
    input.repo,
    await requestForwardedSelectionWait({
      directory: input.directory,
      targets: addressed.orderedIds,
      completion: input.completion,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }),
  );
}

async function localWait(
  addressed: Awaited<ReturnType<typeof addressAkumaSet>>,
  input: Readonly<{
    completion: "any" | "all";
    timeoutMs?: number;
    signal?: AbortSignal;
    repo?: Repo;
  }>,
  reportDiagnostic: (message: string) => void,
): Promise<AkumaWaitResult> {
  try {
    return await composeWaitResult(
      addressed.path,
      input.repo,
      await executeWaitAkuma({
        path: addressed.path,
        ids: addressed.orderedIds,
        completion: input.completion,
        outcomeObserved: outcomePluginObserver({ world: addressed.path, reportDiagnostic }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
    );
  } catch (error) {
    if (input.signal?.aborted === true || addressed.orderedIds.length !== 1) throw error;
    throw observationError(addressed.orderedIds[0]!, error);
  }
}

export async function waitAkumaOn(
  seam: SelectionSeam,
  input: AkumaWaitInput & Readonly<{ path: WorldRoot }>,
): Promise<AkumaWaitResult> {
  const values = requireInput(input, "Akumas.wait input");
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "repo", "completion", "timeoutMs", "signal"].includes(key)) {
      throw new TypeError(`Akumas.wait input has unknown field: ${key}`);
    }
  }
  const selected = completionMode(values.completion);
  const timeoutMs = timeout(values.timeoutMs);
  const callerSignal = signal(values.signal);
  const repo = values.repo as Repo | undefined;
  const addressed = await seam.addressSet(setAddress(values));
  return await seam.wait(addressed, {
    completion: selected,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(callerSignal === undefined ? {} : { signal: callerSignal }),
    ...(repo === undefined ? {} : { repo }),
  });
}

export async function killAkumaOn(
  seam: SelectionSeam,
  input: AkumaKillInput & Readonly<{ path: WorldRoot }>,
): Promise<AkumaKillResult> {
  const values = requireInput(input, "Akumas.kill input");
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "repo", "signal"].includes(key)) {
      throw new TypeError(`Akumas.kill input has unknown field: ${key}`);
    }
  }
  return await seam.kill(await seam.addressSet(setAddress(values)), signal(values.signal));
}

export async function tellAkumaOn(
  seam: SelectionSeam,
  input: AkumaTellInput & Readonly<{ path: WorldRoot }>,
): Promise<AkumaTellResult> {
  const values = requireInput(input, "Akumas.tell input");
  for (const key of Object.keys(values)) {
    if (key === "schema") throw new TypeError("Akumas.tell does not accept schema; use Akumas.ask");
    if (!["path", "akuma", "body", "repo", "interrupt", "initiator", "signal"].includes(key)) {
      throw new TypeError(`Akumas.tell input has unknown field: ${key}`);
    }
  }
  if (typeof values.body !== "string") throw new TypeError("body must be a string");
  if (values.interrupt !== undefined && typeof values.interrupt !== "boolean")
    throw new TypeError("interrupt must be a boolean");
  return await seam.tell(await seam.addressOne(directAddress(values)), input, signal(values.signal));
}

function validateAskInput(
  values: Record<string, unknown>,
): asserts values is Record<string, unknown> & Pick<AkumaAskInput, "body" | "timeoutMs"> {
  for (const key of Object.keys(values)) {
    if (
      !["path", "akuma", "body", "repo", "timeoutMs", "schema", "interrupt", "initiator", "signal", "observe"].includes(
        key,
      )
    ) {
      throw new TypeError(`Akumas.ask input has unknown field: ${key}`);
    }
  }
  if (typeof values.body !== "string") throw new TypeError("body must be a string");
  if (
    values.timeoutMs !== undefined &&
    (typeof values.timeoutMs !== "number" ||
      !Number.isFinite(values.timeoutMs) ||
      !Number.isInteger(values.timeoutMs) ||
      values.timeoutMs < 0)
  ) {
    throw new TypeError("timeoutMs must be a nonnegative finite millisecond duration");
  }
  if (values.interrupt !== undefined && typeof values.interrupt !== "boolean")
    throw new TypeError("interrupt must be a boolean");
}

export async function askAkumaOn<T = string>(
  seam: SelectionSeam,
  input: AkumaAskInput<T> & Readonly<{ path: WorldRoot }>,
): Promise<AkumaAskResult<T>> {
  const values = requireInput(input, "Akumas.ask input");
  validateAskInput(values);
  return await seam.ask(await seam.addressOne(directAddress(values)), input, signal(values.signal));
}

function validateHistoryInput(values: Record<string, unknown>): void {
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "id", "before", "since", "limit", "last", "repo"].includes(key))
      throw new TypeError(`Akumas.history input has unknown field: ${key}`);
  }
  if (values.last !== undefined && typeof values.last !== "boolean") throw new TypeError("last must be a boolean");
  if (values.id !== undefined && (typeof values.id !== "string" || values.id.trim() === ""))
    throw new TypeError("id must be a nonblank string");
  if (values.id !== undefined && parsePublicHistoryId(values.id as string) === null)
    throw new TypeError("id must match turn/<positive safe integer>");
  if (
    values.id !== undefined &&
    (values.last === true || values.before !== undefined || values.since !== undefined || values.limit !== undefined)
  )
    throw new TypeError("id cannot be combined with last, before, since, or limit");
}

export async function historyAkuma(
  input: AkumaHistoryInput & Readonly<{ path: WorldRoot }>,
  reportDiagnostic: (message: string) => void = stderrPluginDiagnostic,
): Promise<AkumaHistoryResult> {
  const values = requireInput(input, "Akumas.history input");
  validateHistoryInput(values);
  const addressed = await addressAkuma(directAddress(values));
  try {
    const handle = new AkumaOwner(
      addressed.id,
      addressed.path,
      outcomePluginObserver({ world: addressed.path, reportDiagnostic }),
    );
    const contract = (await dispatchAssociations(values.repo as Repo | undefined, [addressed.id])).get(addressed.id)!;
    if (values.last === true) {
      const answer = await handle.lastAnswer();
      return answer.kind === "answer"
        ? { kind: "last", id: addressed.id, answer: answer.answer, contract }
        : { kind: "no-answer", id: addressed.id, contract };
    }
    const history = await handle.history({
      ...(values.id === undefined ? {} : { id: values.id as string }),
      ...(values.before === undefined ? {} : { before: values.before as number }),
      ...(values.since === undefined ? {} : { since: values.since as number }),
      ...(values.limit === undefined ? {} : { limit: values.limit as number }),
    });
    if (values.id !== undefined) {
      if ("kind" in history && history.kind === "exact")
        return { kind: "exact", id: addressed.id, outcome: history.outcome, contract };
      return { kind: "unknown-history", id: addressed.id, historyId: values.id as string, contract };
    }
    return { kind: "history", id: addressed.id, history: history as ActivityHistory, contract };
  } catch (error) {
    throw observationError(addressed.id, error);
  }
}
