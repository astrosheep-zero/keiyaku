import type { WorldRoot } from "../world.js";
import {
  executionChannel,
  libraryExecution,
  localExecutionContext,
  type ExecutionContext,
  type LibraryExecution,
} from "../akuma/requests.js";
import {
  requestForwardedTask,
  type TaskLifecycleVerb,
  type TaskMutationRequest,
  type TaskMutationResultForRequest,
} from "./mutation.js";
export type { WorldRoot } from "../world.js";
import {
  buildTree,
  createTaskRelations,
  diagnoseBoard,
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
  type TaskCompositionAdmission,
  type TaskCompositionBodyPreview,
  type TaskCompositionPlanAlias,
  type TaskCompositionPlanOrder,
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
  readTaskDetail,
  readyTasks,
  taskView,
  updateTask,
  type AddTaskDocumentInput,
  type AddTaskInput,
  type TaskBatchResult,
  type TaskCleanupFailure,
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
  TaskCleanupFailure,
  TaskCompositionDiagnostic,
  TaskCompositionAlias,
  TaskCompositionAdmission,
  TaskCompositionBodyPreview,
  TaskCompositionPlanAlias,
  TaskCompositionPlanOrder,
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

/**
 * The one captured execution route per Tasks handle. Local execution calls the
 * Task operations directly; a forwarded handle sends the same operation through
 * the one body-request channel. The channel is read once at construction, never
 * re-derived per operation.
 */
type TaskRoute = Readonly<{ kind: "local" }> | Readonly<{ kind: "forwarded"; directory: string }>;

function taskRoute(execution: ExecutionContext): TaskRoute {
  const channel = executionChannel(execution);
  return channel.kind === "body-request" ? { kind: "forwarded", directory: channel.directory } : { kind: "local" };
}

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

type LifecycleAction = "task.start" | "task.stop" | "task.hold" | "task.resume" | "task.done" | "task.drop";
type SingleLifecycleRequest = Extract<TaskMutationRequest, { action: LifecycleAction; id: TaskId }>;
type BatchLifecycleRequest = Extract<TaskMutationRequest, { action: LifecycleAction; ids: readonly TaskId[] }>;

/** The single lifecycle request shapes, keyed once by verb instead of switched per handle. */
const SINGLE_LIFECYCLE: Readonly<
  Record<TaskLifecycleVerb, (id: TaskId, note: string | undefined) => SingleLifecycleRequest>
> = {
  start: (id) => ({ action: "task.start", id }),
  stop: (id) => ({ action: "task.stop", id }),
  hold: (id) => ({ action: "task.hold", id }),
  resume: (id) => ({ action: "task.resume", id }),
  done: (id, note) => ({ action: "task.done", id, ...(note === undefined ? {} : { note }) }),
  drop: (id, note) => ({ action: "task.drop", id, ...(note === undefined ? {} : { note }) }),
};

/** The batch lifecycle request shapes for the same verbs. */
const BATCH_LIFECYCLE: Readonly<
  Record<TaskLifecycleVerb, (ids: readonly TaskId[], note: string | undefined) => BatchLifecycleRequest>
> = {
  start: (ids) => ({ action: "task.start", ids }),
  stop: (ids) => ({ action: "task.stop", ids }),
  hold: (ids) => ({ action: "task.hold", ids }),
  resume: (ids) => ({ action: "task.resume", ids }),
  done: (ids, note) => ({ action: "task.done", ids, ...(note === undefined ? {} : { note }) }),
  drop: (ids, note) => ({ action: "task.drop", ids, ...(note === undefined ? {} : { note }) }),
};

type ComposeValues = Readonly<{
  markdown: string;
  namespace?: readonly string[];
  actor?: string;
  signal?: AbortSignal;
}>;

/**
 * The one bound operation table for a captured route. Each entry either calls the
 * local Task operations directly or sends the same validated values as the one
 * forwarded request shape. Validation stays in the handle methods.
 */
type TaskOperations = Readonly<{
  add(values: AddTaskInput): Promise<TaskMutationResult>;
  addDocument(values: AddTaskDocumentInput): Promise<TaskMutationResult>;
  compose(values: ComposeValues): Promise<TaskCompositionResult>;
  update(id: TaskId, values: UpdateTaskInput): Promise<TaskUpdateResult>;
  lifecycle(
    id: TaskId,
    verb: TaskLifecycleVerb,
    note: string | undefined,
    signal?: AbortSignal,
  ): Promise<TaskMutationResult>;
  batch(
    verb: TaskLifecycleVerb,
    ids: readonly TaskId[],
    note: string | undefined,
    signal?: AbortSignal,
  ): Promise<TaskBatchResult>;
}>;

function taskOperations(world: WorldRoot, route: TaskRoute): TaskOperations {
  if (route.kind === "forwarded") {
    const { directory } = route;
    return {
      add: (values) => {
        const { actor: _actor, signal, namespace: selected, ...request } = values;
        return forwardTask(
          directory,
          world,
          { action: "task.add", input: { ...request, namespace: selected ?? [] } },
          signal,
        );
      },
      addDocument: (values) =>
        forwardTask(
          directory,
          world,
          { action: "task.addDocument", input: { markdown: values.markdown, namespace: values.namespace ?? [] } },
          values.signal,
        ),
      compose: (values) =>
        forwardTask(
          directory,
          world,
          { action: "task.compose", markdown: values.markdown, namespace: values.namespace ?? [] },
          values.signal,
        ),
      update: (id, values) => {
        const { signal, ...request } = values;
        return forwardTask(directory, world, { action: "task.update", id, input: request }, signal);
      },
      lifecycle: (id, verb, note, signal) => forwardTask(directory, world, SINGLE_LIFECYCLE[verb](id, note), signal),
      batch: (verb, ids, note, signal) => forwardTask(directory, world, BATCH_LIFECYCLE[verb](ids, note), signal),
    };
  }
  return {
    add: (values) => addTask(world, values),
    addDocument: (values) => addTaskDocument(world, values),
    compose: (values) =>
      composeTasks({
        world,
        markdown: values.markdown,
        ...(values.signal === undefined ? {} : { signal: values.signal }),
        ...(values.actor === undefined ? {} : { actor: values.actor }),
        ...(values.namespace === undefined ? {} : { defaultNamespace: values.namespace }),
        planOnly: false,
      }),
    update: (id, values) => updateTask(world, id, values),
    lifecycle: (id, verb, note, signal) => lifecycleTask(world, id, verb, signal, note),
    batch: (verb, ids, note, signal) => batchTasks(world, verb, ids, signal, note),
  };
}

class TaskHandle {
  constructor(
    readonly id: TaskId,
    private readonly world: WorldRoot,
    private readonly operations: TaskOperations,
  ) {}
  async read(): Promise<TaskDetail | null> {
    const facts = await readTaskDetail(this.world, this.id);
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
    return this.operations.update(this.id, updateInput(input));
  }
  private lifecycle(verb: TaskLifecycleVerb, input: unknown): Promise<TaskMutationResult> {
    const value = record(input ?? {}, `${verb} input`);
    closed(value, verb === "drop" || verb === "done" ? ["note", "signal"] : ["signal"], `${verb} input`);
    const note = verb === "drop" || verb === "done" ? text(value.note, "note") : undefined;
    return this.operations.lifecycle(this.id, verb, note, signal(value.signal));
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
  private readonly operations: TaskOperations;
  constructor(
    private readonly world: WorldRoot,
    execution: ExecutionContext,
  ) {
    this.root = world;
    this.operations = taskOperations(world, taskRoute(execution));
  }
  task(input: Readonly<{ id: string }>): Task {
    const v = record(input, "task input");
    closed(v, ["id"], "task input");
    return new TaskHandle(id(v.id), this.world, this.operations);
  }
  add(input: AddTaskInput): Promise<TaskMutationResult> {
    return this.operations.add(addInput(input));
  }
  addDocument(input: AddTaskDocumentInput): Promise<TaskMutationResult> {
    const v = record(input, "addDocument input");
    closed(v, ["markdown", "namespace", "actor", "signal"], "addDocument input");
    const markdown = text(v.markdown, "markdown");
    if (markdown === undefined) throw new TypeError("markdown is required");
    const ns = namespace(v.namespace),
      createdBy = actor(v.actor),
      abort = signal(v.signal);
    return this.operations.addDocument({
      markdown,
      ...(ns === undefined ? {} : { namespace: ns }),
      ...(createdBy === undefined ? {} : { actor: createdBy }),
      ...(abort === undefined ? {} : { signal: abort }),
    });
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
      verb: "start" | "stop" | "done" | "drop" | "hold" | "resume";
      ids: readonly string[];
      note?: string;
      signal?: AbortSignal;
    }>,
  ): Promise<TaskBatchResult> {
    const v = record(input, "batch input");
    closed(v, ["verb", "ids", "note", "signal"], "batch input");
    const verb = v.verb;
    if (
      verb !== "start" &&
      verb !== "stop" &&
      verb !== "done" &&
      verb !== "drop" &&
      verb !== "hold" &&
      verb !== "resume"
    )
      throw new TypeError("batch verb is invalid");
    const ids = taskIds(v.ids, "ids");
    if (ids === undefined || ids.length === 0) throw new TypeError("ids requires at least one TaskId");
    const note = text(v.note, "note");
    if (note !== undefined && verb !== "done" && verb !== "drop")
      throw new TypeError("batch note is valid only for done or drop");
    return this.operations.batch(verb, ids, note, signal(v.signal));
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
    if (v.plan === true) {
      // A dry-run plan never leaves the process: it composes locally on any route.
      return composeTasks({
        world: this.world,
        markdown,
        ...(selectedSignal === undefined ? {} : { signal: selectedSignal }),
        ...(selectedActor === undefined ? {} : { actor: selectedActor }),
        ...(selected === undefined ? {} : { defaultNamespace: selected }),
        planOnly: true,
      });
    }
    return this.operations.compose({
      markdown,
      ...(selected === undefined ? {} : { namespace: selected }),
      ...(selectedActor === undefined ? {} : { actor: selectedActor }),
      ...(selectedSignal === undefined ? {} : { signal: selectedSignal }),
    });
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
