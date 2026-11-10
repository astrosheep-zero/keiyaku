import {
  toolCallSchema,
  toolResultSchema,
  fileChangeSchema,
  diffstatSchema,
  type AgentEvent,
  type ToolCall,
  type ToolResult,
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
export const publicFileChangeSchema = fileChangeSchema
  .extend({
    diffstat: strictDiffstatSchema.exactOptional(),
    patch: fileChangeSchema.shape.patch.unwrap().exactOptional(),
  })
  .strict()
  .readonly();
// Public observation historically admits zero-based read positions, unlike native narration.
export const publicRunCallSchema = runCall.strict().readonly();
export const publicReadCallSchema = readCall
  .extend({ offset: countSchema.exactOptional(), limit: countSchema.exactOptional() })
  .strict()
  .readonly();
export const publicSearchCallSchema = searchCall
  .extend({
    scope: searchCall.shape.scope.unwrap().exactOptional(),
    path: searchCall.shape.path.unwrap().exactOptional(),
    glob: searchCall.shape.glob.unwrap().exactOptional(),
  })
  .strict()
  .readonly();
export const publicChangeCallSchema = changeCall
  .extend({ changes: z.array(publicFileChangeSchema).readonly() })
  .strict()
  .readonly();
const publicOtherCallSchema = otherCall
  .omit({ display: true })
  .extend({
    input: z
      .strictObject({
        json: z.string(),
        truncated: z.literal(true).exactOptional(),
      })
      .readonly()
      .exactOptional(),
  })
  .strict()
  .readonly();
const publicToolCallSchema = z.union([
  publicRunCallSchema,
  publicReadCallSchema,
  publicSearchCallSchema,
  publicChangeCallSchema,
  publicOtherCallSchema,
]);
export const publicToolResultSchema = toolResultSchema
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
  })
  .strict()
  .readonly() satisfies z.ZodType<TellDelivery>;
const turnRowSchema = z
  .object({
    kind: z.literal("turn"),
    sequence: countSchema,
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
export const textRowSchema = (kind: "said" | "thought" | "note") =>
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
export const outcomeSchema = z.union([
  z
    .object({
      kind: z.literal("answered"),
      answer: z.string(),
      foldedSaidSequence: countSchema.exactOptional(),
    })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal("failed"), diagnostic: z.string() })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal("canceled") })
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
    toolId: z.string(),
    truncated: z.literal(true).exactOptional(),
  })
  .strict()
  .readonly();
/** Tool state varies inside one kind-tagged row, not competing tool alternatives. */
export const toolRowSchema = completedToolRowSchema
  .unwrap()
  .extend({ state: z.union([z.enum(["active", "unsettled"]), publicToolResultSchema]) })
  .readonly();
const openToolRowSchema = toolRowSchema
  .unwrap()
  .extend({ state: z.union([z.literal("active"), publicToolResultSchema]) })
  .refine((row) => row.state !== "active" || row.durationMs === undefined, "active tool has no duration")
  .readonly();
const snapshotFactRowSchema = z.union([
  reportRowSchema,
  callRowSchema,
  textRowSchema("said"),
  textRowSchema("thought"),
  textRowSchema("note"),
  tellRowSchema,
]);
const openSnapshotRowSchema = z.union([snapshotFactRowSchema, openToolRowSchema]);
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
const reportedFileChangeSchema = z
  .object({
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
      ...reportedChangeFields,
    })
    .strict()
    .readonly(),
]);

type TurnOutcome = z.output<typeof outcomeSchema>;
export type TurnStartRow = z.output<typeof turnRowSchema>;
type CallRow = z.output<typeof callRowSchema>;
type SaidRow = z.output<ReturnType<typeof textRowSchema>>;
type ThoughtRow = z.output<ReturnType<typeof textRowSchema>>;
type NoteRow = z.output<ReturnType<typeof textRowSchema>>;
export type ReportRow = z.output<typeof reportFactSchema>;
type TurnNarrationRow = CallRow | SaidRow | ThoughtRow | NoteRow | ReportRow;
export type { TellRow } from "./heart/facts.js";
export type OutcomeRow = z.output<typeof outcomeRowSchema>;

function publicOutcome(outcome: TurnEndFact["outcome"]): TurnOutcome {
  if (outcome.kind === "answered") return { kind: "answered", answer: outcome.answer };
  if (outcome.kind === "canceled") return { kind: "canceled" };
  return { kind: "failed", diagnostic: outcome.diagnostic };
}

export type ToolRow = z.output<typeof toolRowSchema>;
type ToolRowFields = Omit<ToolRow, "state">;
export type ActiveToolRow = ToolRowFields & Readonly<{ state: "active" }>;
export type CompletedToolRow = z.output<typeof completedToolRowSchema>;
export type UnsettledToolRow = ToolRowFields & Readonly<{ state: "unsettled" }>;

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
export type ActivityRow = z.output<typeof activityRowSchema>;
export type OpenSnapshotRow = z.output<typeof openSnapshotRowSchema>;
export type IdleSnapshotRow = z.output<typeof idleSnapshotRowSchema>;
export type SnapshotRow = OpenSnapshotRow | IdleSnapshotRow;
export type ActivitySnapshotEntry<Row extends SnapshotRow = SnapshotRow> = z.output<
  ReturnType<typeof snapshotEntrySchema<z.ZodType<Row>>>
>;
export type ReportedFileChange = z.output<typeof reportedFileChangeSchema>;
export type ActivitySnapshot = z.output<typeof activitySnapshotSchema>;

export const activityRowSchema = z.union([
  turnRowSchema,
  callRowSchema,
  reportRowSchema,
  textRowSchema("said"),
  textRowSchema("thought"),
  textRowSchema("note"),
  tellRowSchema,
  toolRowSchema,
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

export type ActivityHistory = z.output<typeof activityHistorySchema>;

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
  const outcome = rows.find(
    (row): row is OutcomeRow => row.kind === "outcome" && row.turnSequence === selector.sequence,
  );
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

/** Private neutral tool values carry optional undefined; the published row omits absent members. */
function publicCall(call: ToolCall): ToolRow["call"] {
  if (call.kind === "read")
    return {
      kind: "read",
      path: call.path,
      ...(call.offset === undefined ? {} : { offset: call.offset }),
      ...(call.limit === undefined ? {} : { limit: call.limit }),
    };
  if (call.kind === "search")
    return {
      kind: "search",
      query: call.query,
      ...(call.scope === undefined ? {} : { scope: call.scope }),
      ...(call.path === undefined ? {} : { path: call.path }),
      ...(call.glob === undefined ? {} : { glob: call.glob }),
    };
  if (call.kind === "fileChange")
    return {
      kind: "fileChange",
      changes: call.changes.map((change) => ({
        op: change.op,
        path: change.path,
        ...(change.diffstat === undefined ? {} : { diffstat: change.diffstat }),
        ...(change.patch === undefined ? {} : { patch: change.patch }),
      })),
    };
  if (call.kind === "other")
    return {
      kind: "other",
      ...(call.input === undefined
        ? {}
        : {
            input: {
              json: call.input.json,
              ...(call.input.truncated ? { truncated: true } : {}),
            },
          }),
    };
  return { kind: "run", command: call.command };
}

function publicResult(result: ToolResult): CompletedToolRow["state"] {
  return {
    status: result.status,
    ...(result.message === undefined ? {} : { message: result.message }),
    ...(result.output === undefined ? {} : { output: result.output }),
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
  };
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
      call: publicCall(event.call),
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
      call: publicCall(event.call),
      state: publicResult(event.result),
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
    call: publicCall(event.call),
    state: publicResult(event.result),
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
    throw new Error(`open Turn ${turn.turn.sequence} contains an unsettled tool`);
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
        bodySequence: fact.bodySequence,
        at: fact.startedAt,
      };
      const projected: MutableTurn = { phase: "open", turn, rows: [], running: new Map() };
      state.turns.push(projected);
      state.turnsBySequence.set(turn.sequence, projected);
    } else if (fact.kind === "turn-end") {
      const outcome = {
        kind: "outcome" as const,
        sequence: fact.sequence,
        turnSequence: fact.turnSequence,
        at: fact.completedAt,
        outcome: publicOutcome(fact.outcome),
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
      const tell = projectTell(fact);
      state.tells.push({ ...tell, deliveries: tell.deliveries.map(({ receipt: _receipt, ...delivery }) => delivery) });
    } else {
      projectActivityEvent(state, fact);
    }
  }
  return finishLedger(state, retained);
}

export { ordinarySnapshotBudget, selectHistory, selectSnapshot, withoutReportedChanges } from "./projection-read.js";
