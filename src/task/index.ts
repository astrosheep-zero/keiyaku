import type { WorldRoot } from "../world.js";
export type { WorldRoot } from "../world.js";
import {
  buildTree, createTaskRelations, diagnoseBoard, projectDetailFacts, type BlockedTaskRow,
  type TaskDetailFacts, type TaskDoctorIssue, type TaskRef, type TaskRow, type TaskTreeNode,
} from "./board.js";
import { composeTasks, type TaskCompositionResult } from "./compose.js";
import { TaskAuthorityCorruptionError, type TaskPriority, type TaskState } from "./document.js";
import type { TaskId } from "./identity.js";
import {
  addTask, addTaskDocument, batchTasks, blockedTasks, lifecycleTask, listTasks, queryTasks, readTaskDetails, readyTasks,
  taskView, updateTask, type AddTaskDocumentInput, type AddTaskInput, type TaskBatchResult,
  type TaskMutationResult, type TaskOutcome, type TaskRefusal, type TaskRetry, type TaskUpdateResult, type TaskView, type UpdateTaskInput,
} from "./operations.js";
import { readBoard } from "./store.js";
import {
  actor, addInput, closed, limit, namespace, record, signal, sort,
  taskId as id, taskIds, text, updateInput,
} from "./input.js";
import {
  normalizeTaskQuery, TASK_RELATION_PREDICATE_FIELDS,
  type TaskPage, type TaskQueryExpression, type TaskQueryPredicate, type TaskQueryRow, type TaskQuerySort,
  type TaskRelationPredicateField, DEFAULT_TASK_LIMIT,
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

export async function observeTaskDetails(world: WorldRoot, ids: readonly TaskId[]): Promise<TaskOutcome<readonly TaskDetail[]>> {
  const observed = await readTaskDetails(world, ids);
  if (observed.kind !== "accepted") return observed;
  return { kind: "accepted", value: observed.value.map((facts) => ({ ...facts, task: taskView(facts.task) })) };
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
  task(input: Readonly<{ id: string }>): Task { const v = record(input, "task input"); closed(v, ["id"], "task input"); return new TaskHandle(id(v.id), this.world); }
  add(input: AddTaskInput): Promise<TaskMutationResult> { return addTask(this.world, addInput(input)); }
  addDocument(input: AddTaskDocumentInput): Promise<TaskMutationResult> { const v = record(input, "addDocument input"); closed(v, ["markdown", "namespace", "actor", "signal"], "addDocument input"); const markdown = text(v.markdown, "markdown"); if (markdown === undefined) throw new TypeError("markdown is required"); const ns = namespace(v.namespace), createdBy = actor(v.actor), abort = signal(v.signal); return addTaskDocument(this.world, { markdown, ...(ns === undefined ? {} : { namespace: ns }), ...(createdBy === undefined ? {} : { actor: createdBy }), ...(abort === undefined ? {} : { signal: abort }) }); }
  async list(input: Readonly<{ selection?: "active" | "closed" | "all"; scope?: "namespace" | "world"; namespace?: readonly string[]; limit?: number }> = {}): Promise<TaskList> { const v = record(input, "list input"); closed(v, ["selection", "scope", "namespace", "limit"], "list input"); if (v.selection !== undefined && v.selection !== "active" && v.selection !== "closed" && v.selection !== "all") throw new TypeError("selection must be active, closed, or all"); if (v.scope !== undefined && v.scope !== "namespace" && v.scope !== "world") throw new TypeError("scope must be namespace or world"); return listTasks(this.world, namespace(v.namespace), v.selection ?? "active", v.scope as "namespace" | "world" | undefined, limit(v.limit) ?? DEFAULT_TASK_LIMIT); }
  async ready(input: Readonly<{ scope?: "namespace" | "world"; namespace?: readonly string[]; parent?: string; limit?: number }> = {}): Promise<TaskList> { const v = record(input, "ready input"); closed(v, ["scope", "namespace", "parent", "limit"], "ready input"); if (v.scope !== undefined && v.scope !== "namespace" && v.scope !== "world") throw new TypeError("scope must be namespace or world"); const parent = v.parent === undefined ? undefined : id(v.parent); return readyTasks(this.world, namespace(v.namespace), v.scope as "namespace" | "world" | undefined, parent, limit(v.limit) ?? DEFAULT_TASK_LIMIT); }
  async blocked(input: Readonly<{ scope?: "namespace" | "world"; namespace?: readonly string[]; parent?: string; limit?: number }> = {}): Promise<BlockedTaskList> { const v = record(input, "blocked input"); closed(v, ["scope", "namespace", "parent", "limit"], "blocked input"); if (v.scope !== undefined && v.scope !== "namespace" && v.scope !== "world") throw new TypeError("scope must be namespace or world"); const parent = v.parent === undefined ? undefined : id(v.parent); return blockedTasks(this.world, namespace(v.namespace), v.scope as "namespace" | "world" | undefined, parent, limit(v.limit) ?? DEFAULT_TASK_LIMIT); }
  async query(input: Readonly<{ where?: TaskQueryExpression; scope?: "namespace" | "world"; namespace?: readonly string[]; sort?: TaskQuerySort; limit?: number }> = {}): Promise<TaskQueryResult> { const v = record(input, "query input"); closed(v, ["where", "scope", "namespace", "sort", "limit"], "query input"); if (v.scope !== undefined && v.scope !== "namespace" && v.scope !== "world") throw new TypeError("scope must be namespace or world"); const expression = v.where === undefined ? { kind: "and", terms: [{ kind: "predicate", predicate: { field: "state", operator: "!=", value: "done" } }, { kind: "predicate", predicate: { field: "state", operator: "!=", value: "drop" } }] } as const : normalizeTaskQuery(v.where); const selected = namespace(v.namespace); return queryTasks({ world: this.world, ...(selected === undefined ? {} : { namespace: selected }), expression, ...(v.scope === undefined ? {} : { scope: v.scope as "namespace" | "world" }), sort: sort(v.sort) ?? "priority", limit: limit(v.limit) ?? DEFAULT_TASK_LIMIT }); }
  async doctor(): Promise<TaskDoctorReport> { return { issues: diagnoseBoard((await readBoard(this.world)).board) }; }
  batch(input: Readonly<{ verb: "done" | "drop" | "hold"; ids: readonly string[]; note?: string; signal?: AbortSignal }>): Promise<TaskBatchResult> { const v = record(input, "batch input"); closed(v, ["verb", "ids", "note", "signal"], "batch input"); const verb = v.verb; if (verb !== "done" && verb !== "drop" && verb !== "hold") throw new TypeError("batch verb is invalid"); const note = text(v.note, "note"); if (note !== undefined && verb !== "done" && verb !== "drop") throw new TypeError("batch note is valid only for done or drop"); return batchTasks(this.world, verb, taskIds(v.ids, "ids") ?? [], signal(v.signal), note); }
  compose(input: Readonly<{ markdown: string; namespace?: readonly string[]; actor?: string; signal?: AbortSignal }>): Promise<TaskCompositionResult> { const v = record(input, "compose input"); closed(v, ["markdown", "namespace", "actor", "signal"], "compose input"); const markdown = text(v.markdown, "markdown"); if (markdown === undefined) throw new TypeError("markdown is required"); const selected = namespace(v.namespace); return composeTasks(this.world, markdown, signal(v.signal), actor(v.actor), selected); }
}
export type Tasks = TasksHandle;
export const Tasks = Object.freeze({
  of(world: WorldRoot): Tasks {
    if (typeof world !== "string") throw new TypeError("Tasks.of world must be a WorldRoot");
    return new TasksHandle(world);
  },
});
