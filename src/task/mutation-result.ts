import type { TaskCompositionResult } from "./compose.js";
import { taskId } from "./input.js";
import { parseTaskId, type TaskId } from "./identity.js";
import type { TaskBatchResult, TaskMutationResult, TaskUpdateResult } from "./operations.js";

export type TaskMutationExecutionResult =
  | TaskMutationResult
  | TaskUpdateResult
  | TaskBatchResult
  | TaskCompositionResult;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function taskIdentifier(value: unknown): TaskId | null {
  if (typeof value !== "string") return null;
  try {
    return taskId(value);
  } catch {
    return null;
  }
}

function taskIdentifiers(value: unknown): readonly TaskId[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.map(taskIdentifier);
  return ids.some((id) => id === null) || new Set(ids).size !== ids.length ? null : (ids as readonly TaskId[]);
}

function timestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function state(value: unknown): boolean {
  return value === "open" || value === "in_progress" || value === "on_hold" || value === "done" || value === "drop";
}

function taskViewRelations(task: Readonly<Record<string, unknown>>): boolean {
  const parent = task.parent === null ? null : taskIdentifier(task.parent);
  return (
    taskIdentifier(task.id) !== null &&
    taskIdentifiers(task.needs) !== null &&
    taskIdentifiers(task.supersedes) !== null &&
    taskIdentifiers(task.relates) !== null &&
    (parent !== null || task.parent === null)
  );
}

function taskViewScalars(task: Readonly<Record<string, unknown>>): boolean {
  return (
    Array.isArray(task.namespace) &&
    task.namespace.every((segment) => typeof segment === "string") &&
    state(task.state) &&
    typeof task.priority === "number" &&
    Number.isInteger(task.priority) &&
    task.priority >= 0 &&
    task.priority <= 3 &&
    typeof task.title === "string" &&
    task.title.trim() !== "" &&
    typeof task.note === "string" &&
    typeof task.body === "string" &&
    timestamp(task.createdAt) &&
    timestamp(task.updatedAt) &&
    (task.createdBy === undefined || (typeof task.createdBy === "string" && task.createdBy.trim() !== ""))
  );
}

function taskView(value: unknown): boolean {
  const task = record(value);
  if (task === null) return false;
  const keys = [
    "body",
    "createdAt",
    "id",
    "namespace",
    "needs",
    "note",
    "parent",
    "priority",
    "relates",
    "state",
    "supersedes",
    "title",
    "updatedAt",
    ...(task.createdBy === undefined ? [] : ["createdBy"]),
  ];
  if (!exactKeys(task, keys) || !taskViewRelations(task) || !taskViewScalars(task)) return false;
  const coordinate = parseTaskId(task.id as TaskId);
  const namespace = task.namespace as readonly unknown[];
  return (
    namespace.length === coordinate.namespace.length &&
    namespace.every((item, index) => item === coordinate.namespace[index])
  );
}

function compositionDiagnostic(value: unknown): boolean {
  const diagnostic = record(value);
  return (
    diagnostic !== null &&
    exactKeys(diagnostic, ["line", "reason", "token"]) &&
    typeof diagnostic.line === "number" &&
    Number.isSafeInteger(diagnostic.line) &&
    diagnostic.line >= 1 &&
    typeof diagnostic.reason === "string" &&
    typeof diagnostic.token === "string"
  );
}

function taskRefusal(value: unknown): boolean {
  const refusal = record(value);
  if (refusal === null || typeof refusal.kind !== "string") return false;
  if (refusal.kind === "task-missing")
    return exactKeys(refusal, ["kind", "taskId"]) && taskIdentifier(refusal.taskId) !== null;
  if (refusal.kind === "invalid-lifecycle-transition") {
    return (
      exactKeys(refusal, ["kind", "state", "taskId", "verb"]) &&
      taskIdentifier(refusal.taskId) !== null &&
      state(refusal.state) &&
      ["start", "stop", "hold", "resume", "done", "drop"].includes(refusal.verb as string)
    );
  }
  if (refusal.kind === "invalid-graph")
    return exactKeys(refusal, ["diagnostic", "kind"]) && typeof refusal.diagnostic === "string";
  if (refusal.kind === "invalid-namespace-context")
    return exactKeys(refusal, ["kind", "path"]) && typeof refusal.path === "string";
  if (refusal.kind === "relation-owned-by-other") {
    return (
      exactKeys(refusal, ["declaringTask", "kind", "related", "taskId"]) &&
      taskIdentifier(refusal.taskId) !== null &&
      taskIdentifier(refusal.related) !== null &&
      taskIdentifier(refusal.declaringTask) !== null
    );
  }
  return (
    refusal.kind === "invalid-composition" &&
    exactKeys(refusal, ["diagnostics", "kind"]) &&
    Array.isArray(refusal.diagnostics) &&
    refusal.diagnostics.every(compositionDiagnostic)
  );
}

function taskOutcome(value: unknown): boolean {
  const result = record(value);
  if (result === null || typeof result.kind !== "string") return false;
  if (result.kind === "accepted") return exactKeys(result, ["kind", "value"]) && taskView(result.value);
  if (result.kind === "refused") return exactKeys(result, ["kind", "refusal"]) && taskRefusal(result.refusal);
  return (
    result.kind === "retry" &&
    exactKeys(result, ["kind", "reason"]) &&
    (result.reason === "busy" || result.reason === "concurrent-modification")
  );
}

function taskBatch(value: unknown): boolean {
  const result = record(value);
  return (
    result !== null &&
    exactKeys(result, ["items"]) &&
    Array.isArray(result.items) &&
    result.items.every((item) => {
      const entry = record(item);
      return (
        entry !== null &&
        exactKeys(entry, ["id", "outcome"]) &&
        taskIdentifier(entry.id) !== null &&
        taskOutcome(entry.outcome)
      );
    })
  );
}

function aliases(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((alias) => {
      const item = record(alias);
      return (
        item !== null &&
        exactKeys(item, ["alias", "taskId"]) &&
        typeof item.alias === "string" &&
        item.alias.trim() !== "" &&
        taskIdentifier(item.taskId) !== null
      );
    })
  );
}

function documentChanges(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((change) => {
      const item = record(change);
      return (
        item !== null &&
        exactKeys(item, ["documentDiff", "kind", "taskId"]) &&
        taskIdentifier(item.taskId) !== null &&
        (item.kind === "created" || item.kind === "updated") &&
        typeof item.documentDiff === "string"
      );
    })
  );
}

function compositionFacts(value: Readonly<Record<string, unknown>>): boolean {
  return aliases(value.aliases) && taskIdentifiers(value.admissionOrder) !== null;
}

function plannedComposition(value: Readonly<Record<string, unknown>>): boolean {
  return (
    exactKeys(value, ["admissionOrder", "aliases", "bodies", "kind"]) &&
    compositionFacts(value) &&
    Array.isArray(value.bodies) &&
    value.bodies.every((body) => {
      const item = record(body);
      return (
        item !== null &&
        exactKeys(item, ["bytes", "firstLine", "lastLine", "taskId"]) &&
        taskIdentifier(item.taskId) !== null &&
        typeof item.bytes === "number" &&
        Number.isSafeInteger(item.bytes) &&
        item.bytes >= 0 &&
        typeof item.firstLine === "string" &&
        typeof item.lastLine === "string"
      );
    })
  );
}

function incompleteComposition(value: Readonly<Record<string, unknown>>): boolean {
  const keys = ["documentChanges", "draft", "kind", "stopped"];
  const extended = ["admissionOrder", "aliases", ...keys];
  return (
    (exactKeys(value, keys) || exactKeys(value, extended)) &&
    documentChanges(value.documentChanges) &&
    typeof value.draft === "string" &&
    (taskOutcome(value.stopped) || taskRefusal(value.stopped)) &&
    (value.aliases === undefined || aliases(value.aliases)) &&
    (value.admissionOrder === undefined || taskIdentifiers(value.admissionOrder) !== null)
  );
}

function taskUpdate(value: Readonly<Record<string, unknown>>): boolean {
  if (value.kind !== "accepted") return taskOutcome(value);
  const accepted = record(value.value);
  return (
    exactKeys(value, ["kind", "value"]) &&
    accepted !== null &&
    exactKeys(accepted, ["documentDiff", "task"]) &&
    taskView(accepted.task) &&
    typeof accepted.documentDiff === "string"
  );
}

export function isTaskMutationExecutionResult(value: unknown): value is TaskMutationExecutionResult {
  const result = record(value);
  if (result === null) return false;
  if (taskBatch(result) || taskOutcome(result) || taskUpdate(result)) return true;
  if (result.kind === "planned") return plannedComposition(result);
  if (result.kind === "accepted")
    return (
      exactKeys(result, ["admissionOrder", "aliases", "documentChanges", "kind"]) &&
      compositionFacts(result) &&
      documentChanges(result.documentChanges)
    );
  return result.kind === "incomplete" && incompleteComposition(result);
}
