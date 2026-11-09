/** @architectureCompositionRoot */
import { z } from "zod";
import { privateStateSeatCloseLagSchema } from "../git/private-state-seat.js";
import { aliasBindingSchema } from "../alias/index.js";
import { dispatchSchema, dispatchFailureSchema } from "../dispatch/index.js";
import { tellResultSchema } from "../akuma/call-initial-tell.js";
import { akumaAskObservationSchema } from "../akuma/selection-observation.js";
import { akumaIdSchema } from "../akuma/identity.js";
import { forkFailureSchemas } from "../akuma/akuma-owner.js";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { decodeAkumaCaller, type AkumaCaller } from "../akuma/caller.js";
import { prepareAkumaCall, publishAkumaCall, type InitialCallTell } from "../akuma/akuma-call.js";
import { discardPreparedCall } from "../akuma/publication.js";
import { AkumaOwner, type ForkReceipt } from "../akuma/akuma-owner.js";
import type { BodyLauncher } from "../akuma/body-launch.js";
import {
  decodeAskObservation,
  liveStatusObservationSchema,
  observeAdmittedAskAkuma,
  type AskObserver,
} from "../akuma/akuma-selection-execution.js";
import type { AkumaStatus } from "../akuma/akuma.js";
import type { TellResult } from "../akuma/body.js";
import { bareOption, canonicalBirthCwd } from "../akuma/call-input.js";
import { pathsForAkumaId, type AkumaId, type AkumaPaths } from "../akuma/identity.js";
import { schemaJsonText, type Schema } from "../akuma/schema.js";
import type { AkumaAskResult } from "../akuma/selection-observation.js";
import { moveAlias, type AliasBinding } from "../alias/index.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { publishDispatch, readDispatch, type Dispatch, type DispatchFailure } from "../dispatch/index.js";
import type { PrivateStateSeatCloseLag } from "../git/private-state-seat.js";
import { parseAkumaAlias, type AkumaAlias } from "../identity/selector.js";
import { outcomePluginObserver, stderrPluginDiagnostic, withAkumaWaitDeferrals } from "../plugin/akuma-signals.js";
import type { Settings } from "../settings.js";
import { World, type WorldRoot } from "../world.js";
import { addressAkuma } from "./address.js";
import { requireInput } from "./input.js";
import type { Kei } from "./kei.js";
import { seatForKei } from "./kei.js";
import { scopeForRepo, type Repo } from "./repo.js";

type IntegrationFailure = Readonly<{
  kind: "authority-corruption" | "infrastructure";
  diagnostic: string;
}>;

const integrationFailureSchema = z
  .strictObject({ kind: z.enum(["authority-corruption", "infrastructure"]), diagnostic: z.string() })
  .readonly();
export const dispatchStageSchema = z.union([
  z.strictObject({ kind: z.literal("none") }).readonly(),
  z
    .strictObject({
      kind: z.literal("dispatched"),
      dispatch: dispatchSchema,
      seatClose: z.array(privateStateSeatCloseLagSchema.readonly()).readonly().exactOptional(),
    })
    .readonly(),
  z
    .strictObject({ kind: z.literal("failed"), failure: z.union([dispatchFailureSchema, integrationFailureSchema]) })
    .readonly(),
]);
const aliasStageSchema = z.union([
  z.strictObject({ kind: z.literal("none") }).readonly(),
  z
    .strictObject({ kind: z.literal("aliased"), alias: aliasBindingSchema, previous: akumaIdSchema.nullable() })
    .readonly(),
  z.strictObject({ kind: z.literal("skipped"), reason: z.literal("dispatch-failed") }).readonly(),
  z.strictObject({ kind: z.literal("failed"), failure: integrationFailureSchema }).readonly(),
]);
export const spawnWaitHeadSchema = z
  .strictObject({ dispatch: dispatchStageSchema, alias: aliasStageSchema })
  .readonly();
export const spawnObservationSchema = z.union([
  z.strictObject({ kind: z.literal("born") }).readonly(),
  z.strictObject({ kind: z.literal("detached"), tell: tellResultSchema }).readonly(),
  z
    .strictObject({
      kind: z.literal("observed"),
      tell: tellResultSchema,
      observation: akumaAskObservationSchema,
      completedAt: z.string().nullable().exactOptional(),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("failed"),
      tellId: z.string(),
      tell: tellResultSchema.exactOptional(),
      failure: integrationFailureSchema,
    })
    .readonly(),
]);
export const spawnResultSchema = z
  .strictObject({
    kind: z.literal("spawned"),
    akuma: akumaIdSchema,
    execution: z.strictObject({ cwd: z.string(), source: z.enum(["input", "process", "world"]) }).readonly(),
    dispatch: dispatchStageSchema,
    alias: aliasStageSchema,
    structured: z.literal(true).exactOptional(),
    observation: spawnObservationSchema,
  })
  .readonly();
export const forkResultSchema = z.union([
  z
    .strictObject({
      kind: z.literal("forked"),
      parent: akumaIdSchema,
      child: akumaIdSchema,
      dispatch: dispatchStageSchema,
    })
    .readonly(),
  forkFailureSchemas.unsupported.unwrap().extend({ parent: akumaIdSchema }).readonly(),
  forkFailureSchemas.unknownHistory.unwrap().extend({ parent: akumaIdSchema }).readonly(),
  forkFailureSchemas.failed.unwrap().extend({ parent: akumaIdSchema }).readonly(),
  forkFailureSchemas.upstream.unwrap().extend({ parent: akumaIdSchema }).readonly(),
]);

export type DispatchStage =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "dispatched"; dispatch: Dispatch; seatClose?: readonly PrivateStateSeatCloseLag[] }>
  | Readonly<{ kind: "failed"; failure: DispatchFailure | IntegrationFailure }>;

type AliasStage =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "aliased"; alias: AliasBinding; previous: AkumaId | null }>
  | Readonly<{ kind: "skipped"; reason: "dispatch-failed" }>
  | Readonly<{ kind: "failed"; failure: IntegrationFailure }>;

export type SpawnWaitHead = Readonly<{
  dispatch: DispatchStage;
  alias: AliasStage;
}>;

export const spawnProgressSchema = z.union([
  z
    .strictObject({
      kind: z.literal("admitted"),
      tell: tellResultSchema,
      id: akumaIdSchema,
      head: spawnWaitHeadSchema.unwrap().extend({ cwd: z.string() }).readonly(),
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
  schema?: Schema<unknown>;
  initiator?: string;
  caller?: AkumaCaller;
  signal?: AbortSignal;
  observe?: SpawnWaitObserver;
}>;

export type SpawnObservation =
  | Readonly<{ kind: "born" }>
  | Readonly<{ kind: "detached"; tell: TellResult }>
  | Readonly<{
      kind: "observed";
      tell: TellResult;
      observation: AkumaAskResult["observation"];
      completedAt?: string | null;
    }>
  | Readonly<{ kind: "failed"; tellId: string; tell?: TellResult; failure: IntegrationFailure }>;

export type SpawnResult = Readonly<{
  kind: "spawned";
  akuma: AkumaId;
  execution: Readonly<{
    cwd: string;
    source: "input" | "process" | "world";
  }>;
  dispatch: DispatchStage;
  alias: AliasStage;
  structured?: true;
  observation: SpawnObservation;
}>;

type CallExecution = SpawnResult["execution"];

export type ForkInput = Readonly<{
  akuma: string;
  at: string;
  bare?: boolean;
  repo?: Repo;
  caller?: AkumaCaller;
  initiator?: string;
}>;

export type ForkResult =
  | Readonly<{ kind: "forked"; parent: AkumaId; child: AkumaId; dispatch: DispatchStage }>
  | (Exclude<ForkReceipt, Readonly<{ kind: "forked"; child: AkumaId }>> & Readonly<{ parent: AkumaId }>);

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
  if (body === undefined && values.schema !== undefined) throw new TypeError("schema requires body");
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

async function dispatchStage(
  input: Readonly<{
    repository: Parameters<typeof publishDispatch>[0]["repository"];
    akumaId: AkumaId;
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
    parent: AkumaId;
    child: AkumaId;
  }>,
): Promise<DispatchStage> {
  try {
    const parent = await readDispatch(input.repository, input.parent);
    return parent === null
      ? { kind: "none" }
      : await dispatchStage({ repository: input.repository, akumaId: input.child, contractId: parent.contractId });
  } catch (error) {
    return { kind: "failed", failure: integrationFailure(error) };
  }
}

async function resolveCallExecution(input: Readonly<{ cwd?: string }>): Promise<CallExecution | undefined> {
  if (input.cwd === undefined) return undefined;
  return {
    cwd: await canonicalBirthCwd(input.cwd),
    source: "input",
  };
}

async function resolveAliasStage(
  path: WorldRoot,
  alias: AkumaAlias | undefined,
  dispatch: DispatchStage,
  akuma: AkumaId,
): Promise<AliasStage> {
  if (alias === undefined) return { kind: "none" };
  if (dispatch.kind === "failed") return { kind: "skipped", reason: "dispatch-failed" };
  try {
    const moved = await moveAlias({ world: path, alias, akumaId: akuma });
    return { kind: "aliased", alias: moved.alias, previous: moved.previous };
  } catch (error) {
    return { kind: "failed", failure: integrationFailure(error) };
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
  "schema",
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
  initialTell?: InitialCallTell & Readonly<{ schema?: Schema<unknown> }>;
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
  const schema = values.schema as Schema<unknown> | undefined;
  const schemaJson = schema === undefined ? undefined : schemaJsonText(schema);
  const observe = values.observe as AskObserver | undefined;
  const initialTell =
    body === undefined
      ? undefined
      : {
          tellId: randomUUID(),
          body,
          ...(schema === undefined ? {} : { schema, schemaJson: schemaJson! }),
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
    ...(input.initialTell === undefined
      ? {}
      : {
          initialTell: {
            tellId: input.initialTell.tellId,
            body: input.initialTell.body,
            ...(input.initialTell.schemaJson === undefined ? {} : { schemaJson: input.initialTell.schemaJson }),
            ...(input.initialTell.initiator === undefined ? {} : { initiator: input.initialTell.initiator }),
          },
        }),
    ...(input.writableDirectories === undefined ? {} : { writableDirectories: input.writableDirectories }),
    ...(input.bare === undefined ? {} : { bare: input.bare }),
    ...(execution === undefined ? {} : { cwd: execution.cwd }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

function callResultOf(
  akuma: AkumaId,
  execution: CallExecution,
  dispatch: DispatchStage,
  alias: AliasStage,
  initialTell: ParsedCallInput["initialTell"],
): Omit<SpawnResult, "observation"> {
  return {
    kind: "spawned",
    akuma,
    execution,
    dispatch,
    alias,
    ...(initialTell?.schema === undefined ? {} : { structured: true }),
  };
}

function failedCall(
  result: Omit<SpawnResult, "observation">,
  tellId: string,
  error: unknown,
  tell?: TellResult,
): SpawnResult {
  return {
    ...result,
    observation: {
      kind: "failed",
      tellId,
      ...(tell === undefined ? {} : { tell }),
      failure: integrationFailure(error),
    },
  };
}

async function observeCall(
  input: Readonly<{
    path: WorldRoot;
    akuma: AkumaId;
    result: Omit<SpawnResult, "observation">;
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
      await input.observe?.admitted?.(receipt, id, {
        dispatch: input.result.dispatch,
        alias: input.result.alias,
      });
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
    return {
      ...input.result,
      observation: {
        kind: "observed",
        tell: observed.tell,
        observation:
          input.initialTell.schema === undefined
            ? observed.observation
            : decodeAskObservation(observed.observation, input.initialTell.schema),
        ...(observed.completedAt === undefined ? {} : { completedAt: observed.completedAt }),
      },
    };
  } catch (error) {
    if (input.signal?.aborted) throw knownChildFailure(error, input.akuma);
    return failedCall(input.result, input.initialTell.tellId, error, input.receipt);
  }
}

/** One failure that still names the child the invocation durably admitted. */
function knownChildFailure(reason: unknown, akuma: AkumaId): Error {
  const cause = reason instanceof Error ? reason : new Error(reason === undefined ? "spawn aborted" : String(reason));
  // One AbortSignal may cancel several parallel spawns. Never overwrite another
  // invocation's leading birth on its shared reason object.
  const error =
    Object.isExtensible(cause) && !Object.hasOwn(cause, "akuma") ? cause : new Error(cause.message, { cause });
  Object.defineProperty(error, "akuma", { value: akuma, enumerable: false });
  return error;
}

/** Preserve a native failure identity; only an unknown shape becomes a fresh Error. */
function asError(failure: unknown): Error {
  return failure instanceof Error ? failure : new Error(failure === undefined ? "spawn failed" : String(failure));
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
    const dispatch: DispatchStage =
      seat === undefined
        ? { kind: "none" }
        : await dispatchStage({ repository: seat.scope, akumaId: admitted.id, contractId: seat.id });
    const aliasStage = await resolveAliasStage(parsed.path, parsed.alias, dispatch, admitted.id);
    const result = callResultOf(admitted.id, admitted.execution, dispatch, aliasStage, parsed.initialTell);
    if (parsed.initialTell === undefined) {
      // A prompt-free call must not report a clean birth when a launch stage failed
      // after the child was durably born; keep the native failure and the child.
      if (admitted.failure !== undefined) throw knownChildFailure(admitted.failure, admitted.id);
      return { ...result, observation: { kind: "born" } };
    }
    const receipt = admitted.tell;
    if (receipt === undefined) {
      if (parsed.signal?.aborted === true && admitted.failure !== undefined) {
        // Cancellation keeps its native meaning, and the already-born child stays
        // attached as private invocation evidence rather than being discarded.
        throw knownChildFailure(parsed.signal.reason, admitted.id);
      }
      const failure =
        admitted.failure === undefined
          ? new Error(`Akuma ${admitted.id} returned no exact initial Tell receipt`)
          : asError(admitted.failure);
      return failedCall(result, parsed.initialTell.tellId, failure);
    }
    return parsed.mode === "detach"
      ? { ...result, observation: { kind: "detached", tell: receipt } }
      : await observeCall(
          {
            path: parsed.path,
            akuma: admitted.id,
            result,
            initialTell: parsed.initialTell,
            receipt,
            timeoutMs: parsed.timeoutMs,
            ...(parsed.settings === undefined ? {} : { settings: parsed.settings }),
            ...(parsed.signal === undefined ? {} : { signal: parsed.signal }),
            ...(parsed.observe === undefined ? {} : { observe: parsed.observe }),
          },
          reportDiagnostic,
        );
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
  const addressed = await addressAkuma({ path: values.path, akuma: nonblank(values.akuma, "akuma") });
  const { path, id: akuma } = addressed;
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
  if (receipt.kind !== "forked") return { ...receipt, parent: akuma };
  const dispatch =
    repository === undefined
      ? { kind: "none" as const }
      : await forkDispatchStage({ repository, parent: akuma, child: receipt.child });
  return { kind: "forked", parent: akuma, child: receipt.child, dispatch };
}
