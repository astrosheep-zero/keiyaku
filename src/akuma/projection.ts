import { decodeAgentEvent, type ToolCall, type ToolResult } from "./provider.js";
import type {
  ActivitySlice,
  TellDelivery,
  TellFact,
  TimelineFact,
  TurnEndFact,
} from "./heart/index.js";

const TAIL_LIMIT = 3;
const VOICE_LIMIT = 5;

export type ActivityRow =
  | Readonly<{ kind: "turn"; sequence: number; turnSequence: number; bodySequence: number; at: string }>
  | Readonly<{ kind: "call"; sequence: number; turnSequence: number; at: string; text: string }>
  | Readonly<{ kind: "said"; sequence: number; turnSequence: number; at: string; text: string; truncated?: true }>
  | Readonly<{ kind: "thought"; sequence: number; turnSequence: number; at: string; text: string; truncated?: true }>
  | Readonly<{
      kind: "tool";
      sequence: number;
      turnSequence: number;
      at: string;
      completedAt?: string;
      durationMs?: number;
      name: string;
      call: ToolCall;
      state: "running" | ToolResult;
      truncated?: true;
    }>
  | Readonly<{ kind: "note"; sequence: number; turnSequence: number; at: string; text: string; truncated?: true }>
  | Readonly<{
      kind: "tell";
      sequence: number;
      at: string;
      tellId: string;
      text: string;
      state: TellFact["state"];
      deliveries: readonly TellDelivery[];
    }>
  | Readonly<{
      kind: "outcome";
      sequence: number;
      turnSequence: number;
      at: string;
      outcome: TurnEndFact["outcome"];
    }>;

export type ActivitySnapshot = Readonly<{
  entries: readonly ActivitySnapshotEntry[];
  lowestRetained: number | null;
  highest: number | null;
}>;

export type ActivitySnapshotEntry =
  | Readonly<{ kind: "row"; row: ActivityRow }>
  | Readonly<{ kind: "gap"; count: number }>;

export type ActivitySnapshotProfile = "status" | "feedback";

export type ActivityHistory = Readonly<{
  rows: readonly ActivityRow[];
  omitted: number;
  hasEarlier: boolean;
  hasLater: boolean;
  historyLost: boolean;
  lowestRetained: number | null;
  highest: number | null;
}>;

type Folded = Readonly<{ row: ActivityRow; settled: boolean }>;
type ProjectionState = { rows: Folded[]; running: Map<string, number> };

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
): ActivityRow | null {
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

/** Project the complete retained fact window in persisted timeline order. */
export function projectTimeline(facts: readonly TimelineFact[]): readonly ActivityRow[] {
  const state: ProjectionState = { rows: [], running: new Map() };
  for (const fact of facts) {
    if (fact.kind === "turn-start") state.rows.push({ settled: false, row: { kind: "turn", sequence: fact.sequence, turnSequence: fact.sequence, bodySequence: fact.bodySequence, at: fact.startedAt } });
    else if (fact.kind === "turn-end") state.rows.push({ settled: true, row: { kind: "outcome", sequence: fact.sequence, turnSequence: fact.turnSequence, at: fact.completedAt, outcome: fact.outcome } });
    else if (fact.kind === "call") state.rows.push({ settled: true, row: { kind: "call", sequence: fact.sequence, turnSequence: fact.turnSequence, at: fact.at, text: fact.body } });
    else if (fact.kind === "tell") state.rows.push({ settled: fact.state !== "pending", row: { kind: "tell", sequence: fact.sequence, at: fact.recordedAt, tellId: fact.id, text: fact.body, state: fact.state, deliveries: fact.deliveries } });
    else projectActivityEvent(state, fact);
  }
  return state.rows.map((entry) => entry.row);
}

function projectActivityEvent(state: ProjectionState, fact: Extract<TimelineFact, { kind: "activity" }>): void {
  const event = decodeAgentEvent(fact.event);
  const narration = narrationRow(fact, event);
  if (narration !== null) { state.rows.push({ settled: true, row: narration }); return; }
  if (event.type !== "tool") return;
  const key = toolKey(fact.turnSequence, event.id);
  if (event.phase === "started") {
    state.running.set(key, state.rows.length);
    state.rows.push({ settled: false, row: { kind: "tool", sequence: fact.sequence, turnSequence: fact.turnSequence, at: fact.at, name: event.name, call: event.call, state: "running", ...(event.truncated === true ? { truncated: true } : {}) } });
    return;
  }
  const index = state.running.get(key);
  const started = index === undefined ? undefined : state.rows[index]?.row;
  if (started?.kind !== "tool") {
    state.rows.push({ settled: true, row: {
      kind: "tool", sequence: fact.sequence, turnSequence: fact.turnSequence, at: fact.at,
      name: event.name, call: event.call, state: event.result,
      ...(event.truncated === true ? { truncated: true } : {}),
    } });
    return;
  }
  const startedAt = started.at;
  const durationMs = duration(startedAt, fact.at);
  const completed: ActivityRow = {
    kind: "tool", sequence: started.sequence, turnSequence: fact.turnSequence, at: startedAt,
    completedAt: fact.at, ...(durationMs === undefined ? {} : { durationMs }),
    name: event.name, call: event.call, state: event.result,
    ...(started?.kind === "tool" && started.truncated === true || event.truncated === true ? { truncated: true } : {}),
  };
  state.rows[index!] = { settled: true, row: completed };
  state.running.delete(key);
}

function pinned(row: ActivityRow, latestOutcome: ActivityRow | undefined, openTurn: number | undefined): boolean {
  return row === latestOutcome
    || (row.kind === "turn" && row.turnSequence === openTurn)
    || (row.kind === "call" && row.turnSequence === openTurn)
    || (row.kind === "tool" && row.state === "running")
    || (row.kind === "tell" && row.state === "pending");
}

/** Apply the bounded snapshot policy after semantic projection. */
export function selectActivitySnapshot(
  facts: readonly TimelineFact[],
  input: Readonly<{
    lowestRetained?: number | null;
    highest?: number | null;
    profile?: ActivitySnapshotProfile;
  }> = {},
): ActivitySnapshot {
  const projected = projectTimeline(facts);
  const ended = new Set(projected.filter((row) => row.kind === "outcome").map((row) => row.turnSequence));
  const openTurn = projected.findLast((row): row is Extract<ActivityRow, { kind: "turn" }> =>
    row.kind === "turn" && !ended.has(row.turnSequence));
  const latestOutcome = projected.findLast((row) => row.kind === "outcome");
  const ordinary = projected.filter((row) => !pinned(row, latestOutcome, openTurn?.turnSequence));
  const selected = new Set<ActivityRow>(ordinary.slice(-TAIL_LIMIT));
  if ((input.profile ?? "status") === "status") {
    for (const row of ordinary.filter((value) => value.kind === "said" || value.kind === "thought").slice(-VOICE_LIMIT)) {
      selected.add(row);
    }
  }
  for (const row of projected) if (pinned(row, latestOutcome, openTurn?.turnSequence)) selected.add(row);
  const entries: ActivitySnapshotEntry[] = [];
  let hidden: ActivityRow[] = [];
  const flush = (): void => {
    if (hidden.length === 1) entries.push({ kind: "row", row: hidden[0]! });
    else if (hidden.length > 1) entries.push({ kind: "gap", count: hidden.length });
    hidden = [];
  };
  for (const row of projected) {
    if (!selected.has(row)) hidden.push(row);
    else { flush(); entries.push({ kind: "row", row }); }
  }
  flush();
  return {
    entries,
    lowestRetained: input.lowestRetained ?? (facts[0]?.sequence ?? null),
    highest: input.highest ?? (facts.at(-1)?.sequence ?? null),
  };
}

/** Apply cursor and limit to the one semantic timeline projection. */
export function projectActivityHistory(
  slice: ActivitySlice,
  input: Readonly<{ before?: number; since?: number; limit: number }>,
): ActivityHistory {
  const projected = projectTimeline(slice.rows);
  const eligible = projected.filter((row) => input.before !== undefined
    ? row.sequence < input.before
    : input.since !== undefined ? row.sequence > input.since : true);
  const rows = input.since !== undefined ? eligible.slice(0, input.limit) : eligible.slice(-input.limit);
  const forwardHistoryLost = input.since !== undefined
    && slice.rows[0] !== undefined
    && slice.rows[0].sequence > input.since + 1;
  return {
    rows,
    omitted: Math.max(0, eligible.length - rows.length),
    hasEarlier: input.since === undefined && eligible.length > rows.length,
    hasLater: input.since !== undefined && eligible.length > rows.length,
    historyLost: forwardHistoryLost || (input.since === undefined && eligible.length === rows.length
      && slice.lowestRetained !== null && slice.lowestRetained > 1),
    lowestRetained: slice.lowestRetained,
    highest: slice.highest,
  };
}
