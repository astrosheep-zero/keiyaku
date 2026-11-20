import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  publicFileChangeSchema,
  publicPermissionRequestSchema,
  retainedTurnOutcome,
  turnOutcomeSchema,
  turnHistoryIdSchema,
  type PermissionRow,
  type ActivityRow,
  type ToolRow,
} from "./projection.js";
import { clipActionText, compactTimelineItem, oneLine, permissionText, toolSummary } from "./timeline-text.js";

const sequence = z.number().int().nonnegative().safe();
export const currentWorkSchema = z
  .strictObject({
    kind: z.enum(["open", "idle"]),
    turn: z.strictObject({ sequence }).readonly().exactOptional(),
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
      .array(z.strictObject({ id: sequence }).readonly())
      .nonempty()
      .readonly()
      .exactOptional(),
    outcome: z
      .strictObject({
        historyId: turnHistoryIdSchema,
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
export const addressedWorkSchema = currentWorkSchema
  .unwrap()
  .extend({ outcome: turnOutcomeSchema.exactOptional() })
  .readonly();
export type AddressedWork = z.output<typeof addressedWorkSchema>;

function currentAction(row: ActivityRow): CurrentWork["summary"] {
  let source: string;
  if (row.kind === "permission") source = permissionText(row);
  else if (row.kind === "tool") source = toolSummary(row);
  else if (row.kind === "call" || row.kind === "tell" || row.kind === "said") source = row.text;
  else return undefined;
  const text = oneLine(source);
  if (text === "") return undefined;
  const partial =
    ("truncated" in row && row.truncated === true) ||
    (row.kind === "tool" && row.call.kind === "other" && row.call.input?.truncated === true);
  return { id: row.sequence, ...clipActionText(text, partial) };
}

function belongsToTurn(row: ActivityRow, sequence: number | undefined): boolean {
  if (row.kind === "tell") return row.deliveries.some((delivery) => delivery.turnSequence === sequence);
  if (row.kind === "turn") return row.sequence === sequence;
  return "turnSequence" in row && row.turnSequence === sequence;
}

/** Turn membership follows retained coordinates, including delivered Tells. */
export function frontierRows(rows: readonly ActivityRow[]): readonly ActivityRow[] {
  const turn = rows.findLast((row) => row.kind === "turn");
  return rows.filter((row) => belongsToTurn(row, turn?.sequence));
}

export function frontierTail(rows: readonly ActivityRow[]) {
  return frontierRows(rows).slice(-3).map(compactTimelineItem);
}

function latestUnmatchedTool(rows: readonly ActivityRow[], turnSequence: number): ToolRow | undefined {
  const completed = new Set<string>();
  return rows.findLast((row): row is ToolRow => {
    if (row.kind !== "tool" || !belongsToTurn(row, turnSequence)) return false;
    if (row.phase === "started") return !completed.has(row.toolId);
    completed.add(row.toolId);
    return false;
  });
}

/** Current work reads the complete directly retained frontier, never a bounded tail. */
function workFrontier(rows: readonly ActivityRow[]) {
  const turn = rows.findLast((row) => row.kind === "turn");
  const outcome = rows.findLast((row) => row.kind === "outcome");
  const open = turn !== undefined && (outcome === undefined || outcome.turnSequence !== turn.sequence);
  const pending = rows.flatMap((row) => (row.kind === "tell" && row.state === "pending" ? [{ id: row.sequence }] : []));
  const permission = open
    ? rows.findLast((row): row is PermissionRow => row.kind === "permission" && belongsToTurn(row, turn.sequence))
    : undefined;
  const awaiting = permission?.requests.length ? permission : undefined;
  const selected =
    awaiting ??
    (open ? latestUnmatchedTool(rows, turn.sequence) : undefined) ??
    rows.findLast(
      (row) =>
        (row.kind === "said" || row.kind === "call" || (row.kind === "tell" && row.state === "told")) &&
        belongsToTurn(row, turn?.sequence),
    );
  const summary = selected === undefined ? undefined : currentAction(selected);
  const work: Omit<CurrentWork, "outcome"> = {
    kind: open ? "open" : "idle",
    ...(turn === undefined ? {} : { turn: { sequence: turn.sequence } }),
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
    ...(pending.length === 0 ? {} : { pending }),
    ...(summary === undefined ? {} : { summary }),
  };
  return { work, turn, outcome };
}

export function projectCurrentWork(rows: readonly ActivityRow[]): CurrentWork {
  const { work, outcome } = workFrontier(rows);
  if (outcome === undefined) return work;
  return { ...work, outcome: { historyId: `turn/${outcome.turnSequence}`, verdict: outcome.outcome.kind } };
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
  const { work, turn, outcome } = workFrontier(rows);
  const retained =
    outcome !== undefined ? retainedTurnOutcome(outcome) : turn === undefined ? undefined : retainedTurnOutcome(turn);
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
    work: { ...work, ...(retained === undefined ? {} : { outcome: retained }) },
    ...(recent.length === 0 ? {} : { recent }),
    ...(inside.length === 0 ? {} : { changes: inside.slice(-5) }),
    ...(inside.length > 5 ? { moreChanges: true as const } : {}),
    ...(outside === 0 ? {} : { outsideChanges: outside }),
  };
}
