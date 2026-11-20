/** @architectureCompositionRoot */
import { z } from "zod";
import { akumaIdSchema } from "../akuma/identity.js";
import {
  exactActivityRowSchema,
  doneTurnSchema,
  settledTurnSchema,
  reportRowSchema,
  timelineItemSchema,
  type ActivityHistory,
} from "../akuma/projection.js";
import { AkumaNotBornError, AkumaObservationError } from "../akuma/akuma-errors.js";
import { HeartUnbornError } from "../akuma/heart/facts.js";
import { AkumaOwner, historyInputSchemas } from "../akuma/akuma-owner.js";
import { durationSchema, validateTellObservation, validateAkumaInput } from "../akuma/call-input.js";
import type { BodyLauncher } from "../akuma/body-launch.js";
import {
  executeAskAkuma,
  executeKillAkuma,
  executeTellAkuma,
  type AskObserver,
} from "../akuma/akuma-selection-execution.js";
import { executeWaitAkuma } from "../akuma/akuma-wait.js";
import type { AkumaStatus } from "../akuma/akuma.js";
import { canonicalDocument, type JsonSchemaDocument } from "../akuma/schema.js";
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
import { KeiyakuError } from "../errors.js";
import type { WorldRoot } from "../world.js";
import { outcomePluginObserver, stderrPluginDiagnostic, withAkumaWaitDeferrals } from "../plugin/akuma-signals.js";
import { addressAkuma, addressAkumaSet, type AkumaAddressInput, type AkumaSetAddressInput } from "./address.js";
import { optionalSignal, requireInput } from "./input.js";
import { scopeForRepo, type Repo } from "./repo.js";

export type AkumaWaitInput = AkumaSetAddressInput &
  Readonly<{
    completion?: "any" | "all";
    timeoutMs?: number;
    signal?: AbortSignal;
  }>;

export type AkumaTellInput = AkumaAddressInput &
  Readonly<{
    body: string;
    wait?: boolean;
    timeoutMs?: number;
    observe?: AskObserver;
    interrupt?: boolean;
    initiator?: string;
    signal?: AbortSignal;
  }>;
export type AkumaAskInput = Omit<AkumaTellInput, "wait"> & Readonly<{ schema: JsonSchemaDocument }>;
export type {
  AkumaAskResult,
  AkumaKillResult,
  AkumaObservation,
  AkumaTellResult,
  AkumaWaitResult,
} from "../akuma/selection-observation.js";
export type AkumaKillInput = AkumaAddressInput & Readonly<{ signal?: AbortSignal }>;
export type AkumaHistoryInput = AkumaAddressInput &
  Readonly<{
    id?: string;
    before?: number;
    since?: number;
    limit?: number;
    last?: boolean;
  }>;
export const historySelectionSchemas = [
  ...historyInputSchemas.map((branch) => branch.extend({ last: z.literal(false).exactOptional() })),
  z.strictObject({ last: z.literal(true) }),
] as const;
const historySelectionSchema = z.union(historySelectionSchemas);

const historyCommon = { akumaId: akumaIdSchema };
export const akumaHistoryResultSchema = z.union([
  z
    .strictObject({
      kind: z.literal("akuma"),
      ...historyCommon,
      events: z.array(timelineItemSchema).readonly(),
      omitted: z.number().int().positive().exactOptional(),
      retentionLost: z.literal(true).exactOptional(),
      lowestRetainedSequence: z.number().int().positive().exactOptional(),
      highestSequence: z.number().int().positive().exactOptional(),
    })
    .readonly(),
  z.strictObject({ kind: z.literal("akuma-activity"), ...historyCommon, row: exactActivityRowSchema }).readonly(),
  z.strictObject({ kind: z.literal("akuma-exact"), ...historyCommon, outcome: settledTurnSchema }).readonly(),
  reportRowSchema
    .unwrap()
    .extend({ kind: z.literal("akuma-report"), ...historyCommon })
    .readonly(),
  z.strictObject({ kind: z.literal("akuma-unknown-history"), ...historyCommon }).readonly(),
  doneTurnSchema
    .unwrap()
    .extend({ kind: z.literal("akuma-answer"), ...historyCommon })
    .readonly(),
  z.strictObject({ kind: z.literal("akuma-no-answer"), ...historyCommon }).readonly(),
]);

export type AkumaHistoryResult = z.output<typeof akumaHistoryResultSchema>;
type HistorySubject = Pick<AkumaHistoryResult, "akumaId">;

function observationError(id: AkumaStatus["id"], error: unknown): Error {
  if (error instanceof AkumaNotBornError || error instanceof AkumaObservationError) return error;
  return new AkumaObservationError(id, error instanceof Error ? error.message : String(error));
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
async function placementDischarged(repo: Repo | undefined, contract: DispatchAssociation): Promise<boolean> {
  if (repo === undefined || contract.kind !== "associated") return false;
  try {
    const scope = scopeForRepo(repo);
    return await withGitDecodeChannel(
      scope,
      async (channel) =>
        (await observeContractAt(scope, channel, contract.contractId)).state?.terminal?.kind === "claimed",
    );
  } catch {
    return false;
  }
}

async function observeAkuma(status: AkumaStatus, repo?: Repo): Promise<AkumaObservation> {
  const contract = (await dispatchAssociations(repo, [status.id])).get(status.id)!;
  const { birth: _birth, cwd, provider, ...native } = status;
  if (cwd === undefined || provider === undefined)
    throw new Error(`Born Akuma ${status.id} lacks its frozen execution context`);
  const observation: AkumaObservation = {
    kind: "akuma",
    ...native,
    cwd,
    provider,
    ...(contract.kind === "none" ? {} : { contract }),
  };
  if (!(await placementDischarged(repo, contract))) return observation;
  const { changes: _changes, moreChanges: _more, outsideChanges: _outside, ...discharged } = observation;
  return discharged;
}

function timeout(value: unknown): number | undefined {
  return validateAkumaInput(durationSchema.optional(), value);
}

function addressInput(values: Record<string, unknown>): Parameters<typeof addressAkuma>[0] {
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
      input.repo,
    );
  } catch (error) {
    throw observationError(addressed.id, error);
  }
}

function completionMode(value: unknown): "any" | "all" {
  // An omitted mode is any: a plural wait returns when any selected Akuma is complete.
  if (value === undefined) return "any";
  if (value !== "any" && value !== "all") throw new KeiyakuError("invalid-input", "completion must be any or all");
  return value;
}

async function localWait(
  addressed: Awaited<ReturnType<typeof addressAkumaSet>>,
  input: Readonly<{
    completion: "any" | "all";
    timeoutMs?: number;
    signal?: AbortSignal;
    reportDiagnostic: (message: string) => void;
  }>,
): Promise<AkumaWaitResult> {
  try {
    const native = await executeWaitAkuma({
      path: addressed.path,
      ids: addressed.orderedIds,
      completion: input.completion,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      outcomeObserved: outcomePluginObserver({ world: addressed.path, reportDiagnostic: input.reportDiagnostic }),
    });
    return { kind: "akuma", reason: native.reason, results: native.results };
  } catch (error) {
    if (input.signal?.aborted === true || addressed.orderedIds.length !== 1) throw error;
    throw observationError(addressed.orderedIds[0]!, error);
  }
}

export async function waitAkuma(
  input: AkumaWaitInput & Readonly<{ path: WorldRoot }>,
  reportDiagnostic: (message: string) => void = stderrPluginDiagnostic,
): Promise<AkumaWaitResult> {
  const values = requireInput(input, "Akumas.wait input", [
    "path",
    "akuma",
    "repo",
    "completion",
    "timeoutMs",
    "signal",
  ]);
  const selected = completionMode(values.completion);
  const timeoutMs = timeout(values.timeoutMs);
  const callerSignal = optionalSignal(values.signal);
  const addressed = await addressAkumaSet(addressInput(values), { contractSelectors: false });
  return await withAkumaWaitDeferrals(
    { world: addressed.path, reportDiagnostic },
    { akumaIds: addressed.orderedIds },
    callerSignal,
    async () => {
      return await localWait(addressed, {
        completion: selected,
        reportDiagnostic,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(callerSignal === undefined ? {} : { signal: callerSignal }),
      });
    },
  );
}

export async function killAkuma(input: AkumaKillInput & Readonly<{ path: WorldRoot }>): Promise<AkumaKillResult> {
  const values = requireInput(input, "Akumas.kill input", ["path", "akuma", "repo", "signal"]);
  if (typeof values.akuma !== "string" || values.akuma.trim().length === 0)
    throw new KeiyakuError("invalid-input", "akuma must be a nonblank string");
  const callerSignal = optionalSignal(values.signal);
  const addressed = await addressAkumaSet({ ...addressInput(values), akuma: [values.akuma] }, { forWrite: true });
  return await executeKillAkuma({
    path: addressed.path,
    ids: addressed.orderedIds,
    ...(callerSignal === undefined ? {} : { signal: callerSignal }),
  }).catch((error: unknown) => {
    if (error instanceof HeartUnbornError) throw new AkumaNotBornError(error.id);
    throw error;
  });
}

export async function surveilAkuma(path: WorldRoot, akuma: string, owner: string, off: boolean, signal?: AbortSignal) {
  const addressed = await addressAkuma({ path, akuma }, true);
  return await new AkumaOwner(addressed.id, addressed.path).surveil(owner, off, signal);
}

export async function tellAkuma(
  input: AkumaTellInput & Readonly<{ path: WorldRoot }>,
  spawn: BodyLauncher,
  reportDiagnostic: (message: string) => void = stderrPluginDiagnostic,
): Promise<AkumaTellResult> {
  const values = requireInput(input, "Akumas.tell input");
  for (const key of Object.keys(values)) {
    if (key === "schema") throw new KeiyakuError("invalid-input", "Akumas.tell does not accept schema; use Akumas.ask");
    if (
      !["path", "akuma", "body", "repo", "interrupt", "initiator", "signal", "wait", "timeoutMs", "observe"].includes(
        key,
      )
    ) {
      throw new KeiyakuError("invalid-input", `Akumas.tell input has unknown field: ${key}`);
    }
  }
  if (typeof values.body !== "string") throw new KeiyakuError("invalid-input", "body must be a string");
  if (values.interrupt !== undefined && typeof values.interrupt !== "boolean")
    throw new KeiyakuError("invalid-input", "interrupt must be a boolean");
  validateTellObservation(values);
  const callerSignal = optionalSignal(values.signal);
  const addressed = await addressAkuma(addressInput(values), true);
  const execution = {
    spawn,
    path: addressed.path,
    id: addressed.id,
    body: input.body,
    ...(input.wait === undefined ? {} : { wait: input.wait }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.observe === undefined ? {} : { onObserve: input.observe }),
    outcomeObserved: outcomePluginObserver({ world: addressed.path, reportDiagnostic }),
    ...(input.interrupt === true ? { interrupt: true } : {}),
    ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
    ...(callerSignal === undefined ? {} : { signal: callerSignal }),
  };
  return input.wait === true
    ? await withAkumaWaitDeferrals(
        { world: addressed.path, reportDiagnostic },
        { akumaIds: [addressed.id] },
        callerSignal,
        async () => await executeTellAkuma(execution),
      )
    : await executeTellAkuma(execution);
}

export async function askAkuma(
  input: AkumaAskInput & Readonly<{ path: WorldRoot }>,
  spawn: BodyLauncher,
  reportDiagnostic: (message: string) => void = stderrPluginDiagnostic,
): Promise<AkumaAskResult> {
  const values = requireInput(input, "Akumas.ask input", [
    "path",
    "akuma",
    "body",
    "repo",
    "timeoutMs",
    "schema",
    "interrupt",
    "initiator",
    "signal",
    "observe",
  ]);
  if (typeof values.body !== "string") throw new KeiyakuError("invalid-input", "body must be a string");
  timeout(values.timeoutMs);
  if (values.interrupt !== undefined && typeof values.interrupt !== "boolean")
    throw new KeiyakuError("invalid-input", "interrupt must be a boolean");
  const schema = canonicalDocument(input.schema);
  const callerSignal = optionalSignal(values.signal);
  const addressed = await addressAkuma(addressInput(values), true);
  return await withAkumaWaitDeferrals(
    { world: addressed.path, reportDiagnostic },
    { akumaIds: [addressed.id] },
    callerSignal,
    async () => {
      return await executeAskAkuma({
        spawn,
        path: addressed.path,
        id: addressed.id,
        outcomeObserved: outcomePluginObserver({ world: addressed.path, reportDiagnostic }),
        body: input.body,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        schemaJson: schema.jsonText,
        ...(input.interrupt === true ? { interrupt: true } : {}),
        ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
        ...(input.observe === undefined ? {} : { onObserve: input.observe }),
        ...(callerSignal === undefined ? {} : { signal: callerSignal }),
      });
    },
  );
}

function historyPage(subject: HistorySubject, page: ActivityHistory): AkumaHistoryResult {
  return {
    kind: "akuma",
    ...subject,
    events: page.rows,
    ...(page.omitted === 0 ? {} : { omitted: page.omitted }),

    ...(page.historyLost ? { retentionLost: true } : {}),
    ...(page.lowestRetained === null ? {} : { lowestRetainedSequence: page.lowestRetained }),
    ...(page.highest === null ? {} : { highestSequence: page.highest }),
  };
}

export async function historyAkuma(
  input: AkumaHistoryInput & Readonly<{ path: WorldRoot }>,
  reportDiagnostic: (message: string) => void = stderrPluginDiagnostic,
): Promise<AkumaHistoryResult> {
  const values = requireInput(input, "Akumas.history input");
  const { path: _path, akuma: _akuma, repo: _repo, ...selection } = values;
  const { last, ...options } = validateAkumaInput(historySelectionSchema, selection);
  const addressed = await addressAkuma(addressInput(values));
  try {
    const handle = new AkumaOwner(
      addressed.id,
      addressed.path,
      outcomePluginObserver({ world: addressed.path, reportDiagnostic }),
    );
    const subject: HistorySubject = { akumaId: addressed.id };
    if (last === true) {
      const answer = await handle.lastAnswer();
      if (answer.kind !== "answer") return { kind: "akuma-no-answer", ...subject };
      const { kind: _kind, ...outcome } = answer;
      return { kind: "akuma-answer", ...subject, ...outcome };
    }
    const history = await handle.history(options);
    if ("id" in options) {
      if ("kind" in history && history.kind === "exact-activity")
        return { kind: "akuma-activity", ...subject, row: history.row };
      if ("kind" in history && history.kind === "exact")
        return { kind: "akuma-exact", ...subject, outcome: history.outcome };
      if ("kind" in history && history.kind === "exact-report") {
        const { kind: _kind, ...row } = history.report;
        return { kind: "akuma-report", ...subject, ...row };
      }
      return { kind: "akuma-unknown-history", ...subject };
    }
    const page = history as ActivityHistory;
    return historyPage(subject, page);
  } catch (error) {
    throw observationError(addressed.id, error);
  }
}
