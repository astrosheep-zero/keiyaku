import { projectAkumaBirth } from "./caller.js";
import {
  readStatusFacts,
  createStatusFactReader,
  readLifeSnapshot,
  HeldAkumaLeash,
  isHeartAbsent,
  life,
  lifeAt,
  probeLeash,
  readHeart,
  readSeal,
  readSoul,
  type HeartSnapshot,
} from "./heart/index.js";
import { pathsForAkuId, type AkuId, type AkumaPaths } from "./identity.js";
import {
  ordinarySnapshotBudget,
  projectTurns,
  selectHistory,
  selectSnapshot,
  type ActivityHistory,
  type ActivityRow,
  type ActivitySnapshot,
  type TurnLedger,
} from "./projection.js";
import { resolveProviderExecution } from "./providers/index.js";
import { abortableDelay } from "./abort.js";
import type { WorldRoot } from "../world.js";
import type { AkumaAlias } from "../identity/selector.js";
import type { AkumaListRow, AkumaStatus, UnbornAkumaListRow } from "./akuma.js";
import { AkumaNotBornError } from "./akuma-errors.js";

export async function rosterListRow(
  paths: AkumaPaths,
  expected: AkuId,
  aliases: readonly AkumaAlias[] = [],
): Promise<AkumaListRow | UnbornAkumaListRow> {
  const snapshot = await readHeart(paths);
  if (snapshot.soul !== null) {
    const observed = await bornObservation(paths, expected, () => readHeart(paths), snapshot);
    return {
      id: observed.soul.id,
      archetype: observed.soul.archetype,
      ...(observed.soul.description === undefined ? {} : { description: observed.soul.description }),
      life: observed.currentLife,
      lifeAt: lifeAt(
        observed.currentLife,
        observed.snapshot.latestBody,
        observed.snapshot.latestKill,
        observed.soul.createdAt,
      ),
      lastActivityAt: observed.snapshot.lastActivityAt,
      pending: observed.snapshot.pending.map((tell) => tell.id),
      aliases,
    };
  }
  try {
    if ((await probeLeash(paths)) === "held") return { id: expected, life: "unborn", aliases };
    const seal = await readSeal(paths);
    return seal === null
      ? { id: expected, life: "unborn", aliases }
      : { id: expected, life: "stillborn", seal, aliases };
  } catch (error) {
    if (isHeartAbsent(error)) return { id: expected, life: "unborn", aliases };
    throw error;
  }
}

async function bornObservation<T extends Pick<HeartSnapshot, "soul" | "latestBody" | "latestKill">>(
  paths: AkumaPaths,
  expected: AkuId,
  read: () => Promise<T>,
  snapshot?: T,
) {
  snapshot ??= await read();
  if (snapshot.soul === null) throw new AkumaNotBornError(expected);
  const claim = await HeldAkumaLeash.try(paths);
  try {
    // A Body may finish after the first read. Refresh under the free seat so
    // neither its release nor a successor can manufacture an untidy observation.
    if (claim !== null) snapshot = await read();
    const soul = snapshot.soul;
    if (soul === null) throw new AkumaNotBornError(expected);
    if (soul.id !== expected) throw new Error("Akuma soul does not match its coordinate");
    const currentLife = life({
      leash: claim === null ? "held" : "free",
      body: snapshot.latestBody,
      kill: snapshot.latestKill,
    });
    return { snapshot, soul, currentLife };
  } finally {
    claim?.release();
  }
}

/** Optional semantic seam; the observer composition owns delivery and deduplication. */
export type OutcomeObserver = (akumaId: AkuId, historyIds: readonly string[]) => Promise<void>;

export async function observeOutcomeRows(
  id: AkuId,
  rows: readonly ActivityRow[],
  observer?: OutcomeObserver,
): Promise<void> {
  if (observer === undefined) return;
  const historyIds = rows.flatMap((row) => (row.kind === "outcome" ? [row.outcome.historyId] : []));
  if (historyIds.length > 0) await observer(id, historyIds);
}

export async function observeStatusOutcome(status: AkumaStatus, observer?: OutcomeObserver): Promise<void> {
  const snapshot = status.timeline;
  if (snapshot.kind === "idle" && snapshot.outcome !== undefined)
    await observer?.(status.id, [snapshot.outcome.outcome.historyId]);
}

type BudgetedStatusObservation = Readonly<{ status: AkumaStatus; ordinarySelected: number }>;

/**
 * The internal live-observation companion for one status frontier.  It is not
 * part of status or any returned facade result: viewers receive it only while
 * an observation loop is still streaming.
 */
export type LiveStatusObservation = BudgetedStatusObservation & Readonly<{ rows: readonly ActivityRow[] }>;

type StatusObservationInput = Readonly<{
  aperture: "monitoring" | "receipt";
  ordinaryBudget?: number;
  admittedTellId?: string;
}>;

function snapshotSelection(input: StatusObservationInput) {
  return {
    aperture: input.aperture,
    budget: ordinarySnapshotBudget(input.ordinaryBudget),
    ...(input.admittedTellId === undefined ? {} : { admittedTellId: input.admittedTellId }),
  };
}

/** Private to a live wait: retain only this member's current frontier and last selection. */
export function createLiveStatusReader(paths: AkumaPaths, expected: AkuId) {
  const reader = createStatusFactReader(paths);
  let memo:
    | Readonly<{
        facts: Awaited<ReturnType<typeof readStatusFacts>>;
        ledger: TurnLedger;
        options: ReturnType<typeof snapshotSelection>;
        selected: ReturnType<typeof selectSnapshot>;
      }>
    | undefined;
  const clear = (): void => {
    reader.clear();
    memo = undefined;
  };
  return {
    clear,
    tellOutcome: reader.tellOutcome,
    async complete(signal?: AbortSignal): Promise<boolean> {
      try {
        const observed = await bornObservation(paths, expected, () => reader.life(signal));
        return complete(observed.currentLife, observed.snapshot.hasPendingTell);
      } catch (error) {
        clear();
        throw error;
      }
    },
    async read(input: StatusObservationInput, signal?: AbortSignal): Promise<LiveStatusObservation> {
      try {
        if (
          input.ordinaryBudget !== undefined &&
          (!Number.isSafeInteger(input.ordinaryBudget) || input.ordinaryBudget < 0)
        )
          throw new TypeError("ordinary budget must be a nonnegative safe integer");
        const { snapshot, soul, currentLife } = await bornObservation(paths, expected, () => reader.life(signal));
        const resumeUnsupported =
          currentLife === "stranded" &&
          snapshot.latestSession?.provider === soul.provider.name &&
          (await resolveProviderExecution(soul.provider)).adapter.resume === undefined;
        const facts = await reader.read(input, signal);
        const ledger = memo?.facts === facts ? memo.ledger : projectTurns(facts);
        const options = snapshotSelection(input);
        const selected =
          memo?.ledger === ledger &&
          memo.options.aperture === options.aperture &&
          memo.options.admittedTellId === options.admittedTellId &&
          memo.options.budget.tail === options.budget.tail &&
          memo.options.budget.voice === options.budget.voice
            ? memo.selected
            : selectSnapshot(ledger, options);
        memo = { facts, ledger, options, selected };
        return {
          status: {
            id: soul.id,
            birth: projectAkumaBirth(soul),
            life: currentLife,
            cwd: soul.cwd,
            // The execution adapter and its one current model are what this Akuma
            // actually runs; a birth request the Soul still only seeded is not a
            // claim that a native runtime ever used it.
            provider: soul.provider.name,
            ...(soul.options.model === undefined ? {} : { model: soul.options.model }),
            allowed: soul.allowed,
            ...(resumeUnsupported ? { strandedReason: "resume-unsupported" as const } : {}),
            timeline: selected.snapshot,
          },
          ordinarySelected: selected.ordinaryCount,
          rows: ledger.rows,
        };
      } catch (error) {
        clear();
        throw error;
      }
    },
  };
}

/** One-shot observations use the same reader and always release it. */
export async function bornLiveStatus(
  paths: AkumaPaths,
  expected: AkuId,
  input: StatusObservationInput,
  signal?: AbortSignal,
): Promise<LiveStatusObservation> {
  const reader = createLiveStatusReader(paths, expected);
  try {
    return await reader.read(input, signal);
  } finally {
    reader.clear();
  }
}

export async function bornStatus(
  paths: AkumaPaths,
  expected: AkuId,
  input: StatusObservationInput,
): Promise<BudgetedStatusObservation> {
  const { rows: _rows, ...status } = await bornLiveStatus(paths, expected, input);
  return status;
}

export async function readLiveStatus(
  worldPath: WorldRoot,
  id: AkuId,
  input: StatusObservationInput,
  signal?: AbortSignal,
): Promise<LiveStatusObservation> {
  return await bornLiveStatus(pathsForAkuId(worldPath, id), id, input, signal);
}

function complete(life: AkumaStatus["life"], pending: boolean): boolean {
  return life !== "running" && !pending;
}

export function defaultWaitComplete(status: AkumaStatus): boolean {
  return complete(
    status.life,
    status.timeline.entries.some(
      (entry) => entry.kind === "row" && entry.row.kind === "tell" && entry.row.state === "pending",
    ),
  );
}

/** Probe completion only; returned statuses still come from a full observation. */
export async function readWaitComplete(
  worldPath: WorldRoot,
  ids: readonly AkuId[],
  completion: "any" | "all",
  signal?: AbortSignal,
  probe?: (id: AkuId) => Promise<boolean>,
): Promise<boolean> {
  let completed = 0;
  for (const id of ids) {
    signal?.throwIfAborted();
    try {
      const paths = pathsForAkuId(worldPath, id);
      const ready =
        probe === undefined
          ? await bornObservation(paths, id, () => readLifeSnapshot(paths, signal)).then((observed) =>
              complete(observed.currentLife, observed.snapshot.hasPendingTell),
            )
          : await probe(id);
      if (ready) {
        if (completion === "any") return true;
        completed += 1;
      }
    } catch (error) {
      if (ids.length === 1 || error instanceof AkumaNotBornError) throw error;
    }
  }
  return ids.length > 0 && completed === ids.length;
}

export type WaitReason = "completed" | "deadline";
/** The one observation cadence public waiting and timeline streaming share. */
export const OBSERVATION_POLL_MS = 100;

/**
 * The one deadline-aware observation loop for public Akuma waiting.  It always
 * reads once before judging a passed deadline, so a zero-duration wait remains
 * an honest final snapshot and completion wins at the deadline edge.
 */
export async function waitForObservation<T>(
  input: Readonly<{
    timeoutMs?: number;
    pollMs?: number;
    signal?: AbortSignal;
    probe?(): Promise<boolean>;
    observe(): Promise<T>;
    complete(value: T): boolean;
    onObserve?(value: T): void | Promise<void>;
  }>,
): Promise<Readonly<{ reason: WaitReason; value: T }>> {
  const deadline = input.timeoutMs === undefined ? undefined : performance.now() + input.timeoutMs;
  for (;;) {
    input.signal?.throwIfAborted();
    const ready = input.probe === undefined || (await input.probe());
    input.signal?.throwIfAborted();
    if (ready || (deadline !== undefined && performance.now() >= deadline)) {
      const value = await input.observe();
      input.signal?.throwIfAborted();
      await input.onObserve?.(value);
      if (input.complete(value)) return { reason: "completed", value };
      if (deadline !== undefined && performance.now() >= deadline) return { reason: "deadline", value };
    }
    await abortableDelay(
      deadline === undefined
        ? (input.pollMs ?? OBSERVATION_POLL_MS)
        : Math.min(input.pollMs ?? OBSERVATION_POLL_MS, Math.max(0, deadline - performance.now())),
      input.signal,
    );
  }
}

export async function readAkumaBirthCwd(worldPath: WorldRoot, id: AkuId): Promise<string> {
  const soul = await readSoul(pathsForAkuId(worldPath, id));
  if (soul === null) throw new AkumaNotBornError(id);
  return soul.cwd;
}

export { selectHistory, type ActivityHistory, type ActivitySnapshot };
