/** @architectureCompositionRoot */
import { z } from "zod";
import { akumaIdSchema } from "../akuma/identity.js";
import { activityRowSchema, outcomeRowSchema, reportRowSchema } from "../akuma/projection.js";
import { projectCurrentWork } from "../akuma/status-projection.js";
import { withoutReportedChanges } from "../akuma/projection.js";
import { AkumaNotBornError, AkumaObservationError } from "../akuma/akuma-errors.js";
import { AkumaOwner } from "../akuma/akuma-owner.js";
import type { BodyLauncher } from "../akuma/body-launch.js";
import {
  executeAskAkuma,
  executeKillAkuma,
  executeTellAkuma,
  type AskObserver,
} from "../akuma/akuma-selection-execution.js";
import { executeWaitAkuma } from "../akuma/akuma-wait.js";
import type { LiveStatusObservation } from "../akuma/akuma-observe.js";
import { type AkumaStatus } from "../akuma/akuma.js";
import { parseExactHistorySelector } from "../akuma/identity.js";
import { type ActivityHistory } from "../akuma/projection.js";
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
import { observeCreatedDebtObservations } from "../debt/created-observation.js";
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
export type AkumaKillInput = AkumaSetAddressInput & Readonly<{ signal?: AbortSignal }>;
export type AkumaHistoryInput = AkumaAddressInput &
  Readonly<{
    id?: string;
    before?: number;
    since?: number;
    limit?: number;
    last?: boolean;
  }>;
const historyCommon = { akumaId: akumaIdSchema };
export const akumaHistoryResultSchema = z.union([
  z
    .strictObject({
      kind: z.literal("akuma"),
      ...historyCommon,
      events: z.array(activityRowSchema).readonly(),
      omitted: z.number().int().positive().exactOptional(),
      retentionLost: z.literal(true).exactOptional(),
      lowestRetainedSequence: z.number().int().positive().exactOptional(),
      highestSequence: z.number().int().positive().exactOptional(),
    })
    .readonly(),
  z
    .strictObject({
      ...outcomeRowSchema.unwrap().omit({ kind: true }).shape,
      kind: z.literal("akuma-exact"),
      ...historyCommon,
    })
    .readonly(),
  z
    .strictObject({
      ...reportRowSchema.unwrap().omit({ kind: true }).shape,
      kind: z.literal("akuma-report"),
      ...historyCommon,
    })
    .readonly(),
  z.strictObject({ kind: z.literal("akuma-unknown-history"), ...historyCommon }).readonly(),
  z.strictObject({ kind: z.literal("akuma-last"), ...historyCommon, answer: z.string() }).readonly(),
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

async function observeAkuma(
  status: LiveStatusObservation["status"],
  path: WorldRoot,
  repo?: Repo,
): Promise<AkumaObservation> {
  const contract = (await dispatchAssociations(repo, [status.id])).get(status.id)!;
  const createdDebts = (await observeCreatedDebtObservations(path, [status.id]))[0]!;
  if (status.cwd === undefined || status.provider === undefined)
    throw new Error(`Born Akuma ${status.id} lacks its frozen execution context`);
  const composed = (await placementDischarged(repo)(contract))
    ? { ...status, timeline: withoutReportedChanges(status.timeline) }
    : status;
  const changes = composed.timeline.reportedChanges;
  return {
    kind: "akuma",
    id: status.id,
    life: status.life,
    cwd: status.cwd,
    provider: status.provider,
    ...(status.model === undefined ? {} : { model: status.model }),
    work: projectCurrentWork(composed.timeline),
    ...(status.lastActivityAt === undefined ? {} : { lastActivityAt: status.lastActivityAt }),
    ...(status.strandedReason === undefined ? {} : { strandedReason: status.strandedReason }),
    ...(contract.kind === "none" ? {} : { contract }),
    ...(createdDebts.kind === "failed"
      ? { createdDebts }
      : createdDebts.rows === undefined
        ? {}
        : { createdDebts: createdDebts.rows }),
    ...(changes.length === 0 ? {} : { changes }),
    ...(composed.timeline.reportedChangesOmitted === 0 ? {} : { moreChanges: true }),
    ...(composed.timeline.reportedChangesOutside === undefined
      ? {}
      : { outsideChanges: composed.timeline.reportedChangesOutside }),
  };
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
  const addressed = await addressAkumaSet(setAddress(values));
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
  reportDiagnostic: (message: string) => void = stderrPluginDiagnostic,
): Promise<AkumaTellResult> {
  const values = requireInput(input, "Akumas.tell input");
  for (const key of Object.keys(values)) {
    if (key === "schema") throw new TypeError("Akumas.tell does not accept schema; use Akumas.ask");
    if (
      !["path", "akuma", "body", "repo", "interrupt", "initiator", "signal", "wait", "timeoutMs", "observe"].includes(
        key,
      )
    ) {
      throw new TypeError(`Akumas.tell input has unknown field: ${key}`);
    }
  }
  if (typeof values.body !== "string") throw new TypeError("body must be a string");
  if (values.interrupt !== undefined && typeof values.interrupt !== "boolean")
    throw new TypeError("interrupt must be a boolean");
  if (values.wait !== undefined && typeof values.wait !== "boolean") throw new TypeError("wait must be a boolean");
  if (values.timeoutMs !== undefined && values.wait !== true) throw new TypeError("timeoutMs requires wait");
  const timeoutMs = timeout(values.timeoutMs);
  const callerSignal = signal(values.signal);
  const addressed = await addressAkuma(directAddress(values));
  const execution = {
    spawn,
    path: addressed.path,
    id: addressed.id,
    body: input.body,
    ...(input.wait === undefined ? {} : { wait: input.wait }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
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

export async function askAkuma(
  input: AkumaAskInput & Readonly<{ path: WorldRoot }>,
  spawn: BodyLauncher,
  reportDiagnostic: (message: string) => void = stderrPluginDiagnostic,
): Promise<AkumaAskResult> {
  const values = requireInput(input, "Akumas.ask input");
  validateAskInput(values);
  const schema = canonicalDocument(input.schema);
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
        schemaJson: schema.jsonText,
        ...(input.interrupt === true ? { interrupt: true } : {}),
        ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
        ...(input.observe === undefined ? {} : { onObserve: input.observe }),
        ...(callerSignal === undefined ? {} : { signal: callerSignal }),
      });
      return result.kind === "answered" ? { ...result, answer: JSON.parse(result.answer) } : result;
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
    throw new TypeError(
      "id must be a positive safe decimal integer, turn/<positive safe integer> or report/<positive safe integer>",
    );
  if (
    values.id !== undefined &&
    (values.last === true || values.before !== undefined || values.since !== undefined || values.limit !== undefined)
  )
    throw new TypeError("id cannot be combined with last, before, since, or limit");
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
  validateHistoryInput(values);
  const addressed = await addressAkuma(directAddress(values));
  try {
    const handle = new AkumaOwner(
      addressed.id,
      addressed.path,
      outcomePluginObserver({ world: addressed.path, reportDiagnostic }),
    );
    const subject: HistorySubject = { akumaId: addressed.id };
    if (values.last === true) {
      const answer = await handle.lastAnswer();
      return answer.kind === "answer"
        ? { kind: "akuma-last", ...subject, answer: answer.answer }
        : { kind: "akuma-no-answer", ...subject };
    }
    const history = await handle.history({
      ...(values.id === undefined ? {} : { id: values.id as string }),
      ...(values.before === undefined ? {} : { before: values.before as number }),
      ...(values.since === undefined ? {} : { since: values.since as number }),
      ...(values.limit === undefined ? {} : { limit: values.limit as number }),
    });
    if (values.id !== undefined) {
      if ("kind" in history && history.kind === "exact-activity")
        return { kind: "akuma", ...subject, events: [history.row] };
      if ("kind" in history && history.kind === "exact") {
        const { kind: _kind, ...row } = history.outcome;
        return { kind: "akuma-exact", ...subject, ...row };
      }
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
