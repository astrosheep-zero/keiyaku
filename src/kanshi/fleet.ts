import type { AkumaKanshiRow } from "./report.js";

export const FLEET_VISIBLE_ROWS = 10;
export const FLEET_SNAPSHOT_ROWS = 3;

function isLost(life: string): boolean {
  return life === "stranded" || life === "hung" || life === "untidy";
}

/** The Fleet aperture and snapshot readers share this one visible-row order. */
export function akumaHot(row: AkumaKanshiRow): boolean {
  if (row.life === "running" || row.life === "stillborn" || isLost(row.life)) return true;
  return row.contract?.observed === "missing" || row.contract?.observed === "unavailable";
}

export function visibleFleetRows(rows: readonly AkumaKanshiRow[]): readonly AkumaKanshiRow[] {
  return [...rows.filter(akumaHot), ...rows.filter((row) => !akumaHot(row))].slice(0, FLEET_VISIBLE_ROWS);
}
