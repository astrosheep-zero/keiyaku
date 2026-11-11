import { z } from "zod";
import { type ActiveToolRow, type ActivityRow, type ActivitySnapshot, type ToolRow } from "./projection.js";
import { turnHistoryIdSchema } from "./identity.js";

const sequence = z.number().int().nonnegative().safe();
const coordinate = z.strictObject({ id: sequence, turnSequence: sequence, toolId: z.string() }).readonly();
export const currentWorkSchema = z
  .strictObject({
    kind: z.enum(["open", "idle"]),
    turn: z.strictObject({ sequence, bodySequence: sequence }).readonly().exactOptional(),
    activeTools: z.array(coordinate).nonempty().readonly().exactOptional(),
    latestActivity: sequence.exactOptional(),
    pending: z
      .array(z.strictObject({ id: sequence, tellId: z.string() }).readonly())
      .nonempty()
      .readonly()
      .exactOptional(),
    outcome: z
      .strictObject({
        historyId: turnHistoryIdSchema,
        activityId: sequence,
        verdict: z.enum(["answered", "failed", "canceled"]),
      })
      .readonly()
      .exactOptional(),
    summary: z
      .strictObject({ id: sequence, text: z.string(), clipped: z.literal(true).exactOptional() })
      .readonly()
      .exactOptional(),
  })
  .readonly();
export type CurrentWork = z.output<typeof currentWorkSchema>;

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

function currentAction(row: ActivityRow): CurrentWork["summary"] {
  let text: string;
  if (row.kind === "tool") {
    const tool = toolRepr(row);
    text = `${tool.label} ${tool.text}${tool.suffix}${tool.diagnostic === "" ? "" : ` · ${tool.diagnostic}`}`;
  } else if (row.kind === "call" || row.kind === "tell" || row.kind === "said") text = row.text;
  else return undefined;
  const points = Array.from(oneLine(text));
  if (points.length === 0) return undefined;
  const clipped =
    points.length > 300 ||
    ("truncated" in row && row.truncated === true) ||
    (row.kind === "tool" && row.call.kind === "other" && row.call.input?.truncated === true);
  return {
    id: row.sequence,
    text: clipped ? `${points.slice(0, 299).join("").replace(/…$/u, "")}…` : points.join(""),
    ...(clipped ? { clipped: true } : {}),
  };
}

/** One semantic projection of the already selected retained frontier. */
export function projectCurrentWork(snapshot: ActivitySnapshot): CurrentWork {
  if (snapshot.kind === "unborn") return { kind: "idle" };
  const rows = snapshot.entries.flatMap((entry) => (entry.kind === "row" ? [entry.row] : []));
  const active = rows.filter((row): row is ActiveToolRow => row.kind === "tool" && row.state === "active");
  const pending = rows.flatMap((row) =>
    row.kind === "tell" && row.state === "pending" ? [{ id: row.sequence, tellId: row.tellId }] : [],
  );
  const selected =
    active.at(-1) ??
    rows.findLast((row) => row.kind === "said" || row.kind === "call" || (row.kind === "tell" && row.state === "told"));
  const summary = selected === undefined ? undefined : currentAction(selected);
  const outcome = snapshot.kind === "idle" ? snapshot.outcome : undefined;
  const latest = Math.max(rows.at(-1)?.sequence ?? -1, outcome?.sequence ?? -1);
  return {
    kind: snapshot.kind,
    ...(snapshot.kind === "open"
      ? { turn: { sequence: snapshot.turn.sequence, bodySequence: snapshot.turn.bodySequence } }
      : {}),
    ...(active.length === 0
      ? {}
      : {
          activeTools: active.map((row) => ({ id: row.sequence, turnSequence: row.turnSequence, toolId: row.toolId })),
        }),
    ...(latest < 0 ? {} : { latestActivity: latest }),
    ...(pending.length === 0 ? {} : { pending }),
    ...(outcome === undefined
      ? {}
      : {
          outcome: {
            historyId: `turn/${outcome.turnSequence}` as const,
            activityId: outcome.sequence,
            verdict: outcome.outcome.kind,
          },
        }),
    ...(summary === undefined ? {} : { summary }),
  };
}
