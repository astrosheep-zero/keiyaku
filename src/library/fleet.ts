import {
  Akuma,
  AkumaNotBornError,
  type ActivityHistory,
  type AkumaStatus,
  type InterruptReceipt,
  type KillEvidence,
  type TellResult,
} from "../akuma/index.js";
import { readBudgetedStatus, tellAkumaWithId } from "../akuma/akuma.js";
import {
  injectedBodyRequests,
  requestBodyKill,
  requestBodyTell,
  requestBodyWait,
  type UpstreamRequestOutcome,
} from "../akuma/requests.js";
import type { ContractId } from "../core/facts/types.js";
import { readDispatch } from "../dispatch/index.js";
import type { TaskRow } from "../task/index.js";
import { observeTaskBoard } from "../task/operations.js";
import type { WorldRoot } from "../world.js";
import { addressAkuma, addressAkumaSet, type AkumaAddressInput, type AkumaSetAddressInput } from "./address.js";
import { requireInput } from "./input.js";
import { scopeForRepo, type Repo } from "./repo.js";

export type CreatedTaskObservation =
  | Readonly<{ kind: "present"; rows: readonly TaskRow[] }>
  | Readonly<{ kind: "failed"; diagnostic: string }>;

export type AkumaObservation = Readonly<{
  status: AkumaStatus;
  contractId?: ContractId;
  createdTasks: CreatedTaskObservation;
}>;

export type AkumaWaitInput = AkumaSetAddressInput & Readonly<{
  completion?: "any" | "all";
  timeoutMs?: number;
}>;

export type AkumaWaitResult = Readonly<{
  completion: "any" | "all";
  observations: readonly AkumaObservation[];
}>;

export type AkumaKillResult = Readonly<{
  results: readonly Readonly<{ id: AkumaStatus["id"]; evidence: KillEvidence; observation: AkumaObservation }>[];
}>;

export type AkumaTellInput = AkumaAddressInput & Readonly<{ body: string }>;
export type AkumaTellResult = Readonly<{ akuma: AkumaStatus["id"]; tell: TellResult; observation: AkumaObservation }>;
export type AkumaInterruptInput = AkumaAddressInput & Readonly<{ body: string }>;
export type AkumaInterruptResult = Readonly<{
  id: AkumaStatus["id"];
  receipt: InterruptReceipt;
  observation: AkumaObservation;
}>;
export type AkumaHistoryInput = AkumaAddressInput & Readonly<{
  before?: number;
  since?: number;
  limit?: number;
  last?: boolean;
}>;
export type AkumaHistoryResult =
  | Readonly<{ kind: "history"; id: AkumaStatus["id"]; history: ActivityHistory; contractId?: ContractId }>
  | Readonly<{ kind: "last"; id: AkumaStatus["id"]; answer: string; contractId?: ContractId }>
  | Readonly<{ kind: "no-answer"; id: AkumaStatus["id"]; contractId?: ContractId }>;

function source(path: WorldRoot): Akuma {
  return Akuma.of(path);
}

async function contractFor(repo: Repo | undefined, id: AkumaStatus["id"]): Promise<ContractId | undefined> {
  const dispatch = repo === undefined ? null : await readDispatch(scopeForRepo(repo), id);
  return dispatch?.contractId;
}

function createdTaskDiagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function createdTasksFor(
  path: WorldRoot,
  statuses: readonly AkumaStatus[],
): Promise<readonly CreatedTaskObservation[]> {
  let board;
  try {
    board = await observeTaskBoard(path);
  } catch (error) {
    const failed = { kind: "failed" as const, diagnostic: createdTaskDiagnostic(error) };
    return statuses.map(() => failed);
  }
  return statuses.map((status) => ({ kind: "present", rows: board.selectCreatedBy(status.id) }));
}

async function observeAkuma(status: AkumaStatus, path: WorldRoot, repo?: Repo): Promise<AkumaObservation> {
  return (await observeAkumaSet([status], path, repo))[0]!;
}

async function observeAkumaSet(
  statuses: readonly AkumaStatus[],
  path: WorldRoot,
  repo?: Repo,
): Promise<readonly AkumaObservation[]> {
  const created = await createdTasksFor(path, statuses);
  return await Promise.all(statuses.map(async (status, index) => {
    const contractId = await contractFor(repo, status.id);
    return {
      status,
      createdTasks: created[index]!,
      ...(contractId === undefined ? {} : { contractId }),
    };
  }));
}

function timeout(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError("timeoutMs must be a nonnegative finite number");
  }
  return value;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const done = (): void => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new Error("upstream request aborted"));
    };
    timer = setTimeout(done, milliseconds);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

const SHARED_ORDINARY_BUDGET = 30;

async function observeWaitStatuses(
  path: WorldRoot,
  ids: readonly AkumaStatus["id"][],
  signal?: AbortSignal,
): Promise<readonly AkumaStatus[]> {
  signal?.throwIfAborted();
  if (ids.length <= 1) {
    return await Promise.all(ids.map(async (id) => await source(path).of({ id }).status()));
  }
  let remaining = SHARED_ORDINARY_BUDGET;
  const statuses: AkumaStatus[] = [];
  for (const id of ids) {
    signal?.throwIfAborted();
    try {
      const observed = await readBudgetedStatus(path, id, { ordinaryBudget: remaining });
      statuses.push(observed.status);
      remaining -= observed.ordinarySelected;
    } catch (error) {
      if (error instanceof AkumaNotBornError) throw error;
      // Plural wait omits one unreadable status without spending its shared budget.
    }
  }
  return statuses;
}

type WaitExecutionInput = Readonly<{
  path: WorldRoot;
  ids: readonly AkumaStatus["id"][];
  completion: "any" | "all";
  timeoutMs?: number;
  repo?: Repo;
  signal?: AbortSignal;
}>;

export async function executeWaitAkuma(input: WaitExecutionInput): Promise<AkumaWaitResult> {
  const deadline = input.timeoutMs === undefined ? undefined : performance.now() + input.timeoutMs;
  for (;;) {
    const statuses = await observeWaitStatuses(input.path, input.ids, input.signal);
    const settled = statuses.map((status) => status.life !== "running");
    const completed = statuses.length > 0
      && (input.completion === "any" ? settled.some(Boolean) : settled.every(Boolean));
    if (completed
      || (deadline !== undefined && performance.now() >= deadline)) {
      return {
        completion: input.completion,
        observations: await observeAkumaSet(statuses, input.path, input.repo),
      };
    }
    await delay(deadline === undefined ? 25 : Math.min(25, Math.max(0, deadline - performance.now())), input.signal);
  }
}

type TellExecutionInput = Readonly<{
  path: WorldRoot;
  id: AkumaStatus["id"];
  body: string;
  tellId?: string;
  recordedAt?: string;
  repo?: Repo;
  signal?: AbortSignal;
}>;

export async function executeTellAkuma(input: TellExecutionInput): Promise<AkumaTellResult> {
  input.signal?.throwIfAborted();
  const handle = source(input.path).of({ id: input.id });
  const tell = input.tellId === undefined
    ? await handle.tell(input.body)
    : await tellAkumaWithId(input.path, input.id, input.body, input.tellId, input.recordedAt);
  input.signal?.throwIfAborted();
  return {
    akuma: input.id,
    tell,
    observation: await observeAkuma(await handle.status(), input.path, input.repo),
  };
}

type KillExecutionInput = Readonly<{
  path: WorldRoot;
  ids: readonly AkumaStatus["id"][];
  repo?: Repo;
  signal?: AbortSignal;
}>;

export async function executeKillAkuma(input: KillExecutionInput): Promise<AkumaKillResult> {
  input.signal?.throwIfAborted();
  const handles = input.ids.map((id) => source(input.path).of({ id }));
  const evidence = await Promise.all(handles.map(async (handle) => await handle.kill()));
  input.signal?.throwIfAborted();
  const statuses = await Promise.all(input.ids.map(async (id) => await source(input.path).of({ id }).status()));
  const observations = await observeAkumaSet(statuses, input.path, input.repo);
  return {
    results: input.ids.map((id, index) => ({ id, evidence: evidence[index]!, observation: observations[index]! })),
  };
}

function upstreamResult<T>(outcome: UpstreamRequestOutcome): T {
  if (outcome.kind === "returned") return outcome.result as T;
  if (outcome.failure.kind === "akuma-not-born") throw new AkumaNotBornError(outcome.failure.id);
  throw new Error(outcome.failure.diagnostic);
}

async function attachContract(repo: Repo | undefined, observation: AkumaObservation): Promise<AkumaObservation> {
  if (repo === undefined || observation.contractId !== undefined) return observation;
  const contractId = await contractFor(repo, observation.status.id);
  return contractId === undefined ? observation : { ...observation, contractId };
}

async function attachWaitContracts(repo: Repo | undefined, result: AkumaWaitResult): Promise<AkumaWaitResult> {
  return repo === undefined
    ? result
    : {
        ...result,
        observations: await Promise.all(result.observations.map((observation) => attachContract(repo, observation))),
      };
}

async function attachTellContract(repo: Repo | undefined, result: AkumaTellResult): Promise<AkumaTellResult> {
  return repo === undefined ? result : { ...result, observation: await attachContract(repo, result.observation) };
}

async function attachKillContracts(repo: Repo | undefined, result: AkumaKillResult): Promise<AkumaKillResult> {
  return repo === undefined
    ? result
    : {
        ...result,
        results: await Promise.all(result.results.map(async (entry) => ({
          ...entry,
          observation: await attachContract(repo, entry.observation),
        }))),
      };
}

function directAddress(values: Record<string, unknown>): AkumaAddressInput {
  return {
    path: values.path as WorldRoot,
    akuma: values.akuma as string,
    ...(values.repo === undefined ? {} : { repo: values.repo as Repo }),
  };
}

function setAddress(values: Record<string, unknown>): AkumaSetAddressInput {
  return {
    path: values.path as WorldRoot,
    akuma: values.akuma as readonly string[],
    ...(values.repo === undefined ? {} : { repo: values.repo as NonNullable<AkumaSetAddressInput["repo"]> }),
  };
}

export async function statusAkuma(input: AkumaAddressInput): Promise<AkumaObservation> {
  const addressed = await addressAkuma(input);
  return await observeAkuma(await source(addressed.path).of({ id: addressed.id }).status(), addressed.path, input.repo);
}

export async function waitAkuma(input: AkumaWaitInput): Promise<AkumaWaitResult> {
  const values = requireInput(input, "Keiyaku.wait input");
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "repo", "completion", "timeoutMs"].includes(key)) {
      throw new TypeError(`Keiyaku.wait input has unknown field: ${key}`);
    }
  }
  const addressed = await addressAkumaSet(setAddress(values));
  const completion = values.completion;
  if (addressed.ids.length > 1 && completion !== "any" && completion !== "all") {
    throw new TypeError("completion must be any or all when waiting for multiple Akuma");
  }
  if (completion !== undefined && completion !== "any" && completion !== "all") {
    throw new TypeError("completion must be any or all");
  }
  const selected = completion ?? "all";
  const timeoutMs = timeout(values.timeoutMs);
  const requests = injectedBodyRequests();
  if (requests !== null) {
    const outcome = await requestBodyWait({
      directory: requests,
      targets: addressed.ids,
      completion: selected,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return await attachWaitContracts(values.repo as Repo | undefined, upstreamResult<AkumaWaitResult>(outcome));
  }
  return await executeWaitAkuma({
    path: addressed.path,
    ids: addressed.ids,
    completion: selected,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(values.repo === undefined ? {} : { repo: values.repo as Repo }),
  });
}

export async function killAkuma(input: AkumaSetAddressInput): Promise<AkumaKillResult> {
  const addressed = await addressAkumaSet(input);
  const requests = injectedBodyRequests();
  if (requests !== null) {
    const outcome = await requestBodyKill({ directory: requests, targets: addressed.ids });
    return await attachKillContracts(input.repo, upstreamResult<AkumaKillResult>(outcome));
  }
  return await executeKillAkuma({
    path: addressed.path,
    ids: addressed.ids,
    ...(input.repo === undefined ? {} : { repo: input.repo }),
  });
}

export async function tellAkuma(input: AkumaTellInput): Promise<AkumaTellResult> {
  const values = requireInput(input, "Keiyaku.tell input");
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "body", "repo"].includes(key)) {
      throw new TypeError(`Keiyaku.tell input has unknown field: ${key}`);
    }
  }
  if (typeof values.body !== "string") throw new TypeError("body must be a string");
  const addressed = await addressAkuma(directAddress(values));
  const requests = injectedBodyRequests();
  if (requests !== null) {
    const outcome = await requestBodyTell({
      directory: requests,
      target: addressed.id,
      body: values.body,
    });
    return await attachTellContract(values.repo as Repo | undefined, upstreamResult<AkumaTellResult>(outcome));
  }
  return await executeTellAkuma({
    path: addressed.path,
    id: addressed.id,
    body: values.body,
    ...(values.repo === undefined ? {} : { repo: values.repo as Repo }),
  });
}

export async function interruptAkuma(input: AkumaInterruptInput): Promise<AkumaInterruptResult> {
  const values = requireInput(input, "Keiyaku.interrupt input");
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "body", "repo"].includes(key)) {
      throw new TypeError(`Keiyaku.interrupt input has unknown field: ${key}`);
    }
  }
  if (typeof values.body !== "string") throw new TypeError("body must be a string");
  const addressed = await addressAkuma(directAddress(values));
  const handle = source(addressed.path).of({ id: addressed.id });
  const receipt = await handle.interrupt(values.body);
  const observation = await observeAkuma(await handle.status(), addressed.path, values.repo as Repo | undefined);
  return { id: addressed.id, receipt, observation };
}

export async function historyAkuma(input: AkumaHistoryInput): Promise<AkumaHistoryResult> {
  const values = requireInput(input, "Keiyaku.history input");
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "before", "since", "limit", "last", "repo"].includes(key)) {
      throw new TypeError(`Keiyaku.history input has unknown field: ${key}`);
    }
  }
  if (values.last !== undefined && typeof values.last !== "boolean") throw new TypeError("last must be a boolean");
  const addressed = await addressAkuma(directAddress(values));
  const handle = source(addressed.path).of({ id: addressed.id });
  if (values.last === true) {
    const answer = await handle.lastAnswer();
    const contractId = await contractFor(values.repo as Repo | undefined, addressed.id);
    return answer.kind === "answer"
      ? { kind: "last", id: addressed.id, answer: answer.answer, ...(contractId === undefined ? {} : { contractId }) }
      : { kind: "no-answer", id: addressed.id, ...(contractId === undefined ? {} : { contractId }) };
  }
  const history = await handle.history({
    ...(values.before === undefined ? {} : { before: values.before as number }),
    ...(values.since === undefined ? {} : { since: values.since as number }),
    ...(values.limit === undefined ? {} : { limit: values.limit as number }),
  });
  const contractId = await contractFor(values.repo as Repo | undefined, addressed.id);
  return { kind: "history", id: addressed.id, history, ...(contractId === undefined ? {} : { contractId }) };
}
