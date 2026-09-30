import type {
  BlockedTaskList,
  BlockedTaskRow,
  TaskBatchResult,
  TaskCompositionDiagnostic,
  TaskCompositionResult,
  TaskDecompositionTree,
  TaskDetail,
  TaskDoctorIssue,
  TaskDoctorReport,
  TaskList,
  TaskMutationResult,
  TaskContextResult,
  TaskQueryResult,
  TaskQueryRow,
  TaskRef,
  TaskRefusal,
  TaskRow,
  TaskTreeNode,
  TaskUpdateResult,
  TaskView,
} from "../../task/index.js";
import { outcomeLines, refusalLines, receiptPayload, receiptRow } from "./receipt.js";
import { taskMark } from "./marks.js";
export { taskMark } from "./marks.js";
import { DEFAULT_CLI_COLUMNS, displayColumns, emptyCatalogue, safeText, type TextRenderContext } from "./terminal.js";

type TaskListOutcome = TaskList | BlockedTaskList | TaskQueryResult;
/** One addressed show selection: native details, or a refusal naming a missing addressed read. */
export type TaskShowResult = TaskDetail | TaskDetail[] | Extract<TaskMutationResult, { kind: "refused" }>;
/** Presentation-only list scope the leaf acquired; never part of a product value. */
export type TaskListScope = "world" | "current" | Readonly<{ namespace: string }>;
/** The union of native Task SDK answers one leaf renders directly; the CLI adds no result envelope. */
export type TaskNativeResult =
  | TaskMutationResult
  | TaskUpdateResult
  | TaskBatchResult
  | TaskCompositionResult
  | TaskShowResult
  | TaskList
  | BlockedTaskList
  | TaskQueryResult
  | TaskDecompositionTree
  | TaskDoctorReport
  | TaskContextResult;
type TaskFailure =
  | Extract<TaskMutationResult, { kind: "refused" | "retry" }>
  | Extract<TaskContextResult, { kind: "refused" | "retry" }>
  | Extract<TaskCompositionResult, { kind: "refused" }>;
type TaskWord = TaskRow["disposition"] | TaskView["state"] | TaskRef["state"];
type TaskEntity = Readonly<{
  id: string;
  priority: number | null;
  word?: TaskWord;
  facts?: string;
  title: string | null;
}>;
type RefusalProjection = Readonly<{
  diagnostic: string;
  facts?: readonly string[];
  compositionDiagnostics?: readonly TaskCompositionDiagnostic[];
}>;
type ComposeStop = Extract<TaskCompositionResult, { kind: "incomplete" }>["stopped"];

const DEFAULT_CONTEXT: TextRenderContext = { columns: DEFAULT_CLI_COLUMNS, color: false };

/** Task dispositions and relation states are snake_case facts; people read them as words. */
export function dispositionText(word: string): string {
  return word === "drop" ? "dropped" : word.replaceAll("_", " ");
}

function priorityText(priority: number | null): string {
  return priority === null ? "P?" : `P${priority}`;
}

function scanUnit(id: string, priority: number | null, word: TaskWord | undefined): string {
  return word === undefined
    ? `${taskMark("ready")} ${id} · ${priorityText(priority)}`
    : `${taskMark(word)} ${id} · ${dispositionText(word)} · ${priorityText(priority)}`;
}

function entityLines(entity: TaskEntity, columns: number, indent = ""): readonly string[] {
  const scan = `${indent}${scanUnit(entity.id, entity.priority, entity.word)}${entity.facts === undefined ? "" : ` · ${entity.facts}`}`;
  if (entity.title === null || entity.title.length === 0) return [scan];
  const title = safeText(entity.title);
  const inline = `${scan} — ${title}`;
  if (displayColumns(inline) <= columns) return [inline];
  return [scan, ...dashTitleLines(title, `${indent}  `, columns)];
}

/** Wrap `— <title>` as one unit: the dash never dangles alone at a line end. */
function dashTitleLines(title: string, indent: string, columns: number): readonly string[] {
  const words = title
    .trim()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  const unit = words.length === 0 ? [`—`] : [`— ${words[0]!}`, ...words.slice(1)];
  const lines: string[] = [];
  let current = indent;
  for (const word of unit) {
    const candidate = current === indent ? `${indent}${word}` : `${current} ${word}`;
    if (current !== indent && displayColumns(candidate) > columns) {
      lines.push(current);
      current = `${indent}${word}`;
    } else current = candidate;
  }
  lines.push(current);
  return lines;
}

function stateEntity(task: TaskView | (TaskRef & { priority?: number | null })): TaskEntity {
  return {
    id: task.id,
    priority: "priority" in task && task.priority !== undefined ? task.priority : null,
    word: task.state,
    title: task.title,
  };
}

const TASK_REFUSAL_WORDS: Readonly<Record<string, string>> = {
  "task-missing": "task missing",
  "invalid-lifecycle-transition": "invalid lifecycle transition",
  "invalid-namespace-context": "invalid namespace context",
  "relation-owned-by-other": "relation owned by other",
  "invalid-composition": "invalid composition",
};

function projectRefusal(refusal: TaskRefusal): RefusalProjection {
  const diagnostic = TASK_REFUSAL_WORDS[refusal.kind] ?? refusal.kind.replaceAll("-", " ");
  if (refusal.kind === "task-missing") return { diagnostic, facts: [`task  ${refusal.taskId}`] };
  if (refusal.kind === "invalid-lifecycle-transition") {
    return { diagnostic, facts: [`task  ${refusal.taskId}`, `state  ${refusal.state} · verb  ${refusal.verb}`] };
  }
  if (refusal.kind === "invalid-namespace-context") return { diagnostic, facts: [`path  ${refusal.path}`] };
  if (refusal.kind === "relation-owned-by-other") {
    return {
      diagnostic,
      facts: [
        `task  ${refusal.taskId}`,
        `related task  ${refusal.related}`,
        `declaring task  ${refusal.declaringTask}`,
      ],
    };
  }
  if (refusal.kind === "invalid-composition") return { diagnostic, compositionDiagnostics: refusal.diagnostics };
  return refusal.diagnostic === undefined ? { diagnostic } : { diagnostic, facts: [`detail  ${refusal.diagnostic}`] };
}

function renderFailure(verb: string, result: TaskFailure, columns: number): string {
  if (result.kind === "retry") {
    return [...outcomeLines("?", verb, "retry", undefined, columns), result.reason].join("\n");
  }
  const facts = projectRefusal(result.refusal);
  return refusalLines(
    verb,
    [`reason  ${facts.diagnostic}`, ...(facts.facts ?? [])],
    columns,
    (facts.compositionDiagnostics ?? []).map(
      (item) => `line ${item.line} · ${safeText(item.reason)} · ${safeText(item.token)}`,
    ),
  ).join("\n");
}

function edge(label: string, ref: TaskRef, mark?: string): string {
  const prefix = mark === undefined ? `  ${label}` : `  ${mark} ${label}`;
  return `${prefix} ${ref.id} · ${dispositionText(ref.state)}`;
}

export function taskFrameHead(view: string, scope: string): string {
  return `${view.toUpperCase()} // ${scope}`;
}

function updatedAge(updatedAt: string): string {
  const elapsed = Math.max(0, performance.timeOrigin + performance.now() - Date.parse(updatedAt));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function compactFacts(item: TaskRow): string {
  return [
    `updated ${updatedAge(item.updatedAt)}`,
    ...(item.children === undefined ? [] : [`children ${item.children.live} live · ${item.children.total} total`]),
  ].join(" · ");
}

function listEntity(item: TaskRow, omitDisposition: boolean): TaskEntity {
  return {
    id: item.id,
    priority: item.priority,
    ...(omitDisposition ? {} : { word: item.disposition }),
    facts: compactFacts(item),
    title: item.title,
  };
}

function renderListRow(
  item: TaskRow | BlockedTaskRow | TaskQueryRow,
  columns: number,
  omitDisposition: boolean,
): readonly string[] {
  const lines = [...entityLines(listEntity(item, omitDisposition), columns)];
  if ("blockers" in item) {
    for (const blocker of item.blockers) lines.push(`  needs ${blocker.id} · ${dispositionText(blocker.state)}`);
  }
  return lines;
}

function renderRows(
  action: "ls" | "ready" | "blocked" | "query",
  scope: TaskListScope,
  result: TaskListOutcome,
  columns: number,
): string {
  if (result.kind !== "accepted") return renderFailure(action, result, columns);
  const view = action === "ls" ? "tasks" : action;
  const footer = result.value.hasMore ? ["…"] : [];
  const scopeText =
    scope === "world"
      ? "world"
      : scope === "current"
        ? "current namespace"
        : `namespace ${scope.namespace.replace(/^task\//u, "").replace(/\/$/u, "") || "root"}`;
  const heading = taskFrameHead(view, scopeText);
  if (result.value.rows.length === 0) return emptyCatalogue(view);
  return [
    heading,
    ...result.value.rows.flatMap((item) => renderListRow(item, columns, action === "ready")),
    ...footer,
  ].join("\n");
}

function textTimestamp(timestamp: string): string {
  return timestamp.replace(/\.\d+(?=Z$)/u, "");
}

function renderShowDetail(result: TaskDetail, columns: number): string {
  const task = result.task;
  const lines = [
    ...entityLines(stateEntity(task), columns),
    `  created  ${textTimestamp(task.createdAt)}`,
    `  updated  ${textTimestamp(task.updatedAt)}`,
    ...(task.createdBy === undefined ? [] : [`  created by  ${task.createdBy}`]),
  ];
  for (const need of result.needs.filter((item) => !item.released)) lines.push(edge("needs", need, "!"));
  for (const need of result.needs.filter((item) => item.released)) lines.push(edge("needs", need, "✓"));
  for (const item of result.blocks) lines.push(edge("blocks", item));
  if (result.parent !== null) lines.push(edge("parent", result.parent));
  for (const item of result.children) lines.push(edge("child", item));
  for (const item of result.supersedes) lines.push(edge("supersedes", item));
  for (const item of result.supersededBy) lines.push(edge("superseded-by", item));
  for (const item of result.related) lines.push(edge("related", item));
  if (task.note.length > 0) receiptPayload(lines, "note", task.note);
  if (task.body.length > 0) receiptPayload(lines, "body", task.body);
  return lines.join("\n");
}

function renderShow(result: TaskShowResult, columns: number): string {
  if (Array.isArray(result)) return result.map((detail) => renderShowDetail(detail, columns)).join("\n\n");
  if ("kind" in result) return renderFailure("show", result, columns);
  return renderShowDetail(result, columns);
}

function treeLines(node: TaskTreeNode, columns: number, depth = 0): readonly string[] {
  const indent = "  ".repeat(depth);
  if (node.cycle === true) return [`${indent}! ${node.task.id} · cycle`];
  return [
    ...entityLines(stateEntity(node.task), columns, indent),
    ...node.children.flatMap((child) => treeLines(child, columns, depth + 1)),
  ];
}

function doctorIssue(issue: TaskDoctorIssue): string {
  if (issue.kind === "missing-target") return `! missing-target ${issue.taskId} ${issue.relation} ${issue.target}`;
  if (issue.kind === "self-relation") return `! self-relation ${issue.taskId} ${issue.relation}`;
  return `! cycle ${issue.relation} ${issue.tasks.join(" ")}`;
}

function renderDoctor(report: TaskDoctorReport): string {
  if (report.issues.length === 0) return "✓ doctor  healthy";
  const noun = report.issues.length === 1 ? "issue" : "issues";
  return [`! doctor  ${report.issues.length} ${noun}`, ...report.issues.map(doctorIssue)].join("\n");
}

const PAST_VERBS: Readonly<Record<string, string>> = {
  add: "added",
  start: "started",
  stop: "stopped",
  hold: "held",
  resume: "resumed",
  done: "done",
  drop: "dropped",
  update: "updated",
};

function renderAcceptedMutation(
  verb: string,
  task: TaskView,
  columns: number,
  changes: Extract<TaskUpdateResult, { kind: "accepted" }>["value"]["changedFields"] = [],
): string {
  const lines: string[] = [];
  receiptRow(lines, "✓", PAST_VERBS[verb] ?? verb, [{ text: task.id, opaque: true }], columns);
  lines.push(...entityLines(stateEntity(task), columns));
  for (const change of changes) lines.push(`  ${change.field}  ${change.action}`);
  return lines.join("\n");
}

function renderMutation(action: string, result: TaskMutationResult, columns: number): string {
  if (result.kind !== "accepted") return renderFailure(action, result, columns);
  return renderAcceptedMutation(action, result.value, columns);
}

function renderUpdate(result: TaskUpdateResult, columns: number): string {
  if (result.kind !== "accepted") return renderFailure("update", result, columns);
  return renderAcceptedMutation("update", result.value.task, columns, result.value.changedFields);
}

function renderBatchItem(verb: string, item: TaskBatchResult["items"][number], columns: number): string {
  if (item.outcome.kind === "accepted") return `✓ ${PAST_VERBS[verb] ?? verb}  ${item.id}`;
  if (item.outcome.kind === "retry") return `? ${verb}  ${item.id}  ${item.outcome.reason}`;
  const facts = projectRefusal(item.outcome.refusal);
  return refusalLines(verb, [`task  ${item.id}`, `reason  ${facts.diagnostic}`, ...(facts.facts ?? [])], columns).join(
    "\n",
  );
}

function renderBatch(verb: string, batch: TaskBatchResult, columns: number): string {
  return batch.items.map((item) => renderBatchItem(verb, item, columns)).join("\n");
}

function admissionLines(
  admissions: readonly Extract<TaskCompositionResult, { kind: "planned" }>["admissions"][number][],
): string[] {
  return admissions.map(
    (admission) =>
      `admit ${admission.position}  ${admission.kind === "new" ? "+" : `@${admission.taskId}`} ${safeText(admission.title)}${admission.kind === "new" && admission.alias !== undefined ? `  as ^${admission.alias}` : ""}`,
  );
}

function stoppedLines(stopped: ComposeStop): string[] {
  if (stopped.kind === "retry") return [`? stopped ${stopped.reason}`];
  const facts = projectRefusal(stopped);
  return refusalLines("stopped", [`reason  ${facts.diagnostic}`, ...(facts.facts ?? [])], DEFAULT_CLI_COLUMNS);
}

function aliasLines(aliases: readonly Readonly<{ alias: string; taskId: string }>[]): readonly string[] {
  return aliases.map((binding) => `alias ^${binding.alias} ${binding.taskId}`);
}

function planAliasLines(aliases: Extract<TaskCompositionResult, { kind: "planned" }>["aliases"]): readonly string[] {
  return aliases.map((binding) => `alias ^${binding.alias} ${binding.position}`);
}

function renderPlan(result: Extract<TaskCompositionResult, { kind: "planned" }>): string {
  const lines = [
    `compose plan · ${result.admissionOrder.length} documents`,
    ...planAliasLines(result.aliases),
    ...admissionLines(result.admissions),
  ];
  for (const body of result.bodies) {
    lines.push(`body ${body.position}  + ${safeText(body.title)} · ${body.bytes} bytes`);
    lines.push(`  first ${safeText(body.firstLine)}`);
    lines.push(`  last ${safeText(body.lastLine)}`);
  }
  return lines.join("\n");
}

function renderCompose(result: TaskCompositionResult, columns: number): string {
  if (result.kind === "incomplete") return "";
  if (result.kind === "planned") return renderPlan(result);
  if (result.kind !== "accepted") return renderFailure("compose", result, columns);
  return [
    `✓ composed · ${result.documentChanges.length} changed`,
    ...aliasLines(result.aliases),
    ...admissionLines(result.admissions),
  ].join("\n");
}

/** One addressed show selection rendered directly from its native answer. */
export function renderTaskShow(result: TaskShowResult, context: TextRenderContext = DEFAULT_CONTEXT): string {
  return renderShow(result, context.columns);
}

/** One list read rendered from its native answer and the leaf's presentation-only scope. */
export function renderTaskList(
  action: "ls" | "ready" | "blocked" | "query",
  scope: TaskListScope,
  result: TaskListOutcome,
  context: TextRenderContext = DEFAULT_CONTEXT,
): string {
  return renderRows(action, scope, result, context.columns);
}

export function renderTaskTree(result: TaskDecompositionTree, context: TextRenderContext = DEFAULT_CONTEXT): string {
  return result.kind === "accepted"
    ? treeLines(result.value, context.columns).join("\n")
    : renderFailure("tree", result, context.columns);
}

export function renderTaskDoctor(result: TaskDoctorReport): string {
  return renderDoctor(result);
}

export function renderTaskContext(result: TaskContextResult, context: TextRenderContext = DEFAULT_CONTEXT): string {
  if (result.kind !== "accepted") return renderFailure("context", result, context.columns);
  const value = result.value.namespace.length === 0 ? "root" : result.value.namespace.join("/");
  return `context ${value} · ${result.value.source}`;
}

export function renderTaskCompose(result: TaskCompositionResult, context: TextRenderContext = DEFAULT_CONTEXT): string {
  return renderCompose(result, context.columns);
}

/** One single-Task mutation answer; `verb` is the literal action the leaf invoked. */
export function renderTaskMutation(
  verb: string,
  result: TaskMutationResult,
  context: TextRenderContext = DEFAULT_CONTEXT,
): string {
  return renderMutation(verb, result, context.columns);
}

export function renderTaskUpdate(result: TaskUpdateResult, context: TextRenderContext = DEFAULT_CONTEXT): string {
  return renderUpdate(result, context.columns);
}

/** One lifecycle answer: a single mutation or a plural batch, both native shapes. */
export function renderTaskLifecycle(
  verb: string,
  result: TaskMutationResult | TaskBatchResult,
  context: TextRenderContext = DEFAULT_CONTEXT,
): string {
  return "items" in result ? renderBatch(verb, result, context.columns) : renderMutation(verb, result, context.columns);
}

/** A native refusal the CLI edge raised for one action, through the shared refusal grammar. */
export function renderTaskFailure(
  verb: string,
  result: TaskFailure,
  context: TextRenderContext = DEFAULT_CONTEXT,
): string {
  return renderFailure(verb, result, context.columns);
}

export function renderTaskIncompleteDiagnostic(result: TaskCompositionResult): string {
  if (result.kind !== "incomplete") return "";
  return [
    `! compose incomplete  ${result.documentChanges.length} admitted`,
    ...admissionLines(result.admissions.slice(0, result.documentChanges.length)),
    ...stoppedLines(result.stopped),
  ].join("\n");
}

export function taskExitCode(result: TaskNativeResult): number {
  if ("issues" in result) return result.issues.length === 0 ? 0 : 1;
  if ("items" in result) {
    const kinds = result.items.map((item) => item.outcome.kind);
    return kinds.includes("retry") ? 2 : kinds.includes("refused") ? 1 : 0;
  }
  if ("kind" in result) {
    if (result.kind === "retry") return 2;
    if (result.kind === "refused" || result.kind === "incomplete") return 1;
  }
  return 0;
}
