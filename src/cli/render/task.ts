import type {
  BlockedTaskList,
  BlockedTaskRow,
  TaskBatchResult,
  TaskCompositionResult,
  TaskDependencyTree,
  TaskDetail,
  TaskDoctorIssue,
  TaskDoctorReport,
  TaskList,
  TaskMutationResult,
  TaskNamespaceResult,
  TaskPage,
  TaskQueryResult,
  TaskQueryRow,
  TaskRow,
  TaskUpdateResult,
  TaskView,
} from "../../task/index.js";
import type { TaskInvocationResult, TaskWorldObservation } from "../commands/task-invoke.js";
import type { ParsedTaskCommand } from "../commands/task.js";

type TaskReadOutcome = TaskList | BlockedTaskList | TaskQueryResult | TaskDependencyTree | TaskNamespaceResult;
type TaskDocumentChanges = Extract<TaskCompositionResult, { kind: "accepted" }>["documentChanges"];
type TaskFailure =
  | Extract<TaskMutationResult, { kind: "refused" | "retry" }>
  | Extract<TaskCompositionResult, { kind: "refused" }>;

function isWorldObservation(result: TaskInvocationResult): result is TaskWorldObservation {
  return typeof result === "object" && result !== null
    && "kind" in result
    && (result.kind === "present" || result.kind === "absent" || result.kind === "failed");
}

function row(value: TaskRow | TaskView): string {
  const disposition = "disposition" in value ? value.disposition : value.state;
  return `${value.id} - P${value.priority} - ${disposition} - ${value.title}`;
}
function changes(values: TaskDocumentChanges): string {
  return values.map((change) => change.documentDiff).filter((diff) => diff.length > 0).join("\n");
}
function failure(result: TaskFailure): string {
  return result.kind === "retry" ? `retry ${JSON.stringify(result.reason)}` : `refused ${JSON.stringify(result.refusal)}`;
}
function renderListRow(item: TaskRow | BlockedTaskRow | TaskQueryRow): readonly string[] {
  const lines = [row(item)];
  if ("blockers" in item) {
    for (const blocker of item.blockers) lines.push(`  needs ${blocker.id} (${blocker.state})`);
  }
  return lines;
}
function pageHeading(command: ParsedTaskCommand, page: TaskPage<TaskRow | TaskQueryRow>): string {
  const count = page.truncated ? `${page.returned} of ${page.total}` : `${page.returned}`;
  return `${count} ${command.action}${page.truncated ? ` · limit ${page.returned}` : ""}`;
}
function renderRows(command: ParsedTaskCommand, result: TaskList | BlockedTaskList | TaskQueryResult): string {
  if (result.kind !== "accepted") return failure(result);
  return [pageHeading(command, result.value), ...result.value.rows.flatMap(renderListRow)].join("\n");
}
function renderShow(result: TaskDetail | TaskMutationResult): string {
  if ("kind" in result) return result.kind === "accepted" ? row(result.value) : failure(result);
  const task = result.task, lines = [
    row(task), `namespace: ${task.namespace.join("/") || "root"}`,
    `createdAt: ${task.createdAt}`, `updatedAt: ${task.updatedAt}`, `note: ${task.note}`,
  ];
  for (const [label, values] of [
    ["needs", task.needs], ["blockers", result.blockers.map((item) => item.id)], ["blocks", result.blocks.map((item) => item.id)],
    ["children", result.children.map((item) => item.id)], ["supersedes", task.supersedes],
    ["superseded by", result.supersededBy.map((item) => item.id)], ["related", result.related.map((item) => item.id)],
  ] as const) if (values.length > 0) lines.push(`${label}: ${values.join(", ")}`);
  if (task.parent !== null) lines.push(`parent: ${task.parent}`);
  if (task.body.length > 0) lines.push("", task.body);
  return lines.join("\n");
}
function treeLines(node: Extract<TaskDependencyTree, { kind: "accepted" }>["value"], depth = 0): readonly string[] {
  const marker = node.cycle ? "cycle" : node.reference ? "reference" : node.task.state;
  const line = `${"  ".repeat(depth)}${node.task.id} - ${node.task.priority === null ? "P?" : `P${node.task.priority}`} - ${marker}${node.task.title === null ? "" : ` - ${node.task.title}`}`;
  return [line, ...node.needs.flatMap((child) => treeLines(child, depth + 1))];
}
function doctorIssue(issue: TaskDoctorIssue): string {
  if (issue.kind === "missing-target") return `${issue.taskId}: ${issue.relation} target missing: ${issue.target}`;
  if (issue.kind === "self-relation") return `${issue.taskId}: self ${issue.relation}`;
  return `${issue.relation} cycle: ${issue.tasks.join(" -> ")}`;
}

export function renderTaskText(command: ParsedTaskCommand, result: TaskInvocationResult): string {
  if (isWorldObservation(result)) return renderTaskWorldObservation(command, result);
  return renderTaskValue(command, result);
}

function renderTaskWorldObservation(command: ParsedTaskCommand, result: TaskWorldObservation): string {
  if (result.kind === "absent") return "task world absent";
  if (result.kind === "failed") return `task world failed\n  ${result.failure.message}`;
  return renderTaskValue(command, result.value);
}

function renderMutation(command: ParsedTaskCommand, result: TaskMutationResult | TaskUpdateResult): string {
  if (result.kind !== "accepted") return failure(result);
  if (command.action !== "update") {
    return row((result as Extract<TaskMutationResult, { kind: "accepted" }>).value);
  }
  const value = (result as Extract<TaskUpdateResult, { kind: "accepted" }>).value;
  return [row(value.task), value.documentDiff].filter((line) => line.length > 0).join("\n");
}

function renderTaskValue(command: ParsedTaskCommand, result: Exclude<TaskInvocationResult, TaskWorldObservation>): string {
  if (command.action === "show") return renderShow(result as TaskDetail | TaskMutationResult);
  if (command.action === "ls" || command.action === "ready" || command.action === "blocked" || command.action === "query") return renderRows(command, result as TaskList | BlockedTaskList | TaskQueryResult);
  if (command.action === "tree") {
    const tree = result as TaskDependencyTree; return tree.kind === "accepted" ? treeLines(tree.value).join("\n") : failure(tree);
  }
  if (command.action === "doctor") {
    const report = result as TaskDoctorReport; return report.issues.length === 0 ? "healthy" : report.issues.map(doctorIssue).join("\n");
  }
  if (command.action === "namespace") {
    const namespace = result as TaskNamespaceResult; return namespace.kind === "accepted" ? namespace.value.join("/") || "root" : failure(namespace);
  }
  if (command.action === "compose") {
    const composition = result as TaskCompositionResult;
    return composition.kind === "accepted" ? changes(composition.documentChanges) : composition.kind === "incomplete" ? "" : failure(composition);
  }
  if (command.action === "hold" || command.action === "done" || command.action === "drop") {
    const batch = result as TaskBatchResult;
    return batch.items.map((item) => item.outcome.kind === "accepted" ? `accepted ${item.id}` : `${item.id}: ${failure(item.outcome)}`).join("\n");
  }
  return renderMutation(command, result as TaskMutationResult | TaskUpdateResult);
}

export function renderTaskIncompleteDiagnostic(result: TaskCompositionResult): string {
  if (result.kind !== "incomplete") return "";
  return [`incomplete ${JSON.stringify(result.stopped)}`, changes(result.documentChanges)].filter((line) => line.length > 0).join("\n");
}

export function taskExitCode(result: TaskInvocationResult): number {
  if (isWorldObservation(result)) {
    if (result.kind === "absent") return 1;
    if (result.kind === "failed") return 3;
    result = result.value;
  }
  if (typeof result === "object" && result !== null && "issues" in result) return (result as TaskDoctorReport).issues.length === 0 ? 0 : 1;
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
