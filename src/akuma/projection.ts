/* eslint-disable max-lines -- Akuma owns one coherent activity projection and strict boundary schema. */
import { decodeAgentEvent } from "./provider.js";
import type { TimelineFact, TurnEndFact } from "./heart/index.js";
import { projectTell, type TellDelivery, type TellRow } from "./heart/facts.js";
import { z } from "zod";

const nonblankTextSchema = z.string().refine((value) => value.trim() !== "");
const countSchema = z.number().int().nonnegative();
const timestampSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)), "expected timestamp");
const diffstatSchema = z.object({ added: countSchema, removed: countSchema }).strict();
const fileChangeSchema = z
  .object({
    op: z.enum(["add", "update", "delete", "unspecified"]),
    path: z.string(),
    diffstat: diffstatSchema.optional(),
  })
  .strict();
const toolCallSchema = z.union([
  z.object({ kind: z.literal("run"), command: z.string() }).strict(),
  z
    .object({
      kind: z.literal("read"),
      path: z.string(),
      offset: countSchema.optional(),
      limit: countSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("search"),
      query: z.string(),
      scope: z.enum(["content", "files", "web"]).optional(),
      path: z.string().optional(),
      glob: z.string().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("fileChange"), changes: z.array(fileChangeSchema).readonly() }).strict(),
  z.object({ kind: z.literal("other"), display: z.string() }).strict(),
]);
const toolResultSchema = z
  .object({ status: z.enum(["ok", "error"]), message: z.string().optional(), exitCode: z.number().int().optional() })
  .strict();
const tellDeliverySchema = z
  .object({
    deliveredAt: timestampSchema,
    route: z.enum(["launch", "live"]),
    turnSequence: countSchema,
    receipt: z.enum(["unavailable", "required"]).optional(),
  })
  .strict()
  .transform(({ receipt, ...delivery }): TellDelivery => (receipt === undefined ? delivery : { ...delivery, receipt }));
const turnRowSchema = z
  .object({
    kind: z.literal("turn"),
    sequence: countSchema,
    turnSequence: countSchema,
    bodySequence: countSchema,
    at: timestampSchema,
  })
  .strict();
const callRowSchema = z
  .object({
    kind: z.literal("call"),
    sequence: countSchema,
    turnSequence: countSchema,
    at: timestampSchema,
    text: z.string(),
  })
  .strict();
const textRowSchema = (kind: "said" | "thought" | "note") =>
  z
    .object({
      kind: z.literal(kind),
      sequence: countSchema,
      turnSequence: countSchema,
      at: timestampSchema,
      text: z.string(),
      truncated: z.literal(true).optional(),
    })
    .strict();
export const tellRowSchema = z
  .object({
    kind: z.literal("tell"),
    sequence: countSchema,
    at: timestampSchema,
    tellId: nonblankTextSchema,
    text: z.string(),
    state: z.enum(["pending", "told"]),
    deliveries: z.array(tellDeliverySchema).readonly(),
  })
  .strict() satisfies z.ZodType<TellRow>;
const outcomeSchema = z.union([
  z.object({ kind: z.literal("answered"), historyId: nonblankTextSchema, answer: z.string() }).strict(),
  z.object({ kind: z.literal("failed"), historyId: nonblankTextSchema, diagnostic: z.string() }).strict(),
]);
const outcomeRowSchema = z
  .object({
    kind: z.literal("outcome"),
    sequence: countSchema,
    turnSequence: countSchema,
    at: timestampSchema,
    outcome: outcomeSchema,
  })
  .strict();
const activeToolRowSchema = z
  .object({
    kind: z.literal("tool"),
    sequence: countSchema,
    turnSequence: countSchema,
    at: timestampSchema,
    name: nonblankTextSchema,
    call: toolCallSchema,
    state: z.literal("active"),
    truncated: z.literal(true).optional(),
  })
  .strict();
const completedToolRowSchema = z
  .object({
    kind: z.literal("tool"),
    sequence: countSchema,
    turnSequence: countSchema,
    at: timestampSchema,
    completedAt: timestampSchema.optional(),
    durationMs: z.number().finite().nonnegative().optional(),
    name: nonblankTextSchema,
    call: toolCallSchema,
    state: toolResultSchema,
    truncated: z.literal(true).optional(),
  })
  .strict();
const unsettledToolRowSchema = z
  .object({
    kind: z.literal("tool"),
    sequence: countSchema,
    turnSequence: countSchema,
    at: timestampSchema,
    name: nonblankTextSchema,
    call: toolCallSchema,
    state: z.literal("unsettled"),
    truncated: z.literal(true).optional(),
  })
  .strict();
const snapshotFactRowSchema = z.union([
  callRowSchema,
  textRowSchema("said"),
  textRowSchema("thought"),
  textRowSchema("note"),
  tellRowSchema,
]);
const openSnapshotRowSchema = z.union([snapshotFactRowSchema, activeToolRowSchema, completedToolRowSchema]);
const idleSnapshotRowSchema = z.union([snapshotFactRowSchema, completedToolRowSchema]);
const snapshotEntrySchema = <Row extends z.ZodType>(row: Row) =>
  z.union([
    z.object({ kind: z.literal("gap"), count: countSchema }).strict(),
    z.object({ kind: z.literal("row"), row }).strict(),
  ]);
const reportedFileChangeSchema = z
  .object({
    sequence: countSchema,
    at: timestampSchema,
    op: z.enum(["add", "update", "delete", "unspecified"]),
    path: z.string(),
    diffstat: diffstatSchema.optional(),
  })
  .strict();
const reportedChangeFields = {
  reportedChanges: z.array(reportedFileChangeSchema).readonly(),
  reportedChangesOmitted: countSchema,
};
export const activitySnapshotSchema = z.union([
  z
    .object({
      kind: z.literal("unborn"),
      entries: z.tuple([]).readonly(),
      omitted: z.literal(0),
      ...reportedChangeFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal("open"),
      turn: turnRowSchema,
      entries: z.array(snapshotEntrySchema(openSnapshotRowSchema)).readonly(),
      omitted: countSchema,
      ...reportedChangeFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal("idle"),
      outcome: outcomeRowSchema.optional(),
      entries: z.array(snapshotEntrySchema(idleSnapshotRowSchema)).readonly(),
      omitted: countSchema,
      ...reportedChangeFields,
    })
    .strict(),
]);

export type TurnOutcome = z.infer<typeof outcomeSchema>;
export type TurnStartRow = z.infer<typeof turnRowSchema>;
type CallRow = z.infer<typeof callRowSchema>;
type SaidRow = z.infer<ReturnType<typeof textRowSchema>>;
type ThoughtRow = z.infer<ReturnType<typeof textRowSchema>>;
type NoteRow = z.infer<ReturnType<typeof textRowSchema>>;
type TurnNarrationRow = CallRow | SaidRow | ThoughtRow | NoteRow;
export type { TellRow } from "./heart/facts.js";
export type OutcomeRow = z.infer<typeof outcomeRowSchema>;

function publicOutcome(turnSequence: number, outcome: TurnEndFact["outcome"]): TurnOutcome {
  const historyId = `turn/${turnSequence}`;
  return outcome.kind === "answered"
    ? { kind: "answered", historyId, answer: outcome.answer }
    : { kind: "failed", historyId, diagnostic: outcome.diagnostic };
}

export type ActiveToolRow = z.infer<typeof activeToolRowSchema>;
export type CompletedToolRow = z.infer<typeof completedToolRowSchema>;
export type UnsettledToolRow = z.infer<typeof unsettledToolRowSchema>;

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

export type OpenSnapshotRow = z.infer<typeof openSnapshotRowSchema>;
export type IdleSnapshotRow = z.infer<typeof idleSnapshotRowSchema>;
export type SnapshotRow = OpenSnapshotRow | IdleSnapshotRow;
export type ActivitySnapshotEntry<Row extends SnapshotRow = SnapshotRow> = z.infer<
  ReturnType<typeof snapshotEntrySchema<z.ZodType<Row>>>
>;
export type ReportedFileChange = z.infer<typeof reportedFileChangeSchema>;
export type Snapshot = z.infer<typeof activitySnapshotSchema>;
export type ActivitySnapshot = z.infer<typeof activitySnapshotSchema>;

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
      state.tells.push(projectTell(fact));
    } else {
      projectActivityEvent(state, fact);
    }
  }
  return finishLedger(state, retained);
}

export { ordinarySnapshotBudget, selectHistory, selectSnapshot } from "./projection-read.js";
