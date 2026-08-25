import { decodeAgentEvent, type ToolCall, type ToolResult } from "./provider.js";
import type { TellDelivery, TellFact, TimelineFact, TurnEndFact } from "./heart/index.js";

export type TurnOutcome =
  | Readonly<{
      kind: "answered";
      historyId: string;
      answer: string;
    }>
  | Readonly<{ kind: "failed"; historyId: string; diagnostic: string }>;

export type TurnStartRow = Readonly<{
  kind: "turn";
  sequence: number;
  turnSequence: number;
  bodySequence: number;
  at: string;
}>;

type CallRow = Readonly<{ kind: "call"; sequence: number; turnSequence: number; at: string; text: string }>;
type SaidRow = Readonly<{
  kind: "said";
  sequence: number;
  turnSequence: number;
  at: string;
  text: string;
  truncated?: true;
}>;
type ThoughtRow = Readonly<{
  kind: "thought";
  sequence: number;
  turnSequence: number;
  at: string;
  text: string;
  truncated?: true;
}>;
type NoteRow = Readonly<{
  kind: "note";
  sequence: number;
  turnSequence: number;
  at: string;
  text: string;
  truncated?: true;
}>;
type TurnNarrationRow = CallRow | SaidRow | ThoughtRow | NoteRow;

export type TellRow = Readonly<{
  kind: "tell";
  sequence: number;
  at: string;
  tellId: string;
  text: string;
  state: TellFact["state"];
  deliveries: readonly TellDelivery[];
}>;

export type OutcomeRow = Readonly<{
  kind: "outcome";
  sequence: number;
  turnSequence: number;
  at: string;
  outcome: TurnOutcome;
}>;

function publicOutcome(turnSequence: number, outcome: TurnEndFact["outcome"]): TurnOutcome {
  const historyId = `turn/${turnSequence}`;
  return outcome.kind === "answered"
    ? { kind: "answered", historyId, answer: outcome.answer }
    : { kind: "failed", historyId, diagnostic: outcome.diagnostic };
}

export type ActiveToolRow = Readonly<{
  kind: "tool";
  sequence: number;
  turnSequence: number;
  at: string;
  name: string;
  call: ToolCall;
  state: "active";
  truncated?: true;
}>;

export type CompletedToolRow = Readonly<{
  kind: "tool";
  sequence: number;
  turnSequence: number;
  at: string;
  completedAt?: string;
  durationMs?: number;
  name: string;
  call: ToolCall;
  state: ToolResult;
  truncated?: true;
}>;

export type UnsettledToolRow = Readonly<{
  kind: "tool";
  sequence: number;
  turnSequence: number;
  at: string;
  name: string;
  call: ToolCall;
  state: "unsettled";
  truncated?: true;
}>;

export type OpenTurnRow = TurnNarrationRow | ActiveToolRow | CompletedToolRow;
export type ClosedTurnRow = TurnNarrationRow | UnsettledToolRow | CompletedToolRow;

export type OpenTurn = Readonly<{
  kind: "open";
  turn: TurnStartRow;
  rows: readonly OpenTurnRow[];
}>;

export type ClosedTurn = Readonly<{
  kind: "closed";
  turn: TurnStartRow;
  rows: readonly ClosedTurnRow[];
  outcome: OutcomeRow;
}>;

export type ProjectedTurn = OpenTurn | ClosedTurn;
export type ActivityRow = TurnStartRow | OpenTurnRow | ClosedTurnRow | TellRow | OutcomeRow;

type SnapshotFactRow = TurnNarrationRow | TellRow;
export type OpenSnapshotRow = SnapshotFactRow | ActiveToolRow | CompletedToolRow;
export type IdleSnapshotRow = SnapshotFactRow | CompletedToolRow;
export type SnapshotRow = OpenSnapshotRow | IdleSnapshotRow;
export type ActivitySnapshotEntry<Row extends SnapshotRow = SnapshotRow> =
  | Readonly<{ kind: "row"; row: Row }>
  | Readonly<{ kind: "gap"; count: number }>;

export type ReportedFileChange = Readonly<{
  sequence: number;
  at: string;
  op: "add" | "update" | "delete" | "unspecified";
  path: string;
  diffstat?: Readonly<{ added: number; removed: number }>;
}>;

type ReportedChangeSummary = Readonly<{
  reportedChanges: readonly ReportedFileChange[];
  reportedChangesOmitted: number;
}>;

export type Snapshot =
  | Readonly<{ kind: "unborn"; entries: readonly []; omitted: 0 } & ReportedChangeSummary>
  | Readonly<
      {
        kind: "open";
        turn: TurnStartRow;
        entries: readonly ActivitySnapshotEntry<OpenSnapshotRow>[];
        omitted: number;
      } & ReportedChangeSummary
    >
  | Readonly<
      {
        kind: "idle";
        outcome?: OutcomeRow;
        entries: readonly ActivitySnapshotEntry<IdleSnapshotRow>[];
        omitted: number;
      } & ReportedChangeSummary
    >;

export type ActivitySnapshot = Snapshot;

export type ActivityHistory = Readonly<{
  rows: readonly ActivityRow[];
  omitted: number;
  hasEarlier: boolean;
  hasLater: boolean;
  historyLost: boolean;
  lowestRetained: number | null;
  highest: number | null;
}>;

export type ExactHistory =
  | Readonly<{ kind: "exact"; outcome: OutcomeRow }>
  | Readonly<{ kind: "unknown-history"; id: string }>;

export type HistoryPage = ActivityHistory;

export function selectExactHistory(rows: readonly ActivityRow[], id: string): ExactHistory {
  const outcome = rows.find((row): row is OutcomeRow => row.kind === "outcome" && row.outcome.historyId === id);
  return outcome === undefined ? { kind: "unknown-history", id } : { kind: "exact", outcome };
}

export type HistoryCursor = Readonly<{ before?: number; since?: number; limit: number }>;

export type RetainedWindow = Readonly<{
  lowestRetained: number | null;
  highest: number | null;
}>;

export type TurnLedger = Readonly<{
  rows: readonly ActivityRow[];
  turns: readonly ProjectedTurn[];
  retained: RetainedWindow;
  openTurn?: OpenTurn;
  latestOutcome?: OutcomeRow;
}>;

type MutableTurn = {
  phase: "open" | "closed";
  turn: TurnStartRow;
  rows: (OpenTurnRow | UnsettledToolRow)[];
  running: Map<string, number>;
  outcome?: OutcomeRow;
};

type ProjectionState = {
  turns: MutableTurn[];
  turnsBySequence: Map<number, MutableTurn>;
  tells: TellRow[];
  orphanRows: ClosedTurnRow[];
  orphanOutcomes: OutcomeRow[];
  orphanRunning: Map<string, number>;
};

function duration(startedAt: string, completedAt: string): number | undefined {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return end - start;
}

function toolKey(turnSequence: number, id: string): string {
  return `${turnSequence}:${id}`;
}

function narrationRow(
  fact: Extract<TimelineFact, { event: unknown }>,
  event: ReturnType<typeof decodeAgentEvent>,
): TurnNarrationRow | null {
  if (event.type === "assistant") {
    return {
      kind: "said",
      sequence: fact.sequence,
      turnSequence: fact.turnSequence,
      at: fact.at,
      text: event.text,
      ...(event.truncated === true ? { truncated: true } : {}),
    };
  }
  if (event.type === "thought" || event.type === "note") {
    return {
      kind: event.type,
      sequence: fact.sequence,
      turnSequence: fact.turnSequence,
      at: fact.at,
      text: event.text,
      ...(event.truncated === true ? { truncated: true } : {}),
    };
  }
  return null;
}

function projectToolEvent(
  rows: (OpenTurnRow | UnsettledToolRow)[],
  running: Map<string, number>,
  fact: Extract<TimelineFact, { kind: "activity" }>,
  event: Extract<ReturnType<typeof decodeAgentEvent>, { type: "tool" }>,
  phase: "open" | "closed",
): void {
  const key = toolKey(fact.turnSequence, event.id);
  if (event.phase === "started") {
    running.set(key, rows.length);
    rows.push({
      kind: "tool",
      sequence: fact.sequence,
      turnSequence: fact.turnSequence,
      at: fact.at,
      name: event.name,
      call: event.call,
      state: phase === "open" ? "active" : "unsettled",
      ...(event.truncated === true ? { truncated: true } : {}),
    });
    return;
  }
  const index = running.get(key);
  const started = index === undefined ? undefined : rows[index];
  if (started?.kind !== "tool") {
    rows.push({
      kind: "tool",
      sequence: fact.sequence,
      turnSequence: fact.turnSequence,
      at: fact.at,
      name: event.name,
      call: event.call,
      state: event.result,
      ...(event.truncated === true ? { truncated: true } : {}),
    });
    return;
  }
  const durationMs = duration(started.at, fact.at);
  rows[index!] = {
    kind: "tool",
    sequence: started.sequence,
    turnSequence: fact.turnSequence,
    at: started.at,
    completedAt: fact.at,
    ...(durationMs === undefined ? {} : { durationMs }),
    name: event.name,
    call: event.call,
    state: event.result,
    ...(started.truncated === true || event.truncated === true ? { truncated: true } : {}),
  };
  running.delete(key);
}

function projectActivityEvent(state: ProjectionState, fact: Extract<TimelineFact, { kind: "activity" }>): void {
  const event = decodeAgentEvent(fact.event);
  const narration = narrationRow(fact, event);
  if (narration !== null) {
    const turn = state.turnsBySequence.get(fact.turnSequence);
    if (turn === undefined) state.orphanRows.push(narration);
    else turn.rows.push(narration);
    return;
  }
  if (event.type !== "tool") return;
  const turn = state.turnsBySequence.get(fact.turnSequence);
  if (turn === undefined) projectToolEvent(state.orphanRows, state.orphanRunning, fact, event, "closed");
  else projectToolEvent(turn.rows, turn.running, fact, event, turn.phase);
}

function demoteActive(row: OpenTurnRow | UnsettledToolRow): ClosedTurnRow {
  if (row.kind !== "tool" || row.state !== "active") return row;
  return { ...row, state: "unsettled" };
}

function foldOutcomeVoice(
  rows: readonly (OpenTurnRow | UnsettledToolRow)[],
  outcome: OutcomeRow | undefined,
): readonly (OpenTurnRow | UnsettledToolRow)[] {
  if (outcome?.outcome.kind !== "answered") return rows;
  const finalVoice = rows.findLast((row): row is SaidRow => row.kind === "said");
  return finalVoice?.text === outcome.outcome.answer && finalVoice.truncated !== true
    ? rows.filter((row) => row !== finalVoice)
    : rows;
}

function finishTurn(turn: MutableTurn): ProjectedTurn {
  const rows = foldOutcomeVoice(turn.rows, turn.outcome);
  if (turn.phase === "closed" && turn.outcome !== undefined) {
    return { kind: "closed", turn: turn.turn, rows: rows.map(demoteActive), outcome: turn.outcome };
  }
  if (rows.some((row) => row.kind === "tool" && row.state === "unsettled")) {
    throw new Error(`open Turn ${turn.turn.turnSequence} contains an unsettled tool`);
  }
  return { kind: "open", turn: turn.turn, rows: rows as readonly OpenTurnRow[] };
}

function finishLedger(state: ProjectionState, retained: RetainedWindow): TurnLedger {
  const turns = state.turns.map(finishTurn);
  const rows: readonly ActivityRow[] = [
    ...turns.flatMap((turn) => [turn.turn, ...turn.rows, ...(turn.kind === "closed" ? [turn.outcome] : [])]),
    ...state.tells,
    ...state.orphanRows,
    ...state.orphanOutcomes,
  ].sort((left, right) => left.sequence - right.sequence);
  const frontier = turns.at(-1);
  const openTurn = frontier?.kind === "open" ? frontier : undefined;
  const latestOutcome = rows.findLast((row): row is OutcomeRow => row.kind === "outcome");
  return {
    rows,
    turns,
    retained,
    ...(openTurn === undefined ? {} : { openTurn }),
    ...(latestOutcome === undefined ? {} : { latestOutcome }),
  };
}

/** Fold the retained fact timeline into Turn-owned rows without inventing provider facts. */
export function projectTurns(
  facts: readonly TimelineFact[],
  retained: RetainedWindow = {
    lowestRetained: facts[0]?.sequence ?? null,
    highest: facts.at(-1)?.sequence ?? null,
  },
): TurnLedger {
  const state: ProjectionState = {
    turns: [],
    turnsBySequence: new Map(),
    tells: [],
    orphanRows: [],
    orphanOutcomes: [],
    orphanRunning: new Map(),
  };
  for (const fact of facts) {
    if (fact.kind === "turn-start") {
      const turn = {
        kind: "turn" as const,
        sequence: fact.sequence,
        turnSequence: fact.sequence,
        bodySequence: fact.bodySequence,
        at: fact.startedAt,
      };
      const projected: MutableTurn = { phase: "open", turn, rows: [], running: new Map() };
      state.turns.push(projected);
      state.turnsBySequence.set(turn.turnSequence, projected);
    } else if (fact.kind === "turn-end") {
      const outcome = {
        kind: "outcome" as const,
        sequence: fact.sequence,
        turnSequence: fact.turnSequence,
        at: fact.completedAt,
        outcome: publicOutcome(fact.turnSequence, fact.outcome),
      };
      const turn = state.turnsBySequence.get(fact.turnSequence);
      if (turn === undefined) state.orphanOutcomes.push(outcome);
      else {
        turn.phase = "closed";
        turn.rows = turn.rows.map(demoteActive);
        turn.outcome = outcome;
      }
    } else if (fact.kind === "call") {
      const row = {
        kind: "call" as const,
        sequence: fact.sequence,
        turnSequence: fact.turnSequence,
        at: fact.at,
        text: fact.body,
      };
      const turn = state.turnsBySequence.get(fact.turnSequence);
      if (turn === undefined) state.orphanRows.push(row);
      else turn.rows.push(row);
    } else if (fact.kind === "tell") {
      state.tells.push({
        kind: "tell",
        sequence: fact.sequence,
        at: fact.recordedAt,
        tellId: fact.id,
        text: fact.body,
        state: fact.state,
        deliveries: fact.deliveries,
      });
    } else {
      projectActivityEvent(state, fact);
    }
  }
  return finishLedger(state, retained);
}

export { ordinarySnapshotBudget, selectHistory, selectSnapshot } from "./projection-read.js";
