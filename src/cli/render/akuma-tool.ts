import type { ActivityRow, SnapshotRow } from "../../akuma/akuma.js";
import type { AkumaObservation } from "../../index.js";
import { displayColumns, truncateDisplayText } from "./terminal.js";
import { normalizeToolCommand } from "./akuma-tool-command.js";

type FleetTimelineRow = Extract<AkumaObservation["status"]["timeline"]["entries"][number], { kind: "row" }>["row"];
type ToolRow = Extract<ActivityRow | SnapshotRow | FleetTimelineRow, { kind: "tool" }>;

/** The bounded body of a generic tool row, including its terminal diagnostic. */
export function toolContent(row: ToolRow, columns: number): string {
  const input = row.call.kind === "other" ? row.call.input : undefined;
  const diagnostic = toolDiagnostic(row);
  const width = Math.max(0, columns - displayColumns(diagnostic));
  let text: string;
  if (input === undefined) {
    text = "";
  } else {
    const common = commonOtherText(row);
    if (common !== undefined) text = common;
    else if (input.json === "{}") text = "";
    else if (input.truncated) text = `${input.json}…`;
    else {
      const value = jsonObject(input.json);
      text = value === undefined ? input.json : objectFieldsText(value, width);
    }
  }
  return `${truncateDisplayText(text, width)}${diagnostic}`;
}

export function toolLabel(row: ToolRow): string {
  return toolCore(row).label;
}

/** The trailing failure, duration, or message clause one settled tool row carries, otherwise the empty string. */
export function toolDiagnostic(row: ToolRow): string {
  const suffix = result(row);
  return suffix === undefined ? "" : ` — ${suffix}`;
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
  return truncateDisplayText(full, columns);
}

export type ToolRepr = Readonly<{
  label: string;
  text: string;
  overflow?: "middle-ellipsis";
  suffix?: string;
}>;

type ToolCore = Omit<ToolRepr, "suffix">;

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

function result(row: ToolRow): string | undefined {
  if (row.state === "active" || row.state === "unsettled") return undefined;
  const disposition =
    row.state.exitCode !== undefined
      ? row.state.exitCode === 0
        ? "ok"
        : `exit ${row.state.exitCode}`
      : row.state.status;
  const parts = [
    ...(row.call.kind === "run" && row.durationMs !== undefined ? [duration(row.durationMs)] : []),
    ...(disposition === "ok" ? [] : [disposition]),
    ...(row.state.message === undefined ? [] : [oneLine(row.state.message)]),
  ];
  return parts.length === 0 ? undefined : parts.join(" · ");
}

function readText(call: Extract<ToolRow["call"], { kind: "read" }>): string {
  const path = oneLine(call.path);
  if (call.offset !== undefined && call.limit !== undefined) {
    return `${path} · L${call.offset}-${call.offset + call.limit - 1}`;
  }
  if (call.offset !== undefined) return `${path} · from L${call.offset}`;
  if (call.limit !== undefined) return `${path} · ${call.limit} lines`;
  return path;
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

function inputObject(row: ToolRow): Readonly<Record<string, unknown>> | undefined {
  if (row.call.kind !== "other" || row.call.input?.truncated === true) return undefined;
  return jsonObject(row.call.input?.json ?? "");
}

function suppliedSlice(value: Readonly<Record<string, unknown>>): string {
  const offset = typeof value.offset_chars === "number" ? `from ${value.offset_chars}` : "";
  const limit = typeof value.limit_chars === "number" ? `${value.limit_chars} chars` : "";
  return [offset, limit].filter(Boolean).join(" · ");
}

function commonOtherText(row: ToolRow): string | undefined {
  const input = inputObject(row);
  if (input === undefined) return undefined;
  if (row.name === "get_context_remaining") return undefined;
  if (row.name === "notes_read") {
    const address =
      typeof input.address === "string" ? input.address : typeof input.path === "string" ? input.path : undefined;
    return [address, suppliedSlice(input)]
      .filter((value): value is string => value !== undefined && value !== "")
      .join(" · ");
  }
  if (row.name === "history_read") {
    const item = typeof input.item_id === "string" ? input.item_id : undefined;
    const window = typeof input.window_id === "string" ? input.window_id : undefined;
    return [item, window, suppliedSlice(input)]
      .filter((value): value is string => value !== undefined && value !== "")
      .join(" · ");
  }
  if (row.name === "history_list") {
    const role = typeof input.role === "string" ? `role ${input.role}` : undefined;
    const order =
      input.recent_first === true ? "newest first" : input.recent_first === false ? "oldest first" : undefined;
    const limit = typeof input.limit === "number" ? `${input.limit} rows` : undefined;
    return [role, order, limit].filter((value): value is string => value !== undefined).join(" · ");
  }
  return undefined;
}

function fileChange(call: Extract<ToolRow["call"], { kind: "fileChange" }>, state: ToolRow["state"]): ToolCore {
  const first = call.changes[0];
  if (first === undefined) return { label: "edit", text: "files" };
  const label =
    call.changes.length === 1 ? (first.op === "add" ? "write" : first.op === "delete" ? "delete" : "edit") : "edit";
  const subject =
    call.changes.length === 1 ? oneLine(first.path) : `${call.changes.length} files · ${oneLine(first.path)} ...`;
  const complete = call.changes.every((change) => change.diffstat !== undefined);
  if (!complete && (state === "active" || state === "unsettled")) return { label, text: subject };
  if (!complete) return { label, text: `${subject} — +? -?` };
  const totals = call.changes.reduce(
    (sum, change) => ({
      added: sum.added + change.diffstat!.added,
      removed: sum.removed + change.diffstat!.removed,
    }),
    { added: 0, removed: 0 },
  );
  return { label, text: `${subject} — +${totals.added} -${totals.removed}` };
}

/** One provider-neutral core owns every tool-kind label and non-generic body. */
function toolCore(row: ToolRow): ToolCore {
  switch (row.call.kind) {
    case "run":
      return {
        label: "run",
        text: `$ ${oneLine(normalizeToolCommand(row.call.command))}`,
        overflow: "middle-ellipsis",
      };
    case "read":
      return { label: "read", text: readText(row.call) };
    case "search":
      return { label: searchLabel(row.call.scope), text: searchText(row.call) };
    case "fileChange":
      return fileChange(row.call, row.state);
    case "other":
      return { label: row.name, text: "" };
  }
}

/** Pure provider-neutral tool presentation; it performs no activity selection. */
export function toolRepr(row: ToolRow): ToolRepr {
  const core = toolCore(row);
  if (row.call.kind === "other") return core;
  const suffix = result(row);
  if (suffix === undefined) return core;
  return core.overflow === "middle-ellipsis"
    ? { ...core, suffix: ` — ${suffix}` }
    : { ...core, text: `${core.text} — ${suffix}` };
}
