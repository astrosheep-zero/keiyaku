import type { WorldRoot } from "../world.js";
export type { WorldRoot } from "../world.js";
import {
  buildTree, createTaskRelations, diagnoseBoard, projectDetailFacts, type BlockedTaskRow,
  type TaskDetailFacts, type TaskDoctorIssue, type TaskRef, type TaskRow, type TaskTreeNode,
} from "./board.js";
import { composeTasks, type TaskCompositionResult } from "./compose.js";
import { TaskAuthorityCorruptionError, type TaskPriority, type TaskState } from "./document.js";
import { isTaskSegment, parseTaskId, type TaskId } from "./identity.js";
import {
  addTask, addTaskDocument, batchTasks, blockedTasks, currentNamespace, lifecycleTask, listTasks, queryTasks, readyTasks,
  setCurrentNamespace, taskView, updateTask, type AddTaskDocumentInput, type AddTaskInput, type TaskBatchResult,
  type TaskMutationResult, type TaskOutcome, type TaskRefusal, type TaskRetry, type TaskUpdateResult, type TaskView, type UpdateTaskInput,
} from "./operations.js";
import { readBoard } from "./store.js";
import {
  isValidTaskLimit, normalizeTaskQuery, TASK_RELATION_PREDICATE_FIELDS,
  type TaskPage, type TaskQueryExpression, type TaskQueryPredicate, type TaskQueryRow, type TaskQuerySort,
  type TaskRelationPredicateField, MAX_TASK_LIMIT, DEFAULT_TASK_LIMIT,
} from "./query.js";

export type TaskDetail = Omit<TaskDetailFacts, "task"> & Readonly<{ task: TaskView }>;
export type TaskList = TaskOutcome<TaskPage<TaskRow>>;
export type BlockedTaskList = TaskOutcome<TaskPage<BlockedTaskRow>>;
export type TaskQueryResult = TaskOutcome<TaskPage<TaskQueryRow>>;
export type TaskNamespaceResult = TaskOutcome<readonly string[]>;
export type TaskDoctorReport = Readonly<{ issues: readonly TaskDoctorIssue[] }>;
export type TaskDecompositionTree = TaskOutcome<TaskTreeNode>;
export type {
  AddTaskDocumentInput, AddTaskInput, BlockedTaskRow, TaskBatchResult, TaskCompositionResult, TaskDoctorIssue,
  TaskId, TaskMutationResult, TaskOutcome, TaskPriority, TaskRef, TaskRefusal, TaskRetry, TaskRow, TaskState,
  TaskTreeNode, TaskUpdateResult, TaskView, UpdateTaskInput, TaskPage, TaskQueryExpression, TaskQueryPredicate,
  TaskQueryRow, TaskQuerySort, TaskRelationPredicateField,
};
export { TaskAuthorityCorruptionError, TASK_RELATION_PREDICATE_FIELDS };

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function closed(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${label} has unknown field: ${key}`);
}
function id(value: unknown): TaskId { if (typeof value !== "string") throw new TypeError("task ID must be a string"); parseTaskId(value); return value as TaskId; }
function signal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal"); return value;
}
function strings(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined; if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new TypeError(`${label} must be an array of strings`); return value;
}
function taskIds(value: unknown, label: string): readonly TaskId[] | undefined {
  const values = strings(value, label)?.map(id);
  if (values !== undefined && new Set(values).size !== values.length) throw new TypeError(`${label} must not contain duplicates`);
  return values;
}
function namespace(value: unknown): readonly string[] | undefined {
  const values = strings(value, "namespace"); if (values === undefined) return undefined;
  if (!values.every(isTaskSegment)) throw new TypeError("namespace must contain canonical segments"); return values;
}
function text(value: unknown, label: string): string | undefined { if (value === undefined) return undefined; if (typeof value !== "string") throw new TypeError(`${label} must be a string`); return value; }
function actor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError("actor must be a nonblank string");
  return value;
}
function priority(value: unknown): TaskPriority | undefined { if (value === undefined) return undefined; if (!Number.isInteger(value) || typeof value !== "number" || value < 0 || value > 3) throw new TypeError("priority must be 0..3"); return value as TaskPriority; }
function limit(value: unknown): number | undefined { if (value === undefined) return undefined; if (typeof value !== "number" || !isValidTaskLimit(value)) throw new TypeError(`limit must be an integer from 1 to ${MAX_TASK_LIMIT}`); return value; }
function sort(value: unknown): TaskQuerySort | undefined {
  if (value === undefined) return undefined;
  if (value !== "priority" && value !== "created" && value !== "updated" && value !== "id") throw new TypeError("sort is invalid");
  return value;
}
function state(value: unknown): TaskState | undefined {
  if (value === undefined) return undefined;
  if (value !== "open" && value !== "in_progress" && value !== "on_hold" && value !== "done" && value !== "drop") throw new TypeError("state is invalid");
  return value;
}
function nullableId(value: unknown): TaskId | null | undefined { return value === undefined || value === null ? value : id(value); }
function addInput(input: unknown): AddTaskInput {
  const v = record(input, "add input");
  closed(v, ["title", "namespace", "body", "note", "state", "priority", "needs", "parent", "supersedes", "relates", "actor", "signal"], "add input");
  const title = text(v.title, "title"); if (title === undefined || title.trim() === "") throw new TypeError("title is required");
  const ns = namespace(v.namespace), body = text(v.body, "body"), note = text(v.note, "note"), initialState = state(v.state), pri = priority(v.priority);
  const needs = taskIds(v.needs, "needs"), parent = nullableId(v.parent), supersedes = taskIds(v.supersedes, "supersedes"), relates = taskIds(v.relates, "relates");
  const createdBy = actor(v.actor), abort = signal(v.signal);
  return { title, ...(ns === undefined ? {} : { namespace: ns }), ...(body === undefined ? {} : { body }), ...(note === undefined ? {} : { note }),
    ...(initialState === undefined ? {} : { state: initialState }), ...(pri === undefined ? {} : { priority: pri }),
    ...(needs === undefined ? {} : { needs }), ...(parent === undefined ? {} : { parent }),
    ...(supersedes === undefined ? {} : { supersedes }), ...(relates === undefined ? {} : { relates }),
    ...(createdBy === undefined ? {} : { actor: createdBy }),
    ...(abort === undefined ? {} : { signal: abort }) };
}
function updateInput(input: unknown): UpdateTaskInput {
  const v = record(input, "update input");
  closed(v, ["title", "body", "appendBody", "note", "priority", "needs", "addNeeds", "dropNeeds", "parent", "supersedes", "addSupersedes", "dropSupersedes", "relates", "addRelates", "dropRelates", "signal"], "update input");
  if (v.body !== undefined && v.appendBody !== undefined) throw new TypeError("body and appendBody are mutually exclusive");
  const result: Record<string, unknown> = {};
  const title = text(v.title, "title"); if (title !== undefined) { if (title.trim().length === 0) throw new TypeError("title must be nonblank"); result.title = title; }
  const body = text(v.body, "body"); if (body !== undefined) result.body = body;
  const appendBody = text(v.appendBody, "appendBody"); if (appendBody !== undefined) result.appendBody = appendBody;
  const note = text(v.note, "note"); if (note !== undefined) result.note = note;
  const pri = priority(v.priority); if (pri !== undefined) result.priority = pri;
  for (const [key, value] of [["needs", taskIds(v.needs, "needs")], ["addNeeds", taskIds(v.addNeeds, "addNeeds")], ["dropNeeds", taskIds(v.dropNeeds, "dropNeeds")], ["supersedes", taskIds(v.supersedes, "supersedes")], ["addSupersedes", taskIds(v.addSupersedes, "addSupersedes")], ["dropSupersedes", taskIds(v.dropSupersedes, "dropSupersedes")], ["relates", taskIds(v.relates, "relates")], ["addRelates", taskIds(v.addRelates, "addRelates")], ["dropRelates", taskIds(v.dropRelates, "dropRelates")]] as const) if (value !== undefined) result[key] = value;
  const parent = nullableId(v.parent); if (parent !== undefined) result.parent = parent;
  const abort = signal(v.signal); if (abort !== undefined) result.signal = abort;
  const update = result as UpdateTaskInput;
  if (Object.keys(result).filter((key) => key !== "signal").length === 0) throw new TypeError("update requires at least one field change"); return update;
}

class TaskHandle {
  constructor(readonly id: TaskId, private readonly world: WorldRoot) {}
  async read(): Promise<TaskDetail | null> {
    const board = (await readBoard(this.world)).board;
    const facts = projectDetailFacts(board, this.id, createTaskRelations(board));
    return facts === null ? null : { ...facts, task: taskView(facts.task) };
  }
  async tree(): Promise<TaskDecompositionTree> {
    if (arguments.length > 0) throw new TypeError("tree accepts no input");
    const board = (await readBoard(this.world)).board;
    const node = buildTree(board, this.id, createTaskRelations(board));
    return node === null ? { kind: "refused", refusal: { kind: "task-missing", taskId: this.id } } : { kind: "accepted", value: node };
  }
  update(input: UpdateTaskInput): Promise<TaskUpdateResult> { return updateTask(this.world, this.id, updateInput(input)); }
  private lifecycle(verb: "start" | "stop" | "hold" | "resume" | "done" | "drop", input: unknown): Promise<TaskMutationResult> {
    const value = record(input ?? {}, `${verb} input`); closed(value, verb === "drop" || verb === "done" ? ["note", "signal"] : ["signal"], `${verb} input`);
    const note = verb === "drop" || verb === "done" ? text(value.note, "note") : undefined;
    return lifecycleTask(this.world, this.id, verb, signal(value.signal), note);
  }
  start(input?: { signal?: AbortSignal }): Promise<TaskMutationResult> { return this.lifecycle("start", input); }
  stop(input?: { signal?: AbortSignal }): Promise<TaskMutationResult> { return this.lifecycle("stop", input); }
  hold(input?: { signal?: AbortSignal }): Promise<TaskMutationResult> { return this.lifecycle("hold", input); }
  resume(input?: { signal?: AbortSignal }): Promise<TaskMutationResult> { return this.lifecycle("resume", input); }
  done(input?: { note?: string; signal?: AbortSignal }): Promise<TaskMutationResult> { return this.lifecycle("done", input); }
  drop(input?: { note?: string; signal?: AbortSignal }): Promise<TaskMutationResult> { return this.lifecycle("drop", input); }
}
export type Task = TaskHandle;

class TasksHandle {
  readonly root: WorldRoot;
  constructor(private readonly world: WorldRoot) { this.root = world; }
  async namespace(): Promise<TaskNamespaceResult> { const value = await currentNamespace(this.world); return "kind" in value ? { kind: "refused", refusal: value } : { kind: "accepted", value }; }
  async setNamespace(input: Readonly<{ namespace: readonly string[] }>): Promise<void> { const v = record(input, "setNamespace input"); closed(v, ["namespace"], "setNamespace input"); const ns = namespace(v.namespace); if (ns === undefined) throw new TypeError("namespace is required"); await setCurrentNamespace(this.world, ns); }
  task(input: Readonly<{ id: string }>): Task { const v = record(input, "task input"); closed(v, ["id"], "task input"); return new TaskHandle(id(v.id), this.world); }
  add(input: AddTaskInput): Promise<TaskMutationResult> { return addTask(this.world, addInput(input)); }
  addDocument(input: AddTaskDocumentInput): Promise<TaskMutationResult> { const v = record(input, "addDocument input"); closed(v, ["markdown", "namespace", "actor", "signal"], "addDocument input"); const markdown = text(v.markdown, "markdown"); if (markdown === undefined) throw new TypeError("markdown is required"); const ns = namespace(v.namespace), createdBy = actor(v.actor), abort = signal(v.signal); return addTaskDocument(this.world, { markdown, ...(ns === undefined ? {} : { namespace: ns }), ...(createdBy === undefined ? {} : { actor: createdBy }), ...(abort === undefined ? {} : { signal: abort }) }); }
  async list(input: Readonly<{ selection?: "active" | "closed" | "all"; scope?: "namespace" | "world"; limit?: number }> = {}): Promise<TaskList> { const v = record(input, "list input"); closed(v, ["selection", "scope", "limit"], "list input"); if (v.selection !== undefined && v.selection !== "active" && v.selection !== "closed" && v.selection !== "all") throw new TypeError("selection must be active, closed, or all"); if (v.scope !== undefined && v.scope !== "namespace" && v.scope !== "world") throw new TypeError("scope must be namespace or world"); return listTasks(this.world, v.selection ?? "active", v.scope as "namespace" | "world" | undefined, limit(v.limit) ?? DEFAULT_TASK_LIMIT); }
  async ready(input: Readonly<{ scope?: "namespace" | "world"; parent?: string; limit?: number }> = {}): Promise<TaskList> { const v = record(input, "ready input"); closed(v, ["scope", "parent", "limit"], "ready input"); if (v.scope !== undefined && v.scope !== "namespace" && v.scope !== "world") throw new TypeError("scope must be namespace or world"); const parent = v.parent === undefined ? undefined : id(v.parent); return readyTasks(this.world, v.scope as "namespace" | "world" | undefined, parent, limit(v.limit) ?? DEFAULT_TASK_LIMIT); }
  async blocked(input: Readonly<{ scope?: "namespace" | "world"; parent?: string; limit?: number }> = {}): Promise<BlockedTaskList> { const v = record(input, "blocked input"); closed(v, ["scope", "parent", "limit"], "blocked input"); if (v.scope !== undefined && v.scope !== "namespace" && v.scope !== "world") throw new TypeError("scope must be namespace or world"); const parent = v.parent === undefined ? undefined : id(v.parent); return blockedTasks(this.world, v.scope as "namespace" | "world" | undefined, parent, limit(v.limit) ?? DEFAULT_TASK_LIMIT); }
  async query(input: Readonly<{ where?: TaskQueryExpression; scope?: "namespace" | "world"; sort?: TaskQuerySort; limit?: number }> = {}): Promise<TaskQueryResult> { const v = record(input, "query input"); closed(v, ["where", "scope", "sort", "limit"], "query input"); if (v.scope !== undefined && v.scope !== "namespace" && v.scope !== "world") throw new TypeError("scope must be namespace or world"); const expression = v.where === undefined ? { kind: "and", terms: [{ kind: "predicate", predicate: { field: "state", operator: "!=", value: "done" } }, { kind: "predicate", predicate: { field: "state", operator: "!=", value: "drop" } }] } as const : normalizeTaskQuery(v.where); return queryTasks(this.world, expression, v.scope as "namespace" | "world" | undefined, sort(v.sort) ?? "priority", limit(v.limit) ?? DEFAULT_TASK_LIMIT); }
  async doctor(): Promise<TaskDoctorReport> { return { issues: diagnoseBoard((await readBoard(this.world)).board) }; }
  batch(input: Readonly<{ verb: "done" | "drop" | "hold"; ids: readonly string[]; note?: string; signal?: AbortSignal }>): Promise<TaskBatchResult> { const v = record(input, "batch input"); closed(v, ["verb", "ids", "note", "signal"], "batch input"); const verb = v.verb; if (verb !== "done" && verb !== "drop" && verb !== "hold") throw new TypeError("batch verb is invalid"); const note = text(v.note, "note"); if (note !== undefined && verb !== "done" && verb !== "drop") throw new TypeError("batch note is valid only for done or drop"); return batchTasks(this.world, verb, taskIds(v.ids, "ids") ?? [], signal(v.signal), note); }
  compose(input: Readonly<{ markdown: string; actor?: string; signal?: AbortSignal }>): Promise<TaskCompositionResult> { const v = record(input, "compose input"); closed(v, ["markdown", "actor", "signal"], "compose input"); const markdown = text(v.markdown, "markdown"); if (markdown === undefined) throw new TypeError("markdown is required"); return composeTasks(this.world, markdown, signal(v.signal), actor(v.actor)); }
}
export type Tasks = TasksHandle;
export const Tasks = Object.freeze({
  of(root: WorldRoot): Tasks {
    if (typeof root !== "string") throw new TypeError("Tasks.of root must be a WorldRoot");
    return new TasksHandle(root);
  },
});
