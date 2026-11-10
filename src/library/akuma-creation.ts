/** @architectureCompositionRoot */
import { z } from "zod";
import { contractIdSchema } from "../git/identity.js";
import { tellResultSchema } from "../akuma/call-initial-tell.js";
import { akumaTextObservationSchema, publicWakeSchema, compactTellResult } from "../akuma/selection-observation.js";
import { akumaIdSchema } from "../akuma/identity.js";
import { forkFailureSchemas } from "../akuma/akuma-owner.js";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { decodeAkumaCaller, type AkumaCaller } from "../akuma/caller.js";
import {
  prepareAkumaCall,
  publishAkumaCall,
  type AdmittedAkumaCall,
  type InitialCallTell,
} from "../akuma/akuma-call.js";
import { discardPreparedCall } from "../akuma/publication.js";
import { AkumaOwner } from "../akuma/akuma-owner.js";
import type { BodyLauncher } from "../akuma/body-launch.js";
import {
  liveStatusObservationSchema,
  observeAdmittedAskAkuma,
  type AskObserver,
} from "../akuma/akuma-selection-execution.js";
import type { AkumaStatus } from "../akuma/akuma.js";
import type { TellResult } from "../akuma/body.js";
import { bareOption, canonicalBirthCwd } from "../akuma/call-input.js";
import { pathsForAkumaId, type AkumaId, type AkumaPaths } from "../akuma/identity.js";
import { moveAlias } from "../alias/index.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { publishDispatch, readDispatch } from "../dispatch/index.js";
import { akumaAliasSchema, parseAkumaAlias, type AkumaAlias } from "../identity/selector.js";
import { outcomePluginObserver, stderrPluginDiagnostic, withAkumaWaitDeferrals } from "../plugin/akuma-signals.js";
import type { Settings } from "../settings.js";
import { World, type WorldRoot } from "../world.js";
import { addressAkuma } from "./address.js";
import { requireInput } from "./input.js";
import type { Kei } from "./kei.js";
import { seatForKei } from "./kei.js";
import { scopeForRepo, type Repo } from "./repo.js";
import { withSpawnFailureReceipt } from "./outcome.js";

const integrationFailureSchema = z
  .strictObject({ kind: z.enum(["authority-corruption", "infrastructure"]), diagnostic: z.string() })
  .readonly();
type IntegrationFailure = z.output<typeof integrationFailureSchema>;
const dispatchFailure = z.union([
  z.strictObject({ kind: z.literal("conflict"), currentContractId: contractIdSchema }).readonly(),
  z.strictObject({ kind: z.literal("publication-failed"), diagnostic: z.string() }).readonly(),
  integrationFailureSchema,
]);
const dispatchFields = {
  dispatchFailure: dispatchFailure.exactOptional(),
  dispatchWarning: z.string().exactOptional(),
};
const publicationFields = {
  ...dispatchFields,
  alias: z
    .union([
      z.strictObject({ kind: z.literal("moved"), previousAkumaId: akumaIdSchema }).readonly(),
      integrationFailureSchema,
    ])
    .exactOptional(),
};
export const spawnWaitHeadSchema = z
  .strictObject({
    cwd: z.string(),
    ...publicationFields,
    contractId: contractIdSchema.exactOptional(),
    aliasName: akumaAliasSchema.exactOptional(),
  })
  .readonly();
export const spawnResultSchema = z
  .strictObject({
    akumaId: akumaIdSchema,
    ...publicationFields,
    tellId: z.string().exactOptional(),
    wake: publicWakeSchema.exactOptional(),
    input: akumaTextObservationSchema.exactOptional(),
    failure: integrationFailureSchema
      .unwrap()
      .extend({ attemptedTellId: z.string().exactOptional() })
      .readonly()
      .exactOptional(),
  })
  .readonly();
const parentFields = { parentAkumaId: akumaIdSchema.exactOptional() };
export const forkResultSchema = z.union([
  z
    .strictObject({
      kind: z.literal("forked"),
      childAkumaId: akumaIdSchema,
      ...parentFields,
      ...dispatchFields,
    })
    .readonly(),
  forkFailureSchemas.unsupported.unwrap().extend(parentFields).readonly(),
  forkFailureSchemas.unknownHistory.unwrap().extend(parentFields).readonly(),
  forkFailureSchemas.failed.unwrap().extend(parentFields).readonly(),
  forkFailureSchemas.upstream.unwrap().extend(parentFields).readonly(),
]);
export type SpawnWaitHead = z.output<typeof spawnWaitHeadSchema>;
export type SpawnResult = z.output<typeof spawnResultSchema>;
export type ForkResult = z.output<typeof forkResultSchema>;

export const spawnProgressSchema = z.union([
  z
    .strictObject({
      kind: z.literal("admitted"),
      tell: tellResultSchema,
      id: akumaIdSchema,
      head: spawnWaitHeadSchema,
    })
    .readonly(),
  z.strictObject({ kind: z.literal("live"), observation: liveStatusObservationSchema }).readonly(),
]);
export type SpawnProgress = z.output<typeof spawnProgressSchema>;

type SpawnWaitObserver = Readonly<{
  admitted?: (tell: TellResult, id: AkumaStatus["id"], head: SpawnWaitHead) => void | Promise<void>;
  observe?: AskObserver["observe"];
}>;

export type SpawnInput = Readonly<{
  akumaName: string;
  body?: string;
  cwd?: string;
  mode?: "wait" | "detach";
  timeoutMs?: number;
  home?: string;
  settings?: Settings;
  contract?: Kei;
  alias?: AkumaAlias;
  writableDirectories?: readonly string[];
  bare?: boolean;
  initiator?: string;
  caller?: AkumaCaller;
  signal?: AbortSignal;
  observe?: SpawnWaitObserver;
}>;

type CallExecution = Readonly<{ cwd: string }>;

export type ForkInput = Readonly<{
  akuma: string;
  at: string;
  bare?: boolean;
  repo?: Repo;
  caller?: AkumaCaller;
  initiator?: string;
}>;

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

function callBody(value: unknown): string | undefined {
  return value === undefined ? undefined : text(value, "body");
}

function validateCallBodyOptions(
  body: string | undefined,
  values: Record<string, unknown>,
  mode: "wait" | "detach",
): void {
  if (body === undefined && (mode === "wait" || values.timeoutMs !== undefined))
    throw new TypeError("wait and timeoutMs require body");
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
  const seat = seatForKei(contract);
  if (seat === null) throw new TypeError("contract must be a Kei");
  return seat;
}

function pluginDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 500 ? message : `${message.slice(0, 500)}...`;
}

async function recordPluginDiagnostic(paths: AkumaPaths, error: unknown, occurrence: string): Promise<void> {
  try {
    await appendFile(paths.log, `plugin ${occurrence} failed: ${pluginDiagnostic(error)}\n`);
  } catch {
    // Plugin diagnostic loss must not change an already admitted call.
  }
}

function callDiagnosticSink(
  paths: AkumaPaths,
  occurrence: string,
  reportDiagnostic?: (message: string) => void,
): (message: string) => void {
  return (message) => {
    void recordPluginDiagnostic(paths, message, occurrence);
    // Return the host's possible Promise for the plugin diagnostic isolation boundary.
    return reportDiagnostic?.(message);
  };
}

async function callDispatch(
  input: Parameters<typeof publishDispatch>[0],
): Promise<Pick<SpawnResult, "dispatchFailure" | "dispatchWarning">> {
  try {
    const published = await publishDispatch(input);
    if (published.kind === "dispatched") {
      const warning = published.seatClose?.map((lag) => lag.diagnostic).join("\n");
      return warning === undefined || warning.length === 0 ? {} : { dispatchWarning: warning };
    }
    const failure = published.failure;
    return {
      dispatchFailure:
        failure.kind === "conflict" ? { kind: "conflict", currentContractId: failure.current.contractId } : failure,
    };
  } catch (error) {
    return { dispatchFailure: integrationFailure(error) };
  }
}

async function forkDispatch(
  repository: Parameters<typeof readDispatch>[0],
  parent: AkumaId,
  child: AkumaId,
): Promise<Pick<SpawnResult, "dispatchFailure" | "dispatchWarning">> {
  try {
    const association = await readDispatch(repository, parent);
    return association === null
      ? {}
      : await callDispatch({ repository, akumaId: child, contractId: association.contractId });
  } catch (error) {
    return { dispatchFailure: integrationFailure(error) };
  }
}

async function resolveCallExecution(input: Readonly<{ cwd?: string }>): Promise<CallExecution | undefined> {
  return input.cwd === undefined ? undefined : { cwd: await canonicalBirthCwd(input.cwd) };
}

async function callAlias(
  path: WorldRoot,
  alias: AkumaAlias | undefined,
  dispatchFailure: SpawnResult["dispatchFailure"],
  akuma: AkumaId,
): Promise<Pick<SpawnWaitHead, "alias">> {
  if (alias === undefined || dispatchFailure !== undefined) return {};
  try {
    const moved = await moveAlias({ world: path, alias, akumaId: akuma });
    return moved.previous === null || moved.previous === akuma
      ? {}
      : {
          alias: { kind: "moved", previousAkumaId: moved.previous },
        };
  } catch (error) {
    return { alias: integrationFailure(error) };
  }
}

const CALL_INPUT_KEYS = [
  "path",
  "akumaName",
  "body",
  "cwd",
  "mode",
  "timeoutMs",
  "home",
  "settings",
  "contract",
  "alias",
  "writableDirectories",
  "bare",
  "initiator",
  "caller",
  "signal",
  "observe",
] as const;

type ParsedCallInput = Readonly<{
  path: WorldRoot;
  akumaName: string;
  cwd?: string;
  mode: "wait" | "detach";
  timeoutMs: number;
  signal?: AbortSignal;
  home?: string;
  settings?: Settings;
  alias?: AkumaAlias;
  writableDirectories?: readonly string[];
  bare?: boolean;
  seat: ReturnType<typeof callSeat>;
  caller?: AkumaCaller;
  initiator?: string;
  initialTell?: InitialCallTell;
  observe?: SpawnWaitObserver;
}>;

async function parseCallInput(input: SpawnInput & Readonly<{ path: WorldRoot }>): Promise<ParsedCallInput> {
  const values = requireInput(input, "Akumas.spawn input");
  onlyKeys(values, CALL_INPUT_KEYS, "Akumas.spawn input");
  const path = await World.prove(nonblank(values.path, "path"));
  const akumaName = nonblank(values.akumaName, "akumaName");
  const body = callBody(values.body);
  const initiator = values.initiator === undefined ? undefined : text(values.initiator, "initiator");
  const caller = decodeAkumaCaller(values.caller);
  const bare = bareOption(values.bare);
  const cwd = values.cwd === undefined ? undefined : nonblank(values.cwd, "cwd");
  const mode = callMode(values.mode);
  validateCallBodyOptions(body, values, mode);
  const timeoutMs = callTimeout(values.timeoutMs, mode);
  const signal = callSignal(values.signal);
  const home = homeOption(values.home);
  const settings = settingsOption(values.settings);
  const alias: AkumaAlias | undefined =
    values.alias === undefined ? undefined : parseAkumaAlias(nonblank(values.alias, "alias"));
  const seat = callSeat(values.contract);
  const observe = values.observe as AskObserver | undefined;
  const initialTell =
    body === undefined
      ? undefined
      : {
          tellId: randomUUID(),
          body,
          ...(initiator === undefined ? {} : { initiator }),
        };
  return {
    path,
    akumaName,
    ...(cwd === undefined ? {} : { cwd }),
    mode,
    timeoutMs,
    ...(signal === undefined ? {} : { signal }),
    ...(home === undefined ? {} : { home }),
    ...(settings === undefined ? {} : { settings }),
    ...(alias === undefined ? {} : { alias }),
    ...(values.writableDirectories === undefined
      ? {}
      : { writableDirectories: values.writableDirectories as readonly string[] }),
    ...(bare === undefined ? {} : { bare }),
    seat,
    ...(caller === undefined ? {} : { caller }),
    ...(initiator === undefined ? {} : { initiator }),
    ...(initialTell === undefined ? {} : { initialTell }),
    ...(observe === undefined ? {} : { observe }),
  };
}

function callConfiguration(input: ParsedCallInput) {
  return {
    ...(input.home === undefined ? {} : { home: input.home }),
    ...(input.settings === undefined ? {} : { settings: input.settings }),
  };
}

function callAdmissionInput(input: ParsedCallInput, execution: CallExecution | undefined) {
  return {
    akumaName: input.akumaName,
    ...(input.caller === undefined ? {} : { caller: input.caller }),
    ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
    ...(input.initialTell === undefined ? {} : { initialTell: input.initialTell }),
    ...(input.writableDirectories === undefined ? {} : { writableDirectories: input.writableDirectories }),
    ...(input.bare === undefined ? {} : { bare: input.bare }),
    ...(execution === undefined ? {} : { cwd: execution.cwd }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

function failedCall(result: SpawnResult, error: unknown, attemptedTellId?: string): SpawnResult {
  return {
    ...result,
    failure: {
      ...integrationFailure(error),
      ...(attemptedTellId === undefined ? {} : { attemptedTellId }),
    },
  };
}

async function observeCall(
  input: Readonly<{
    path: WorldRoot;
    akuma: AkumaId;
    result: SpawnResult;
    head: SpawnWaitHead;
    initialTell: NonNullable<ParsedCallInput["initialTell"]>;
    receipt: TellResult;
    timeoutMs: number;
    settings?: Settings;
    signal?: AbortSignal;
    observe?: SpawnWaitObserver;
  }>,
  reportDiagnostic?: (message: string) => void,
): Promise<SpawnResult> {
  const onObserve: AskObserver = {
    admitted: async (receipt, id) => {
      await input.observe?.admitted?.(receipt, id, input.head);
    },
    ...(input.observe?.observe === undefined ? {} : { observe: input.observe.observe }),
  };
  try {
    const observed = await observeAdmittedAskAkuma({
      path: input.path,
      id: input.akuma,
      tellId: input.initialTell.tellId,
      timeoutMs: input.timeoutMs,
      receipt: input.receipt,
      outcomeObserved: outcomePluginObserver({
        world: input.path,
        ...(input.settings === undefined ? {} : { settings: input.settings }),
        reportDiagnostic: callDiagnosticSink(
          pathsForAkumaId(input.path, input.akuma),
          "outcome observation",
          reportDiagnostic,
        ),
      }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      onObserve,
    });
    const { akumaId: _id, tellId: _tell, wake: _wake, interrupt: _interrupt, ...outcome } = observed;
    return {
      ...input.result,
      input: outcome.kind === "invalid-output" ? { kind: "failed", diagnostic: outcome.diagnostic } : outcome,
    };
  } catch (error) {
    if (input.signal?.aborted) throw withSpawnFailureReceipt(error, input.result);
    return failedCall(input.result, error);
  }
}

/** Preserve a native failure identity; only an unknown shape becomes a fresh Error. */
function asError(failure: unknown): Error {
  return failure instanceof Error ? failure : new Error(failure === undefined ? "spawn failed" : String(failure));
}

/** Settle one admitted birth: detach, observe, or report the exact initial-Tell failure. */
async function settleCall(
  parsed: ParsedCallInput,
  admitted: AdmittedAkumaCall,
  head: SpawnWaitHead,
  reportDiagnostic?: (message: string) => void,
): Promise<SpawnResult> {
  const receipt = admitted.tell;
  const { cwd: _cwd, contractId: _contract, aliasName: _alias, ...publication } = head;
  const compact = receipt === undefined ? undefined : compactTellResult(admitted.id, receipt);
  const result: SpawnResult = {
    akumaId: admitted.id,
    ...publication,
    ...(compact === undefined
      ? {}
      : { tellId: compact.tellId, ...(compact.wake === undefined ? {} : { wake: compact.wake }) }),
  };
  if (parsed.initialTell === undefined) {
    // A durable child does not turn a later native birth failure into success.
    if (admitted.failure !== undefined) throw withSpawnFailureReceipt(admitted.failure, result);
    return result;
  }
  if (receipt === undefined) {
    if (parsed.signal?.aborted === true && admitted.failure !== undefined)
      throw withSpawnFailureReceipt(parsed.signal.reason, result);
    const failure =
      admitted.failure === undefined
        ? new Error(`Akuma ${admitted.id} returned no exact initial Tell receipt`)
        : asError(admitted.failure);
    return failedCall(result, failure, parsed.initialTell.tellId);
  }
  if (parsed.mode === "detach") return result;
  return await observeCall(
    {
      path: parsed.path,
      akuma: admitted.id,
      result,
      head,
      initialTell: parsed.initialTell,
      receipt,
      timeoutMs: parsed.timeoutMs,
      ...(parsed.settings === undefined ? {} : { settings: parsed.settings }),
      ...(parsed.signal === undefined ? {} : { signal: parsed.signal }),
      ...(parsed.observe === undefined ? {} : { observe: parsed.observe }),
    },
    reportDiagnostic,
  );
}

export async function callAkumas(
  input: SpawnInput & Readonly<{ path: WorldRoot }>,
  spawn: BodyLauncher,
  reportDiagnostic?: (message: string) => void,
): Promise<SpawnResult> {
  const parsed = await parseCallInput(input);
  const selectedExecution = await resolveCallExecution(parsed.cwd === undefined ? {} : { cwd: parsed.cwd });
  const seat = parsed.seat;
  const prepared = await prepareAkumaCall(
    parsed.path,
    callConfiguration(parsed),
    {
      ...callAdmissionInput(parsed, selectedExecution),
      ...(seat === undefined ? {} : { contractId: seat.id }),
    },
    selectedExecution === undefined ? {} : { cwdCanonical: true },
    spawn,
  );
  let publishing = false;
  const run = async (): Promise<SpawnResult> => {
    publishing = true;
    const admitted = await publishAkumaCall(prepared);
    const dispatch =
      seat === undefined
        ? {}
        : await callDispatch({
            repository: seat.scope,
            akumaId: admitted.id,
            contractId: seat.id,
          });
    const alias = await callAlias(parsed.path, parsed.alias, dispatch.dispatchFailure, admitted.id);
    const head: SpawnWaitHead = {
      cwd: admitted.cwd,
      ...dispatch,
      ...alias,
      ...(seat === undefined || dispatch.dispatchFailure !== undefined ? {} : { contractId: seat.id }),
      ...(parsed.alias === undefined ||
      dispatch.dispatchFailure !== undefined ||
      (alias.alias !== undefined && alias.alias.kind !== "moved")
        ? {}
        : { aliasName: parsed.alias }),
    };
    return await settleCall(parsed, admitted, head, reportDiagnostic);
  };
  try {
    return parsed.mode === "wait" && parsed.initialTell !== undefined
      ? await withAkumaWaitDeferrals(
          {
            world: parsed.path,
            ...(parsed.settings === undefined ? {} : { settings: parsed.settings }),
            reportDiagnostic: reportDiagnostic ?? stderrPluginDiagnostic,
          },
          { akumaIds: [prepared.publication.allocated.id] },
          parsed.signal,
          run,
        )
      : await run();
  } catch (error) {
    if (!publishing) await discardPreparedCall(prepared.publication, error).catch(() => {});
    throw error;
  }
}

export async function forkAkumas(
  input: ForkInput & Readonly<{ path: WorldRoot }>,
  spawn: BodyLauncher,
): Promise<ForkResult> {
  const values = requireInput(input, "Akumas.fork input");
  onlyKeys(values, ["path", "akuma", "at", "bare", "repo", "caller", "initiator"], "Akumas.fork input");
  const bare = bareOption(values.bare);
  const caller = decodeAkumaCaller(values.caller);
  const initiator = values.initiator === undefined ? undefined : text(values.initiator, "initiator");
  const at = nonblank(values.at, "at");
  const selector = nonblank(values.akuma, "akuma");
  const { path, id: akuma } = await addressAkuma({ path: values.path, akuma: selector });
  const parent = selector === akuma ? {} : { parentAkumaId: akuma };
  const repository = values.repo === undefined ? undefined : scopeForRepo(values.repo);

  const receipt = await new AkumaOwner(akuma, path).fork(
    {
      at,
      ...(bare === undefined ? {} : { bare }),
      ...(caller === undefined ? {} : { caller }),
      ...(initiator === undefined ? {} : { initiator }),
    },
    spawn,
  );
  if (receipt.kind !== "forked") return { ...receipt, ...parent };
  const dispatch = repository === undefined ? {} : await forkDispatch(repository, akuma, receipt.childAkumaId);
  return {
    ...receipt,
    ...parent,
    ...dispatch,
  };
}
