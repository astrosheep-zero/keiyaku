import { projectAkumaBirth } from "./caller.js";
import {
  createStatusFactReader,
  readLifeSnapshot,
  HeldAkumaLeash,
  heartExists,
  isHeartAbsent,
  life,
  lifeAt,
  probeLeash,
  readHeart,
  readSeal,
  type HeartSnapshot,
  type Soul,
  type TimelineFact,
  type WaitFacts,
} from "./heart/index.js";
import { pathsForAkumaId, type AkumaId, type AkumaPaths } from "./identity.js";
import type { LeashProbe, SurveillanceAudience } from "./heart/facts.js";
import { projectFact, type ActivityRow } from "./projection.js";
import { projectCurrentWork, summarizeFrontier, type CurrentWork } from "./status-projection.js";
import { resolveProviderExecution } from "./providers/index.js";
import { abortableDelay } from "./abort.js";
import type { WorldRoot } from "../world.js";
import type { AkumaRosterRow, AkumaStatus } from "./akuma.js";
import { AkumaNotBornError } from "./akuma-errors.js";

export async function rosterListRow(paths: AkumaPaths, expected: AkumaId): Promise<AkumaRosterRow> {
  const snapshot = await readHeart(paths);
  if (snapshot.soul !== null) {
    const observed = await bornObservation(paths, expected, () => readHeart(paths), snapshot);
    const lifeAtValue = lifeAt(
      observed.currentLife,
      observed.snapshot.latestBody,
      observed.snapshot.latestKill,
      observed.soul.createdAt,
    );
    const lastActivityAt = observed.snapshot.lastActivityAt;
    const pending = observed.snapshot.pending.length;
    return {
      kind: "born",
      id: observed.soul.id,
      life: observed.currentLife,
      ...(lifeAtValue === null ? {} : { lifeAt: lifeAtValue }),
      ...(lastActivityAt === null ? {} : { lastActivityAt }),
      ...(pending === 0 ? {} : { pending }),
      ...(observed.soul.caller === undefined ? {} : { caller: observed.soul.caller }),
    };
  }
  const unborn = (life: "unborn" | "stillborn", diagnostic?: string) => ({
    kind: "unborn" as const,
    id: expected,
    life,
    ...(diagnostic === undefined ? {} : { diagnostic }),
  });
  try {
    if ((await probeLeash(paths)) === "held") return unborn("unborn");
    const seal = await readSeal(paths);
    return unborn(seal === null ? "unborn" : "stillborn", seal?.evidence);
  } catch (error) {
    if (isHeartAbsent(error) && !(await heartExists(paths))) return unborn("unborn");
    throw error;
  }
}

async function bornObservation<T extends Pick<HeartSnapshot, "soul" | "latestBody" | "latestKill">>(
  paths: AkumaPaths,
  expected: AkumaId,
  read: (leash: LeashProbe) => Promise<T>,
  snapshot?: T,
) {
  const fresh = async (leash: LeashProbe) => {
    try {
      return await read(leash);
    } catch (error) {
      if (isHeartAbsent(error)) throw new AkumaNotBornError(expected);
      throw error;
    }
  };
  snapshot ??= await fresh("held");
  if (snapshot.soul === null) throw new AkumaNotBornError(expected);
  const claim = await HeldAkumaLeash.try(paths);
  try {
    if (claim !== null) snapshot = await fresh("free");
    const soul = snapshot.soul;
    if (soul === null) throw new AkumaNotBornError(expected);
    if (soul.id !== expected) throw new Error("Akuma soul does not match its coordinate");
    const currentLife = observedLife(snapshot, claim === null ? "held" : "free");
    return { snapshot, soul, currentLife };
  } finally {
    claim?.release();
  }
}

function observedLife(snapshot: Pick<HeartSnapshot, "latestBody" | "latestKill">, leash: LeashProbe) {
  return life({ leash, body: snapshot.latestBody, kill: snapshot.latestKill });
}

export async function readBornLife(paths: AkumaPaths, expected: AkumaId): Promise<AkumaStatus["life"]> {
  return (await bornObservation(paths, expected, () => readLifeSnapshot(paths))).currentLife;
}

export type OutcomeObserver = (akumaId: AkumaId, historyIds: readonly string[]) => Promise<void>;
export async function observeOutcomeRows(
  id: AkumaId,
  rows: readonly ActivityRow[],
  observer?: OutcomeObserver,
): Promise<void> {
  const ids = rows.flatMap((row) => (row.kind === "outcome" ? [`turn/${row.turnSequence}`] : []));
  if (ids.length > 0) await observer?.(id, ids);
}
export async function observeStatusOutcome(status: AkumaStatus, observer?: OutcomeObserver): Promise<void> {
  if (status.work.outcome !== undefined) await observer?.(status.id, [status.work.outcome.historyId]);
}

export type LiveStatusObservation = Readonly<{ status: AkumaStatus; rows: readonly ActivityRow[] }>;
export type WaitStatusObservation = WaitFacts & Readonly<{ id: AkumaId; life: AkumaStatus["life"] }>;

async function projectLiveStatus(
  snapshot: Pick<HeartSnapshot, "latestSession" | "lastActivityAt"> & Readonly<{ surveillants?: SurveillanceAudience }>,
  soul: Soul,
  currentLife: AkumaStatus["life"],
  timeline: readonly TimelineFact[],
): Promise<LiveStatusObservation> {
  const resumeUnsupported =
    currentLife === "stranded" &&
    snapshot.latestSession?.provider === soul.provider.name &&
    (await resolveProviderExecution(soul.provider)).adapter.resume === undefined;
  const rows = timeline.map(projectFact);
  return {
    status: {
      id: soul.id,
      birth: projectAkumaBirth(soul),
      life: currentLife,
      cwd: soul.cwd,
      provider: soul.provider.name,
      ...(soul.options.model === undefined ? {} : { model: soul.options.model }),
      ...(snapshot.surveillants === undefined ? {} : { surveillants: snapshot.surveillants }),
      ...(resumeUnsupported ? { strandedReason: "resume-unsupported" as const } : {}),
      ...summarizeFrontier(rows, soul.cwd),
      ...(snapshot.lastActivityAt === null ? {} : { lastActivityAt: snapshot.lastActivityAt }),
    },
    rows,
  };
}

/** Operation-scoped read custody, with no cached fact or presentation fallback. */
export function createLiveStatusReader(paths: AkumaPaths, expected: AkumaId) {
  const reader = createStatusFactReader(paths);
  return {
    clear: reader.clear,
    async tellOutcome(id: string, includeLive: boolean, signal?: AbortSignal) {
      const observed = await bornObservation(paths, expected, () => reader.tellOutcome(id, includeLive, signal));
      const { tell, end, live } = observed.snapshot;
      const exact = { tell, end, life: observed.currentLife };
      if (live === undefined) return { ...exact, live };
      return {
        ...exact,
        async live() {
          signal?.throwIfAborted();
          if ("error" in live) throw live.error;
          return await projectLiveStatus(observed.snapshot, observed.soul, exact.life, live);
        },
      };
    },
    async wait(
      recent: boolean,
      reportAfter: number | null | undefined,
      skipAdvancingOutcome: boolean,
      signal?: AbortSignal,
    ): Promise<WaitStatusObservation> {
      const observed = await bornObservation(paths, expected, (leash) =>
        reader.wait(
          recent,
          reportAfter,
          (snapshot) => !skipAdvancingOutcome || waitComplete(observedLife(snapshot, leash), snapshot.hasPendingTell),
          signal,
        ),
      );
      return { ...observed.snapshot, id: expected, life: observed.currentLife };
    },
    async complete(signal?: AbortSignal): Promise<boolean> {
      const observed = await bornObservation(paths, expected, () => reader.life(signal));
      return waitComplete(observed.currentLife, observed.snapshot.hasPendingTell);
    },
    async read(signal?: AbortSignal): Promise<LiveStatusObservation> {
      try {
        const { snapshot, soul, currentLife } = await bornObservation(paths, expected, () => reader.read(signal, true));
        return await projectLiveStatus(snapshot, soul, currentLife, snapshot.timeline);
      } catch (error) {
        reader.clear();
        throw error;
      }
    },
  };
}

export async function bornLiveStatus(
  paths: AkumaPaths,
  expected: AkumaId,
  signal?: AbortSignal,
): Promise<LiveStatusObservation> {
  const reader = createLiveStatusReader(paths, expected);
  try {
    return await reader.read(signal);
  } finally {
    reader.clear();
  }
}
export async function bornStatus(paths: AkumaPaths, expected: AkumaId): Promise<AkumaStatus> {
  return (await bornLiveStatus(paths, expected)).status;
}
export async function readLiveStatus(
  worldPath: WorldRoot,
  id: AkumaId,
  signal?: AbortSignal,
): Promise<LiveStatusObservation> {
  return await bornLiveStatus(pathsForAkumaId(worldPath, id), id, signal);
}

/** Bounded native current work without status/detail or provider capability. */
export async function readAkumaWork(worldPath: WorldRoot, id: AkumaId): Promise<CurrentWork> {
  const paths = pathsForAkumaId(worldPath, id);
  const reader = createStatusFactReader(paths);
  try {
    const { snapshot } = await bornObservation(paths, id, () => reader.read());
    return projectCurrentWork(snapshot.timeline.map(projectFact));
  } finally {
    reader.clear();
  }
}

export type ExecutionProgress = "settled" | "advancing" | "stopped";
export function executionProgress(
  life: AkumaStatus["life"],
  pending: boolean,
  wake: "launching" | "settled" | "failed" = "settled",
): ExecutionProgress {
  if (wake === "launching" || life === "running") return "advancing";
  if (wake === "failed") return "stopped";
  if (life === "asleep") return pending ? "advancing" : "settled";
  return "stopped";
}
export function waitComplete(life: AkumaStatus["life"], pending: boolean): boolean {
  return executionProgress(life, pending) !== "advancing";
}
export function defaultWaitComplete(status: AkumaStatus): boolean {
  return waitComplete(status.life, status.work.pending !== undefined);
}

export type WaitReason = "completed" | "deadline";
export const OBSERVATION_POLL_MS = 100;

/** A final deadline-edge observation always precedes the completion judgment. */
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
