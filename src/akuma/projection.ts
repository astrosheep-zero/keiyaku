import {
  toolCallSchema,
  toolResultSchema,
  toolInputSchema,
  fileChangeSchema,
  diffstatSchema,
  type AgentEvent,
} from "./heart/activity-schema.js";
import type { TimelineFact, TurnEndFact } from "./heart/index.js";
import { projectTell, reportFactSchema, reportFactWireSchema, type TellDelivery, type TellRow } from "./heart/facts.js";
import { z } from "zod";

const nonblankTextSchema = z.string().refine((value) => value.trim() !== "");
const countSchema = z.number().int().nonnegative();
const sequenceSchema = z.number().int().positive();
const timestampSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)), "expected timestamp");
const strictDiffstatSchema = diffstatSchema.strict().readonly();
const [runCall, readCall, searchCall, changeCall, otherCall] = toolCallSchema.options;
const publicFileChangeSchema = fileChangeSchema
  .extend({
    diffstat: strictDiffstatSchema.exactOptional(),
    patch: fileChangeSchema.shape.patch.unwrap().exactOptional(),
  })
  .strict()
  .readonly();
// Public observation historically admits zero-based read positions, unlike native narration.
const publicToolCallSchema = z.union([
  runCall.strict().readonly(),
  readCall.extend({ offset: countSchema.exactOptional(), limit: countSchema.exactOptional() }).strict().readonly(),
  searchCall
    .extend({
      scope: searchCall.shape.scope.unwrap().exactOptional(),
      path: searchCall.shape.path.unwrap().exactOptional(),
      glob: searchCall.shape.glob.unwrap().exactOptional(),
    })
    .strict()
    .readonly(),
  changeCall
    .extend({ changes: z.array(publicFileChangeSchema).readonly() })
    .strict()
    .readonly(),
  otherCall.extend({ input: toolInputSchema.strict().readonly().exactOptional() }).strict().readonly(),
]);
const publicToolResultSchema = toolResultSchema
  .extend({
    message: toolResultSchema.shape.message.unwrap().exactOptional(),
    output: toolResultSchema.shape.output.unwrap().exactOptional(),
    exitCode: toolResultSchema.shape.exitCode.unwrap().exactOptional(),
  })
  .strict()
  .readonly();

const tellDeliverySchema = z
  .object({
    deliveredAt: timestampSchema,
    route: z.enum(["launch", "live"]),
    turnSequence: countSchema,
    receipt: z.enum(["unavailable", "required"]).exactOptional(),
  })
  .strict()
  .readonly() satisfies z.ZodType<TellDelivery>;
const turnRowSchema = z
  .object({
    kind: z.literal("turn"),
    sequence: countSchema,
    turnSequence: countSchema,
    bodySequence: countSchema,
    at: timestampSchema,
  })
  .strict()
  .readonly();
const callRowSchema = z
  .object({
    kind: z.literal("call"),
    sequence: countSchema,
    turnSequence: countSchema,
    at: timestampSchema,
    text: z.string(),
  })
  .strict()
  .readonly();
export const reportRowSchema = reportFactWireSchema;
const textRowSchema = (kind: "said" | "thought" | "note") =>
  z
    .object({
      kind: z.literal(kind),
      sequence: countSchema,
      turnSequence: countSchema,
      at: timestampSchema,
      text: z.string(),
      truncated: z.literal(true).exactOptional(),
    })
    .strict()
    .readonly();
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
  .strict()
  .readonly() satisfies z.ZodType<TellRow>;
const outcomeSchema = z.union([
  z
    .object({
      kind: z.literal("answered"),
      historyId: nonblankTextSchema,
      answer: z.string(),
      foldedSaidSequence: countSchema.exactOptional(),
    })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal("failed"), historyId: nonblankTextSchema, diagnostic: z.string() })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal("canceled"), historyId: nonblankTextSchema })
    .strict()
    .readonly(),
]);
export const outcomeRowSchema = z
  .object({
    kind: z.literal("outcome"),
    sequence: countSchema,
    turnSequence: countSchema,
    at: timestampSchema,
    outcome: outcomeSchema,
  })
  .strict()
  .readonly();
const activeToolRowSchema = z
  .object({
    kind: z.literal("tool"),
    sequence: countSchema,
    turnSequence: countSchema,
    at: timestampSchema,
    name: nonblankTextSchema,
    call: publicToolCallSchema,
    state: z.literal("active"),
    toolId: z.string().exactOptional(),
    truncated: z.literal(true).exactOptional(),
  })
  .strict()
  .readonly();
const completedToolRowSchema = z
  .object({
    kind: z.literal("tool"),
    sequence: countSchema,
    turnSequence: countSchema,
    at: timestampSchema,
    durationMs: z.number().finite().nonnegative().exactOptional(),
    name: nonblankTextSchema,
    call: publicToolCallSchema,
    state: publicToolResultSchema,
    toolId: z.string().exactOptional(),
    truncated: z.literal(true).exactOptional(),
  })
  .strict()
  .readonly();
const unsettledToolRowSchema = z
  .object({
    kind: z.literal("tool"),
    sequence: countSchema,
    turnSequence: countSchema,
    at: timestampSchema,
    name: nonblankTextSchema,
    call: publicToolCallSchema,
    state: z.literal("unsettled"),
    toolId: z.string().exactOptional(),
    truncated: z.literal(true).exactOptional(),
  })
  .strict()
  .readonly();
const snapshotFactRowSchema = z.union([
  reportRowSchema,
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
    z
      .object({ kind: z.literal("gap"), count: countSchema })
      .strict()
      .readonly(),
    z
      .object({ kind: z.literal("row"), row })
      .strict()
      .readonly(),
  ]);
const nativeSnapshotEntrySchema = <Row extends z.ZodType>(row: Row) => {
  const entry = snapshotEntrySchema(row);
  return z.union([entry.options[0].unwrap(), entry.options[1].unwrap()]);
};
const reportedFileChangeSchema = z
  .object({
    sequence: countSchema,
    at: timestampSchema,
    op: z.enum(["add", "update", "delete", "unspecified"]),
    path: z.string(),
    diffstat: strictDiffstatSchema.exactOptional(),
  })
  .strict()
  .readonly();
const reportedChangeFields = {
  reportedChanges: z.array(reportedFileChangeSchema).readonly(),
  reportedChangesOmitted: countSchema,
};
const openActivitySnapshotSchema = z
  .object({
    kind: z.literal("open"),
    turn: turnRowSchema,
    entries: z.array(snapshotEntrySchema(openSnapshotRowSchema)).readonly(),
    omitted: countSchema,
    openingSequence: sequenceSchema.exactOptional(),
    ...reportedChangeFields,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.openingSequence === undefined) return;
    const matches = snapshot.entries.filter(
      (entry) => entry.kind === "row" && entry.row.sequence === snapshot.openingSequence,
    );
    if (matches.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["openingSequence"],
        message: "openingSequence must name exactly one snapshot entry",
      });
    }
  })
  .readonly();

export const activitySnapshotSchema = z.union([
  z
    .object({
      kind: z.literal("unborn"),
      entries: z.tuple([]).readonly(),
      omitted: z.literal(0),
      ...reportedChangeFields,
    })
    .strict()
    .readonly(),
  openActivitySnapshotSchema,
  z
    .object({
      kind: z.literal("idle"),
      outcome: outcomeRowSchema.exactOptional(),
      entries: z.array(snapshotEntrySchema(idleSnapshotRowSchema)).readonly(),
      omitted: countSchema,
      ...reportedChangeFields,
    })
    .strict()
    .readonly(),
]);

const nativeTurnRowSchema = turnRowSchema.unwrap();
const nativeCallRowSchema = callRowSchema.unwrap();
const nativeTextRowSchema = (kind: "said" | "thought" | "note") =>
  textRowSchema(kind)
    .unwrap()
    .extend({ truncated: z.literal(true).optional() });
const nativeOutcomeSchema = z.union([
  outcomeSchema.options[0].unwrap().extend({ foldedSaidSequence: countSchema.optional() }),
  outcomeSchema.options[1].unwrap(),
  outcomeSchema.options[2].unwrap(),
]);
const nativeOutcomeRowSchema = outcomeRowSchema.unwrap().extend({ outcome: nativeOutcomeSchema });
const nativeReportedFileChangeSchema = reportedFileChangeSchema
  .unwrap()
  .extend({ diffstat: diffstatSchema.strict().optional() });
type TurnOutcome = z.output<typeof nativeOutcomeSchema>;
export type TurnStartRow = z.output<typeof nativeTurnRowSchema>;
type CallRow = z.output<typeof nativeCallRowSchema>;
type SaidRow = z.output<ReturnType<typeof nativeTextRowSchema>>;
type ThoughtRow = z.output<ReturnType<typeof nativeTextRowSchema>>;
type NoteRow = z.output<ReturnType<typeof nativeTextRowSchema>>;
export type ReportRow = z.output<typeof reportFactSchema>;
type TurnNarrationRow = CallRow | SaidRow | ThoughtRow | NoteRow | ReportRow;
export type { TellRow } from "./heart/facts.js";
export type OutcomeRow = z.output<typeof nativeOutcomeRowSchema>;

function publicOutcome(turnSequence: number, outcome: TurnEndFact["outcome"]): TurnOutcome {
  const historyId = `turn/${turnSequence}`;
  if (outcome.kind === "answered") return { kind: "answered", historyId, answer: outcome.answer };
  if (outcome.kind === "canceled") return { kind: "canceled", historyId };
  return { kind: "failed", historyId, diagnostic: outcome.diagnostic };
}

const nativeActiveToolRowSchema = activeToolRowSchema
  .unwrap()
  .extend({ call: toolCallSchema, toolId: z.string().optional(), truncated: z.literal(true).optional() });
const nativeCompletedToolRowSchema = completedToolRowSchema.unwrap().extend({
  call: toolCallSchema,
  state: toolResultSchema,
  toolId: z.string().optional(),
  truncated: z.literal(true).optional(),
  durationMs: z.number().optional(),
});
const nativeUnsettledToolRowSchema = unsettledToolRowSchema
  .unwrap()
  .extend({ call: toolCallSchema, toolId: z.string().optional(), truncated: z.literal(true).optional() });
export type ActiveToolRow = z.output<typeof nativeActiveToolRowSchema>;
export type CompletedToolRow = z.output<typeof nativeCompletedToolRowSchema>;
export type UnsettledToolRow = z.output<typeof nativeUnsettledToolRowSchema>;

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

const nativeSnapshotFactRowSchema = z.union([
  reportFactSchema,
  nativeCallRowSchema,
  nativeTextRowSchema("said"),
  nativeTextRowSchema("thought"),
  nativeTextRowSchema("note"),
  tellRowSchema.unwrap(),
]);
const nativeOpenSnapshotRowSchema = z.union([
  nativeSnapshotFactRowSchema,
  nativeActiveToolRowSchema,
  nativeCompletedToolRowSchema,
]);
const nativeIdleSnapshotRowSchema = z.union([nativeSnapshotFactRowSchema, nativeCompletedToolRowSchema]);
export type OpenSnapshotRow = z.output<typeof nativeOpenSnapshotRowSchema>;
export type IdleSnapshotRow = z.output<typeof nativeIdleSnapshotRowSchema>;
export type SnapshotRow = OpenSnapshotRow | IdleSnapshotRow;
export type ActivitySnapshotEntry<Row extends SnapshotRow = SnapshotRow> = z.infer<
  ReturnType<typeof nativeSnapshotEntrySchema<z.ZodType<Row>>>
>;
export type ReportedFileChange = z.output<typeof nativeReportedFileChangeSchema>;
export const nativeActivitySnapshotSchema = z.union([
  activitySnapshotSchema.options[0]
    .unwrap()
    .extend({ reportedChanges: z.array(nativeReportedFileChangeSchema).readonly() }),
  z.strictObject({
    ...openActivitySnapshotSchema.unwrap().shape,
    turn: nativeTurnRowSchema,
    entries: z.array(nativeSnapshotEntrySchema(nativeOpenSnapshotRowSchema)).readonly(),
    openingSequence: sequenceSchema.optional(),
    reportedChanges: z.array(nativeReportedFileChangeSchema).readonly(),
  }),
  activitySnapshotSchema.options[2].unwrap().extend({
    entries: z.array(nativeSnapshotEntrySchema(nativeIdleSnapshotRowSchema)).readonly(),
    outcome: nativeOutcomeRowSchema.optional(),
    reportedChanges: z.array(nativeReportedFileChangeSchema).readonly(),
  }),
]);
export type ActivitySnapshot = z.output<typeof nativeActivitySnapshotSchema>;

export const activityRowSchema = z.union([
  turnRowSchema,
  callRowSchema,
  reportRowSchema,
  textRowSchema("said"),
  textRowSchema("thought"),
  textRowSchema("note"),
  tellRowSchema,
  activeToolRowSchema,
  completedToolRowSchema,
  unsettledToolRowSchema,
  outcomeRowSchema,
]);
export const activityHistorySchema = z
  .strictObject({
    rows: z.array(activityRowSchema).readonly(),
    omitted: z.number(),
    hasEarlier: z.boolean(),
    hasLater: z.boolean(),
    historyLost: z.boolean(),
    lowestRetained: z.number().nullable(),
    highest: z.number().nullable(),
  })
  .readonly();

const nativeActivityRowSchema = z.union([
  nativeTurnRowSchema,
  nativeCallRowSchema,
  reportFactSchema,
  nativeTextRowSchema("said"),
  nativeTextRowSchema("thought"),
  nativeTextRowSchema("note"),
  tellRowSchema,
  nativeActiveToolRowSchema,
  nativeCompletedToolRowSchema,
  nativeUnsettledToolRowSchema,
  nativeOutcomeRowSchema,
]);
const nativeActivityHistorySchema = activityHistorySchema
  .unwrap()
  .extend({ rows: z.array(nativeActivityRowSchema).readonly() })
  .readonly();
export type ActivityHistory = z.output<typeof nativeActivityHistorySchema>;

export type ExactHistory =
  | Readonly<{ kind: "exact"; outcome: OutcomeRow }>
  | Readonly<{ kind: "exact-report"; report: ReportRow }>
  | Readonly<{ kind: "unknown-history"; id: string }>;

export type HistoryPage = ActivityHistory;

export function selectExactHistory(
  rows: readonly ActivityRow[],
  selector: Readonly<{ kind: "turn" | "report"; sequence: number }>,
): ExactHistory {
  const id = `${selector.kind}/${selector.sequence}`;
  if (selector.kind === "report") {
    const report = rows.find((row): row is ReportRow => row.kind === "report" && row.sequence === selector.sequence);
    return report === undefined ? { kind: "unknown-history", id } : { kind: "exact-report", report };
  }
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

function narrationRow(fact: Extract<TimelineFact, { event: unknown }>, event: AgentEvent): TurnNarrationRow | null {
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
  event: Extract<AgentEvent, { type: "tool" }>,
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
      toolId: event.id,
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
      toolId: event.id,
      call: event.call,
      state: event.result,
      ...(event.truncated === true ? { truncated: true } : {}),
    });
    return;
  }
  const durationMs = duration(started.at, fact.at);
  rows[index!] = {
    kind: "tool",
    sequence: fact.sequence,
    turnSequence: fact.turnSequence,
    at: fact.at,
    ...(durationMs === undefined ? {} : { durationMs }),
    name: event.name,
    toolId: event.id,
    call: event.call,
    state: event.result,
    ...(started.truncated === true || event.truncated === true ? { truncated: true } : {}),
  };
  running.delete(key);
}

function projectActivityEvent(state: ProjectionState, fact: Extract<TimelineFact, { kind: "activity" }>): void {
  const event: AgentEvent = fact.event;
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
): Readonly<{ rows: readonly (OpenTurnRow | UnsettledToolRow)[]; outcome: OutcomeRow | undefined }> {
  if (outcome?.outcome.kind !== "answered") return { rows, outcome };
  const finalVoice = rows.findLast((row): row is SaidRow => row.kind === "said");
  return finalVoice?.text === outcome.outcome.answer && finalVoice.truncated !== true
    ? {
        rows: rows.filter((row) => row !== finalVoice),
        outcome: { ...outcome, outcome: { ...outcome.outcome, foldedSaidSequence: finalVoice.sequence } },
      }
    : { rows, outcome };
}

function finishTurn(turn: MutableTurn): ProjectedTurn {
  const folded = foldOutcomeVoice(turn.rows, turn.outcome);
  const rows = [...folded.rows].sort((left, right) => left.sequence - right.sequence);
  if (turn.phase === "closed" && folded.outcome !== undefined) {
    return { kind: "closed", turn: turn.turn, rows: rows.map(demoteActive), outcome: folded.outcome };
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
    } else if (fact.kind === "report") {
      const turn = state.turnsBySequence.get(fact.turnSequence);
      if (turn === undefined) state.orphanRows.push(fact);
      else turn.rows.push(fact);
    } else if (fact.kind === "tell") {
      state.tells.push(projectTell(fact));
    } else {
      projectActivityEvent(state, fact);
    }
  }
  return finishLedger(state, retained);
}

export { ordinarySnapshotBudget, selectHistory, selectSnapshot, withoutReportedChanges } from "./projection-read.js";
