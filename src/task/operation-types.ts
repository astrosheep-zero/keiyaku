import type { TaskDocument, TaskPriority, TaskState } from "./document.js";
import type { TaskId } from "./identity.js";

export type TaskView = Readonly<TaskDocument & { namespace: readonly string[] }>;
export type TaskCleanupFailure = Readonly<{
  kind: "lock-release-failed";
  diagnostics: readonly string[];
}>;
export type TaskCompositionDiagnostic = Readonly<{ line: number; reason: string; token: string }>;
export type TaskRefusal =
  | Readonly<{ kind: "task-missing"; taskId: TaskId }>
  | Readonly<{ kind: "invalid-lifecycle-transition"; taskId: TaskId; state: TaskState; verb: TaskLifecycleVerb }>
  | Readonly<{ kind: "invalid-graph"; diagnostic: string }>
  | Readonly<{ kind: "invalid-namespace-context"; path: string }>
  | Readonly<{ kind: "relation-owned-by-other"; taskId: TaskId; related: TaskId; declaringTask: TaskId }>
  | Readonly<{ kind: "invalid-composition"; diagnostics: readonly TaskCompositionDiagnostic[] }>;
export type TaskRetry = "busy" | "concurrent-modification";
export type TaskOutcome<A> =
  | Readonly<{ kind: "accepted"; value: A; cleanup?: TaskCleanupFailure }>
  | Readonly<{ kind: "refused"; refusal: TaskRefusal }>
  | Readonly<{ kind: "retry"; reason: TaskRetry }>;
export type TaskMutationResult = TaskOutcome<TaskView>;
export type TaskUpdateResult = TaskOutcome<Readonly<{ task: TaskView; documentDiff: string }>>;
export type TaskLifecycleVerb = "start" | "stop" | "hold" | "resume" | "done" | "drop";
export type TaskBatchResult = Readonly<{ items: readonly Readonly<{ id: TaskId; outcome: TaskMutationResult }>[] }>;
export type SettledTaskAction = "done";
export type SettledTaskResult =
  | Readonly<{ kind: "changed"; task: TaskView; action: SettledTaskAction; cleanup?: TaskCleanupFailure }>
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{ kind: "refused"; refusal: TaskRefusal }>
  | Readonly<{ kind: "retry"; reason: TaskRetry }>;
export type AddTaskInput = Readonly<{
  title: string;
  namespace?: readonly string[];
  body?: string;
  note?: string;
  state?: TaskState;
  priority?: TaskPriority;
  needs?: readonly TaskId[];
  parent?: TaskId | null;
  supersedes?: readonly TaskId[];
  relates?: readonly TaskId[];
  actor?: string;
  signal?: AbortSignal;
}>;
export type AddTaskDocumentInput = Readonly<{
  markdown: string;
  namespace?: readonly string[];
  actor?: string;
  signal?: AbortSignal;
}>;
export type UpdateTaskInput = Readonly<{
  title?: string;
  body?: string;
  appendBody?: string;
  note?: string;
  priority?: TaskPriority;
  needs?: readonly TaskId[];
  addNeeds?: readonly TaskId[];
  dropNeeds?: readonly TaskId[];
  parent?: TaskId | null;
  supersedes?: readonly TaskId[];
  addSupersedes?: readonly TaskId[];
  dropSupersedes?: readonly TaskId[];
  relates?: readonly TaskId[];
  addRelates?: readonly TaskId[];
  dropRelates?: readonly TaskId[];
  signal?: AbortSignal;
}>;
