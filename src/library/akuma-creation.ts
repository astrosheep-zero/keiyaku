/** @architectureCompositionRoot */
import { z } from "zod";
import { contractIdSchema } from "../git/identity.js";
import { tellResultSchema } from "../akuma/call-initial-tell.js";
import {
  completedTextObservationSchema,
  operationDiagnosticSchema,
  tellFailureSchema,
  completeTell,
  tellAdmissionEvidence,
} from "../akuma/selection-observation.js";
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
import { bareOption, canonicalBirthCwd, durationSchema, validateAkumaInput } from "../akuma/call-input.js";
import { pathsForAkumaId, type AkumaId, type AkumaPaths } from "../akuma/identity.js";
import { moveAlias } from "../alias/index.js";
import { errorCategory, KeiyakuError } from "../errors.js";
import { publishDispatch, readDispatch } from "../dispatch/index.js";
import { akumaAliasSchema, parseAkumaAlias, type AkumaAlias } from "../identity/selector.js";
import { outcomePluginObserver, stderrPluginDiagnostic, withAkumaWaitDeferrals } from "../plugin/akuma-signals.js";
import type { Settings } from "../settings.js";
import { World, type WorldRoot } from "../world.js";
import { addressAkuma } from "./address.js";
import { requireInput, requireMarkdown as text, optionalNonblank, optionalSignal } from "./input.js";
import type { Kei } from "./kei.js";
import { seatForKei } from "./kei.js";
import { scopeForRepo, type Repo } from "./repo.js";
import { withSpawnFailureReceipt } from "./outcome.js";

type IntegrationFailure = z.output<typeof operationDiagnosticSchema>;
const dispatchFailureSchema = z.union([
  z.strictObject({ kind: z.literal("conflict"), currentContractId: contractIdSchema }).readonly(),
  z.strictObject({ kind: z.literal("publication-failed"), diagnostic: z.string() }).readonly(),
  operationDiagnosticSchema,
]);
const dispatchStageSchema = z.strictObject({ stage: z.literal("dispatch"), failure: dispatchFailureSchema }).readonly();
const aliasStageSchema = operationDiagnosticSchema
  .unwrap()
  .extend({ stage: z.literal("alias") })
  .readonly();
const spawnFailureSchema = z.union([
  operationDiagnosticSchema
    .unwrap()
    .extend({ stage: z.enum(["birth", "tell"]), attemptedTellId: z.string().exactOptional() })
    .readonly(),
  dispatchStageSchema,
  aliasStageSchema,
  ...tellFailureSchema.options,
]);
type SpawnFailure = z.output<typeof spawnFailureSchema>;
const publicationFields = {
  dispatchWarning: z.string().exactOptional(),
  alias: z
    .strictObject({ kind: z.literal("moved"), previousAkumaId: akumaIdSchema })
    .readonly()
    .exactOptional(),
};
export const spawnWaitHeadSchema = z
  .strictObject({
    cwd: z.string(),
    ...publicationFields,
    failures: z.array(spawnFailureSchema).nonempty().readonly().exactOptional(),
    contractId: contractIdSchema.exactOptional(),
    aliasName: akumaAliasSchema.exactOptional(),
  })
  .readonly();
const spawnAnswer = {
  akumaId: akumaIdSchema,
  ...publicationFields,
  tellId: z.string().exactOptional(),
  wake: z
    .strictObject({ kind: z.literal("pending") })
    .readonly()
    .exactOptional(),
  input: completedTextObservationSchema.exactOptional(),
};
export const spawnNormalResultSchema = z.strictObject({ kind: z.literal("spawned"), ...spawnAnswer }).readonly();
export const spawnResultSchema = z.union([
  spawnNormalResultSchema,
  z
    .strictObject({
      kind: z.literal("failed"),
      ...spawnAnswer,
      failures: z.tuple([spawnFailureSchema], spawnFailureSchema).readonly(),
    })
    .readonly(),
]);
const parentFields = { parentAkumaId: akumaIdSchema.exactOptional() };
export const forkNormalResultSchema = z
  .strictObject({
    kind: z.literal("forked"),
    childAkumaId: akumaIdSchema,
    ...parentFields,
    dispatchWarning: publicationFields.dispatchWarning,
  })
  .readonly();
export const forkResultSchema = z.union([
  forkNormalResultSchema,
  z
    .strictObject({
      kind: z.literal("failed"),
      childAkumaId: akumaIdSchema,
      ...parentFields,
      failure: dispatchStageSchema,
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
    .strictObject({ kind: z.literal("admitted"), tell: tellResultSchema, id: akumaIdSchema, head: spawnWaitHeadSchema })
    .readonly(),
  z.strictObject({ kind: z.literal("live"), observation: liveStatusObservationSchema }).readonly(),
]);
export type SpawnProgress = z.output<typeof spawnProgressSchema>;

export type SpawnWaitObserver = Omit<AskObserver, "admitted"> &
  Readonly<{
    admitted?: (tell: TellResult, id: AkumaStatus["id"], head: SpawnWaitHead) => void | Promise<void>;
  }>;

export const spawnModeSchemas = [
  z.strictObject({
    mode: z.literal("wait"),
    body: z.string(),
    timeoutMs: durationSchema.exactOptional(),
  }),
  z.strictObject({ mode: z.literal("detach").exactOptional(), body: z.string().exactOptional() }),
] as const;
const spawnModeSchema = z.union(spawnModeSchemas);

export type SpawnInput = Readonly<{
  akumaName: string;
  body?: string;
  cwd?: string;
  mode?: "wait" | "detach";
  timeoutMs?: number;
  home?: string;
  settings?: Settings;
  contract?: Kei;
  alias?: string;
  writableDirectories?: readonly string[];
  bare?: boolean;
  initiator?: string;
  caller?: AkumaCaller;
  signal?: AbortSignal;
  observe?: SpawnWaitObserver;
}>;

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
    throw new KeiyakuError("invalid-input", `${label} must be a nonblank string`);
  }
  return value;
}

function settingsOption(value: unknown): Settings | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { namespace?: unknown }).namespace !== "function"
  ) {
    throw new KeiyakuError("invalid-input", "settings must be a Settings");
  }
  return value as Settings;
}

function integrationFailure(error: unknown): IntegrationFailure {
  return {
    kind: errorCategory(error) === "authority-corruption" ? "authority-corruption" : "infrastructure",
    diagnostic: error instanceof Error ? error.message : String(error),
  };
}

function callSeat(contract: unknown) {
  if (contract === undefined) return undefined;
  const seat = seatForKei(contract);
  if (seat === null) throw new KeiyakuError("invalid-input", "contract must be a Kei");
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

type DispatchAnswer = Readonly<{ failure?: z.output<typeof dispatchStageSchema>; dispatchWarning?: string }>;
async function callDispatch(input: Parameters<typeof publishDispatch>[0]): Promise<DispatchAnswer> {
  try {
    const published = await publishDispatch(input);
    if (published.kind === "dispatched") {
      const warning = published.seatClose?.map((lag) => lag.diagnostic).join("\n");
      return warning === undefined || warning.length === 0 ? {} : { dispatchWarning: warning };
    }
    const failure = published.failure;
    return {
      failure: {
        stage: "dispatch",
        failure:
          failure.kind === "conflict" ? { kind: "conflict", currentContractId: failure.current.contractId } : failure,
      },
    };
  } catch (error) {
    return { failure: { stage: "dispatch", failure: integrationFailure(error) } };
  }
}

async function forkDispatch(
  repository: Parameters<typeof readDispatch>[0],
  parent: AkumaId,
  child: AkumaId,
): Promise<DispatchAnswer> {
  try {
    const association = await readDispatch(repository, parent);
    return association === null
      ? {}
      : await callDispatch({ repository, akumaId: child, contractId: association.contractId });
  } catch (error) {
    return { failure: { stage: "dispatch", failure: integrationFailure(error) } };
  }
}

async function callAlias(
  path: WorldRoot,
  alias: AkumaAlias | undefined,
  akuma: AkumaId,
): Promise<Readonly<{ alias?: SpawnResult["alias"]; failure?: z.output<typeof aliasStageSchema> }>> {
  if (alias === undefined) return {};
  try {
    const moved = await moveAlias({ world: path, alias, akumaId: akuma });
    return moved.previous === null || moved.previous === akuma
      ? {}
      : { alias: { kind: "moved", previousAkumaId: moved.previous } };
  } catch (error) {
    return { failure: { stage: "alias", ...integrationFailure(error) } };
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

type ParsedCallInput = Omit<SpawnInput, "alias" | "body" | "contract" | "mode" | "timeoutMs"> &
  Readonly<{
    path: WorldRoot;
    alias?: AkumaAlias;
    mode: "wait" | "detach";
    timeoutMs: number;
    seat: ReturnType<typeof callSeat>;
    initialTell?: InitialCallTell;
  }>;

function initialCallTell(body: string | undefined, initiator: string | undefined): InitialCallTell | undefined {
  if (body === undefined) return undefined;
  return {
    tellId: randomUUID(),
    body,
    ...(initiator === undefined ? {} : { initiator }),
  };
}

function parseSpawnAlias(value: unknown): AkumaAlias | undefined {
  if (value === undefined) return undefined;
  const alias = nonblank(value, "alias");
  return parseAkumaAlias(alias.startsWith("@") ? alias : `@${alias}`);
}

async function parseCallInput(input: SpawnInput & Readonly<{ path: WorldRoot }>): Promise<ParsedCallInput> {
  const values = requireInput(input, "Akumas.spawn input", CALL_INPUT_KEYS);
  const options = validateAkumaInput(spawnModeSchema, {
    ...(values.body === undefined ? {} : { body: values.body }),
    ...(values.mode === undefined ? {} : { mode: values.mode }),
    ...(values.timeoutMs === undefined ? {} : { timeoutMs: values.timeoutMs }),
  });
  const path = await World.prove(nonblank(values.path, "path"));
  const akumaName = nonblank(values.akumaName, "akumaName");
  const initiator = values.initiator === undefined ? undefined : text(values.initiator, "initiator");
  const caller = decodeAkumaCaller(values.caller);
  const bare = bareOption(values.bare);
  const cwd = optionalNonblank(values.cwd, "cwd");
  const mode = options.mode ?? "detach";
  const timeoutMs = options.mode === "wait" ? (options.timeoutMs ?? 300_000) : 300_000;
  const signal = optionalSignal(values.signal);
  const home = optionalNonblank(values.home, "home");
  const settings = settingsOption(values.settings);
  const alias = parseSpawnAlias(values.alias);
  const seat = callSeat(values.contract);
  const observe = values.observe as AskObserver | undefined;
  const initialTell = initialCallTell(options.body, initiator);
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

/** Project native birth and initial-Tell stops before association work. */
function callAdmissionFailures(admitted: AdmittedAkumaCall, initialTell: InitialCallTell | undefined): SpawnFailure[] {
  if (admitted.failure !== undefined)
    return [
      admitted.failureStage === "wake"
        ? { stage: "wake", diagnostic: integrationFailure(admitted.failure).diagnostic }
        : {
            stage: admitted.failureStage ?? "birth",
            ...integrationFailure(admitted.failure),
            ...(initialTell === undefined || admitted.tell !== undefined
              ? {}
              : { attemptedTellId: initialTell.tellId }),
          },
    ];
  return initialTell !== undefined && admitted.tell === undefined
    ? [
        {
          stage: "tell",
          kind: "infrastructure",
          attemptedTellId: initialTell.tellId,
          diagnostic: `Akuma ${admitted.id} returned no exact initial Tell receipt`,
        },
      ]
    : [];
}

/** Settle one admitted birth: detach, observe, or report the exact initial-Tell failure. */
async function settleCall(
  parsed: ParsedCallInput,
  admitted: AdmittedAkumaCall,
  head: SpawnWaitHead,
  reportDiagnostic?: (message: string) => void,
): Promise<SpawnResult> {
  const receipt = admitted.tell;
  const { cwd: _cwd, contractId: _contract, aliasName: _alias, failures: associationFailures, ...publication } = head;
  const compact = receipt === undefined ? undefined : completeTell(tellAdmissionEvidence(admitted.id, receipt));
  const failures = callAdmissionFailures(admitted, parsed.initialTell);
  if (compact?.kind === "failed") failures.push(...compact.failures);
  failures.push(...(associationFailures ?? []));
  const answer = {
    akumaId: admitted.id,
    ...publication,
    ...(compact === undefined
      ? {}
      : { tellId: compact.tellId, ...(compact.wake === undefined ? {} : { wake: compact.wake }) }),
  };
  let input: SpawnResult["input"];
  const result = (): SpawnResult => {
    const [first, ...rest] = failures;
    const observed = { ...answer, ...(input === undefined ? {} : { input }) };
    return first === undefined
      ? { kind: "spawned", ...observed }
      : { kind: "failed", ...observed, failures: [first, ...rest] };
  };
  if (parsed.signal?.aborted === true && admitted.failure !== undefined)
    throw withSpawnFailureReceipt(parsed.signal.reason, result(), parsed.signal);
  if (admitted.failure !== undefined && (parsed.initialTell === undefined || admitted.failureStage === "wake"))
    throw withSpawnFailureReceipt(admitted.failure, result(), parsed.signal);
  if (receipt !== undefined && parsed.mode === "wait") {
    try {
      const {
        akumaId: _id,
        tellId: _tell,
        wake: _wake,
        interrupt: _interrupt,
        ...observation
      } = await observeAdmittedAskAkuma({
        ...parsed,
        id: admitted.id,
        tellId: receipt.admission.tellId,
        receipt,
        onObserve: {
          ...parsed.observe,
          admitted: async (tell, id) => {
            await parsed.observe?.admitted?.(tell, id, head);
          },
        },
        outcomeObserved: outcomePluginObserver({
          ...parsed,
          world: parsed.path,
          reportDiagnostic: callDiagnosticSink(
            pathsForAkumaId(parsed.path, admitted.id),
            "outcome observation",
            reportDiagnostic,
          ),
        }),
      });
      if (observation.kind === "failed" || observation.kind === "invalid-output")
        failures.push({ stage: "observation", diagnostic: observation.diagnostic });
      else input = observation;
    } catch (error) {
      if (parsed.signal?.aborted) throw withSpawnFailureReceipt(error, result(), parsed.signal);
      failures.push({ stage: "observation", diagnostic: integrationFailure(error).diagnostic });
    }
  }
  return result();
}

export async function callAkumas(
  input: SpawnInput & Readonly<{ path: WorldRoot }>,
  spawn: BodyLauncher,
  reportDiagnostic?: (message: string) => void,
): Promise<SpawnResult> {
  const parsed = await parseCallInput(input);
  const cwd = parsed.cwd === undefined ? undefined : await canonicalBirthCwd(parsed.cwd);
  const seat = parsed.seat;
  const prepared = await prepareAkumaCall(
    parsed.path,
    parsed,
    { ...parsed, ...(cwd === undefined ? {} : { cwd }), ...(seat === undefined ? {} : { contractId: seat.id }) },
    cwd === undefined ? {} : { cwdCanonical: true },
    spawn,
  );
  let publishing = false;
  const run = async (): Promise<SpawnResult> => {
    publishing = true;
    const admitted = await publishAkumaCall(prepared);
    const dispatch: DispatchAnswer =
      seat === undefined
        ? {}
        : await callDispatch({
            repository: seat.scope,
            akumaId: admitted.id,
            contractId: seat.id,
          });
    const alias = dispatch.failure === undefined ? await callAlias(parsed.path, parsed.alias, admitted.id) : {};
    const failures = [dispatch.failure, alias.failure].filter((failure) => failure !== undefined);
    const head: SpawnWaitHead = {
      cwd: admitted.cwd,
      ...(dispatch.dispatchWarning === undefined ? {} : { dispatchWarning: dispatch.dispatchWarning }),
      ...(alias.alias === undefined ? {} : { alias: alias.alias }),
      ...(failures.length === 0 ? {} : { failures }),
      ...(seat === undefined || dispatch.failure !== undefined ? {} : { contractId: seat.id }),
      ...(parsed.alias === undefined || dispatch.failure !== undefined || alias.failure !== undefined
        ? {}
        : { aliasName: parsed.alias }),
    };
    return await settleCall(parsed, admitted, head, reportDiagnostic);
  };
  try {
    return parsed.mode === "wait" && parsed.initialTell !== undefined
      ? await withAkumaWaitDeferrals(
          {
            ...parsed,
            world: parsed.path,
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
  const values = requireInput(input, "Akumas.fork input", [
    "path",
    "akuma",
    "at",
    "bare",
    "repo",
    "caller",
    "initiator",
  ]);
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
  const dispatch: DispatchAnswer =
    repository === undefined ? {} : await forkDispatch(repository, akuma, receipt.childAkumaId);
  return dispatch.failure === undefined
    ? {
        ...receipt,
        ...parent,
        ...(dispatch.dispatchWarning === undefined ? {} : { dispatchWarning: dispatch.dispatchWarning }),
      }
    : { kind: "failed", childAkumaId: receipt.childAkumaId, ...parent, failure: dispatch.failure };
}
