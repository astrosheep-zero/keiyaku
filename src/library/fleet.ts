/* eslint-disable max-lines -- Fleet owns one coherent public operation surface. */
import {
  Akuma,
  AkumaNotBornError,
  akumaIdSchema,
  defaultWaitComplete,
  type ActivityHistory,
  type OutcomeRow,
  type AkumaStatus,
  type InterruptReceipt,
  type KillEvidence,
} from "../akuma/index.js";
import { readBudgetedStatus, tellAkumaWithId } from "../akuma/akuma.js";
import {
  executionChannel,
  localExecutionContext,
  requestBodyCommand,
  type ExecutionContext,
} from "../akuma/requests.js";
import { eraseRequestCommand, type ErasedRequestCommand, type RequestCommand } from "../akuma/request-wire.js";
import { readDispatch } from "../dispatch/index.js";
import { observeTaskBoard } from "../task/operations.js";
import type { WorldRoot } from "../world.js";
import { addressAkuma, addressAkumaSet, type AkumaAddressInput, type AkumaSetAddressInput } from "./address.js";
import { requireInput } from "./input.js";
import {
  isKillResult,
  isTellResult,
  isWaitResult,
  fleetResultSchemas,
  type AkumaKillResult,
  type AkumaObservation,
  type AkumaObservationStage,
  type AkumaTellResult,
  type AkumaUnobserved,
  type AkumaWaitResult,
  type CreatedTaskObservation,
  type DispatchAssociation,
  parseAkumaObservation,
  parseCreatedTaskObservation,
} from "./fleet-result.js";
export { isKillResult, isTellResult, isWaitResult } from "./fleet-result.js";
export type {
  AkumaKillResult,
  AkumaObservation,
  AkumaObservationStage,
  AkumaTellResult,
  AkumaUnobserved,
  AkumaWaitResult,
  CreatedTaskObservation,
  DispatchAssociation,
} from "./fleet-result.js";
import { scopeForRepo, type Repo } from "./repo.js";
import { parsePublicHistoryId } from "../akuma/identity.js";
import { z } from "zod";

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

const NO_DISPATCH: DispatchAssociation = { kind: "none" };

async function dispatchAssociation(repo: Repo | undefined, id: AkumaStatus["id"]): Promise<DispatchAssociation> {
  if (repo === undefined) return NO_DISPATCH;
  try {
    const dispatch = await readDispatch(scopeForRepo(repo), id);
    return dispatch === null ? NO_DISPATCH : { kind: "associated", contractId: dispatch.contractId };
  } catch (error) {
    return { kind: "failed", diagnostic: observationDiagnostic(error) };
  }
}

function createdTaskDiagnostic(error: unknown): string {
  return observationDiagnostic(error);
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
  return statuses.map((status) =>
    parseCreatedTaskObservation({ kind: "present", rows: board.selectCreatedBy(status.id) }),
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
const POLL_MS = 100;

type WaitRound = Readonly<{
  statuses: readonly AkumaStatus[];
  unobserved: readonly AkumaUnobserved[];
}>;

async function observeWaitRound(
  path: WorldRoot,
  ids: readonly AkumaStatus["id"][],
  signal?: AbortSignal,
): Promise<WaitRound> {
  signal?.throwIfAborted();
  if (ids.length <= 1) {
    return {
      statuses: await Promise.all(ids.map(async (id) => await source(path).of({ id }).status())),
      unobserved: [],
    };
  }
  let remaining = SHARED_ORDINARY_BUDGET;
  const statuses: AkumaStatus[] = [];
  const unobserved: AkumaUnobserved[] = [];
  for (const id of ids) {
    signal?.throwIfAborted();
    try {
      const observed = await readBudgetedStatus(path, id, { aperture: "monitoring", ordinaryBudget: remaining });
      statuses.push(observed.status);
      remaining -= observed.ordinarySelected;
    } catch (error) {
      if (error instanceof AkumaNotBornError) throw error;
      unobserved.push({ id, diagnostic: observationDiagnostic(error) });
    }
  }
  return { statuses, unobserved };
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
    const round = await observeWaitRound(input.path, input.ids, input.signal);
    const settled = round.statuses.map(defaultWaitComplete);
    const completed =
      round.statuses.length > 0 &&
      (input.completion === "any" ? settled.some(Boolean) : round.unobserved.length === 0 && settled.every(Boolean));
    if (completed || (deadline !== undefined && performance.now() >= deadline)) {
      return fleetResultSchemas.wait.parse({
        completion: input.completion,
        observations: await observeAkumaSet(round.statuses, input.path, input.repo),
        unobserved: round.unobserved,
      });
    }
    await delay(
      deadline === undefined ? POLL_MS : Math.min(POLL_MS, Math.max(0, deadline - performance.now())),
      input.signal,
    );
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
  const tell =
    input.tellId === undefined
      ? await handle.tell(input.body)
      : await tellAkumaWithId({
          worldPath: input.path,
          id: input.id,
          body: input.body,
          tellId: input.tellId,
          ...(input.recordedAt === undefined ? {} : { recordedAt: input.recordedAt }),
        });
  input.signal?.throwIfAborted();
  return fleetResultSchemas.tell.parse({
    akuma: input.id,
    tell,
  });
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
  return fleetResultSchemas.kill.parse({
    results: input.ids.map((id, index) => ({ id, evidence: evidence[index]! })),
  });
}

function forwardedFleetCommandResult(
  response: Awaited<ReturnType<typeof requestBodyCommand<FleetRequest, unknown, FleetService>>>,
  action: "akuma.wait",
): AkumaWaitResult;
function forwardedFleetCommandResult(
  response: Awaited<ReturnType<typeof requestBodyCommand<FleetRequest, unknown, FleetService>>>,
  action: "akuma.tell",
): AkumaTellResult;
function forwardedFleetCommandResult(
  response: Awaited<ReturnType<typeof requestBodyCommand<FleetRequest, unknown, FleetService>>>,
  action: "akuma.kill",
): AkumaKillResult;
function forwardedFleetCommandResult(
  response: Awaited<ReturnType<typeof requestBodyCommand<FleetRequest, unknown, FleetService>>>,
  action: FleetRequest["action"],
): AkumaWaitResult | AkumaTellResult | AkumaKillResult {
  if (response.kind === "returned") {
    if (action === "akuma.wait" && isWaitResult(response.result)) return response.result;
    if (action === "akuma.tell" && isTellResult(response.result)) return response.result;
    if (action === "akuma.kill" && isKillResult(response.result)) return response.result;
    throw new Error(`transport integrity: request Fleet ${action} returned an invalid live result`);
  }
  throw new Error("Akuma body request terminal Fleet reference cannot reproduce an expired live result");
}

const nonblankTextSchema = z.string().refine((value) => value.trim() !== "");
const fleetTargetsSchema = z
  .array(akumaIdSchema)
  .min(1)
  .superRefine((ids, context) => {
    if (ids.some((id, index) => index > 0 && ids[index - 1]! >= id))
      context.addIssue({ code: "custom", message: "expected a strictly ordered target set" });
  });
const waitRequestSchema = z
  .object({
    targets: fleetTargetsSchema,
    completion: z.enum(["any", "all"]),
    timeoutMs: z.number().int().nonnegative().optional(),
  })
  .strict()
  .transform(({ timeoutMs, ...request }) => ({
    action: "akuma.wait" as const,
    ...request,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }));
const tellRequestSchema = z
  .object({ target: akumaIdSchema, body: z.string() })
  .strict()
  .transform((request) => ({ action: "akuma.tell" as const, ...request }));
const killRequestSchema = z
  .object({ targets: fleetTargetsSchema })
  .strict()
  .transform((request) => ({ action: "akuma.kill" as const, ...request }));
const waitServiceSchema = z.object({ action: z.literal("akuma.wait") }).strict();
const tellServiceSchema = z
  .object({ action: z.literal("akuma.tell"), target: akumaIdSchema, tellId: nonblankTextSchema })
  .strict();
const killServiceSchema = z
  .object({
    action: z.literal("akuma.kill"),
    results: z.array(z.object({ id: akumaIdSchema, evidence: fleetResultSchemas.killEvidence }).strict()),
  })
  .strict();
type FleetRequest =
  | (Omit<z.infer<typeof waitRequestSchema>, "targets"> & Readonly<{ targets: readonly AkumaStatus["id"][] }>)
  | z.infer<typeof tellRequestSchema>
  | (Omit<z.infer<typeof killRequestSchema>, "targets"> & Readonly<{ targets: readonly AkumaStatus["id"][] }>);
type FleetService =
  | z.infer<typeof waitServiceSchema>
  | z.infer<typeof tellServiceSchema>
  | (Omit<z.infer<typeof killServiceSchema>, "results"> &
      Readonly<{ results: readonly Readonly<{ id: AkumaStatus["id"]; evidence: KillEvidence }>[] }>);

export type FleetRequestPort = Readonly<{
  wait(
    input: Readonly<{
      targets: readonly AkumaStatus["id"][];
      completion: "any" | "all";
      timeoutMs?: number;
      signal: AbortSignal;
    }>,
  ): Promise<AkumaWaitResult>;
  tell(
    input: Readonly<{
      target: AkumaStatus["id"];
      body: string;
      tellId: string;
      recordedAt: string;
      signal: AbortSignal;
    }>,
  ): Promise<AkumaTellResult>;
  kill(
    input: Readonly<{ targets: readonly AkumaStatus["id"][]; signal: AbortSignal }>,
  ): Promise<
    | AkumaKillResult
    | Readonly<{ result: unknown; service: readonly Readonly<{ id: AkumaStatus["id"]; evidence: KillEvidence }>[] }>
  >;
}>;
type FleetExecutionContext = Readonly<{
  id: string;
  admittedAt: string;
  signal: AbortSignal;
  upstream: FleetRequestPort;
}>;

function decodeFleetExecutionContext(value: unknown): FleetExecutionContext {
  const context = fleetPayload(value);
  if (
    context === null ||
    typeof context.id !== "string" ||
    context.id.trim() === "" ||
    typeof context.admittedAt !== "string" ||
    !isAbortSignal(context.signal) ||
    !isFleetRequestPort(context.upstream)
  )
    throw new Error("invalid Fleet execution context");
  return {
    id: context.id,
    admittedAt: context.admittedAt,
    signal: context.signal,
    upstream: context.upstream,
  };
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { throwIfAborted?: unknown }).throwIfAborted === "function"
  );
}

function isFleetRequestPort(value: unknown): value is FleetRequestPort {
  const port = fleetPayload(value);
  return (
    port !== null &&
    typeof port.wait === "function" &&
    typeof port.tell === "function" &&
    typeof port.kill === "function"
  );
}

function fleetPayload(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function decodeFleetRequest(action: FleetRequest["action"], value: unknown): FleetRequest | null {
  const schema =
    action === "akuma.wait" ? waitRequestSchema : action === "akuma.tell" ? tellRequestSchema : killRequestSchema;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function decodeFleetService(action: FleetRequest["action"], value: unknown): FleetService {
  const schema =
    action === "akuma.wait" ? waitServiceSchema : action === "akuma.tell" ? tellServiceSchema : killServiceSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("malformed stored Fleet service evidence");
  return parsed.data;
}

/** Fleet owns its Body Request payload, live result, and durable service codecs. */
export function fleetRequestCommand(
  action: FleetRequest["action"],
): RequestCommand<FleetRequest, unknown, FleetService, FleetService, FleetExecutionContext> {
  return {
    action,
    encodeRequest: (request) => {
      const { action: _action, ...payload } = request;
      return payload;
    },
    decodeRequest: (payload) => decodeFleetRequest(action, payload),
    encodeResult: (result) => result,
    decodeResult: (result) => {
      const schema =
        action === "akuma.wait"
          ? fleetResultSchemas.wait
          : action === "akuma.tell"
            ? fleetResultSchemas.tell
            : fleetResultSchemas.kill;
      const parsed = schema.safeParse(result);
      if (!parsed.success) throw new Error(`Akuma body request returned an invalid live result for ${action}`);
      return parsed.data;
    },
    encodeService: (service) => decodeFleetService(action, service),
    decodeService: (service) => decodeFleetService(action, service),
    projectService: (service) => decodeFleetService(action, service),
    decodeReference: (reference) => decodeFleetService(action, reference),
    isPermitted: (allowed) => action === "akuma.wait" || allowed.includes(action),
    decodeExecutionContext: decodeFleetExecutionContext,
    execute: async (request, context) => {
      if (request.action === "akuma.wait") {
        return {
          result: await context.upstream.wait({ ...request, signal: context.signal }),
          service: { action: request.action },
        };
      }
      if (request.action === "akuma.tell") {
        return {
          result: await context.upstream.tell({
            target: request.target,
            body: request.body,
            tellId: context.id,
            recordedAt: context.admittedAt,
            signal: context.signal,
          }),
          service: { action: request.action, target: request.target, tellId: context.id },
        };
      }
      const result = await context.upstream.kill({ targets: request.targets, signal: context.signal });
      if ("result" in result)
        return { result: result.result, service: { action: request.action, results: result.service } };
      return {
        result,
        service: { action: request.action, results: result.results.map(({ id, evidence }) => ({ id, evidence })) },
      };
    },
  };
}

export function fleetRequestCommands(): Readonly<
  Record<"akuma.wait" | "akuma.tell" | "akuma.kill", ErasedRequestCommand>
> {
  return {
    "akuma.wait": eraseRequestCommand(fleetRequestCommand("akuma.wait")),
    "akuma.tell": eraseRequestCommand(fleetRequestCommand("akuma.tell")),
    "akuma.kill": eraseRequestCommand(fleetRequestCommand("akuma.kill")),
  };
}

function needsDispatchAttach(association: DispatchAssociation): boolean {
  return association.kind === "none";
}

async function attachObservationContract(
  repo: Repo | undefined,
  observation: AkumaObservation,
): Promise<AkumaObservation> {
  if (repo === undefined || !needsDispatchAttach(observation.contract)) return observation;
  return { ...observation, contract: await dispatchAssociation(repo, observation.status.id) };
}

async function attachWaitContracts(repo: Repo | undefined, result: AkumaWaitResult): Promise<AkumaWaitResult> {
  if (repo === undefined) return result;
  return fleetResultSchemas.wait.parse({
    ...result,
    observations: await Promise.all(
      result.observations.map((observation) => attachObservationContract(repo, observation)),
    ),
  });
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
  if (channel.kind === "body-request") {
    const response = await requestBodyCommand({
      directory: channel.directory,
      command: fleetRequestCommand("akuma.wait"),
      value: {
        action: "akuma.wait",
        targets: addressed.ids,
        completion: selected,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      },
    });
    return await attachWaitContracts(
      values.repo as Repo | undefined,
      forwardedFleetCommandResult(response, "akuma.wait"),
    );
  }
  return await executeWaitAkuma({
    path: addressed.path,
    ids: addressed.ids,
    completion: selected,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(values.repo === undefined ? {} : { repo: values.repo as Repo }),
  });
}

export async function killAkuma(
  input: AkumaSetAddressInput,
  execution: ExecutionContext = localExecutionContext(),
): Promise<AkumaKillResult> {
  const addressed = await addressAkumaSet(input);
  const channel = executionChannel(execution);
  if (channel.kind === "body-request") {
    const response = await requestBodyCommand({
      directory: channel.directory,
      command: fleetRequestCommand("akuma.kill"),
      value: { action: "akuma.kill", targets: addressed.ids },
    });
    return forwardedFleetCommandResult(response, "akuma.kill");
  }
  return await executeKillAkuma({
    path: addressed.path,
    ids: addressed.ids,
    ...(input.repo === undefined ? {} : { repo: input.repo }),
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
    const response = await requestBodyCommand({
      directory: channel.directory,
      command: fleetRequestCommand("akuma.tell"),
      value: { action: "akuma.tell", target: addressed.id, body: values.body },
    });
    return forwardedFleetCommandResult(response, "akuma.tell");
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
