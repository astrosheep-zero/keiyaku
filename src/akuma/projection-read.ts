import { selectHistoryPage } from "../history.js";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ActivityRow, HistoryCursor, HistoryPage, ReportedFileChange } from "./projection.js";
import { projectCurrentWork } from "./status-projection.js";

function accumulateChange(previous: ReportedFileChange | undefined, change: ReportedFileChange): ReportedFileChange {
  if (previous === undefined)
    return { path: change.path, ...(change.diffstat === undefined ? {} : { diffstat: change.diffstat }) };
  const before = previous.diffstat;
  const after = change.diffstat;
  return before === undefined || after === undefined
    ? { path: change.path }
    : { path: change.path, diffstat: { added: before.added + after.added, removed: before.removed + after.removed } };
}

/** Turn membership follows retained coordinates, including delivered Tells. */
export function frontierRows(rows: readonly ActivityRow[]): readonly ActivityRow[] {
  const turn = rows.findLast((row) => row.kind === "turn");
  return rows.filter((row) =>
    row.kind === "tell"
      ? row.deliveries.some((delivery) => delivery.turnSequence === turn?.sequence)
      : row.kind === "turn"
        ? row.sequence === turn?.sequence
        : "turnSequence" in row && row.turnSequence === turn?.sequence,
  );
}

/** Native status derives work, its three-row detail and advisory changes together. */
export function summarizeFrontier(rows: readonly ActivityRow[], executionDir: string) {
  const work = projectCurrentWork(rows);
  const frontier = frontierRows(rows);
  const changes = new Map<string, ReportedFileChange>();
  for (const row of frontier) {
    if (
      row.kind !== "tool" ||
      row.phase !== "completed" ||
      row.result?.status !== "ok" ||
      row.call.kind !== "fileChange"
    )
      continue;
    for (const change of row.call.changes) {
      const combined = accumulateChange(changes.get(change.path), change);
      changes.delete(change.path);
      changes.set(change.path, combined);
    }
  }
  const inside = [...changes.values()].filter((change) => {
    const path = relative(executionDir, resolve(executionDir, change.path));
    return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  });
  const outside = changes.size - inside.length;
  return {
    work,
    ...(frontier.length === 0 ? {} : { recent: frontier.slice(-3) }),
    ...(inside.length === 0 ? {} : { changes: inside.slice(-5) }),
    ...(inside.length > 5 ? { moreChanges: true as const } : {}),
    ...(outside === 0 ? {} : { outsideChanges: outside }),
  };
}

export function selectHistory(
  timeline: Readonly<{ rows: readonly ActivityRow[]; lowestRetained: number | null; highest: number | null }>,
  cursor: HistoryCursor,
): HistoryPage {
  const { rows, omitted } = selectHistoryPage(timeline.rows, (row) => row.sequence, cursor);
  const historyLost =
    cursor.since !== undefined
      ? timeline.rows[0] !== undefined && timeline.rows[0].sequence > cursor.since + 1
      : timeline.lowestRetained !== null && timeline.lowestRetained > 1 && omitted === 0;
  return {
    rows,
    omitted,
    hasEarlier: cursor.since === undefined && omitted > 0,
    hasLater: cursor.since !== undefined && omitted > 0,
    historyLost,
    lowestRetained: timeline.lowestRetained,
    highest: timeline.highest,
  };
}
