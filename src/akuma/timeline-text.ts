import { opaqueCoordinate, previewLines, safeText } from "../text-preview.js";
import type { ActivityRow, ExactActivityRow, OutcomeRow, PermissionRow, TimelineItem, ToolRow } from "./projection.js";

export function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

const ACTION_PREVIEW_LIMIT = 300;

export function clipActionText(text: string, partial = false): Readonly<{ text: string; clipped?: true }> {
  const points: string[] = [];
  for (const point of text) {
    if (points.length === ACTION_PREVIEW_LIMIT) {
      partial = true;
      break;
    }
    points.push(point);
  }
  if (!partial) return { text };
  const prefix = points
    .slice(0, ACTION_PREVIEW_LIMIT - 1)
    .join("")
    .replace(/…$/u, "");
  return { text: `${prefix}…`, clipped: true };
}

type ToolRepr = Readonly<{ label: string; text: string; suffix: string; diagnostic: string }>;

function readText(call: Extract<ToolRow["call"], { kind: "read" }>): Omit<ToolRepr, "diagnostic"> {
  const suffix =
    call.offset !== undefined && call.limit !== undefined
      ? ` · L${call.offset}-${call.offset + call.limit - 1}`
      : call.offset !== undefined
        ? ` · from L${call.offset}`
        : call.limit !== undefined
          ? ` · ${call.limit} ${call.limit === 1 ? "line" : "lines"}`
          : "";
  return { label: "read", text: oneLine(call.path), suffix };
}

/** Unknown stays unknown; known changes retain their aggregate diffstat. */
export function renderDiffstat(diffstat: Readonly<{ added: number; removed: number }> | undefined): string {
  return diffstat === undefined ? "~" : `+${diffstat.added} -${diffstat.removed}`;
}

function fileChange(
  call: Extract<ToolRow["call"], { kind: "fileChange" }>,
  phase: ToolRow["phase"],
): Omit<ToolRepr, "diagnostic"> {
  const first = call.changes[0];
  if (first === undefined) return { label: "edit", text: "files", suffix: "" };
  const multiple = call.changes.length > 1;
  const label = multiple ? "edit" : first.op === "add" ? "write" : first.op === "delete" ? "delete" : "edit";
  const text = `${multiple ? `${call.changes.length} files · ` : ""}${oneLine(first.path)}`;
  const more = multiple ? " ..." : "";
  const complete = call.changes.every((change) => change.diffstat !== undefined);
  const totals = complete
    ? call.changes.reduce(
        (sum, change) => ({
          added: sum.added + change.diffstat!.added,
          removed: sum.removed + change.diffstat!.removed,
        }),
        { added: 0, removed: 0 },
      )
    : undefined;
  return { label, text, suffix: !complete && phase === "started" ? more : `${more} — ${renderDiffstat(totals)}` };
}

function toolCore(row: ToolRow): Omit<ToolRepr, "diagnostic"> {
  switch (row.call.kind) {
    case "run":
      return { label: "run", text: `$ ${oneLine(row.call.command)}`, suffix: "" };
    case "read":
      return readText(row.call);
    case "search": {
      const { scope, query, path, glob } = row.call;
      return {
        label: scope === "files" ? "find" : scope === "web" ? "web" : "search",
        text: [query, path, glob].flatMap((value) => (value === undefined ? [] : [oneLine(value)])).join(" · "),
        suffix: "",
      };
    }
    case "fileChange":
      return fileChange(row.call, row.phase);
    case "other": {
      const input = row.call.input;
      return {
        label: row.name,
        text: input === undefined ? "" : `${input.json}${input.truncated && !input.json.endsWith("…") ? "…" : ""}`,
        suffix: "",
      };
    }
  }
}

function toolRepr(row: ToolRow): ToolRepr {
  const core = toolCore(row);
  if (row.result === undefined) return { ...core, diagnostic: "" };
  const { exitCode, status, message } = row.result;
  const disposition = exitCode === undefined ? status : exitCode === 0 ? "ok" : `exit ${exitCode}`;
  return {
    ...core,
    suffix: `${core.suffix}${disposition === "ok" ? "" : ` — ${disposition}`}`,
    diagnostic: message ?? "",
  };
}

export function toolSummary(row: ToolRow): string {
  const { label, text, suffix, diagnostic } = toolRepr(row);
  return `${label} ${text}${suffix}${diagnostic === "" ? "" : ` · ${diagnostic}`}`;
}

function approvalRequests(requests: PermissionRow["requests"], escape = (value: string) => value): string[] {
  const lines = requests.map(({ action, tool, resources }) =>
    [action, ...(tool === undefined ? [] : [tool]), ...resources].map(escape).join(" · "),
  );
  if (lines.length === 0) lines.push("Approval wait cleared");
  else lines[0] = `Awaiting approval: ${lines[0]}`;
  return lines;
}

export function permissionText(row: PermissionRow): string {
  return approvalRequests(row.requests).join("; ");
}

export function approvalLines(requests: PermissionRow["requests"], clipped?: true): readonly string[] {
  const lines = approvalRequests(requests, safeText);
  return clipped ? [...lines, "…"] : lines;
}

function toolLines(row: ToolRow): readonly string[] {
  const { call, result } = row;
  const tool = toolRepr(row);
  const mark = row.phase === "started" ? "?" : result?.status === "ok" ? " " : "!";
  const label = tool.label === row.name ? tool.label : `${tool.label} (${row.name})`;
  const lines = [`${mark} ${safeText(label)} ${row.sequence}`];
  let path: string | undefined;
  let text = tool.text;
  let clipped = row.truncated;
  switch (call.kind) {
    case "read":
      path = call.path;
      text = "";
      break;
    case "fileChange": {
      const [first, second] = call.changes;
      if (first !== undefined) {
        path = first.path;
        text = second === undefined ? "" : `${call.changes.length} files`;
      }
      break;
    }
    case "search":
      if (call.path !== undefined) {
        path = call.path;
        text = [call.query, call.glob].filter(Boolean).join(" · ");
      }
      break;
    case "other":
      if (call.input !== undefined) {
        text = call.input.json;
        clipped ||= call.input.truncated;
      }
      break;
  }
  const clauses = tool.suffix.trimStart().replace(/^(?:· |— )/u, "");
  const detail = [clauses, result?.exitCode === 0 ? "exit 0" : ""].filter(Boolean).join(" · ");
  if (path !== undefined) lines.push(`  path  ${safeText(path)}`);
  if (text !== "" || clipped) lines.push(...previewLines(text, "  ", 1, clipped));
  if (detail !== "") lines.push(`  detail  ${safeText(detail)}`);
  if (tool.diagnostic !== "") lines.push("  cause", ...previewLines(tool.diagnostic, "    "));
  return lines;
}

export function outcomeText(outcome: OutcomeRow["outcome"]): string {
  return outcome.kind === "answered" ? outcome.answer : outcome.kind === "canceled" ? "canceled" : outcome.diagnostic;
}

/** One row vocabulary for compact snapshots and the exact item read. */
function rowText(row: ActivityRow, exact: boolean): readonly string[] {
  const id = row.sequence;
  let lead: string;
  switch (row.kind) {
    case "turn":
      return [];
    case "tool":
      if (!exact) return toolLines(row);
      return [`${row.result?.status === "error" ? "error: " : ""}${toolSummary(row)}`];
    case "permission":
      if (exact) return [`permission: ${permissionText(row)}`];
      return [
        `  approval ${id}`,
        ...previewLines(approvalRequests(row.requests, safeText).join("\n"), "  ", 3, row.truncated),
      ];
    case "outcome": {
      const coordinate = `turn/${row.turnSequence}`;
      const text = outcomeText(row.outcome);
      if (row.outcome.kind === "canceled") return [`○ ${coordinate} · ${text}`];
      const title = `${row.outcome.kind === "answered" ? "✓" : "!"} ${coordinate}`;
      return text === "" ? [title] : [title, ...previewLines(text, "  ")];
    }
    case "surveillance": {
      const text = `${row.off ? "unsurveilled" : "surveilled"} ${opaqueCoordinate(row.owner)}`;
      return exact ? [text] : previewLines(text, `  ${id} `);
    }
    case "report":
      lead = `  report/${id}`;
      break;
    case "said":
      lead = `▎ ${id}`;
      break;
    case "tell":
      lead = `${row.state === "pending" ? "⧗" : "▸"} ${id}`;
      break;
    case "call":
      lead = `▸ ${id}`;
      break;
    case "thought":
      lead = `  think ${id}`;
      break;
    case "note":
      lead = `  note ${id}`;
      break;
  }
  if (exact) return [`${row.kind === "tell" && row.state === "pending" ? "pending-tell" : row.kind}: ${row.text}`];
  const clipped = "truncated" in row && row.truncated === true;
  return row.text === "" && !clipped
    ? [lead]
    : [lead, ...previewLines(row.text, "  ", row.kind === "call" || row.kind === "tell" ? 1 : 3, clipped)];
}

export function compactTimelineItem(row: ActivityRow): TimelineItem {
  return { id: row.sequence, text: rowText(row, false).join("\n") };
}

export function exactActivityText(row: ExactActivityRow): string {
  return rowText(row, true).join("\n");
}
