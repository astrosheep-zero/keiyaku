import { decodeAgentEvent, type ToolCall, type ToolResult } from "./provider.js";
import type {
  TellDelivery,
  TellFact,
  TimelineFact,
  TurnEndFact,
} from "./heart/index.js";

const DEFAULT_TAIL = 3;
const DEFAULT_VOICE = 3;

export type TurnOutcome = TurnEndFact["outcome"];

export type TurnStartRow = Readonly<{
  kind: "turn";
  sequence: number;
  turnSequence: number;
  bodySequence: number;
  at: string;
}>;

type CallRow = Readonly<{ kind: "call"; sequence: number; turnSequence: number; at: string; text: string }>;
type SaidRow = Readonly<{ kind: "said"; sequence: number; turnSequence: number; at: string; text: string; truncated?: true }>;
type ThoughtRow = Readonly<{ kind: "thought"; sequence: number; turnSequence: number; at: string; text: string; truncated?: true }>;
type NoteRow = Readonly<{ kind: "note"; sequence: number; turnSequence: number; at: string; text: string; truncated?: true }>;
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
export type ActivitySnapshotEntry<Row extends SnapshotRow = SnapshotRow> = Readonly<{ kind: "row"; row: Row }>;

export type Snapshot =
  | Readonly<{ kind: "unborn"; entries: readonly []; omitted: 0 }>
  | Readonly<{
      kind: "open";
      turn: TurnStartRow;
      entries: readonly ActivitySnapshotEntry<OpenSnapshotRow>[];
      omitted: number;
    }>
  | Readonly<{
      kind: "idle";
      outcome?: OutcomeRow;
      entries: readonly ActivitySnapshotEntry<IdleSnapshotRow>[];
      omitted: number;
    }>;

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

export type HistoryPage = ActivityHistory;

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
    return { kind: "said", sequence: fact.sequence, turnSequence: fact.turnSequence, at: fact.at, text: event.text,
      ...(event.truncated === true ? { truncated: true } : {}) };
  }
  if (event.type === "thought" || event.type === "note") {
    return { kind: event.type, sequence: fact.sequence, turnSequence: fact.turnSequence, at: fact.at, text: event.text,
      ...(event.truncated === true ? { truncated: true } : {}) };
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
    rows.push({ kind: "tool", sequence: fact.sequence, turnSequence: fact.turnSequence, at: fact.at, name: event.name, call: event.call, state: event.result, ...(event.truncated === true ? { truncated: true } : {}) });
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

/** Fold the retained fact timeline into Turn-owned rows without inventing provider facts. */
export function projectTurns(facts: readonly TimelineFact[], retained: RetainedWindow = {
  lowestRetained: facts[0]?.sequence ?? null,
  highest: facts.at(-1)?.sequence ?? null,
}): TurnLedger {
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
      const turn = { kind: "turn" as const, sequence: fact.sequence, turnSequence: fact.sequence, bodySequence: fact.bodySequence, at: fact.startedAt };
      const projected: MutableTurn = { phase: "open", turn, rows: [], running: new Map() };
      state.turns.push(projected);
      state.turnsBySequence.set(turn.turnSequence, projected);
    } else if (fact.kind === "turn-end") {
      const outcome = { kind: "outcome" as const, sequence: fact.sequence, turnSequence: fact.turnSequence, at: fact.completedAt, outcome: fact.outcome };
      const turn = state.turnsBySequence.get(fact.turnSequence);
      if (turn === undefined) state.orphanOutcomes.push(outcome);
      else {
        turn.phase = "closed";
        turn.rows = turn.rows.map(demoteActive);
        turn.outcome = outcome;
      }
    } else if (fact.kind === "call") {
      const row = { kind: "call" as const, sequence: fact.sequence, turnSequence: fact.turnSequence, at: fact.at, text: fact.body };
      const turn = state.turnsBySequence.get(fact.turnSequence);
      if (turn === undefined) state.orphanRows.push(row);
      else turn.rows.push(row);
    } else if (fact.kind === "tell") {
      state.tells.push({ kind: "tell", sequence: fact.sequence, at: fact.recordedAt, tellId: fact.id, text: fact.body, state: fact.state, deliveries: fact.deliveries });
    } else {
      projectActivityEvent(state, fact);
    }
  }
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
  return { rows, turns, retained, ...(openTurn === undefined ? {} : { openTurn }), ...(latestOutcome === undefined ? {} : { latestOutcome }) };
}

function entries<Row extends SnapshotRow>(rows: readonly Row[]): readonly ActivitySnapshotEntry<Row>[] {
  return rows.map((row) => ({ kind: "row", row }));
}

/** Select one current Turn, one latest outcome, or no focus; pending tells stay actionable. */
export function selectSnapshot(ledger: TurnLedger, budget: Readonly<{ tail: number; voice?: number }> = { tail: DEFAULT_TAIL, voice: DEFAULT_VOICE }): ActivitySnapshot {
  if (ledger.turns.length === 0 && !ledger.rows.some((row) => row.kind === "tell")) return { kind: "unborn", entries: [], omitted: 0 };
  const pending = ledger.rows.filter((row): row is Extract<ActivityRow, { kind: "tell" }> => row.kind === "tell" && row.state === "pending");
  if (ledger.openTurn !== undefined) {
    const window = ledger.openTurn.rows;
    const tailCount = Math.max(0, budget.tail);
    const tail = tailCount === 0 ? [] : window.slice(-tailCount);
    const tailSet = new Set(tail);
    const voiceCount = Math.max(0, budget.voice ?? DEFAULT_VOICE);
    const voiceCandidates = window
      .filter((row) => !tailSet.has(row) && (row.kind === "said" || row.kind === "thought"));
    const voice = voiceCount === 0 ? [] : voiceCandidates.slice(-voiceCount);
    const active = window.filter((row) => row.kind === "tool" && row.state === "active");
    const selected = new Set<ActivityRow>([...tail, ...voice, ...active, ...pending]);
    const visible = ledger.rows
      .filter((row) => selected.has(row))
      .filter((row): row is OpenSnapshotRow => row.kind !== "turn" && row.kind !== "outcome" && !(row.kind === "tool" && row.state === "unsettled"));
    return { kind: "open", turn: ledger.openTurn.turn, entries: entries(visible), omitted: window.filter((row) => !selected.has(row)).length };
  }
  return {
    kind: "idle",
    ...(ledger.latestOutcome === undefined ? {} : { outcome: ledger.latestOutcome }),
    entries: entries(pending),
    omitted: 0,
  };
}

/** Apply the one snapshot policy used by every public observation consumer. */
export function selectActivitySnapshot(
  facts: readonly TimelineFact[],
): ActivitySnapshot {
  return selectSnapshot(projectTurns(facts));
}

export function selectHistory(ledger: TurnLedger, cursor: HistoryCursor): HistoryPage {
  const eligible = ledger.rows.filter((row) => cursor.before !== undefined
    ? row.sequence < cursor.before
    : cursor.since !== undefined ? row.sequence > cursor.since : true);
  const rows = cursor.since !== undefined ? eligible.slice(0, cursor.limit) : eligible.slice(-cursor.limit);
  const omitted = Math.max(0, eligible.length - rows.length);
  const historyLost = cursor.since !== undefined
    ? (ledger.rows[0] !== undefined && ledger.rows[0].sequence > cursor.since + 1)
    : (ledger.retained.lowestRetained !== null && ledger.retained.lowestRetained > 1 && omitted === 0);
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
