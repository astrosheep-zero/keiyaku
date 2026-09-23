/** @architectureCompositionRoot */
import {
  AkumaNotBornError,
  type ActivityHistory,
  type OutcomeRow,
  type AkumaStatus,
  type InterruptReceipt,
  readBudgetedStatus,
  withoutReportedChanges,
} from "../akuma/akuma.js";
import { AkumaObservationError } from "../akuma/akuma-errors.js";
import { createAkumaProduct } from "../akuma/akuma-product.js";
import { executionChannel, localExecutionContext, type ExecutionContext } from "../akuma/requests.js";
import {
  requestForwardedFleetKill,
  requestForwardedFleetTell,
  requestForwardedFleetTellWait,
  requestForwardedFleetWait,
} from "../akuma/fleet-request.js";
import {
  executeKillAkuma,
  executeTellAkuma,
  executeTellWaitAkuma,
  executeWaitAkuma,
} from "../akuma/fleet-execution.js";
import type { TellWaitObserver, WaitIdentityFacts, WaitObserver } from "../akuma/fleet-execution.js";
import { readAliases } from "../alias/index.js";
import { observeDispatchAssociation, type DispatchAssociation } from "../dispatch/index.js";
import { observeContractAt } from "../git/observe.js";
import { withGitDecodeChannel } from "../git/read-observation.js";
import type { AkumaAlias } from "../identity/selector.js";
import { observeCreatedTaskObservations, type CreatedTaskObservation } from "../task/created-observation.js";
import { schemaJsonText, type Schema } from "../akuma/schema.js";
import type { WorldRoot } from "../world.js";
import {
  addressAkuma,
  addressAkumaSet,
  resolveAkuma,
  resolveAkumaSet,
  type AkumaAddressInput,
  type AkumaSetAddressInput,
} from "./address.js";
import { requireInput } from "./input.js";
import {
  fleetResultSchemas,
  parseAkumaObservation,
  type AkumaKillResult,
  type AkumaObservation,
  type AkumaObservationStage,
  type AkumaTellResult,
  type AkumaTellWaitResult,
  type AkumaWaitResult,
} from "../akuma/fleet-observation.js";
import { scopeForRepo, type Repo } from "./repo.js";
import { parsePublicHistoryId } from "../akuma/identity.js";

export type AkumaWaitInput = AkumaSetAddressInput &
  Readonly<{
    completion?: "any" | "all";
    timeoutMs?: number;
    signal?: AbortSignal;
  }>;

export type AkumaTellInput = AkumaAddressInput & Readonly<{ body: string; initiator?: string; signal?: AbortSignal }>;
export type AkumaTellWaitInput = AkumaAddressInput &
  Readonly<{
    body: string;
    timeoutMs: number;
    schema?: Schema<unknown>;
    interrupt?: boolean;
    initiator?: string;
    signal?: AbortSignal;
    observe?: TellWaitObserver;
  }>;
export type { TellResult, TellWake } from "../akuma/akuma.js";
export type { CreatedTaskObservation } from "../task/created-observation.js";
export type { DispatchAssociation } from "../dispatch/association.js";
export type {
  AkumaKillResult,
  AkumaObservation,
  AkumaObservationStage,
  AkumaTellResult,
  AkumaUnobserved,
  AkumaWaitResult,
} from "../akuma/fleet-observation.js";
export type AkumaInterruptInput = AkumaAddressInput &
  Readonly<{ body: string; initiator?: string; signal?: AbortSignal }>;
export type AkumaKillInput = AkumaSetAddressInput & Readonly<{ signal?: AbortSignal }>;
export type AkumaInterruptResult = Readonly<{
  id: AkumaStatus["id"];
  receipt: InterruptReceipt;
  observation: AkumaObservationStage;
}>;
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

function source(path: WorldRoot): ReturnType<typeof createAkumaProduct> {
  return createAkumaProduct(path);
}

function observationDiagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function observationError(id: AkumaStatus["id"], error: unknown): Error {
  if (error instanceof AkumaNotBornError || error instanceof AkumaObservationError) return error;
  return new AkumaObservationError(id, observationDiagnostic(error));
}

async function dispatchAssociation(repo: Repo | undefined, id: AkumaStatus["id"]): Promise<DispatchAssociation> {
  return await observeDispatchAssociation(repo === undefined ? undefined : scopeForRepo(repo), id);
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

async function createdTasksFor(
  path: WorldRoot,
  statuses: readonly AkumaStatus[],
): Promise<readonly CreatedTaskObservation[]> {
  return await observeCreatedTaskObservations(
    path,
    statuses.map((status) => status.id),
  );
}

/**
 * One wait's identity-fact resolver: the alias bound to an Akuma in its world and
 * its Dispatch association. The alias index is read once, on the first observed
 * Akuma, and each Akuma's alias is the first binding the canonical order offers.
 */
function waitIdentityFacts(
  path: WorldRoot,
  repo: Repo | undefined,
): (id: AkumaStatus["id"]) => Promise<WaitIdentityFacts> {
  let aliases: ReadonlyMap<AkumaStatus["id"], AkumaAlias> | undefined;
  return async (id) => {
    if (aliases === undefined) {
      const bound = new Map<AkumaStatus["id"], AkumaAlias>();
      for (const binding of await readAliases(path)) {
        if (!bound.has(binding.akuId)) bound.set(binding.akuId, binding.alias);
      }
      aliases = bound;
    }
    const alias = aliases.get(id);
    return { ...(alias === undefined ? {} : { alias }), contract: await dispatchAssociation(repo, id) };
  };
}

async function observeAkuma(status: AkumaStatus, path: WorldRoot, repo?: Repo): Promise<AkumaObservation> {
  return (await observeAkumaSet([status], path, repo))[0]!;
}

async function observeAkumaStage(
  path: WorldRoot,
  id: AkumaStatus["id"],
  repo?: Repo,
  admittedTellId?: string,
): Promise<AkumaObservationStage> {
  try {
    const observed = await readBudgetedStatus(path, id, {
      aperture: "receipt",
      ...(admittedTellId === undefined ? {} : { admittedTellId }),
    });
    return { kind: "observed", ...(await observeAkuma(observed.status, path, repo)) };
  } catch (error) {
    if (error instanceof AkumaNotBornError) throw error;
    return { kind: "unobserved", diagnostic: observationDiagnostic(error) };
  }
}

async function observeAkumaSet(
  statuses: readonly AkumaStatus[],
  path: WorldRoot,
  repo?: Repo,
): Promise<readonly AkumaObservation[]> {
  const created = await createdTasksFor(path, statuses);
  const discharged = placementDischarged(repo);
  return await Promise.all(
    statuses.map(async (status, index) => {
      const contract = await dispatchAssociation(repo, status.id);
      return parseAkumaObservation({
        status: await composeObservation(status, contract, discharged),
        contract,
        createdTasks: created[index]!,
      });
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

async function attachWaitAssociations(
  path: WorldRoot,
  repo: Repo | undefined,
  result: AkumaWaitResult,
): Promise<AkumaWaitResult> {
  const created = await createdTasksFor(
    path,
    result.observations.map((observation) => observation.status),
  );
  const discharged = placementDischarged(repo);
  return fleetResultSchemas.wait.parse({
    ...result,
    observations: await Promise.all(
      result.observations.map(async (observation, index) => {
        const contract = await dispatchAssociation(repo, observation.status.id);
        return parseAkumaObservation({
          status: await composeObservation(observation.status, contract, discharged),
          contract,
          createdTasks: created[index]!,
        });
      }),
    ),
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

export async function statusAkuma(input: AkumaAddressInput): Promise<AkumaObservation> {
  const addressed = await addressAkuma(input);
  try {
    return await observeAkuma(
      await source(addressed.path).selectHandle({ id: addressed.id }).status(),
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
    await requestForwardedFleetWait({
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
    observer?: WaitObserver;
  }>,
): Promise<AkumaWaitResult> {
  try {
    return await attachWaitAssociations(
      addressed.path,
      input.repo,
      await executeWaitAkuma({
        path: addressed.path,
        ids: addressed.orderedIds,
        completion: input.completion,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        identity: waitIdentityFacts(addressed.path, input.repo),
        selectionOrder: addressed.orderedIds,
        ...(input.observer?.selected === undefined ? {} : { onSelected: input.observer.selected }),
        ...(input.observer?.observe === undefined ? {} : { observe: input.observer.observe }),
      }),
    );
  } catch (error) {
    if (input.signal?.aborted === true || addressed.orderedIds.length !== 1) throw error;
    throw observationError(addressed.orderedIds[0]!, error);
  }
}

export async function waitAkuma(
  input: AkumaWaitInput,
  execution: ExecutionContext = localExecutionContext(),
  observer?: WaitObserver,
): Promise<AkumaWaitResult> {
  const values = requireInput(input, "Keiyaku.wait input");
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "repo", "completion", "timeoutMs", "signal"].includes(key)) {
      throw new TypeError(`Keiyaku.wait input has unknown field: ${key}`);
    }
  }
  const selected = completionMode(values.completion);
  const timeoutMs = timeout(values.timeoutMs);
  const callerSignal = signal(values.signal);
  const channel = executionChannel(execution);
  const repo = values.repo as Repo | undefined;
  const mode = {
    completion: selected,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(callerSignal === undefined ? {} : { signal: callerSignal }),
    ...(repo === undefined ? {} : { repo }),
  };
  if (channel.kind === "body-request") {
    // A forwarded operation resolves coordinates without proving birth: the
    // parent Fleet owns the target, so this process never probes locally.
    const addressed = await resolveAkumaSet(setAddress(values));
    return await forwardedWait(addressed, { ...mode, directory: channel.directory });
  }
  const addressed = await addressAkumaSet(setAddress(values));
  return await localWait(addressed, { ...mode, ...(observer === undefined ? {} : { observer }) });
}

export async function killAkuma(
  input: AkumaKillInput,
  execution: ExecutionContext = localExecutionContext(),
): Promise<AkumaKillResult> {
  const values = requireInput(input, "Keiyaku.kill input");
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "repo", "signal"].includes(key)) {
      throw new TypeError(`Keiyaku.kill input has unknown field: ${key}`);
    }
  }
  const callerSignal = signal(values.signal);
  const channel = executionChannel(execution);
  if (channel.kind === "body-request") {
    const addressed = await resolveAkumaSet(setAddress(values));
    return await requestForwardedFleetKill({
      directory: channel.directory,
      targets: addressed.orderedIds,
      ...(callerSignal === undefined ? {} : { signal: callerSignal }),
    });
  }
  const addressed = await addressAkumaSet(setAddress(values));
  return await executeKillAkuma({
    path: addressed.path,
    ids: addressed.orderedIds,
    ...(callerSignal === undefined ? {} : { signal: callerSignal }),
  });
}

export async function tellAkuma(
  input: AkumaTellInput,
  execution: ExecutionContext = localExecutionContext(),
): Promise<AkumaTellResult> {
  const values = requireInput(input, "Keiyaku.tell input");
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "body", "repo", "initiator", "signal"].includes(key)) {
      throw new TypeError(`Keiyaku.tell input has unknown field: ${key}`);
    }
  }
  if (typeof values.body !== "string") throw new TypeError("body must be a string");
  const callerSignal = signal(values.signal);
  const channel = executionChannel(execution);
  if (channel.kind === "body-request") {
    const addressed = await resolveAkuma(directAddress(values));
    return await requestForwardedFleetTell({
      directory: channel.directory,
      target: addressed.id,
      body: values.body,
      ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
      ...(callerSignal === undefined ? {} : { signal: callerSignal }),
    });
  }
  const addressed = await addressAkuma(directAddress(values));
  return await executeTellAkuma({
    path: addressed.path,
    id: addressed.id,
    body: values.body,
    ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
    ...(callerSignal === undefined ? {} : { signal: callerSignal }),
  });
}

function validateTellWaitInput(
  values: Record<string, unknown>,
): asserts values is Record<string, unknown> & Pick<AkumaTellWaitInput, "body" | "timeoutMs"> {
  for (const key of Object.keys(values)) {
    if (
      !["path", "akuma", "body", "repo", "timeoutMs", "schema", "interrupt", "initiator", "signal", "observe"].includes(
        key,
      )
    ) {
      throw new TypeError(`Keiyaku tell wait input has unknown field: ${key}`);
    }
  }
  if (typeof values.body !== "string") throw new TypeError("body must be a string");
  if (
    typeof values.timeoutMs !== "number" ||
    !Number.isFinite(values.timeoutMs) ||
    !Number.isInteger(values.timeoutMs) ||
    values.timeoutMs < 0
  ) {
    throw new TypeError("timeoutMs must be a nonnegative finite millisecond duration");
  }
  if (values.interrupt !== undefined && typeof values.interrupt !== "boolean")
    throw new TypeError("interrupt must be a boolean");
}

export async function tellWaitAkuma(
  input: AkumaTellWaitInput,
  execution: ExecutionContext = localExecutionContext(),
): Promise<AkumaTellWaitResult> {
  const values = requireInput(input, "Keiyaku tell wait input");
  validateTellWaitInput(values);
  const callerSignal = signal(values.signal);
  const channel = executionChannel(execution);
  if (channel.kind === "body-request") {
    // A forwarded Tell is resolved by its serving parent, so this process must
    // not prove the target against its own Heart files.
    const addressed = await resolveAkuma(directAddress(values));
    return await requestForwardedFleetTellWait({
      directory: channel.directory,
      target: addressed.id,
      body: values.body,
      timeoutMs: values.timeoutMs,
      ...(input.schema === undefined ? {} : { schema: input.schema }),
      ...(input.interrupt === true ? { interrupt: true } : {}),
      ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
      ...(callerSignal === undefined ? {} : { signal: callerSignal }),
    });
  }
  const addressed = await addressAkuma(directAddress(values));
  return await executeTellWaitAkuma({
    path: addressed.path,
    id: addressed.id,
    body: values.body,
    timeoutMs: values.timeoutMs,
    ...(input.schema === undefined ? {} : { schemaJson: schemaJsonText(input.schema) }),
    ...(input.interrupt === true ? { interrupt: true } : {}),
    ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
    ...(input.observe === undefined ? {} : { onObserve: input.observe }),
    ...(callerSignal === undefined ? {} : { signal: callerSignal }),
  });
}

export async function interruptAkuma(input: AkumaInterruptInput): Promise<AkumaInterruptResult> {
  const values = requireInput(input, "Keiyaku.interrupt input");
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "body", "repo", "initiator", "signal"].includes(key)) {
      throw new TypeError(`Keiyaku.interrupt input has unknown field: ${key}`);
    }
  }
  if (typeof values.body !== "string") throw new TypeError("body must be a string");
  const callerSignal = signal(values.signal);
  const addressed = await addressAkuma(directAddress(values));
  const handle = source(addressed.path).selectHandle({ id: addressed.id });
  const receipt = await handle.interrupt(values.body, {
    ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
    ...(callerSignal === undefined ? {} : { signal: callerSignal }),
  });
  const observation = await observeAkumaStage(addressed.path, addressed.id, values.repo as Repo | undefined);
  return { id: addressed.id, receipt, observation };
}

function validateHistoryInput(values: Record<string, unknown>): void {
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "id", "before", "since", "limit", "last", "repo"].includes(key))
      throw new TypeError(`Keiyaku.history input has unknown field: ${key}`);
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

export async function historyAkuma(input: AkumaHistoryInput): Promise<AkumaHistoryResult> {
  const values = requireInput(input, "Keiyaku.history input");
  validateHistoryInput(values);
  const addressed = await addressAkuma(directAddress(values));
  try {
    const handle = source(addressed.path).selectHandle({ id: addressed.id });
    const contract = await dispatchAssociation(values.repo as Repo | undefined, addressed.id);
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
