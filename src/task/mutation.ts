import type { WorldRoot } from "../world.js";
import type { TaskCompositionResult } from "./compose.js";
import { addInput, closed, namespace, record, taskId, taskIds, text, updateInput } from "./input.js";
import { Tasks } from "./index.js";
import type {
  AddTaskDocumentInput,
  AddTaskInput,
  TaskBatchResult,
  TaskMutationResult,
  TaskUpdateResult,
  UpdateTaskInput,
} from "./operations.js";
import type { TaskId } from "./identity.js";

export const TASK_MUTATION_ACTIONS = Object.freeze([
  "task.add", "task.addDocument", "task.compose", "task.done", "task.drop",
  "task.hold", "task.resume", "task.start", "task.stop", "task.update",
] as const);

export type TaskMutationAction = (typeof TASK_MUTATION_ACTIONS)[number];
const TASK_MUTATION_ACTION_SET: ReadonlySet<string> = new Set(TASK_MUTATION_ACTIONS);

export function isTaskMutationAction(value: unknown): value is TaskMutationAction {
  return typeof value === "string" && TASK_MUTATION_ACTION_SET.has(value);
}

export type TaskMutationRequest =
  | Readonly<{ action: "task.add"; input: Omit<AddTaskInput, "actor" | "signal"> }>
  | Readonly<{ action: "task.addDocument"; input: Omit<AddTaskDocumentInput, "actor" | "signal"> }>
  | Readonly<{ action: "task.compose"; markdown: string }>
  | Readonly<{ action: "task.update"; id: TaskId; input: Omit<UpdateTaskInput, "signal"> }>
  | Readonly<{ action: "task.start" | "task.stop" | "task.resume"; id: TaskId }>
  | Readonly<{ action: "task.hold"; ids: readonly TaskId[] }>
  | Readonly<{ action: "task.done" | "task.drop"; ids: readonly TaskId[]; note?: string }>;

export type TaskMutationExecutionResult = TaskMutationResult | TaskUpdateResult
  | TaskBatchResult | TaskCompositionResult;

function mutationObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const decoded = record(value, label);
  closed(decoded, keys, label);
  return decoded;
}

export function decodeTaskMutationRequest(action: TaskMutationAction, value: unknown): TaskMutationRequest {
  switch (action) {
    case "task.add": {
      const input = mutationObject(value, ["input"], "task.add request");
      const raw = mutationObject(input.input, [
        "title", "namespace", "body", "note", "state", "priority", "needs", "parent", "supersedes", "relates",
      ], "task.add input");
      return { action, input: addInput(raw) };
    }
    case "task.addDocument": {
      const input = mutationObject(value, ["input"], "task.addDocument request");
      const raw = mutationObject(input.input, ["markdown", "namespace"], "task.addDocument input");
      const markdown = text(raw.markdown, "markdown");
      if (markdown === undefined) throw new TypeError("markdown is required");
      const selected = namespace(raw.namespace);
      return { action, input: { markdown, ...(selected === undefined ? {} : { namespace: selected }) } };
    }
    case "task.compose": {
      const input = mutationObject(value, ["markdown"], "task.compose request");
      const markdown = text(input.markdown, "markdown");
      if (markdown === undefined) throw new TypeError("markdown is required");
      return { action, markdown };
    }
    case "task.update": {
      const request = mutationObject(value, ["id", "input"], "task.update request");
      const raw = mutationObject(request.input, [
        "title", "body", "appendBody", "note", "priority", "needs", "addNeeds", "dropNeeds", "parent",
        "supersedes", "addSupersedes", "dropSupersedes", "relates", "addRelates", "dropRelates",
      ], "task.update input");
      return { action, id: taskId(request.id), input: updateInput(raw) };
    }
    case "task.start":
    case "task.stop":
    case "task.resume": {
      const request = mutationObject(value, ["id"], `${action} request`);
      return { action, id: taskId(request.id) };
    }
    case "task.hold": {
      const request = mutationObject(value, ["ids"], "task.hold request");
      return { action, ids: taskIds(request.ids, "ids") ?? [] };
    }
    case "task.done":
    case "task.drop": {
      const request = mutationObject(value, ["ids", "note"], `${action} request`);
      const note = text(request.note, "note");
      return { action, ids: taskIds(request.ids, "ids") ?? [], ...(note === undefined ? {} : { note }) };
    }
  }
}

export async function executeTaskMutation(input: Readonly<{
  world: WorldRoot;
  request: TaskMutationRequest;
  requester: string;
  signal?: AbortSignal;
}>): Promise<TaskMutationExecutionResult> {
  const tasks = Tasks.of(input.world);
  const { request, signal } = input;
  const withSignal = signal === undefined ? {} : { signal };
  switch (request.action) {
    case "task.add": return await tasks.add({ ...request.input, actor: input.requester, ...withSignal });
    case "task.addDocument": return await tasks.addDocument({ ...request.input, actor: input.requester, ...withSignal });
    case "task.compose": return await tasks.compose({ markdown: request.markdown, actor: input.requester, ...withSignal });
    case "task.update": return await tasks.task({ id: request.id }).update({ ...request.input, ...withSignal });
    case "task.start": return await tasks.task({ id: request.id }).start(withSignal);
    case "task.stop": return await tasks.task({ id: request.id }).stop(withSignal);
    case "task.resume": return await tasks.task({ id: request.id }).resume(withSignal);
    case "task.hold": return await tasks.batch({ verb: "hold", ids: request.ids, ...withSignal });
    case "task.done": return await tasks.batch({ verb: "done", ids: request.ids, ...withSignal,
      ...(request.note === undefined ? {} : { note: request.note }) });
    case "task.drop": return await tasks.batch({ verb: "drop", ids: request.ids, ...withSignal,
      ...(request.note === undefined ? {} : { note: request.note }) });
  }
}
