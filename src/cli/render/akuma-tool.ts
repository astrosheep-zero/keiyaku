import type { ActivityRow, SnapshotRow } from "../../akuma/index.js";
import type { AkumaObservation } from "../../index.js";
import { normalizeToolCommand } from "./akuma-tool-command.js";

type FleetTimelineRow = Extract<AkumaObservation["status"]["timeline"]["entries"][number], { kind: "row" }>["row"];
type ToolRow = Extract<ActivityRow | SnapshotRow | FleetTimelineRow, { kind: "tool" }>;

export type ToolRepr = Readonly<{
  label: string;
  text: string;
  overflow?: "middle-ellipsis";
  suffix?: string;
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
    ...(row.call.kind === "fileChange" && disposition === "ok" ? [] : [disposition]),
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

function fileChange(call: Extract<ToolRow["call"], { kind: "fileChange" }>): ToolRepr {
  const first = call.changes[0];
  if (first === undefined) return { label: "edit", text: "files" };
  const label =
    call.changes.length === 1 ? (first.op === "add" ? "write" : first.op === "delete" ? "delete" : "edit") : "edit";
  const subject =
    call.changes.length === 1 ? oneLine(first.path) : `${call.changes.length} files · ${oneLine(first.path)} ...`;
  const complete = call.changes.every((change) => change.diffstat !== undefined);
  if (!complete) return { label, text: subject };
  const totals = call.changes.reduce(
    (sum, change) => ({
      added: sum.added + change.diffstat!.added,
      removed: sum.removed + change.diffstat!.removed,
    }),
    { added: 0, removed: 0 },
  );
  return { label, text: `${subject} — +${totals.added} -${totals.removed}` };
}

/** Pure provider-neutral tool presentation; it performs no activity selection. */
export function toolRepr(row: ToolRow): ToolRepr {
  let core: ToolRepr;
  switch (row.call.kind) {
    case "run":
      core = {
        label: "run",
        text: `$ ${oneLine(normalizeToolCommand(row.call.command))}`,
        overflow: "middle-ellipsis",
      };
      break;
    case "read":
      core = { label: "read", text: readText(row.call) };
      break;
    case "search":
      core = { label: searchLabel(row.call.scope), text: searchText(row.call) };
      break;
    case "fileChange":
      core = fileChange(row.call);
      break;
    case "other":
      core = { label: "use", text: oneLine(row.call.display || row.name) };
      break;
  }
  const suffix = result(row);
  if (suffix === undefined) return core;
  return core.overflow === "middle-ellipsis"
    ? { ...core, suffix: ` — ${suffix}` }
    : { ...core, text: `${core.text} — ${suffix}` };
}
