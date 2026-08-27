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
  TaskPage,
  TaskQueryResult,
  TaskQueryRow,
  TaskRef,
  TaskRefusal,
  TaskRow,
  TaskTreeNode,
  TaskUpdateResult,
  TaskView,
} from "../../task/index.js";
import type { TaskInvocationResult, TaskShowResult, TaskWorldObservation } from "../commands/task-invoke.js";
import type { ParsedTaskCommand } from "../commands/task.js";
import { outcomeLines, receiptPayload } from "./receipt.js";
import { displayColumns, renderTextBlock, safeText, type TextRenderContext } from "./terminal.js";

type TaskReadOutcome = TaskList | BlockedTaskList | TaskQueryResult | TaskDecompositionTree | TaskContextResult;
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
  line: string;
  diagnostic?: string;
  compositionDiagnostics?: readonly TaskCompositionDiagnostic[];
}>;
type ComposeStop = Extract<TaskCompositionResult, { kind: "incomplete" }>["stopped"];

const DEFAULT_CONTEXT: TextRenderContext = { columns: 80, color: false };

function isWorldObservation(result: TaskInvocationResult): result is TaskWorldObservation {
  return (
    typeof result === "object" &&
    result !== null &&
    "kind" in result &&
    (result.kind === "present" || result.kind === "absent" || result.kind === "failed")
  );
}

function markFor(word: string): string {
  if (word === "in_progress") return "●";
  if (word === "ready" || word === "open") return "○";
  if (word === "blocked") return "‖";
  if (word === "missing") return "!";
  if (word === "on_hold") return "⧗";
  if (word === "done") return "✓";
  if (word === "drop") return "×";
  return "?";
}

function priorityText(priority: number | null): string {
  return priority === null ? "P?" : `P${priority}`;
}

function scanUnit(id: string, priority: number | null, word: TaskWord | undefined): string {
  return word === undefined
    ? `${markFor("ready")} ${id} · ${priorityText(priority)}`
    : `${markFor(word)} ${id} · ${priorityText(priority)} ${word}`;
}

function entityLines(entity: TaskEntity, columns: number, indent = ""): readonly string[] {
  const scan = `${indent}${scanUnit(entity.id, entity.priority, entity.word)}${entity.facts === undefined ? "" : ` · ${entity.facts}`}`;
  if (entity.title === null || entity.title.length === 0) return [scan];
  const title = safeText(entity.title);
  const inline = `${scan} — ${title}`;
  if (displayColumns(inline) <= columns) return [inline];
  return [`${scan} —`, ...renderTextBlock(title, `${indent}  `, columns)];
}

function stateEntity(task: TaskView | (TaskRef & { priority?: number | null })): TaskEntity {
  return {
    id: task.id,
    priority: "priority" in task && task.priority !== undefined ? task.priority : null,
    word: task.state,
    title: task.title,
  };
}

function projectRefusal(refusal: TaskRefusal): RefusalProjection {
  if (refusal.kind === "task-missing") return { line: `task-missing ${refusal.taskId}` };
  if (refusal.kind === "invalid-lifecycle-transition") {
    return { line: `invalid-lifecycle-transition ${refusal.taskId} ${refusal.state} ${refusal.verb}` };
  }
  if (refusal.kind === "invalid-namespace-context") return { line: `invalid-namespace-context ${refusal.path}` };
  if (refusal.kind === "relation-owned-by-other") {
    return { line: `relation-owned-by-other ${refusal.taskId} ${refusal.related} ${refusal.declaringTask}` };
  }
  if (refusal.kind === "invalid-composition") {
    return { line: refusal.kind, compositionDiagnostics: refusal.diagnostics };
  }
  return { line: refusal.kind, diagnostic: refusal.diagnostic };
}

function appendDiagnostic(lines: string[], diagnostic: string | undefined): void {
  if (diagnostic !== undefined) receiptPayload(lines, "diagnostic", diagnostic);
}

function renderFailure(verb: string, result: TaskFailure, columns: number): string {
  if (result.kind === "retry") {
    return [...outcomeLines("?", verb, "retry", undefined, columns), result.reason].join("\n");
  }
  const lines = [...outcomeLines("!", verb, "refused", undefined, columns)];
  const facts = projectRefusal(result.refusal);
  lines.push(facts.line);
  appendDiagnostic(lines, facts.diagnostic);
  for (const item of facts.compositionDiagnostics ?? []) {
    lines.push(`line ${item.line} · ${safeText(item.reason)} · ${safeText(item.token)}`);
  }
  return lines.join("\n");
}

function edge(label: string, ref: TaskRef, mark?: string): string {
  const prefix = mark === undefined ? `  ${label}` : `  ${mark} ${label}`;
  return `${prefix} ${ref.id} · ${ref.state}`;
}

function pageHeading(view: string, page: TaskPage<TaskRow | TaskQueryRow>): string {
  if (page.truncated) return `${view} ${page.returned} of ${page.total} · limit ${page.returned}`;
  return `${view} ${page.returned}`;
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
    ...(item.bodyPresent ? [] : ["no body"]),
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
    for (const blocker of item.blockers) lines.push(`  needs ${blocker.id} · ${blocker.state}`);
  }
  return lines;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function recoveryCommand(command: ParsedTaskCommand, total: number): string {
  const parts = ["keiyaku", "task", command.action];
  if (command.action === "ls") {
    if (command.positionals.length > 0) parts.push(command.positionals[0]!);
    if (command.flags.closed === true) parts.push("--closed");
    if (command.flags.all === true) parts.push("--all");
  }
  if (command.flags.world === true) parts.push("--world");
  if ((command.action === "ready" || command.action === "blocked") && typeof command.flags.parent === "string") {
    parts.push("--parent", command.flags.parent);
  }
  if (command.action === "query" && typeof command.flags.where === "string")
    parts.push("--where", shellQuote(command.flags.where));
  if (command.action === "query" && typeof command.flags.sort === "string") parts.push("--sort", command.flags.sort);
  parts.push("--limit", String(total));
  return parts.join(" ");
}

function renderRows(
  command: ParsedTaskCommand,
  result: TaskList | BlockedTaskList | TaskQueryResult,
  columns: number,
): string {
  if (result.kind !== "accepted") return renderFailure(command.action, result, columns);
  const view = command.action === "ls" ? "tasks" : command.action;
  const footer = result.value.truncated
    ? [
        "",
        `  + ${result.value.total - result.value.returned} more not shown`,
        `    ${recoveryCommand(command, result.value.total)}`,
      ]
    : [];
  const scope =
    command.action === "ls"
      ? command.flags.world === true
        ? "world"
        : command.positionals.length > 0
          ? `namespace ${command.positionals[0]!.replace(/^task\//u, "").replace(/\/$/u, "") || "root"}`
          : "current namespace"
      : undefined;
  const heading =
    scope === undefined ? pageHeading(view, result.value) : `${pageHeading(view, result.value)} · ${scope}`;
  return [
    heading,
    ...result.value.rows.flatMap((item) => renderListRow(item, columns, command.action === "ready")),
    ...footer,
  ].join("\n");
}

function renderShowDetail(result: TaskDetail, columns: number): string {
  const task = result.task;
  const lines = [
    ...entityLines(stateEntity(task), columns),
    ...renderTextBlock(`created ${task.createdAt} · updated ${task.updatedAt}`, "", columns),
    ...(task.createdBy === undefined ? [] : [`created-by ${task.createdBy}`]),
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
  return renderShowDetail(result as TaskDetail, columns);
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
  if (report.issues.length === 0) return "healthy";
  const noun = report.issues.length === 1 ? "issue" : "issues";
  return [`${report.issues.length} ${noun}`, ...report.issues.map(doctorIssue)].join("\n");
}

function renderAcceptedMutation(verb: string, task: TaskView, columns: number, documentDiff?: string): string {
  const lines = [...outcomeLines("✓", verb, "accepted", task.id, columns), ...entityLines(stateEntity(task), columns)];
  if (documentDiff !== undefined) receiptPayload(lines, "diff", documentDiff);
  return lines.join("\n");
}

function renderMutation(
  command: ParsedTaskCommand,
  result: TaskMutationResult | TaskUpdateResult,
  columns: number,
): string {
  if (result.kind !== "accepted") return renderFailure(command.action, result, columns);
  if (command.action !== "update") {
    return renderAcceptedMutation(
      command.action,
      (result as Extract<TaskMutationResult, { kind: "accepted" }>).value,
      columns,
    );
  }
  const value = (result as Extract<TaskUpdateResult, { kind: "accepted" }>).value;
  return renderAcceptedMutation(command.action, value.task, columns, value.documentDiff);
}

function renderBatchItem(verb: string, item: TaskBatchResult["items"][number]): string {
  if (item.outcome.kind === "accepted") return `✓ ${verb} ${item.id}`;
  if (item.outcome.kind === "retry") return `? ${verb} ${item.id} · ${item.outcome.reason}`;
  const facts = projectRefusal(item.outcome.refusal);
  const lines = [`! ${verb} ${item.id} · ${facts.line}`];
  appendDiagnostic(lines, facts.diagnostic);
  return lines.join("\n");
}

function renderBatch(verb: string, batch: TaskBatchResult): string {
  return batch.items.map((item) => renderBatchItem(verb, item)).join("\n");
}

function composeDiffs(
  lines: string[],
  changes: Extract<TaskCompositionResult, { kind: "accepted" }>["documentChanges"],
): void {
  for (const change of changes) receiptPayload(lines, `diff ${change.taskId}`, change.documentDiff);
}

function stoppedLines(stopped: ComposeStop): string[] {
  if (stopped.kind === "retry") return [`? stopped ${stopped.reason}`];
  const facts = projectRefusal(stopped);
  const lines = [`! stopped ${facts.line}`];
  appendDiagnostic(lines, facts.diagnostic);
  return lines;
}

function aliasLines(aliases: readonly Readonly<{ alias: string; taskId: string }>[]): readonly string[] {
  return aliases.map((binding) => `alias ^${binding.alias} ${binding.taskId}`);
}

function renderPlan(result: Extract<TaskCompositionResult, { kind: "planned" }>): string {
  const lines = [
    `compose plan · ${result.admissionOrder.length} documents`,
    ...aliasLines(result.aliases),
    ...result.admissionOrder.map((id, index) => `admit ${index + 1} ${id}`),
  ];
  for (const body of result.bodies) {
    lines.push(`body ${body.taskId} · ${body.bytes} bytes`);
    lines.push(`  first ${safeText(body.firstLine)}`);
    lines.push(`  last ${safeText(body.lastLine)}`);
  }
  return lines.join("\n");
}

function renderCompose(result: TaskCompositionResult, columns: number): string {
  if (result.kind === "incomplete") return "";
  if (result.kind === "planned") return renderPlan(result);
  if (result.kind !== "accepted") return renderFailure("compose", result, columns);
  const lines = [`✓ compose accepted · ${result.documentChanges.length} changed`, ...aliasLines(result.aliases)];
  composeDiffs(lines, result.documentChanges);
  return lines.join("\n");
}

export function renderTaskText(
  command: ParsedTaskCommand,
  result: TaskInvocationResult,
  context: TextRenderContext = DEFAULT_CONTEXT,
): string {
  if (isWorldObservation(result)) {
    if (result.kind === "absent") return "task world absent";
    if (result.kind === "failed") {
      const lines: string[] = ["task world failed"];
      receiptPayload(lines, "diagnostic", result.failure.message);
      return lines.join("\n");
    }
    result = result.value;
  }
  return renderTaskValue(command, result, context.columns);
}

function renderTaskValue(
  command: ParsedTaskCommand,
  result: Exclude<TaskInvocationResult, TaskWorldObservation>,
  columns: number,
): string {
  if (command.action === "show") return renderShow(result as TaskShowResult, columns);
  if (
    command.action === "ls" ||
    command.action === "ready" ||
    command.action === "blocked" ||
    command.action === "query"
  ) {
    return renderRows(command, result as TaskList | BlockedTaskList | TaskQueryResult, columns);
  }
  if (command.action === "tree") {
    const tree = result as TaskDecompositionTree;
    return tree.kind === "accepted"
      ? treeLines(tree.value, columns).join("\n")
      : renderFailure(command.action, tree, columns);
  }
  if (command.action === "doctor") return renderDoctor(result as TaskDoctorReport);
  if (command.action === "context") {
    const context = result as TaskContextResult;
    if (context.kind !== "accepted") return renderFailure(command.action, context, columns);
    const value = context.value.namespace.length === 0 ? "root" : context.value.namespace.join("/");
    return `context ${value} · ${context.value.source}`;
  }
  if (command.action === "compose") return renderCompose(result as TaskCompositionResult, columns);
  if (
    command.action === "start" ||
    command.action === "hold" ||
    command.action === "done" ||
    command.action === "drop"
  ) {
    if (!(typeof result === "object" && result !== null && "items" in result))
      return renderMutation(command, result as TaskMutationResult | TaskUpdateResult, columns);
    return renderBatch(command.action, result as TaskBatchResult);
  }
  return renderMutation(command, result as TaskMutationResult | TaskUpdateResult, columns);
}

export function renderTaskIncompleteDiagnostic(result: TaskCompositionResult): string {
  if (result.kind !== "incomplete") return "";
  const lines = [`! compose incomplete · ${result.documentChanges.length} admitted`, ...stoppedLines(result.stopped)];
  composeDiffs(lines, result.documentChanges);
  return lines.join("\n");
}

export function taskExitCode(result: TaskInvocationResult): number {
  if (isWorldObservation(result)) {
    if (result.kind === "absent") return 1;
    if (result.kind === "failed") return 3;
    result = result.value;
  }
  if (typeof result === "object" && result !== null && "issues" in result)
    return (result as TaskDoctorReport).issues.length === 0 ? 0 : 1;
  if (typeof result === "object" && result !== null && "items" in result) {
    const kinds = (result as TaskBatchResult).items.map((item) => item.outcome.kind);
    return kinds.includes("retry") ? 2 : kinds.includes("refused") ? 1 : 0;
  }
  if (typeof result === "object" && result !== null && "kind" in result) {
    const outcome = result as TaskReadOutcome | TaskMutationResult | TaskUpdateResult | TaskCompositionResult;
    if (outcome.kind === "retry") return 2;
    if (outcome.kind === "refused" || outcome.kind === "incomplete") return 1;
  }
  return 0;
}
