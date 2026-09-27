import type { AkumaKanshiRow } from "./report.js";

export const ROSTER_VISIBLE_ROWS = 10;
export const ROSTER_SNAPSHOT_ROWS = 3;

export function rosterUpdatedAt(row: AkumaKanshiRow): string | null {
  const lifeAt = "lifeAt" in row ? row.lifeAt : null;
  const lastActivityAt = "lastActivityAt" in row ? row.lastActivityAt : null;
  if (lifeAt === null) return lastActivityAt;
  if (lastActivityAt === null) return lifeAt;
  return lifeAt > lastActivityAt ? lifeAt : lastActivityAt;
}

/** The Roster aperture and snapshot readers share this one visible-row order. */
export function visibleRosterRows(rows: readonly AkumaKanshiRow[]): readonly AkumaKanshiRow[] {
  return [...rows]
    .sort((left, right) => {
      const leftAt = rosterUpdatedAt(left);
      const rightAt = rosterUpdatedAt(right);
      if (leftAt === rightAt) return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      if (leftAt === null) return 1;
      if (rightAt === null) return -1;
      return leftAt > rightAt ? -1 : 1;
    })
    .slice(0, ROSTER_VISIBLE_ROWS);
}
