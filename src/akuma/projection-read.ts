import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ActivityRow,
  ActivitySnapshot,
  ActivitySnapshotEntry,
  ClosedTurn,
  CompletedToolRow,
  OpenSnapshotRow,
  HistoryCursor,
  HistoryPage,
  OpenTurnRow,
  ReportedFileChange,
  SnapshotRow,
  TellRow,
  TurnLedger,
  UnsettledToolRow,
} from "./projection.js";

export const DEFAULT_TAIL = 3;
const REPORTED_CHANGE_LIMIT = 5;

type ReportedChangeSummary = Readonly<{
  reportedChanges: readonly ReportedFileChange[];
  reportedChangesOmitted: number;
  reportedChangesOutside?: number;
}>;

const EMPTY_REPORTED: ReportedChangeSummary = { reportedChanges: [], reportedChangesOmitted: 0 };

/** Present the same snapshot without its reported-change summary. */
export function withoutReportedChanges(snapshot: ActivitySnapshot): ActivitySnapshot {
  const { reportedChangesOutside: _outside, ...rest } = snapshot;
  return { ...rest, reportedChanges: [], reportedChangesOmitted: 0 };
}

function assembleEntries<Row extends SnapshotRow>(
  ledger: TurnLedger,
  window: readonly ActivityRow[],
  selected: ReadonlySet<ActivityRow>,
): readonly ActivitySnapshotEntry<Row>[] {
  const windowRows = new Set<ActivityRow>(window);
  const result: ActivitySnapshotEntry<Row>[] = [];
  let hidden = 0;
  const flushGap = (): void => {
    if (hidden === 0) return;
    result.push({ kind: "gap", count: hidden });
    hidden = 0;
  };
  for (const row of ledger.rows) {
    if (windowRows.has(row) && !selected.has(row)) {
      hidden += 1;
      continue;
    }
    if (!selected.has(row)) continue;
    flushGap();
    if (row.kind !== "turn" && row.kind !== "outcome" && !(row.kind === "tool" && row.state === "unsettled")) {
      result.push({ kind: "row", row: row as Row });
    }
  }
  flushGap();
  return result;
}

type SuccessfulFileChangeRow = CompletedToolRow &
  Readonly<{ call: Extract<CompletedToolRow["call"], { kind: "fileChange" }> }>;
function isSuccessfulFileChange(row: OpenTurnRow | UnsettledToolRow): row is SuccessfulFileChangeRow {
  return (
    row.kind === "tool" && typeof row.state === "object" && row.state.status === "ok" && row.call.kind === "fileChange"
  );
}
function flattenReportedChanges(rows: readonly (OpenTurnRow | UnsettledToolRow)[]): readonly ReportedFileChange[] {
  return rows.flatMap((row) => {
    if (!isSuccessfulFileChange(row)) return [];
    return row.call.changes.map((change) => ({
      path: change.path,
      ...(change.diffstat === undefined ? {} : { diffstat: change.diffstat }),
    }));
  });
}

type AggregatedReportedChange = {
  path: string;
  lastIndex: number;
  added: number;
  removed: number;
  complete: boolean;
};

function aggregateReportedChanges(changes: readonly ReportedFileChange[]): readonly ReportedFileChange[] {
  const groups = new Map<string, AggregatedReportedChange>();
  changes.forEach((change, index) => {
    const current = groups.get(change.path);
    const diffstat = change.diffstat;
    if (current === undefined) {
      groups.set(change.path, {
        path: change.path,
        lastIndex: index,
        added: diffstat?.added ?? 0,
        removed: diffstat?.removed ?? 0,
        complete: diffstat !== undefined,
      });
      return;
    }
    current.lastIndex = index;
    if (diffstat === undefined) current.complete = false;
    else {
      current.added += diffstat.added;
      current.removed += diffstat.removed;
    }
  });
  return [...groups.values()]
    .sort((left, right) => left.lastIndex - right.lastIndex)
    .map((group) =>
      group.complete
        ? { path: group.path, diffstat: { added: group.added, removed: group.removed } }
        : { path: group.path },
    );
}

function summarizeReportedChanges(
  rows: readonly (OpenTurnRow | UnsettledToolRow)[],
  executionDir?: string,
  canonicalize?: (absolutePath: string) => string,
): ReportedChangeSummary {
  const files = aggregateReportedChanges(flattenReportedChanges(rows));
  const inside = files.filter((change) => {
    if (executionDir === undefined) return true;
    const absolute = resolve(executionDir, change.path);
    const path = relative(executionDir, canonicalize === undefined ? absolute : canonicalize(absolute));
    return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  });
  const outside = files.length - inside.length;
  return {
    reportedChanges: inside.slice(-REPORTED_CHANGE_LIMIT),
    reportedChangesOmitted: Math.max(0, inside.length - REPORTED_CHANGE_LIMIT),
    ...(outside === 0 ? {} : { reportedChangesOutside: outside }),
  };
}
function frontierRows(ledger: TurnLedger): readonly (OpenTurnRow | UnsettledToolRow)[] {
  if (ledger.openTurn !== undefined) return ledger.openTurn.rows;
  const closed = ledger.turns.findLast((turn): turn is ClosedTurn => turn.kind === "closed");
  return closed?.rows ?? [];
}
function frontierReportedChanges(
  ledger: TurnLedger,
  executionDir?: string,
  canonicalize?: (absolutePath: string) => string,
): ReportedChangeSummary {
  return summarizeReportedChanges(frontierRows(ledger), executionDir, canonicalize);
}
/** Raw reported spellings on the current frontier, before containment partitioning. */
export function reportedChangePaths(ledger: TurnLedger): readonly string[] {
  return flattenReportedChanges(frontierRows(ledger)).map((change) => change.path);
}
function isPendingTell(row: ActivityRow): row is TellRow {
  return row.kind === "tell" && row.state === "pending";
}
function isProtectedTool(row: ActivityRow): boolean {
  return row.kind === "tool" && (typeof row.state === "string" || row.state.status === "error");
}

function isSettledTellDeliveredTo(row: ActivityRow, turnSequence: number): row is TellRow {
  return (
    row.kind === "tell" &&
    row.state === "told" &&
    row.deliveries.some((delivery) => delivery.turnSequence === turnSequence)
  );
}

function currentTurnWindow(ledger: TurnLedger): readonly ActivityRow[] {
  const turn = ledger.openTurn;
  if (turn === undefined) return [];
  const turnRows = new Set<ActivityRow>(turn.rows);
  return ledger.rows.filter((row) => turnRows.has(row) || isSettledTellDeliveredTo(row, turn.turn.sequence));
}

function openingInput(ledger: TurnLedger): ActivityRow | undefined {
  const turn = ledger.openTurn;
  if (turn === undefined) return undefined;
  const call = turn.rows.find((row) => row.kind === "call");
  if (call !== undefined) return call;
  return ledger.rows.find(
    (row) =>
      row.kind === "tell" &&
      row.state === "told" &&
      row.deliveries.some((delivery) => delivery.route === "launch" && delivery.turnSequence === turn.turn.sequence),
  );
}

export function selectSnapshot(
  ledger: TurnLedger,
  input: Readonly<{
    aperture: "monitoring" | "receipt";
    budget?: Readonly<{ tail: number }>;
    executionDir?: string;
    admittedTellId?: string;
    canonicalize?: (absolutePath: string) => string;
  }>,
): Readonly<{ snapshot: ActivitySnapshot; ordinaryCount: number }> {
  const tailCount = Math.min(DEFAULT_TAIL, Math.max(0, input.budget?.tail ?? DEFAULT_TAIL));
  if (ledger.turns.length === 0 && !ledger.rows.some((row) => row.kind === "tell"))
    return { snapshot: { kind: "unborn", entries: [], ...EMPTY_REPORTED }, ordinaryCount: 0 };
  const receiptTellId = input.aperture === "receipt" ? input.admittedTellId : undefined;
  const pending = ledger.rows.filter(isPendingTell);
  const admittedTell =
    receiptTellId === undefined
      ? undefined
      : ledger.rows.find((row) => row.kind === "tell" && row.tellId === receiptTellId);
  const pins: readonly ActivityRow[] =
    receiptTellId === undefined ? pending : admittedTell === undefined ? [] : [admittedTell];
  const reported = frontierReportedChanges(ledger, input.executionDir, input.canonicalize);
  if (ledger.openTurn !== undefined) {
    const window = currentTurnWindow(ledger);
    const opening = openingInput(ledger);
    const latestSaid = window.findLast((row) => row.kind === "said");
    const pinSet = new Set<ActivityRow>([
      ...window.filter(isProtectedTool),
      ...(latestSaid === undefined ? [] : [latestSaid]),
      ...pins,
      ...(opening === undefined ? [] : [opening]),
    ]);
    const ordinary = window.filter((row) => !pinSet.has(row));
    const tail = tailCount === 0 ? [] : ordinary.slice(-tailCount);
    const selected = new Set<ActivityRow>([...pinSet, ...tail]);
    return {
      snapshot: {
        kind: "open",
        turn: ledger.openTurn.turn,
        entries: assembleEntries<OpenSnapshotRow>(ledger, window, selected),
        ...(opening === undefined ? {} : { openingSequence: opening.sequence }),
        ...reported,
      },
      ordinaryCount: tail.length,
    };
  }
  return {
    snapshot: {
      kind: "idle",
      ...(ledger.latestOutcome === undefined ? {} : { outcome: ledger.latestOutcome }),
      entries: assembleEntries(ledger, [], new Set(pins)),
      ...reported,
    },
    ordinaryCount: 0,
  };
}

export function selectHistory(ledger: TurnLedger, cursor: HistoryCursor): HistoryPage {
  const eligible = ledger.rows.filter((row) =>
    cursor.before !== undefined
      ? row.sequence < cursor.before
      : cursor.since !== undefined
        ? row.sequence > cursor.since
        : true,
  );
  const rows = cursor.since !== undefined ? eligible.slice(0, cursor.limit) : eligible.slice(-cursor.limit);
  const omitted = Math.max(0, eligible.length - rows.length);
  const historyLost =
    cursor.since !== undefined
      ? ledger.rows[0] !== undefined && ledger.rows[0].sequence > cursor.since + 1
      : ledger.retained.lowestRetained !== null && ledger.retained.lowestRetained > 1 && omitted === 0;
  return {
    rows,
    omitted,
    hasEarlier: cursor.since === undefined && eligible.length > rows.length,
    hasLater: cursor.since !== undefined && eligible.length > rows.length,
    historyLost,
    lowestRetained: ledger.retained.lowestRetained,
    highest: ledger.retained.highest,
  };
}
