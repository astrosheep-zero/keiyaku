import { decodeAgentEvent, type ToolCall, type ToolResult } from "./provider.js";
import type { ActivityFact, ActivitySlice, TellFact, TurnFact } from "./heart/index.js";

const SETTLED_LIMIT = 8;
const INTENT_LIMIT = 2;

export type ActivityRow =
  | Readonly<{ kind: "said"; sequence: number; bodySequence: number; at: string; text: string }>
  | Readonly<{ kind: "thought"; sequence: number; bodySequence: number; at: string; text: string }>
  | Readonly<{
      kind: "tool";
      sequence: number;
      bodySequence: number;
      at: string;
      completedAt?: string;
      durationMs?: number;
      name: string;
      call: ToolCall;
      state: "running" | ToolResult;
    }>
  | Readonly<{ kind: "note"; sequence: number; bodySequence: number; at: string; text: string }>;

export type PendingTell = Readonly<{ id: string; body: string; recordedAt: string }>;

export type ActivitySnapshot = Readonly<{
  rows: readonly ActivityRow[];
  pendingTells: readonly PendingTell[];
  omitted: number;
  lowestRetained: number | null;
  highest: number | null;
}>;

export type ActivityHistory = Readonly<{
  rows: readonly ActivityRow[];
  turns: readonly TurnFact[];
  omitted: number;
  hasEarlier: boolean;
  hasLater: boolean;
  historyLost: boolean;
  lowestRetained: number | null;
  highest: number | null;
}>;

type Folded = Readonly<{ row: ActivityRow; settled: boolean }>;

function duration(startedAt: string, completedAt: string): number | undefined {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return end - start;
}

function toolKey(bodySequence: number, id: string): string {
  return `${bodySequence}:${id}`;
}

function narrationRow(fact: ActivityFact, event: ReturnType<typeof decodeAgentEvent>): ActivityRow | null {
  if (event.type === "assistant") {
    return { kind: "said", sequence: fact.sequence, bodySequence: fact.bodySequence, at: fact.at, text: event.text };
  }
  if (event.type === "thought" || event.type === "note") {
    return { kind: event.type, sequence: fact.sequence, bodySequence: fact.bodySequence, at: fact.at, text: event.text };
  }
  return null;
}

/** Fold the complete retained typed event window before any display budget. */
export function foldActivity(facts: readonly ActivityFact[]): readonly ActivityRow[] {
  const rows: Folded[] = [];
  const running = new Map<string, number>();
  for (const fact of facts) {
    const event = decodeAgentEvent(fact.event);
    const narration = narrationRow(fact, event);
    if (narration !== null) {
      rows.push({ settled: true, row: narration });
      continue;
    }
    if (event.type !== "tool") continue;
    const key = toolKey(fact.bodySequence, event.id);
    if (event.phase === "started") {
      const index = rows.length;
      rows.push({
        settled: false,
        row: {
          kind: "tool",
          sequence: fact.sequence,
          bodySequence: fact.bodySequence,
          at: fact.at,
          name: event.name,
          call: event.call,
          state: "running",
        },
      });
      running.set(key, index);
      continue;
    }
    const index = running.get(key);
    if (index === undefined) {
      rows.push({
        settled: true,
        row: {
          kind: "tool",
          sequence: fact.sequence,
          bodySequence: fact.bodySequence,
          at: fact.at,
          name: event.name,
          call: event.call,
          state: event.result,
        },
      });
      continue;
    }
    const started = rows[index]!.row;
    if (started.kind !== "tool") throw new Error("Akuma activity tool fold lost its start row");
    const elapsed = duration(started.at, fact.at);
    rows[index] = {
      settled: true,
      row: {
        kind: "tool",
        sequence: started.sequence,
        bodySequence: started.bodySequence,
        at: started.at,
        completedAt: fact.at,
        ...(elapsed === undefined ? {} : { durationMs: elapsed }),
        name: event.name,
        call: event.call,
        state: event.result,
      },
    };
    running.delete(key);
  }
  return rows.map((entry) => entry.row);
}

function pendingTellFacts(tells: readonly TellFact[]): readonly PendingTell[] {
  return tells
    .filter((tell) => tell.state !== "consumed" && tell.state !== "voided-by-death")
    .map((tell) => ({ id: tell.id, body: tell.body, recordedAt: tell.recordedAt }));
}

/** Apply the one bounded recent selection after folding semantic rows. */
export function selectActivitySnapshot(
  facts: readonly ActivityFact[],
  input: Readonly<{ pending?: readonly TellFact[]; lowestRetained?: number | null; highest?: number | null }> = {},
): ActivitySnapshot {
  const folded = foldActivity(facts);
  const settled = folded.filter((row) => row.kind !== "tool" || row.state !== "running");
  const selected = new Set<ActivityRow>(settled.slice(-SETTLED_LIMIT));
  const intent = settled.filter((row) => row.kind === "said" || row.kind === "thought").slice(-INTENT_LIMIT);
  for (const row of intent) selected.add(row);
  for (const row of folded) {
    if (row.kind === "tool" && row.state === "running") selected.add(row);
  }
  return {
    rows: folded.filter((row) => selected.has(row)),
    pendingTells: pendingTellFacts(input.pending ?? []),
    omitted: settled.length - [...selected].filter((row) => row.kind !== "tool" || row.state !== "running").length,
    lowestRetained: input.lowestRetained ?? (facts[0]?.sequence ?? null),
    highest: input.highest ?? (facts.at(-1)?.sequence ?? null),
  };
}

function visibleRows(facts: readonly ActivityFact[], since: boolean, limit: number): readonly ActivityRow[] {
  const folded = foldActivity(facts);
  return since ? folded.slice(0, limit) : folded.slice(-limit);
}

/** Project a cursor page; history never applies the recent snapshot pinning rules. */
export function projectActivityHistory(
  slice: ActivitySlice,
  turns: readonly TurnFact[],
  input: Readonly<{ since?: boolean; limit: number }>,
): ActivityHistory {
  const all = foldActivity(slice.rows);
  const rows = visibleRows(slice.rows, input.since === true, input.limit);
  const bodySequences = new Set(rows.map((row) => row.bodySequence));
  return {
    rows,
    turns: turns.filter((turn) => bodySequences.has(turn.bodySequence)),
    omitted: Math.max(0, all.length - rows.length),
    hasEarlier: input.since !== true && all.length > rows.length,
    hasLater: input.since === true && all.length > rows.length,
    historyLost: input.since !== true
      && all.length === rows.length
      && slice.lowestRetained !== null
      && slice.lowestRetained > 1,
    lowestRetained: slice.lowestRetained,
    highest: slice.highest,
  };
}
