import type { WorldRoot } from "../world.js";
import {
  executionChannel,
  libraryExecution,
  localExecutionContext,
  type ExecutionContext,
  type LibraryExecution,
} from "../akuma/requests.js";
import { requestForwardedTask, type TaskMutationRequest, type TaskMutationResultForRequest } from "./mutation.js";
export type { WorldRoot } from "../world.js";
import {
  buildTree,
  createTaskRelations,
  diagnoseBoard,
  projectDetailFacts,
  type BlockedTaskRow,
  type TaskDetailFacts,
  type TaskDoctorIssue,
  type TaskRef,
  type TaskRow,
  type TaskTreeNode,
} from "./board.js";
import {
  composeTasks,
  type TaskCompositionAlias,
  type TaskCompositionBodyPreview,
  type TaskCompositionResult,
} from "./compose.js";
import { TaskAuthorityCorruptionError, type TaskPriority, type TaskState } from "./document.js";
import type { TaskId } from "./identity.js";
import {
  addTask,
  addTaskDocument,
  batchTasks,
  blockedTasks,
  lifecycleTask,
  listTasks,
  queryTasks,
  readyTasks,
  taskView,
  updateTask,
  type AddTaskDocumentInput,
  type AddTaskInput,
  type TaskBatchResult,
  type TaskCompositionDiagnostic,
  type TaskMutationResult,
  type TaskOutcome,
  type TaskRefusal,
  type TaskRetry,
  type TaskUpdateResult,
  type TaskView,
  type UpdateTaskInput,
} from "./operations.js";
import { readBoard } from "./store.js";
import {
  actor,
  addInput,
  closed,
  namespace,
  record,
  signal,
  sort,
  taskRowViewLimit,
  taskId as id,
  taskIds,
  text,
  updateInput,
} from "./input.js";
import {
  normalizeTaskQuery,
  TASK_RELATION_PREDICATE_FIELDS,
  type TaskPage,
  type TaskQueryExpression,
  type TaskQueryPredicate,
  type TaskQueryRow,
  type TaskQuerySort,
  type TaskRelationPredicateField,
} from "./query.js";

export type TaskDetail = Omit<TaskDetailFacts, "task"> & Readonly<{ task: TaskView }>;
export type TaskList = TaskOutcome<TaskPage<TaskRow>>;
export type BlockedTaskList = TaskOutcome<TaskPage<BlockedTaskRow>>;
export type TaskQueryResult = TaskOutcome<TaskPage<TaskQueryRow>>;
export type TaskContextSource = "default-root" | "contract-installed" | "local-override";
export type ResolvedNamespaceContext = Readonly<{
  namespace: readonly string[];
  source: TaskContextSource;
}>;
export type TaskContextResult = TaskOutcome<ResolvedNamespaceContext>;
export type TaskDoctorReport = Readonly<{ issues: readonly TaskDoctorIssue[] }>;
export type TaskDecompositionTree = TaskOutcome<TaskTreeNode>;
export type {
  AddTaskDocumentInput,
  AddTaskInput,
  BlockedTaskRow,
  TaskBatchResult,
  TaskCompositionDiagnostic,
  TaskCompositionAlias,
  TaskCompositionBodyPreview,
  TaskCompositionResult,
  TaskDoctorIssue,
  TaskId,
  TaskMutationResult,
  TaskOutcome,
  TaskPriority,
  TaskRef,
  TaskRefusal,
  TaskRetry,
  TaskRow,
  TaskState,
  TaskTreeNode,
  TaskUpdateResult,
  TaskView,
  UpdateTaskInput,
  TaskPage,
  TaskQueryExpression,
  TaskQueryPredicate,
  TaskQueryRow,
  TaskQuerySort,
  TaskRelationPredicateField,
};
export type { LibraryExecution } from "../akuma/requests.js";
export { TaskAuthorityCorruptionError, TASK_RELATION_PREDICATE_FIELDS };
export { observeRecentTaskStatus, type RecentTaskStatusRow } from "./catalog.js";
export { taskRowViewLimit } from "./input.js";

function forwardTask<Request extends TaskMutationRequest>(
  directory: string,
  world: WorldRoot,
  request: Request,
  signal?: AbortSignal,
): Promise<TaskMutationResultForRequest<Request>> {
  return requestForwardedTask({
    directory,
    world,
    request,
    ...(signal === undefined ? {} : { signal }),
  });
}

class TaskHandle {
  constructor(
    readonly id: TaskId,
    private readonly world: WorldRoot,
    private readonly execution: ExecutionContext,
  ) {}
  async read(): Promise<TaskDetail | null> {
    const board = (await readBoard(this.world)).board;
    const facts = projectDetailFacts(board, this.id, createTaskRelations(board));
    return facts === null ? null : { ...facts, task: taskView(facts.task) };
  }
  async tree(): Promise<TaskDecompositionTree> {
    if (arguments.length > 0) throw new TypeError("tree accepts no input");
    const board = (await readBoard(this.world)).board;
    const node = buildTree(board, this.id, createTaskRelations(board));
    return node === null
      ? { kind: "refused", refusal: { kind: "task-missing", taskId: this.id } }
      : { kind: "accepted", value: node };
  }
  update(input: UpdateTaskInput): Promise<TaskUpdateResult> {
    const values = updateInput(input);
    const { signal: abort, ...request } = values;
    const channel = executionChannel(this.execution);
    if (channel.kind === "body-request") {
      return forwardTask(channel.directory, this.world, { action: "task.update", id: this.id, input: request }, abort);
    }
    return updateTask(this.world, this.id, values);
  }
  private lifecycle(
    verb: "start" | "stop" | "hold" | "resume" | "done" | "drop",
    input: unknown,
  ): Promise<TaskMutationResult> {
    const value = record(input ?? {}, `${verb} input`);
    closed(value, verb === "drop" || verb === "done" ? ["note", "signal"] : ["signal"], `${verb} input`);
    const note = verb === "drop" || verb === "done" ? text(value.note, "note") : undefined;
    const abort = signal(value.signal);
    const channel = executionChannel(this.execution);
    if (channel.kind === "body-request") {
      switch (verb) {
        case "start":
          return forwardTask(channel.directory, this.world, { action: "task.start", id: this.id }, abort);
        case "stop":
          return forwardTask(channel.directory, this.world, { action: "task.stop", id: this.id }, abort);
        case "hold":
          return forwardTask(channel.directory, this.world, { action: "task.hold", id: this.id }, abort);
        case "resume":
          return forwardTask(channel.directory, this.world, { action: "task.resume", id: this.id }, abort);
        case "done":
          return forwardTask(
            channel.directory,
            this.world,
            { action: "task.done", id: this.id, ...(note === undefined ? {} : { note }) },
            abort,
          );
        case "drop":
          return forwardTask(
            channel.directory,
            this.world,
            { action: "task.drop", id: this.id, ...(note === undefined ? {} : { note }) },
            abort,
          );
      }
    }
    return lifecycleTask(this.world, this.id, verb, abort, note);
  }
  start(input?: { signal?: AbortSignal }): Promise<TaskMutationResult> {
    return this.lifecycle("start", input);
  }
  stop(input?: { signal?: AbortSignal }): Promise<TaskMutationResult> {
    return this.lifecycle("stop", input);
  }
  hold(input?: { signal?: AbortSignal }): Promise<TaskMutationResult> {
    return this.lifecycle("hold", input);
  }
  resume(input?: { signal?: AbortSignal }): Promise<TaskMutationResult> {
    return this.lifecycle("resume", input);
  }
  done(input?: { note?: string; signal?: AbortSignal }): Promise<TaskMutationResult> {
    return this.lifecycle("done", input);
  }
  drop(input?: { note?: string; signal?: AbortSignal }): Promise<TaskMutationResult> {
    return this.lifecycle("drop", input);
  }
}
export type Task = TaskHandle;

class TasksHandle {
  readonly root: WorldRoot;
  constructor(
    private readonly world: WorldRoot,
    private readonly execution: ExecutionContext,
  ) {
    this.root = world;
  }
  task(input: Readonly<{ id: string }>): Task {
    const v = record(input, "task input");
    closed(v, ["id"], "task input");
    return new TaskHandle(id(v.id), this.world, this.execution);
  }
  add(input: AddTaskInput): Promise<TaskMutationResult> {
    const values = addInput(input);
    const { actor: _actor, signal: abort, namespace: selected, ...request } = values;
    const channel = executionChannel(this.execution);
    if (channel.kind === "body-request") {
      return forwardTask(
        channel.directory,
        this.world,
        { action: "task.add", input: { ...request, namespace: selected ?? [] } },
        abort,
      );
    }
    return addTask(this.world, values);
  }
  addDocument(input: AddTaskDocumentInput): Promise<TaskMutationResult> {
    const v = record(input, "addDocument input");
    closed(v, ["markdown", "namespace", "actor", "signal"], "addDocument input");
    const markdown = text(v.markdown, "markdown");
    if (markdown === undefined) throw new TypeError("markdown is required");
    const ns = namespace(v.namespace),
      createdBy = actor(v.actor),
      abort = signal(v.signal);
    const local = {
      markdown,
      ...(ns === undefined ? {} : { namespace: ns }),
      ...(createdBy === undefined ? {} : { actor: createdBy }),
      ...(abort === undefined ? {} : { signal: abort }),
    };
    const channel = executionChannel(this.execution);
    if (channel.kind === "body-request") {
      return forwardTask(
        channel.directory,
        this.world,
        { action: "task.addDocument", input: { markdown, namespace: ns ?? [] } },
        abort,
      );
    }
    return addTaskDocument(this.world, local);
  }
  async list(
    input: Readonly<{
      selection?: "active" | "closed" | "all";
      scope?: "namespace" | "world";
      namespace?: readonly string[];
      limit?: number;
    }> = {},
  ): Promise<TaskList> {
    const v = record(input, "list input");
    closed(v, ["selection", "scope", "namespace", "limit"], "list input");
    if (v.selection !== undefined && v.selection !== "active" && v.selection !== "closed" && v.selection !== "all")
      throw new TypeError("selection must be active, closed, or all");
    if (v.scope !== undefined && v.scope !== "namespace" && v.scope !== "world")
      throw new TypeError("scope must be namespace or world");
    const selectedLimit = taskRowViewLimit(v.limit);
    return listTasks(
      this.world,
      namespace(v.namespace),
      v.selection ?? "active",
      v.scope as "namespace" | "world" | undefined,
      selectedLimit,
    );
  }
  async ready(
    input: Readonly<{
      scope?: "namespace" | "world";
      namespace?: readonly string[];
      parent?: string;
      limit?: number;
    }> = {},
  ): Promise<TaskList> {
    const v = record(input, "ready input");
    closed(v, ["scope", "namespace", "parent", "limit"], "ready input");
    if (v.scope !== undefined && v.scope !== "namespace" && v.scope !== "world")
      throw new TypeError("scope must be namespace or world");
    const parent = v.parent === undefined ? undefined : id(v.parent);
    const selectedLimit = taskRowViewLimit(v.limit);
    return readyTasks(
      this.world,
      namespace(v.namespace),
      v.scope as "namespace" | "world" | undefined,
      parent,
      selectedLimit,
    );
  }
  async blocked(
    input: Readonly<{
      scope?: "namespace" | "world";
      namespace?: readonly string[];
      parent?: string;
      limit?: number;
    }> = {},
  ): Promise<BlockedTaskList> {
    const v = record(input, "blocked input");
    closed(v, ["scope", "namespace", "parent", "limit"], "blocked input");
    if (v.scope !== undefined && v.scope !== "namespace" && v.scope !== "world")
      throw new TypeError("scope must be namespace or world");
    const parent = v.parent === undefined ? undefined : id(v.parent);
    const selectedLimit = taskRowViewLimit(v.limit);
    return blockedTasks(
      this.world,
      namespace(v.namespace),
      v.scope as "namespace" | "world" | undefined,
      parent,
      selectedLimit,
    );
  }
  async query(
    input: Readonly<{
      where?: TaskQueryExpression;
      scope?: "namespace" | "world";
      namespace?: readonly string[];
      sort?: TaskQuerySort;
      limit?: number;
    }> = {},
  ): Promise<TaskQueryResult> {
    const v = record(input, "query input");
    closed(v, ["where", "scope", "namespace", "sort", "limit"], "query input");
    if (v.scope !== undefined && v.scope !== "namespace" && v.scope !== "world")
      throw new TypeError("scope must be namespace or world");
    const expression =
      v.where === undefined
        ? ({
            kind: "and",
            terms: [
              { kind: "predicate", predicate: { field: "state", operator: "!=", value: "done" } },
              { kind: "predicate", predicate: { field: "state", operator: "!=", value: "drop" } },
            ],
          } as const)
        : normalizeTaskQuery(v.where);
    const selected = namespace(v.namespace);
    const selectedLimit = taskRowViewLimit(v.limit);
    return queryTasks({
      world: this.world,
      ...(selected === undefined ? {} : { namespace: selected }),
      expression,
      ...(v.scope === undefined ? {} : { scope: v.scope as "namespace" | "world" }),
      sort: sort(v.sort) ?? "priority",
      limit: selectedLimit,
    });
  }
  async doctor(): Promise<TaskDoctorReport> {
    return { issues: diagnoseBoard((await readBoard(this.world)).board) };
  }
  batch(
    input: Readonly<{
      verb: "start" | "done" | "drop" | "hold";
      ids: readonly string[];
      note?: string;
      signal?: AbortSignal;
    }>,
  ): Promise<TaskBatchResult> {
    const v = record(input, "batch input");
    closed(v, ["verb", "ids", "note", "signal"], "batch input");
    const verb = v.verb;
    if (verb !== "start" && verb !== "done" && verb !== "drop" && verb !== "hold")
      throw new TypeError("batch verb is invalid");
    const ids = taskIds(v.ids, "ids");
    if (ids === undefined || ids.length === 0) throw new TypeError("ids requires at least one TaskId");
    const note = text(v.note, "note");
    if (note !== undefined && verb !== "done" && verb !== "drop")
      throw new TypeError("batch note is valid only for done or drop");
    const abort = signal(v.signal);
    const channel = executionChannel(this.execution);
    if (channel.kind === "body-request") {
      switch (verb) {
        case "start":
          return forwardTask(channel.directory, this.world, { action: "task.start", ids }, abort);
        case "hold":
          return forwardTask(channel.directory, this.world, { action: "task.hold", ids }, abort);
        case "done":
          return forwardTask(
            channel.directory,
            this.world,
            { action: "task.done", ids, ...(note === undefined ? {} : { note }) },
            abort,
          );
        case "drop":
          return forwardTask(
            channel.directory,
            this.world,
            { action: "task.drop", ids, ...(note === undefined ? {} : { note }) },
            abort,
          );
      }
    }
    return batchTasks(this.world, verb, ids, abort, note);
  }
  compose(
    input: Readonly<{
      markdown: string;
      namespace?: readonly string[];
      actor?: string;
      signal?: AbortSignal;
      plan?: boolean;
    }>,
  ): Promise<TaskCompositionResult> {
    const v = record(input, "compose input");
    closed(v, ["markdown", "namespace", "actor", "signal", "plan"], "compose input");
    const markdown = text(v.markdown, "markdown");
    if (markdown === undefined) throw new TypeError("markdown is required");
    if (v.plan !== undefined && typeof v.plan !== "boolean") throw new TypeError("plan must be a boolean");
    const selected = namespace(v.namespace);
    const selectedSignal = signal(v.signal);
    const selectedActor = actor(v.actor);
    const local = {
      world: this.world,
      markdown,
      ...(selectedSignal === undefined ? {} : { signal: selectedSignal }),
      ...(selectedActor === undefined ? {} : { actor: selectedActor }),
      ...(selected === undefined ? {} : { defaultNamespace: selected }),
      planOnly: v.plan === true,
    };
    const channel = executionChannel(this.execution);
    if (channel.kind === "body-request" && v.plan !== true) {
      return forwardTask(
        channel.directory,
        this.world,
        { action: "task.compose", markdown, namespace: selected ?? [] },
        selectedSignal,
      );
    }
    return composeTasks(local);
  }
}
export type Tasks = TasksHandle;

type TasksOfInput = Readonly<{ execution?: LibraryExecution }>;

function tasksOfExecution(input: TasksOfInput | undefined): ExecutionContext {
  if (input === undefined) return localExecutionContext();
  const values = record(input, "Tasks.of input");
  closed(values, ["execution"], "Tasks.of input");
  return values.execution === undefined ? localExecutionContext() : libraryExecution(values.execution);
}

export const Tasks = Object.freeze({
  of(world: WorldRoot, input?: TasksOfInput): Tasks {
    const execution = tasksOfExecution(input);
    if (typeof world !== "string") throw new TypeError("Tasks.of world must be a WorldRoot");
    return new TasksHandle(world, execution);
  },
});
