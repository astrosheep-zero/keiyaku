import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  publicFileChangeSchema,
  publicPermissionRequestSchema,
  type PermissionRow,
  type ActivityRow,
  type ToolRow,
} from "./projection.js";
import { turnHistoryIdSchema } from "./identity.js";

const sequence = z.number().int().nonnegative().safe();
const coordinate = z.strictObject({ id: sequence, turnSequence: sequence, toolId: z.string() }).readonly();
export const currentWorkSchema = z
  .strictObject({
    kind: z.enum(["open", "idle"]),
    turn: z.strictObject({ sequence, bodySequence: sequence }).readonly().exactOptional(),
    activeTools: z.array(coordinate).nonempty().readonly().exactOptional(),
    latestActivity: sequence.exactOptional(),
    awaiting: z
      .strictObject({
        kind: z.literal("permission"),
        id: sequence,
        requests: z.array(publicPermissionRequestSchema).nonempty().readonly(),
        clipped: z.literal(true).exactOptional(),
      })
      .readonly()
      .exactOptional(),
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

function result(row: ToolRow): Pick<ToolRepr, "suffix" | "diagnostic"> {
  if (row.result === undefined) return { suffix: "", diagnostic: "" };
  const exitCode = row.result.exitCode;
  const disposition = exitCode !== undefined ? (exitCode === 0 ? "ok" : `exit ${exitCode}`) : row.result.status;
  return { suffix: disposition === "ok" ? "" : ` — ${disposition}`, diagnostic: row.result.message ?? "" };
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

function fileChange(call: Extract<ToolRow["call"], { kind: "fileChange" }>, phase: ToolRow["phase"]): ToolRepr {
  const first = call.changes[0];
  if (first === undefined) return { label: "edit", text: "files", suffix: "", diagnostic: "" };
  const label =
    call.changes.length === 1 ? (first.op === "add" ? "write" : first.op === "delete" ? "delete" : "edit") : "edit";
  const before = call.changes.length === 1 ? "" : `${call.changes.length} files · `;
  const path = oneLine(first.path);
  const complete = call.changes.every((change) => change.diffstat !== undefined);
  if (!complete && phase === "started") {
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
      return fileChange(row.call, row.phase);
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

/** A neutral observation of approval work, not a policy or a response channel. */
export function permissionText(row: PermissionRow): string {
  if (row.requests.length === 0) return "Approval wait cleared";
  return `Awaiting approval: ${row.requests
    .map((request) =>
      [request.action, ...(request.tool === undefined ? [] : [request.tool]), ...request.resources].join(" · "),
    )
    .join("; ")}`;
}

function currentAction(row: ActivityRow): CurrentWork["summary"] {
  let text: string;
  if (row.kind === "permission") text = permissionText(row);
  else if (row.kind === "tool") {
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

function belongsToTurn(row: ActivityRow, sequence: number | undefined): boolean {
  if (row.kind === "tell") return row.deliveries.some((delivery) => delivery.turnSequence === sequence);
  return (row.kind === "turn" ? row.sequence : row.turnSequence) === sequence;
}

/** Turn membership follows retained coordinates, including delivered Tells. */
export function frontierRows(rows: readonly ActivityRow[]): readonly ActivityRow[] {
  const turn = rows.findLast((row) => row.kind === "turn");
  return rows.filter((row) => belongsToTurn(row, turn?.sequence));
}

export function frontierTail(rows: readonly ActivityRow[]): readonly ActivityRow[] {
  return frontierRows(rows).slice(-3);
}

function unmatchedTools(rows: readonly ActivityRow[], turnSequence: number): readonly ToolRow[] {
  const active = new Map<string, ToolRow>();
  for (const row of rows) {
    if (row.kind !== "tool" || !belongsToTurn(row, turnSequence)) continue;
    active.delete(row.toolId);
    if (row.phase === "started") active.set(row.toolId, row);
  }
  return [...active.values()];
}

/** Current work reads the complete directly retained frontier, never a bounded tail. */
export function projectCurrentWork(rows: readonly ActivityRow[]): CurrentWork {
  const turn = rows.findLast((row) => row.kind === "turn");
  const outcome = rows.findLast((row) => row.kind === "outcome");
  const open = turn !== undefined && (outcome === undefined || outcome.turnSequence !== turn.sequence);
  const active = open ? unmatchedTools(rows, turn.sequence) : [];
  const pending = rows.flatMap((row) =>
    row.kind === "tell" && row.state === "pending" ? [{ id: row.sequence, tellId: row.tellId }] : [],
  );
  const permission = open
    ? rows.findLast((row): row is PermissionRow => row.kind === "permission" && belongsToTurn(row, turn.sequence))
    : undefined;
  const awaiting = permission?.requests.length ? permission : undefined;
  const selected =
    awaiting ??
    active.at(-1) ??
    rows.findLast(
      (row) =>
        (row.kind === "said" || row.kind === "call" || (row.kind === "tell" && row.state === "told")) &&
        belongsToTurn(row, turn?.sequence),
    );
  const summary = selected === undefined ? undefined : currentAction(selected);
  return {
    kind: open ? "open" : "idle",
    ...(turn === undefined ? {} : { turn: { sequence: turn.sequence, bodySequence: turn.bodySequence } }),
    ...(active.length === 0
      ? {}
      : {
          activeTools: active.map((row) => ({
            id: row.sequence,
            turnSequence: row.turnSequence,
            toolId: row.toolId,
          })),
        }),
    ...(awaiting === undefined
      ? {}
      : {
          awaiting: {
            kind: "permission" as const,
            id: awaiting.sequence,
            requests: awaiting.requests,
            ...(awaiting.truncated === true ? { clipped: true as const } : {}),
          },
        }),
    ...(rows.length === 0 ? {} : { latestActivity: rows.at(-1)!.sequence }),
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

export const reportedFileChangeSchema = publicFileChangeSchema.unwrap().pick({ path: true, diffstat: true }).readonly();
type ReportedFileChange = z.output<typeof reportedFileChangeSchema>;

function accumulateChange(previous: ReportedFileChange | undefined, change: ReportedFileChange): ReportedFileChange {
  if (previous === undefined) return change;
  const before = previous.diffstat;
  const after = change.diffstat;
  return before === undefined || after === undefined
    ? { path: change.path }
    : { path: change.path, diffstat: { added: before.added + after.added, removed: before.removed + after.removed } };
}

/** Native status derives its detail and advisory changes on the same work frontier. */
export function summarizeFrontier(rows: readonly ActivityRow[], executionDir: string) {
  const work = projectCurrentWork(rows);
  const recent = frontierTail(rows);
  const changes = new Map<string, ReportedFileChange>();
  for (const row of rows) {
    if (
      row.kind !== "tool" ||
      !belongsToTurn(row, work.turn?.sequence) ||
      row.phase !== "completed" ||
      row.result?.status !== "ok" ||
      row.call.kind !== "fileChange"
    )
      continue;
    for (const { path, diffstat } of row.call.changes) {
      const combined = accumulateChange(changes.get(path), { path, ...(diffstat === undefined ? {} : { diffstat }) });
      changes.delete(path);
      changes.set(path, combined);
    }
  }
  const inside = [...changes.values()].filter((change) => {
    const path = relative(executionDir, resolve(executionDir, change.path));
    return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  });
  const outside = changes.size - inside.length;
  return {
    work,
    ...(recent.length === 0 ? {} : { recent }),
    ...(inside.length === 0 ? {} : { changes: inside.slice(-5) }),
    ...(inside.length > 5 ? { moreChanges: true as const } : {}),
    ...(outside === 0 ? {} : { outsideChanges: outside }),
  };
}
