import { decodeAgentEvent, type ToolCall, type ToolResult } from "./provider.js";
import type { ActivityFact, ActivitySlice, TellFact, TimelineFact, TurnFact } from "./heart/index.js";

const TAIL_LIMIT = 3;
const VOICE_LIMIT = 5;

export type ActivityRow =
  | Readonly<{ kind: "said"; sequence: number; bodySequence: number; at: string; text: string; truncated?: true }>
  | Readonly<{ kind: "thought"; sequence: number; bodySequence: number; at: string; text: string; truncated?: true }>
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
      truncated?: true;
    }>
  | Readonly<{ kind: "note"; sequence: number; bodySequence: number; at: string; text: string; truncated?: true }>
  | Readonly<{
      kind: "tell";
      sequence: number;
      at: string;
      tellId: string;
      text: string;
      state: TellFact["state"];
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
    return { kind: "said", sequence: fact.sequence, bodySequence: fact.bodySequence, at: fact.at, text: event.text,
      ...(event.truncated === true ? { truncated: true } : {}) };
  }
  if (event.type === "thought" || event.type === "note") {
    return { kind: event.type, sequence: fact.sequence, bodySequence: fact.bodySequence, at: fact.at, text: event.text,
      ...(event.truncated === true ? { truncated: true } : {}) };
  }
  return null;
}

function tellRow(fact: TellFact): Folded {
  return {
    settled: fact.state !== "pending",
    row: {
      kind: "tell",
      sequence: fact.sequence,
      at: fact.recordedAt,
      tellId: fact.id,
      text: fact.body,
      state: fact.state,
    },
  };
}

/** Fold the complete retained typed event window before any display budget. */
export function foldActivity(facts: readonly TimelineFact[]): readonly ActivityRow[] {
  const rows: Folded[] = [];
  const running = new Map<string, number>();
  for (const fact of facts) {
    if (!("event" in fact)) {
      rows.push(tellRow(fact));
      continue;
    }
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
          ...(event.truncated === true ? { truncated: true } : {}),
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
          ...(event.truncated === true ? { truncated: true } : {}),
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
        ...(started.truncated === true || event.truncated === true ? { truncated: true } : {}),
      },
    };
    running.delete(key);
  }
  return rows.map((entry) => entry.row);
}

/** Apply the one bounded recent selection after folding semantic rows. */
export function selectActivitySnapshot(
  facts: readonly TimelineFact[],
  input: Readonly<{
    lowestRetained?: number | null;
    highest?: number | null;
    profile?: ActivitySnapshotProfile;
  }> = {},
): ActivitySnapshot {
  const folded = foldActivity(facts);
  const settled = folded.filter((row) =>
    (row.kind !== "tool" || row.state !== "running") && (row.kind !== "tell" || row.state !== "pending"));
  const selected = new Set<ActivityRow>(settled.slice(-TAIL_LIMIT));
  if ((input.profile ?? "status") === "status") {
    const voice = settled.filter((row) => row.kind === "said" || row.kind === "thought").slice(-VOICE_LIMIT);
    for (const row of voice) selected.add(row);
  }
  for (const row of folded) {
    if ((row.kind === "tool" && row.state === "running") || (row.kind === "tell" && row.state === "pending")) {
      selected.add(row);
    }
  }
  const entries: ActivitySnapshotEntry[] = [];
  let hidden: ActivityRow[] = [];
  const flush = (): void => {
    if (hidden.length === 1) entries.push({ kind: "row", row: hidden[0]! });
    else if (hidden.length > 1) entries.push({ kind: "gap", count: hidden.length });
    hidden = [];
  };
  for (const row of folded) {
    if (!selected.has(row)) {
      hidden.push(row);
      continue;
    }
    flush();
    entries.push({ kind: "row", row });
  }
  flush();
  return {
    entries,
    lowestRetained: input.lowestRetained ?? (facts[0]?.sequence ?? null),
    highest: input.highest ?? (facts.at(-1)?.sequence ?? null),
  };
}

function visibleRows(facts: readonly TimelineFact[], since: boolean, limit: number): readonly ActivityRow[] {
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
  const bodySequences = new Set(rows.flatMap((row) => "bodySequence" in row ? [row.bodySequence] : []));
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
