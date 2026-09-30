import type { TaskPriority, TaskState } from "./document.js";
import type { TaskId } from "./identity.js";

import type { TaskCleanupFailure, TaskRefusal, TaskRetry, TaskView } from "./mutation-result.js";
export type {
  TaskView,
  TaskCleanupFailure,
  TaskCompositionDiagnostic,
  TaskRefusal,
  TaskRetry,
  TaskMutationResult,
  TaskUpdateResult,
  TaskBatchResult,
} from "./mutation-result.js";
export type TaskOutcome<A> =
  | Readonly<{ kind: "accepted"; value: A; cleanup?: TaskCleanupFailure }>
  | Readonly<{ kind: "refused"; refusal: TaskRefusal }>
  | Readonly<{ kind: "retry"; reason: TaskRetry }>;
export type TaskLifecycleVerb = Extract<TaskRefusal, { kind: "invalid-lifecycle-transition" }>["verb"];
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
