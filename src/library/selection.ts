/** @architectureCompositionRoot */
import { observeStatusOutcome } from "../akuma/akuma-observe.js";
import { withoutReportedChanges } from "../akuma/projection.js";
import { AkumaNotBornError, AkumaObservationError } from "../akuma/akuma-errors.js";
import { AkumaOwner } from "../akuma/akuma-owner.js";
import type { BodyLauncher } from "../akuma/body-launch.js";
import {
  decodeAskObservation,
  executeAskAkuma,
  executeKillAkuma,
  executeTellAkuma,
  type AskObserver,
} from "../akuma/akuma-selection-execution.js";
import { executeWaitAkuma, type NativeWaitResult } from "../akuma/akuma-wait.js";
import { type AkumaStatus } from "../akuma/akuma.js";
import { parseExactHistorySelector } from "../akuma/identity.js";
import { type ActivityHistory, type OutcomeRow, type ReportRow } from "../akuma/projection.js";
import { schemaJsonText, type Schema } from "../akuma/schema.js";
import type {
  AkumaAskResult,
  AkumaKillResult,
  AkumaObservation,
  AkumaTellResult,
  AkumaWaitResult,
} from "../akuma/selection-observation.js";
import type { DispatchAssociation } from "../akuma/dispatch-association.js";
import { observeDispatchAssociations } from "../dispatch/index.js";
import { observeContractAt } from "../git/observe.js";
import { withGitDecodeChannel } from "../git/read-observation.js";
import { observeCreatedDebtObservations, type CreatedDebtObservation } from "../debt/created-observation.js";
import type { WorldRoot } from "../world.js";
import { outcomePluginObserver, stderrPluginDiagnostic, withAkumaWaitDeferrals } from "../plugin/akuma-signals.js";
import { addressAkuma, addressAkumaSet, type AkumaAddressInput, type AkumaSetAddressInput } from "./address.js";
import { requireInput } from "./input.js";
import { scopeForRepo, type Repo } from "./repo.js";

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
  | Readonly<{ kind: "exact-report"; id: AkumaStatus["id"]; report: ReportRow; contract: DispatchAssociation }>
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

export async function dispatchAssociations(
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

async function localWait(
  addressed: Awaited<ReturnType<typeof addressAkumaSet>>,
  input: Readonly<{
    completion: "any" | "all";
    timeoutMs?: number;
    signal?: AbortSignal;
    repo?: Repo;
  }>,
): Promise<AkumaWaitResult> {
  try {
    return await composeWaitResult(
      addressed.path,
      input.repo,
      await executeWaitAkuma({
        path: addressed.path,
        ids: addressed.orderedIds,
        completion: input.completion,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
    );
  } catch (error) {
    if (input.signal?.aborted === true || addressed.orderedIds.length !== 1) throw error;
    throw observationError(addressed.orderedIds[0]!, error);
  }
}

export async function waitAkuma(
  input: AkumaWaitInput & Readonly<{ path: WorldRoot }>,
  reportDiagnostic: (message: string) => void = stderrPluginDiagnostic,
): Promise<AkumaWaitResult> {
  const values = requireInput(input, "Akumas.wait input");
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "repo", "completion", "timeoutMs", "signal"].includes(key)) {
      throw new TypeError(`Akumas.wait input has unknown field: ${key}`);
    }
  }
  if (
    Array.isArray(values.akuma) &&
    values.akuma.some((selector: unknown) => typeof selector === "string" && selector.startsWith("kei/"))
  ) {
    throw new TypeError("Akumas.wait does not accept Contract selectors; use Keis.wait");
  }
  const selected = completionMode(values.completion);
  const timeoutMs = timeout(values.timeoutMs);
  const callerSignal = signal(values.signal);
  const repo = values.repo as Repo | undefined;
  const addressed = await addressAkumaSet(setAddress(values));
  return await withAkumaWaitDeferrals(
    { world: addressed.path, reportDiagnostic },
    { akumaIds: addressed.orderedIds },
    callerSignal,
    async () => {
      const result = await localWait(addressed, {
        completion: selected,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(callerSignal === undefined ? {} : { signal: callerSignal }),
        ...(repo === undefined ? {} : { repo }),
      });
      const observer = outcomePluginObserver({ world: addressed.path, reportDiagnostic });
      await Promise.all(result.observations.map(({ status }) => observeStatusOutcome(status, observer)));
      return result;
    },
  );
}

export async function killAkuma(
  input: AkumaKillInput & Readonly<{ path: WorldRoot }>,
  spawn: BodyLauncher,
): Promise<AkumaKillResult> {
  const values = requireInput(input, "Akumas.kill input");
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "repo", "signal"].includes(key)) {
      throw new TypeError(`Akumas.kill input has unknown field: ${key}`);
    }
  }
  const callerSignal = signal(values.signal);
  const addressed = await addressAkumaSet(setAddress(values));
  return await executeKillAkuma({
    spawn,
    path: addressed.path,
    ids: addressed.orderedIds,
    ...(callerSignal === undefined ? {} : { signal: callerSignal }),
  });
}

export async function tellAkuma(
  input: AkumaTellInput & Readonly<{ path: WorldRoot }>,
  spawn: BodyLauncher,
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
  const callerSignal = signal(values.signal);
  const addressed = await addressAkuma(directAddress(values));
  return await executeTellAkuma({
    spawn,
    path: addressed.path,
    id: addressed.id,
    body: input.body,
    ...(input.interrupt === true ? { interrupt: true } : {}),
    ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
    ...(callerSignal === undefined ? {} : { signal: callerSignal }),
  });
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

export async function askAkuma<T = string>(
  input: AkumaAskInput<T> & Readonly<{ path: WorldRoot }>,
  spawn: BodyLauncher,
  reportDiagnostic: (message: string) => void = stderrPluginDiagnostic,
): Promise<AkumaAskResult<T>> {
  const values = requireInput(input, "Akumas.ask input");
  validateAskInput(values);
  const callerSignal = signal(values.signal);
  const addressed = await addressAkuma(directAddress(values));
  return await withAkumaWaitDeferrals(
    { world: addressed.path, reportDiagnostic },
    { akumaIds: [addressed.id] },
    callerSignal,
    async () => {
      const result = await executeAskAkuma({
        spawn,
        path: addressed.path,
        id: addressed.id,
        outcomeObserved: outcomePluginObserver({ world: addressed.path, reportDiagnostic }),
        body: input.body,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.schema === undefined ? {} : { schemaJson: schemaJsonText(input.schema) }),
        ...(input.interrupt === true ? { interrupt: true } : {}),
        ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
        ...(input.observe === undefined ? {} : { onObserve: input.observe }),
        ...(callerSignal === undefined ? {} : { signal: callerSignal }),
      });
      return (
        input.schema === undefined
          ? result
          : { ...result, observation: decodeAskObservation(result.observation, input.schema) }
      ) as AkumaAskResult<T>;
    },
  );
}

function validateHistoryInput(values: Record<string, unknown>): void {
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "id", "before", "since", "limit", "last", "repo"].includes(key))
      throw new TypeError(`Akumas.history input has unknown field: ${key}`);
  }
  if (values.last !== undefined && typeof values.last !== "boolean") throw new TypeError("last must be a boolean");
  if (values.id !== undefined && (typeof values.id !== "string" || values.id.trim() === ""))
    throw new TypeError("id must be a nonblank string");
  if (values.id !== undefined && parseExactHistorySelector(values.id as string) === null)
    throw new TypeError("id must match turn/<positive safe integer> or report/<positive safe integer>");
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
      if ("kind" in history && history.kind === "exact-report")
        return { kind: "exact-report", id: addressed.id, report: history.report, contract };
      return { kind: "unknown-history", id: addressed.id, historyId: values.id as string, contract };
    }
    return { kind: "history", id: addressed.id, history: history as ActivityHistory, contract };
  } catch (error) {
    throw observationError(addressed.id, error);
  }
}
