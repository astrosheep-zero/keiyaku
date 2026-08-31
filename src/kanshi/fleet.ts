import type { AkumaKanshiRow } from "./report.js";

export const FLEET_VISIBLE_ROWS = 10;
export const FLEET_SNAPSHOT_ROWS = 3;

export function fleetUpdatedAt(row: AkumaKanshiRow): string | null {
  const lifeAt = "lifeAt" in row ? row.lifeAt : null;
  const lastActivityAt = "lastActivityAt" in row ? row.lastActivityAt : null;
  if (lifeAt === null) return lastActivityAt;
  if (lastActivityAt === null) return lifeAt;
  return lifeAt > lastActivityAt ? lifeAt : lastActivityAt;
}

/** The Fleet aperture and snapshot readers share this one visible-row order. */
export function visibleFleetRows(rows: readonly AkumaKanshiRow[]): readonly AkumaKanshiRow[] {
  return [...rows]
    .sort((left, right) => {
      const leftAt = fleetUpdatedAt(left);
      const rightAt = fleetUpdatedAt(right);
      if (leftAt === rightAt) return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      if (leftAt === null) return 1;
      if (rightAt === null) return -1;
      return leftAt > rightAt ? -1 : 1;
    })
    .slice(0, FLEET_VISIBLE_ROWS);
}
