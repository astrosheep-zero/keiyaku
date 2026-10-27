import { lstat } from "node:fs/promises";
import type { KnownAkuma } from "./akuma.js";
import { rosterListRow } from "./akuma-observe.js";
import { removeAkumaCustody } from "./custody.js";
import { HeldAkumaLeash, life, lifeAt, readHeart } from "./heart/index.js";

/** The one default age after which an inactive Akuma entry may be retired. */
export const AKUMA_RETENTION_MAX_IDLE_MS = 15 * 24 * 60 * 60 * 1_000;

/** The retention owner's one clock reading; the sweep itself never reads ambient time. */
export function retentionNow(): number {
  return new Date().getTime();
}

export type AkumaRetentionReceipt = "retired" | "retained" | "busy";

/** A cross-authority custody decision that may hold its locks across the effect. */
export type AkumaRetirementCustody = (retire: () => Promise<boolean>) => Promise<AkumaRetentionReceipt>;

/**
 * The later durable life or activity instant, or null when either present
 * timestamp cannot be read. A missing timestamp contributes nothing; a
 * malformed one means this observation cannot prove age.
 */
export function latestRetentionActivity(lifeAtValue: string | null, lastActivityAt: string | null): number | null {
  const instants = [lifeAtValue, lastActivityAt].flatMap((value) => (value === null ? [] : [Date.parse(value)]));
  if (instants.some((instant) => !Number.isFinite(instant))) return null;
  return instants.length === 0 ? null : Math.max(...instants);
}

/** The strict age cutoff shared by candidate reading and final revalidation. */
function isStale(now: number, activityAt: number | null): boolean {
  return activityAt !== null && now - activityAt > AKUMA_RETENTION_MAX_IDLE_MS;
}

/**
 * A cheap metadata bound, never semantic proof. Only a Heart whose last
 * filesystem write is already older than the retention age reaches a Heart
 * open; unreadable metadata stays conservative and skips the candidate.
 */
export async function retentionCandidateBound(paths: KnownAkuma["paths"], now: number): Promise<boolean> {
  const read = async (path: string): Promise<number> => {
    try {
      const value = await lstat(path);
      return value.isFile() ? value.mtimeMs : Number.POSITIVE_INFINITY;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? 0 : Number.POSITIVE_INFINITY;
    }
  };
  const bound = Math.max(await read(paths.heart), await read(`${paths.heart}-wal`));
  if (!Number.isFinite(bound)) return false;
  return bound < now - AKUMA_RETENTION_MAX_IDLE_MS;
}

/**
 * One born, readable, stopped entry whose durable activity is strictly older
 * than the default retention age. Unborn, stillborn, running, pending-input,
 * malformed, and missing-age entries never become candidates.
 */
export async function readRetentionCandidate(entry: KnownAkuma, now: number): Promise<KnownAkuma | null> {
  const row = await rosterListRow(entry.paths, entry.id);
  if (!("lifeAt" in row) || row.life === "running" || row.pending.length > 0) return null;
  return isStale(now, latestRetentionActivity(row.lifeAt, row.lastActivityAt)) ? entry : null;
}

function currentStoppedActivity(snapshot: Awaited<ReturnType<typeof readHeart>>): number | null {
  const soul = snapshot.soul;
  if (soul === null) return null;
  if (snapshot.latestBody?.end === undefined) return null;
  if (snapshot.pending.length > 0) return null;
  const currentLife = life({ leash: "free", body: snapshot.latestBody, kill: snapshot.latestKill });
  if (currentLife === "running") return null;
  return latestRetentionActivity(
    lifeAt(currentLife, snapshot.latestBody, snapshot.latestKill, soul.createdAt),
    snapshot.lastActivityAt,
  );
}

/**
 * Revalidate one candidate under exclusive stopped custody and remove its
 * recognized custody. The caller's custody action runs while the leash is
 * held and may hold Alias or Dispatch publication custody across the `retire`
 * action, so a concurrent wake, alias move, or new Dispatch cannot interleave
 * between the final judgment and removal. `retire` itself re-reads Heart as the
 * last step before deleting and refuses when the entry is no longer eligible.
 * Tell admission has no shared custody here: a pending Tell observed by that
 * final read is preserved, but an admission immediately after it is a
 * documented best-effort boundary, not an atomic guarantee. A busy leash,
 * changed Heart, admitted pending input, or refused judgment leaves the entry
 * intact.
 */
export async function retireInactiveAkuma(
  input: Readonly<{
    entry: KnownAkuma;
    now: number;
    retireUnderCustody: AkumaRetirementCustody;
  }>,
): Promise<AkumaRetentionReceipt> {
  const leash = await HeldAkumaLeash.try(input.entry.paths);
  if (leash === null) return "busy";
  try {
    const eligible = async (): Promise<boolean> => {
      const snapshot = await readHeart(input.entry.paths);
      if (snapshot.soul === null || snapshot.soul.id !== input.entry.id) return false;
      return isStale(input.now, currentStoppedActivity(snapshot));
    };
    if (!(await eligible())) return "retained";
    return await input.retireUnderCustody(async () => {
      if (!(await eligible())) return false;
      await removeAkumaCustody(input.entry);
      return true;
    });
  } finally {
    leash.release();
  }
}
