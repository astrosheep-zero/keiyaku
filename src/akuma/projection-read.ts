import type {
  ActivityRow,
  ActivitySnapshot,
  ActivitySnapshotEntry,
  ClosedTurn,
  CompletedToolRow,
  OpenSnapshotRow,
  OpenTurnRow,
  ReportedFileChange,
  SnapshotRow,
  TellRow,
  TurnLedger,
  UnsettledToolRow,
} from "./projection.js";

const DEFAULT_TAIL = 3;
const DEFAULT_VOICE = 3;
const REPORTED_CHANGE_LIMIT = 5;

type ReportedChangeSummary = Readonly<{
  reportedChanges: readonly ReportedFileChange[];
  reportedChangesOmitted: number;
}>;

const EMPTY_REPORTED: ReportedChangeSummary = { reportedChanges: [], reportedChangesOmitted: 0 };

import type { HistoryCursor, HistoryPage } from "./projection.js";

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

const DEFAULT_ORDINARY = DEFAULT_TAIL + DEFAULT_VOICE;

export function ordinarySnapshotBudget(
  ordinaryBudget: number = DEFAULT_ORDINARY,
): Readonly<{ tail: number; voice: number }> {
  const tail = Math.min(DEFAULT_TAIL, Math.max(0, ordinaryBudget));
  return { tail, voice: Math.min(DEFAULT_VOICE, Math.max(0, ordinaryBudget) - tail) };
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
      sequence: row.sequence,
      at: row.at,
      op: change.op,
      path: change.path,
      ...(change.diffstat === undefined ? {} : { diffstat: change.diffstat }),
    }));
  });
}
function summarizeReportedChanges(rows: readonly (OpenTurnRow | UnsettledToolRow)[]): ReportedChangeSummary {
  const eligible = flattenReportedChanges(rows);
  return {
    reportedChanges: eligible.slice(-REPORTED_CHANGE_LIMIT),
    reportedChangesOmitted: Math.max(0, eligible.length - REPORTED_CHANGE_LIMIT),
  };
}
function frontierReportedChanges(ledger: TurnLedger): ReportedChangeSummary {
  if (ledger.openTurn !== undefined) return summarizeReportedChanges(ledger.openTurn.rows);
  const closed = ledger.turns.findLast((turn): turn is ClosedTurn => turn.kind === "closed");
  return closed === undefined ? EMPTY_REPORTED : summarizeReportedChanges(closed.rows);
}
function isPendingTell(row: ActivityRow): row is TellRow {
  return row.kind === "tell" && row.state === "pending";
}
function isToldTell(row: ActivityRow): row is TellRow {
  return row.kind === "tell" && row.state === "told";
}
function isActiveTool(row: ActivityRow): boolean {
  return row.kind === "tool" && row.state === "active";
}

export function selectSnapshot(
  ledger: TurnLedger,
  input: Readonly<{
    aperture: "monitoring" | "receipt";
    budget?: Readonly<{ tail: number; voice?: number }>;
    admittedTellId?: string;
  }>,
): Readonly<{ snapshot: ActivitySnapshot; ordinaryCount: number }> {
  const budget = input.budget ?? { tail: DEFAULT_TAIL, voice: DEFAULT_VOICE };
  if (ledger.turns.length === 0 && !ledger.rows.some((row) => row.kind === "tell"))
    return { snapshot: { kind: "unborn", entries: [], omitted: 0, ...EMPTY_REPORTED }, ordinaryCount: 0 };
  const pending = ledger.rows.filter(isPendingTell);
  const latestTold = input.aperture === "monitoring" ? ledger.rows.findLast(isToldTell) : undefined;
  const admittedTell =
    input.aperture === "receipt" && input.admittedTellId !== undefined
      ? ledger.rows.find((row) => row.kind === "tell" && row.tellId === input.admittedTellId)
      : undefined;
  const pins: readonly ActivityRow[] = [
    ...pending,
    ...(latestTold === undefined ? [] : [latestTold]),
    ...(admittedTell === undefined ? [] : [admittedTell]),
  ];
  const reported = frontierReportedChanges(ledger);
  if (ledger.openTurn !== undefined) {
    const window = ledger.openTurn.rows;
    const pinSet = new Set<ActivityRow>([...window.filter(isActiveTool), ...pins]);
    const ordinary = window.filter((row) => !pinSet.has(row));
    const tailCount = Math.max(0, budget.tail);
    const tail = tailCount === 0 ? [] : ordinary.slice(-tailCount);
    const tailSet = new Set(tail);
    const voiceCount = Math.max(0, budget.voice ?? DEFAULT_VOICE);
    const voiceCandidates = ordinary.filter(
      (row) => !tailSet.has(row) && (row.kind === "said" || row.kind === "thought"),
    );
    const voice = voiceCount === 0 ? [] : voiceCandidates.slice(-voiceCount);
    const selected = new Set<ActivityRow>([...pinSet, ...tail, ...voice]);
    const omitted = window.filter((row) => !selected.has(row)).length;
    return {
      snapshot: {
        kind: "open",
        turn: ledger.openTurn.turn,
        entries: assembleEntries<OpenSnapshotRow>(ledger, window, selected),
        omitted,
        ...reported,
      },
      ordinaryCount: tail.length + voice.length,
    };
  }
  return {
    snapshot: {
      kind: "idle",
      ...(ledger.latestOutcome === undefined ? {} : { outcome: ledger.latestOutcome }),
      entries: assembleEntries(ledger, [], new Set(pins)),
      omitted: 0,
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
