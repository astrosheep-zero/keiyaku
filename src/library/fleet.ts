import {
  Akuma,
  AkumaNotBornError,
  type ActivityHistory,
  type OutcomeRow,
  type AkumaStatus,
  type InterruptReceipt,
} from "../akuma/index.js";
import { readBudgetedStatus } from "../akuma/akuma.js";
import { executionChannel, localExecutionContext, type ExecutionContext } from "../akuma/requests.js";
import {
  requestForwardedFleetKill,
  requestForwardedFleetTell,
  requestForwardedFleetWait,
} from "../akuma/fleet-request.js";
import { executeKillAkuma, executeTellAkuma, executeWaitAkuma } from "../akuma/fleet-execution.js";
import { observeDispatchAssociation, type DispatchAssociation } from "../dispatch/index.js";
import {
  observeCreatedTaskObservations,
  type CreatedTaskObservation,
} from "../task/created-observation.js";
import type { WorldRoot } from "../world.js";
import { addressAkuma, addressAkumaSet, type AkumaAddressInput, type AkumaSetAddressInput } from "./address.js";
import { requireInput } from "./input.js";
import {
  fleetResultSchemas,
  parseAkumaObservation,
  type AkumaKillResult,
  type AkumaObservation,
  type AkumaObservationStage,
  type AkumaTellResult,
  type AkumaWaitResult,
} from "../akuma/fleet-observation.js";
import { scopeForRepo, type Repo } from "./repo.js";
import { parsePublicHistoryId } from "../akuma/identity.js";

export type AkumaWaitInput = AkumaSetAddressInput &
  Readonly<{
    completion?: "any" | "all";
    timeoutMs?: number;
  }>;

export type AkumaTellInput = AkumaAddressInput & Readonly<{ body: string }>;
export type { TellResult, TellWake } from "../akuma/index.js";
export type AkumaInterruptInput = AkumaAddressInput & Readonly<{ body: string }>;
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

function source(path: WorldRoot): Akuma {
  return Akuma.of(path);
}

function observationDiagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function dispatchAssociation(repo: Repo | undefined, id: AkumaStatus["id"]): Promise<DispatchAssociation> {
  return await observeDispatchAssociation(repo === undefined ? undefined : scopeForRepo(repo), id);
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
  return await Promise.all(
    statuses.map(async (status, index) =>
      parseAkumaObservation({
        status,
        contract: await dispatchAssociation(repo, status.id),
        createdTasks: created[index]!,
      }),
    ),
  );
}

function timeout(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError("timeoutMs must be a nonnegative finite number");
  }
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
  return fleetResultSchemas.wait.parse({
    ...result,
    observations: await Promise.all(
      result.observations.map(async (observation, index) =>
        parseAkumaObservation({
          status: observation.status,
          contract: await dispatchAssociation(repo, observation.status.id),
          createdTasks: created[index]!,
        }),
      ),
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
  return await observeAkuma(await source(addressed.path).of({ id: addressed.id }).status(), addressed.path, input.repo);
}

export async function waitAkuma(
  input: AkumaWaitInput,
  execution: ExecutionContext = localExecutionContext(),
): Promise<AkumaWaitResult> {
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
  const channel = executionChannel(execution);
  const repo = values.repo as Repo | undefined;
  if (channel.kind === "body-request") {
    return await attachWaitAssociations(
      addressed.path,
      repo,
      await requestForwardedFleetWait({
        directory: channel.directory,
        targets: addressed.ids,
        completion: selected,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }),
    );
  }
  return await attachWaitAssociations(
    addressed.path,
    repo,
    await executeWaitAkuma({
      path: addressed.path,
      ids: addressed.ids,
      completion: selected,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }),
  );
}

export async function killAkuma(
  input: AkumaSetAddressInput,
  execution: ExecutionContext = localExecutionContext(),
): Promise<AkumaKillResult> {
  const addressed = await addressAkumaSet(input);
  const channel = executionChannel(execution);
  if (channel.kind === "body-request") {
    return await requestForwardedFleetKill({
      directory: channel.directory,
      targets: addressed.ids,
    });
  }
  return await executeKillAkuma({
    path: addressed.path,
    ids: addressed.ids,
  });
}

export async function tellAkuma(
  input: AkumaTellInput,
  execution: ExecutionContext = localExecutionContext(),
): Promise<AkumaTellResult> {
  const values = requireInput(input, "Keiyaku.tell input");
  for (const key of Object.keys(values)) {
    if (!["path", "akuma", "body", "repo"].includes(key)) {
      throw new TypeError(`Keiyaku.tell input has unknown field: ${key}`);
    }
  }
  if (typeof values.body !== "string") throw new TypeError("body must be a string");
  const addressed = await addressAkuma(directAddress(values));
  const channel = executionChannel(execution);
  if (channel.kind === "body-request") {
    return await requestForwardedFleetTell({
      directory: channel.directory,
      target: addressed.id,
      body: values.body,
    });
  }
  return await executeTellAkuma({
    path: addressed.path,
    id: addressed.id,
    body: values.body,
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
  const handle = source(addressed.path).of({ id: addressed.id });
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
}
