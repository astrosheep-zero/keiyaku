import type { ActivityRow } from "../../akuma/projection.js";
import type { StatusPreview } from "../../akuma/status-projection.js";
import { displayColumns } from "./terminal.js";

type ToolRow = Extract<ActivityRow | StatusPreview, { kind: "tool" }>;

function toolInput(row: ToolRow): Readonly<{ json: string; truncated?: boolean }> | undefined {
  const input = row.call.kind === "other" ? row.call.input : undefined;
  return typeof input === "string" ? { json: input } : input;
}
function toolName(row: ToolRow): string {
  return "name" in row ? row.name : row.call.kind;
}

/** The bounded argument body of a generic tool row. */
export function toolContent(row: ToolRow, columns: number): string {
  const input = toolInput(row);
  let text: string;
  if (input === undefined || input.json === "{}") text = "";
  else if (input.truncated) text = `${input.json}…`;
  else {
    const value = jsonObject(input.json);
    text = value === undefined ? input.json : objectFieldsText(value, columns);
  }
  return text;
}

function jsonObject(json: string): Readonly<Record<string, unknown>> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/**
 * Retain leading whole fields that fit and name the trailing omit count. When
 * even that marker cannot fit, keep the first field or the object's own prefix
 * with a visible ellipsis, never a silently complete-looking value.
 */
function objectFieldsText(value: Readonly<Record<string, unknown>>, columns: number): string {
  const fields = Object.entries(value).map(([key, field]) => `${JSON.stringify(key)}:${JSON.stringify(field)}`);
  if (fields.length === 0) return "";
  const full = `{${fields.join(",")}}`;
  if (displayColumns(full) <= columns) return full;
  for (let count = fields.length - 1; count >= 1; count -= 1) {
    const candidate = `{${fields.slice(0, count).join(",")}} +${fields.length - count} fields`;
    if (displayColumns(candidate) <= columns) return candidate;
  }
  const first = fields[0]!;
  if (fields.length > 1 && displayColumns(first) <= columns) return `${first}…`;
  return full;
}

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
  const exitCode = "exitCode" in row.state ? row.state.exitCode : undefined;
  const durationMs = "durationMs" in row ? row.durationMs : undefined;
  const disposition = exitCode !== undefined ? (exitCode === 0 ? "ok" : `exit ${exitCode}`) : row.state.status;
  const parts = [
    ...(row.call.kind === "run" && durationMs !== undefined ? [duration(durationMs)] : []),
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

/** The one diffstat renderer: unknown stays unknown, known renders compact additions and removals. */
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

/** One provider-neutral core owns every tool-kind label and non-generic body. */
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
    case "other":
      return { label: toolName(row), text: "", suffix: "", diagnostic: "" };
  }
}

/** Pure provider-neutral tool presentation; it performs no activity selection. */
export function toolRepr(row: ToolRow): ToolRepr {
  const core = toolCore(row);
  const { suffix, diagnostic } = result(row);
  return { ...core, suffix: `${core.suffix}${suffix}`, diagnostic };
}
