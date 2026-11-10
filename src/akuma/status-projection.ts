import { z } from "zod";
import {
  outcomeSchema,
  publicChangeCallSchema,
  publicFileChangeSchema,
  publicReadCallSchema,
  publicRunCallSchema,
  publicSearchCallSchema,
  publicToolResultSchema,
  reportRowSchema,
  textRowSchema,
  type ActivityRow,
  type ActivitySnapshot,
  type OutcomeRow,
  type ToolRow,
} from "./projection.js";

const fileChange = publicFileChangeSchema.unwrap().omit({ patch: true }).readonly();
const changeCall = publicChangeCallSchema
  .unwrap()
  .extend({ changes: z.array(fileChange).readonly() })
  .readonly();
const otherCall = z.strictObject({ kind: z.literal("other"), input: z.string().exactOptional() }).readonly();
const result = publicToolResultSchema.unwrap().pick({ status: true, message: true }).readonly();
const toolFields = {
  kind: z.literal("tool"),
  state: z.union([z.literal("active"), result]),
  truncated: z.literal(true).exactOptional(),
};
export const compactToolRowSchema = z.union([
  z
    .strictObject({ ...toolFields, call: publicRunCallSchema, durationMs: z.number().nonnegative().exactOptional() })
    .readonly(),
  z
    .strictObject({ ...toolFields, call: z.union([publicReadCallSchema, publicSearchCallSchema, changeCall]) })
    .readonly(),
  z.strictObject({ ...toolFields, call: otherCall, name: z.string() }).readonly(),
]);
const narration = (kind: "said" | "thought" | "note") =>
  textRowSchema(kind).unwrap().pick({ kind: true, text: true, truncated: true }).readonly();
const report = reportRowSchema.unwrap().pick({ kind: true, text: true }).readonly();
export const statusPreviewSchema = z.union([
  compactToolRowSchema,
  narration("said"),
  narration("thought"),
  narration("note"),
  report,
]);
export const compactOutcomeSchema = z.union([
  outcomeSchema.options[0].unwrap().omit({ foldedSaidSequence: true }).readonly(),
  outcomeSchema.options[1],
  outcomeSchema.options[2],
]);
const pendingInput = z.strictObject({ kind: z.literal("pending-tell"), text: z.string() }).readonly();
const openEntry = z.union([
  compactToolRowSchema,
  narration("said"),
  narration("note"),
  report,
  z.strictObject({ kind: z.literal("call"), text: z.string() }).readonly(),
  z.strictObject({ kind: z.literal("tell"), text: z.string() }).readonly(),
  pendingInput,
  z.strictObject({ kind: z.literal("gap") }).readonly(),
]);
export const compactTimelineSchema = z.union([
  z.strictObject({ kind: z.literal("open"), entries: z.array(openEntry).min(1).readonly().exactOptional() }).readonly(),
  z
    .strictObject({
      kind: z.literal("idle"),
      entries: z
        .array(z.union([pendingInput, compactOutcomeSchema]))
        .min(1)
        .readonly()
        .exactOptional(),
    })
    .readonly(),
]);
export type StatusPreview = z.output<typeof statusPreviewSchema>;
export type CompactOutcome = z.output<typeof compactOutcomeSchema>;
export type CompactTimeline = z.output<typeof compactTimelineSchema>;

function projectTool(row: ToolRow): z.output<typeof compactToolRowSchema> | undefined {
  if (row.state === "unsettled") return undefined;
  const exit = typeof row.state === "string" ? undefined : row.state.exitCode;
  const message = typeof row.state === "string" ? undefined : row.state.message;
  const diagnostic =
    exit === undefined || exit === 0
      ? message
      : [message, `exit ${exit}`].filter((value) => value !== undefined).join(" · ");
  const state =
    row.state === "active"
      ? ("active" as const)
      : { status: row.state.status, ...(diagnostic === undefined ? {} : { message: diagnostic }) };
  const fields = { kind: "tool" as const, state, ...(row.truncated === undefined ? {} : { truncated: row.truncated }) };
  const call = row.call;
  switch (call.kind) {
    case "run":
      return { ...fields, call, ...(row.durationMs === undefined ? {} : { durationMs: row.durationMs }) };
    case "read":
    case "search":
      return { ...fields, call };
    case "fileChange":
      return {
        ...fields,
        call: {
          kind: "fileChange",
          changes: call.changes.map(({ op, path, diffstat }) => ({
            op,
            path,
            ...(diffstat === undefined ? {} : { diffstat }),
          })),
        },
      };
    case "other":
      return {
        ...fields,
        name: row.name,
        call: {
          kind: "other",
          ...(call.input === undefined
            ? {}
            : { input: `${call.input.json}${call.input.truncated && !call.input.json.endsWith("…") ? "…" : ""}` }),
        },
      };
  }
}

/** Contextual static-read narrowing over the owner's retained projection. */
export function projectStatusPreview(row: ActivityRow): StatusPreview | undefined {
  if (row.kind === "tool") return projectTool(row);
  if (row.kind === "report") return { kind: "report", text: row.text };
  if (row.kind === "said" || row.kind === "thought" || row.kind === "note")
    return {
      kind: row.kind,
      text: row.text,
      ...(row.truncated === undefined ? {} : { truncated: row.truncated }),
    };
  return undefined;
}
export function projectStatusOutcome(row: OutcomeRow): CompactOutcome {
  const outcome = row.outcome;
  if (outcome.kind === "answered") return { kind: "answered", answer: outcome.answer };
  if (outcome.kind === "failed") return { kind: "failed", diagnostic: outcome.diagnostic };
  return { kind: "canceled" };
}
export function projectStatusTimeline(snapshot: ActivitySnapshot): CompactTimeline {
  if (snapshot.kind === "unborn") return { kind: "idle" };
  if (snapshot.kind === "idle") {
    const ordered: { sequence: number; entry: z.output<typeof pendingInput> | CompactOutcome }[] =
      snapshot.entries.flatMap((entry) =>
        entry.kind === "row" && entry.row.kind === "tell" && entry.row.state === "pending"
          ? [{ sequence: entry.row.sequence, entry: { kind: "pending-tell" as const, text: entry.row.text } }]
          : [],
      );
    if (snapshot.outcome !== undefined)
      ordered.push({ sequence: snapshot.outcome.sequence, entry: projectStatusOutcome(snapshot.outcome) });
    const entries = ordered.sort((left, right) => left.sequence - right.sequence).map(({ entry }) => entry);
    return { kind: "idle", ...(entries.length === 0 ? {} : { entries }) };
  }
  const entries: z.output<typeof openEntry>[] = snapshot.entries.flatMap((entry): z.output<typeof openEntry>[] => {
    if (entry.kind === "gap") return [{ kind: "gap" }];
    const row = entry.row;
    if (row.kind === "thought") return [];
    if (row.kind === "call") return [{ kind: "call", text: row.text }];
    if (row.kind === "tell") return [{ kind: row.state === "pending" ? "pending-tell" : "tell", text: row.text }];
    const preview = projectStatusPreview(row);
    return preview === undefined || preview.kind === "thought" ? [] : [preview];
  });
  return { kind: "open", ...(entries.length === 0 ? {} : { entries }) };
}
