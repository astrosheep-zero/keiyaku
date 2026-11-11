import { z } from "zod";
import { outcomeSchema, type ActivityRow, type ActivitySnapshot, type OutcomeRow, type ToolRow } from "./projection.js";

export const activityEntrySchema = z
  .strictObject({ id: z.number().int().positive().safe(), text: z.string() })
  .readonly();
export const compactOutcomeSchema = z.union([
  outcomeSchema.options[0].unwrap().omit({ foldedSaidSequence: true }).readonly(),
  outcomeSchema.options[1],
  outcomeSchema.options[2],
]);
export const compactTimelineSchema = z.union([
  z
    .strictObject({ kind: z.literal("open"), entries: z.array(activityEntrySchema).min(1).readonly().exactOptional() })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("idle"),
      entries: z.array(activityEntrySchema).min(1).readonly().exactOptional(),
      outcome: compactOutcomeSchema.exactOptional(),
    })
    .readonly(),
]);
export type ActivityEntry = z.output<typeof activityEntrySchema>;
export type CompactOutcome = z.output<typeof compactOutcomeSchema>;
export type CompactTimeline = z.output<typeof compactTimelineSchema>;

export type ToolRepr = Readonly<{
  label: string;
  text: string;
  suffix: string;
  diagnostic: string;
}>;

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function duration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function result(row: ToolRow): Pick<ToolRepr, "suffix" | "diagnostic"> {
  if (typeof row.state === "string") return { suffix: "", diagnostic: "" };
  const exitCode = row.state.exitCode;
  const disposition = exitCode !== undefined ? (exitCode === 0 ? "ok" : `exit ${exitCode}`) : row.state.status;
  const parts = [
    ...(row.call.kind === "run" && row.durationMs !== undefined ? [duration(row.durationMs)] : []),
    ...(disposition === "ok" ? [] : [disposition]),
  ];
  return { suffix: parts.length === 0 ? "" : ` — ${parts.join(" · ")}`, diagnostic: row.state.message ?? "" };
}

function readText(call: Extract<ToolRow["call"], { kind: "read" }>): ToolRepr {
  const path = oneLine(call.path);
  const detail =
    call.offset !== undefined && call.limit !== undefined
      ? ` · L${call.offset}-${call.offset + call.limit - 1}`
      : call.offset !== undefined
        ? ` · from L${call.offset}`
        : call.limit !== undefined
          ? ` · ${call.limit} ${call.limit === 1 ? "line" : "lines"}`
          : "";
  return { label: "read", text: path, suffix: detail, diagnostic: "" };
}

function searchLabel(scope: Extract<ToolRow["call"], { kind: "search" }>["scope"]): string {
  if (scope === "files") return "find";
  if (scope === "web") return "web";
  return "search";
}

function searchText(call: Extract<ToolRow["call"], { kind: "search" }>): string {
  return [
    oneLine(call.query),
    ...(call.path === undefined ? [] : [oneLine(call.path)]),
    ...(call.glob === undefined ? [] : [oneLine(call.glob)]),
  ].join(" · ");
}

/** Unknown stays unknown; known changes retain their aggregate diffstat. */
export function renderDiffstat(diffstat: Readonly<{ added: number; removed: number }> | undefined): string {
  return diffstat === undefined ? "~" : `+${diffstat.added} -${diffstat.removed}`;
}

function fileChange(call: Extract<ToolRow["call"], { kind: "fileChange" }>, state: ToolRow["state"]): ToolRepr {
  const first = call.changes[0];
  if (first === undefined) return { label: "edit", text: "files", suffix: "", diagnostic: "" };
  const label =
    call.changes.length === 1 ? (first.op === "add" ? "write" : first.op === "delete" ? "delete" : "edit") : "edit";
  const before = call.changes.length === 1 ? "" : `${call.changes.length} files · `;
  const path = oneLine(first.path);
  const complete = call.changes.every((change) => change.diffstat !== undefined);
  if (!complete && (state === "active" || state === "unsettled")) {
    const detail = call.changes.length === 1 ? "" : " ...";
    return { label, text: `${before}${path}`, suffix: detail, diagnostic: "" };
  }
  const totals = complete
    ? call.changes.reduce(
        (sum, change) => ({
          added: sum.added + change.diffstat!.added,
          removed: sum.removed + change.diffstat!.removed,
        }),
        { added: 0, removed: 0 },
      )
    : undefined;
  const detail = `${call.changes.length === 1 ? "" : " ..."} — ${renderDiffstat(totals)}`;
  return { label, text: `${before}${path}`, suffix: detail, diagnostic: "" };
}

/** Formatting consumes only Keiyaku's neutral tool variants. */
function toolCore(row: ToolRow): ToolRepr {
  switch (row.call.kind) {
    case "run":
      return {
        label: "run",
        text: `$ ${oneLine(row.call.command)}`,
        suffix: "",
        diagnostic: "",
      };
    case "read":
      return readText(row.call);
    case "search":
      return { label: searchLabel(row.call.scope), text: searchText(row.call), suffix: "", diagnostic: "" };
    case "fileChange":
      return fileChange(row.call, row.state);
    case "other": {
      const input = row.call.input;
      return {
        label: row.name,
        text: input === undefined ? "" : `${input.json}${input.truncated && !input.json.endsWith("…") ? "…" : ""}`,
        suffix: "",
        diagnostic: "",
      };
    }
  }
}

/** Shared neutral presentation, independent of compact clipping and activity selection. */
export function toolRepr(row: ToolRow): ToolRepr {
  const core = toolCore(row);
  const { suffix, diagnostic } = result(row);
  return { ...core, suffix: `${core.suffix}${suffix}`, diagnostic };
}

export function projectActivityEntry(row: ActivityRow): ActivityEntry | undefined {
  let text: string;
  if (row.kind === "tool") {
    if (row.state === "unsettled") return undefined;
    const tool = toolRepr(row);
    const prefix = row.state === "active" ? "active: " : row.state.status === "error" ? "error: " : "";
    text = oneLine(
      `${prefix}${tool.label} ${tool.text}${tool.suffix}${tool.diagnostic === "" ? "" : ` · ${tool.diagnostic}`}`,
    );
  } else if (row.kind === "turn" || row.kind === "outcome") return undefined;
  else {
    const kind = row.kind === "tell" && row.state === "pending" ? "pending-tell" : row.kind;
    text = `${kind}: ${row.kind === "call" || row.kind === "tell" ? oneLine(row.text) : row.text}`;
  }
  const points = Array.from(text);
  const partial = "truncated" in row && row.truncated === true;
  if (points.length > 300 || partial) text = `${points.slice(0, 299).join("").replace(/…$/u, "")}…`;
  return { id: row.sequence, text };
}

export function projectStatusOutcome(row: OutcomeRow): CompactOutcome {
  const outcome = row.outcome;
  if (outcome.kind === "canceled") return { kind: "canceled" };
  const points = Array.from(outcome.kind === "answered" ? outcome.answer : outcome.diagnostic);
  const text = points.length > 500 ? `${points.slice(0, 499).join("")}…` : points.join("");
  return outcome.kind === "answered" ? { kind: "answered", answer: text } : { kind: "failed", diagnostic: text };
}

export function projectStatusTimeline(snapshot: ActivitySnapshot): CompactTimeline {
  if (snapshot.kind === "unborn") return { kind: "idle" };
  const entries = snapshot.entries.flatMap((entry) => {
    if (entry.kind === "gap" || entry.row.kind === "thought") return [];
    const projected = projectActivityEntry(entry.row);
    return projected === undefined ? [] : [projected];
  });
  return snapshot.kind === "open"
    ? { kind: "open", ...(entries.length === 0 ? {} : { entries }) }
    : {
        kind: "idle",
        ...(entries.length === 0 ? {} : { entries }),
        ...(snapshot.outcome === undefined ? {} : { outcome: projectStatusOutcome(snapshot.outcome) }),
      };
}
