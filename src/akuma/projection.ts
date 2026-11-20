import { selectHistoryPage } from "../history.js";
import { z } from "zod";
import {
  toolCallSchema,
  toolResultSchema,
  fileChangeSchema,
  diffstatSchema,
  permissionRequestSchema,
  type ToolCall,
  type ToolResult,
} from "./heart/activity-schema.js";
import type { TimelineFact, TurnEndFact } from "./heart/index.js";
import {
  projectTell,
  reportFactSchema,
  reportFactWireSchema,
  surveillanceFactSchema,
  type TellDelivery,
  type TellRow,
} from "./heart/facts.js";

const nonblankTextSchema = z.string().refine((value) => value.trim() !== "");
const countSchema = z.number().int().nonnegative();
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
export const publicRunCallSchema = runCall.strict().readonly();
// Historical public observations admit zero-based read positions.
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
      .strictObject({ json: z.string(), truncated: z.literal(true).exactOptional() })
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
export const publicPermissionRequestSchema = permissionRequestSchema
  .extend({ tool: permissionRequestSchema.shape.tool.unwrap().exactOptional() })
  .strict()
  .readonly();
const turnRowSchema = z
  .strictObject({
    kind: z.literal("turn"),
    sequence: countSchema,
    bodySequence: countSchema,
    at: timestampSchema,
  })
  .readonly();
const callRowSchema = z
  .strictObject({
    kind: z.literal("call"),
    sequence: countSchema,
    turnSequence: countSchema,
    at: timestampSchema,
    text: z.string(),
  })
  .readonly();
const permissionRowSchema = z
  .strictObject({
    kind: z.literal("permission"),
    sequence: countSchema,
    turnSequence: countSchema,
    at: timestampSchema,
    requests: z.array(publicPermissionRequestSchema).readonly(),
    truncated: z.literal(true).exactOptional(),
  })
  .readonly();
export const reportRowSchema = reportFactWireSchema;
export const textRowSchema = (kind: "said" | "thought" | "note") =>
  z
    .strictObject({
      kind: z.literal(kind),
      sequence: countSchema,
      turnSequence: countSchema,
      at: timestampSchema,
      text: z.string(),
      truncated: z.literal(true).exactOptional(),
    })
    .readonly();
const tellDeliverySchema = z
  .strictObject({
    deliveredAt: timestampSchema,
    route: z.enum(["launch", "live"]),
    turnSequence: countSchema,
  })
  .readonly() satisfies z.ZodType<TellDelivery>;
export const tellRowSchema = z
  .strictObject({
    kind: z.literal("tell"),
    sequence: countSchema,
    at: timestampSchema,
    tellId: nonblankTextSchema,
    text: z.string(),
    state: z.enum(["pending", "told"]),
    deliveries: z.array(tellDeliverySchema).readonly(),
  })
  .readonly() satisfies z.ZodType<TellRow>;
export const outcomeSchema = z.union([
  z.strictObject({ kind: z.literal("answered"), answer: z.string() }).readonly(),
  z.strictObject({ kind: z.literal("failed"), diagnostic: z.string() }).readonly(),
  z.strictObject({ kind: z.literal("canceled") }).readonly(),
]);
export const outcomeRowSchema = z
  .strictObject({
    kind: z.literal("outcome"),
    sequence: countSchema,
    turnSequence: countSchema,
    at: timestampSchema,
    outcome: outcomeSchema,
  })
  .readonly();
export const toolRowSchema = z
  .strictObject({
    kind: z.literal("tool"),
    sequence: countSchema,
    turnSequence: countSchema,
    at: timestampSchema,
    name: nonblankTextSchema,
    call: publicToolCallSchema,
    phase: z.enum(["started", "completed"]),
    result: publicToolResultSchema.exactOptional(),
    toolId: z.string(),
    truncated: z.literal(true).exactOptional(),
  })
  .refine((row) => (row.phase === "completed") === (row.result !== undefined), "only completed tools have results")
  .readonly();
export const activityRowSchema = z.union([
  permissionRowSchema,
  turnRowSchema,
  callRowSchema,
  reportRowSchema,
  surveillanceFactSchema,
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
export type TurnStartRow = z.output<typeof turnRowSchema>;
export type ReportRow = z.output<typeof reportFactSchema>;
export type PermissionRow = z.output<typeof permissionRowSchema>;
export type OutcomeRow = z.output<typeof outcomeRowSchema>;
export type ToolRow = z.output<typeof toolRowSchema>;
export type ActivityRow = z.output<typeof activityRowSchema>;
export type ActivityHistory = z.output<typeof activityHistorySchema>;
export type { TellRow } from "./heart/facts.js";
export type ExactHistory =
  | Readonly<{ kind: "exact"; outcome: OutcomeRow }>
  | Readonly<{ kind: "exact-report"; report: ReportRow }>
  | Readonly<{ kind: "exact-activity"; row: ActivityRow }>
  | Readonly<{ kind: "unknown-history"; id: string }>;
export type HistoryCursor = Readonly<{ before?: number; since?: number; limit: number }>;

function publicOutcome(outcome: TurnEndFact["outcome"]): OutcomeRow["outcome"] {
  if (outcome.kind === "answered") return { kind: "answered", answer: outcome.answer };
  if (outcome.kind === "canceled") return { kind: "canceled" };
  return { kind: "failed", diagnostic: outcome.diagnostic };
}

/** Omit absent wire members while constructing trusted neutral values. */
function publicCall(call: ToolCall): ToolRow["call"] {
  switch (call.kind) {
    case "read":
      return {
        kind: "read",
        path: call.path,
        ...(call.offset === undefined ? {} : { offset: call.offset }),
        ...(call.limit === undefined ? {} : { limit: call.limit }),
      };
    case "search":
      return {
        kind: "search",
        query: call.query,
        ...(call.scope === undefined ? {} : { scope: call.scope }),
        ...(call.path === undefined ? {} : { path: call.path }),
        ...(call.glob === undefined ? {} : { glob: call.glob }),
      };
    case "fileChange":
      return {
        kind: "fileChange",
        changes: call.changes.map((change) => ({
          op: change.op,
          path: change.path,
          ...(change.diffstat === undefined ? {} : { diffstat: change.diffstat }),
          ...(change.patch === undefined ? {} : { patch: change.patch }),
        })),
      };
    case "other":
      return {
        kind: "other",
        ...(call.input === undefined
          ? {}
          : {
              input: { json: call.input.json, ...(call.input.truncated ? { truncated: true } : {}) },
            }),
      };
    case "run":
      return { kind: "run", command: call.command };
  }
}

function publicResult(result: ToolResult): NonNullable<ToolRow["result"]> {
  return {
    status: result.status,
    ...(result.message === undefined ? {} : { message: result.message }),
    ...(result.output === undefined ? {} : { output: result.output }),
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
  };
}

/** Each retained fact has exactly one row, with its durable identity unchanged. */
export function projectFact(fact: TimelineFact): ActivityRow {
  switch (fact.kind) {
    case "turn-start":
      return { kind: "turn", sequence: fact.sequence, bodySequence: fact.bodySequence, at: fact.startedAt };
    case "turn-end":
      return {
        kind: "outcome",
        sequence: fact.sequence,
        turnSequence: fact.turnSequence,
        at: fact.completedAt,
        outcome: publicOutcome(fact.outcome),
      };
    case "call":
      return { kind: "call", sequence: fact.sequence, turnSequence: fact.turnSequence, at: fact.at, text: fact.body };
    case "report":
    case "surveillance":
      return fact;
    case "tell": {
      const tell = projectTell(fact);
      return { ...tell, deliveries: tell.deliveries.map(({ receipt: _receipt, ...delivery }) => delivery) };
    }
    case "activity": {
      const event = fact.event;
      const coordinate = { sequence: fact.sequence, turnSequence: fact.turnSequence, at: fact.at };
      const truncated = "truncated" in event && event.truncated === true ? { truncated: true as const } : {};
      if (event.type === "tool") {
        return {
          kind: "tool",
          ...coordinate,
          name: event.name,
          toolId: event.id,
          call: publicCall(event.call),
          phase: event.phase,
          ...(event.phase === "completed" ? { result: publicResult(event.result) } : {}),
          ...truncated,
        };
      }
      if (event.type === "permission") {
        return {
          kind: "permission",
          ...coordinate,
          requests: event.requests.map(({ tool, ...request }) => ({
            ...request,
            ...(tool === undefined ? {} : { tool }),
          })),
          ...truncated,
        };
      }
      if (event.type === "assistant" || event.type === "thought" || event.type === "note") {
        return {
          kind: event.type === "assistant" ? "said" : event.type,
          ...coordinate,
          text: event.text,
          ...truncated,
        };
      }
      return {
        kind: "note",
        ...coordinate,
        text: event.type === "unknown" ? event.kind : JSON.stringify(event),
        ...truncated,
      };
    }
  }
}

export function selectHistory(
  timeline: Readonly<{ rows: readonly ActivityRow[]; lowestRetained: number | null; highest: number | null }>,
  cursor: HistoryCursor,
): ActivityHistory {
  const { rows, omitted } = selectHistoryPage(timeline.rows, (row) => row.sequence, cursor);
  const historyLost =
    cursor.since !== undefined
      ? timeline.rows[0] !== undefined && timeline.rows[0].sequence > cursor.since + 1
      : timeline.lowestRetained !== null && timeline.lowestRetained > 1 && omitted === 0;
  return {
    rows,
    omitted,
    hasEarlier: cursor.since === undefined && omitted > 0,
    hasLater: cursor.since !== undefined && omitted > 0,
    historyLost,
    lowestRetained: timeline.lowestRetained,
    highest: timeline.highest,
  };
}

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
