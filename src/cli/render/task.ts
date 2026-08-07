import type {
  BlockedTaskList,
  TaskBatchResult,
  TaskCompositionResult,
  TaskDependencyTree,
  TaskDetail,
  TaskDoctorIssue,
  TaskDoctorReport,
  TaskList,
  TaskMutationResult,
  TaskNamespaceResult,
  TaskRow,
  TaskUpdateResult,
  TaskView,
} from "../../task/index.js";
import type { ParsedTaskCommand, TaskInvocationResult } from "../commands/task.js";

type TaskReadOutcome = TaskList | BlockedTaskList | TaskDependencyTree | TaskNamespaceResult;
type TaskDocumentChanges = Extract<TaskCompositionResult, { kind: "accepted" }>["documentChanges"];
type TaskFailure =
  | Extract<TaskMutationResult, { kind: "refused" | "retry" }>
  | Extract<TaskCompositionResult, { kind: "refused" }>;

function row(value: TaskRow | TaskView): string {
  const disposition = "disposition" in value ? value.disposition : value.state;
  return `${value.id} - P${value.priority} - ${disposition} - ${value.title}${value.contractId === null ? "" : ` - ${value.contractId}`}`;
}
function changes(values: TaskDocumentChanges): string {
  return values.map((change) => change.documentDiff).filter((diff) => diff.length > 0).join("\n");
}
function failure(result: TaskFailure): string {
  return result.kind === "retry" ? `retry ${JSON.stringify(result.reason)}` : `refused ${JSON.stringify(result.refusal)}`;
}
function renderRows(result: TaskList | BlockedTaskList): string {
  if (result.kind !== "accepted") return failure(result);
  return result.value.map((item) => {
    const blockers = "blockers" in item ? item.blockers.map((blocker) => blocker.id).join(", ") : undefined;
    return `${row(item)}${blockers === undefined ? "" : ` <- ${blockers}`}`;
  }).join("\n");
}
function renderShow(result: TaskDetail | TaskMutationResult): string {
  if ("kind" in result) return result.kind === "accepted" ? row(result.value) : failure(result);
  const task = result.task, lines = [row(task), `namespace: ${task.namespace.join("/") || "root"}`];
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
  if (command.action === "show") return renderShow(result as TaskDetail | TaskMutationResult);
  if (command.action === "ls" || command.action === "ready" || command.action === "blocked") return renderRows(result as TaskList | BlockedTaskList);
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
  const mutation = result as TaskMutationResult | TaskUpdateResult;
  if (mutation.kind !== "accepted") return failure(mutation);
  if (command.action === "update") {
    const value = (mutation as Extract<TaskUpdateResult, { kind: "accepted" }>).value;
    return [row(value.task), value.documentDiff].filter((line) => line.length > 0).join("\n");
  }
  return row((mutation as Extract<TaskMutationResult, { kind: "accepted" }>).value);
}

export function renderTaskIncompleteDiagnostic(result: TaskCompositionResult): string {
  if (result.kind !== "incomplete") return "";
  return [`incomplete ${JSON.stringify(result.stopped)}`, changes(result.documentChanges)].filter((line) => line.length > 0).join("\n");
}

export function taskExitCode(result: TaskInvocationResult): number {
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
