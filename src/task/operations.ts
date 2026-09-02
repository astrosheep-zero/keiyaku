import { documentDiff } from "../markdown/diff.js";
import {
  createTaskRelations,
  projectOwnedDetailFacts,
  projectTaskBoardObservation,
  relationProblem,
  projectBlocked,
  projectRows,
  type BlockedTaskRow,
  type TaskBoard,
  type TaskBoardObservation,
  type TaskDetailFacts,
  type TaskRow,
} from "./board.js";
import {
  parseTaskCreationDocument,
  serializeTaskDocument,
  type TaskCreationDocument,
  type TaskDocument,
} from "./document.js";
import { allocateLocalId, deriveLocalStem, formatTaskId, parseTaskId, sameNamespace, type TaskId } from "./identity.js";
import { nukeTaskAuthority, readBoard, readTaskDocument, replaceAuthority, withTaskLocks } from "./store.js";
import type { WorldRoot } from "../world.js";
import { projectBoundedList } from "../bounded-list.js";
import { taskRowViewLimit } from "./input.js";
import {
  projectQuery,
  projectQueryRows,
  queryUnderTargets,
  type TaskPage,
  type TaskQueryExpression,
  type TaskQueryRow,
  type TaskQuerySort,
  underExpression,
} from "./query.js";
import { advanceTaskTimestamp, taskView } from "./view.js";
export { advanceTaskTimestamp, taskView } from "./view.js";
export type {
  AddTaskDocumentInput,
  AddTaskInput,
  TaskCleanupFailure,
  SettledTaskAction,
  SettledTaskResult,
  TaskBatchResult,
  TaskCompositionDiagnostic,
  TaskLifecycleVerb,
  TaskMutationResult,
  TaskOutcome,
  TaskRefusal,
  TaskRetry,
  TaskUpdateResult,
  TaskView,
  UpdateTaskInput,
} from "./operation-types.js";
import type {
  AddTaskDocumentInput,
  AddTaskInput,
  TaskMutationResult,
  TaskOutcome,
  TaskRefusal,
  TaskRetry,
  TaskUpdateResult,
  TaskView,
  UpdateTaskInput,
} from "./operation-types.js";

export async function nukeTask(world: WorldRoot, options?: Readonly<{ timeoutMs?: number }>): Promise<void> {
  if ((await nukeTaskAuthority(world, options)) === "busy") throw new Error("Task reset lock contention");
}

export type { TaskState } from "./document.js";

function refused(refusal: TaskRefusal): TaskMutationResult {
  return { kind: "refused", refusal };
}
function retry(reason: TaskRetry): TaskMutationResult {
  return { kind: "retry", reason };
}
function occupied(board: TaskBoard, namespace: readonly string[]): Set<string> {
  return new Set(
    [...board.tasks.values()].flatMap((task) => {
      const coordinate = parseTaskId(task.id);
      return sameNamespace(coordinate.namespace, namespace) ? [coordinate.localId] : [];
    }),
  );
}
function currentTimestamp(): string {
  return new Date().toISOString();
}

/** Internal Task timestamp rule shared by ordinary mutations and compose. */
function addDocument(
  base: TaskCreationDocument,
  namespace: readonly string[],
  board: TaskBoard,
  at: string,
  actor?: string,
): TaskDocument {
  const localId = allocateLocalId(deriveLocalStem(base.title), occupied(board, namespace));
  return {
    ...base,
    id: formatTaskId({ namespace, localId }),
    ...(actor === undefined ? {} : { createdBy: actor }),
    createdAt: at,
    updatedAt: at,
  };
}
function boardWith(board: TaskBoard, document: TaskDocument): TaskBoard {
  const tasks = new Map(board.tasks);
  tasks.set(document.id, document);
  return { tasks };
}
async function create(
  world: WorldRoot,
  base: TaskCreationDocument,
  namespace: readonly string[],
  signal?: AbortSignal,
  actor?: string,
): Promise<TaskMutationResult> {
  let result: TaskMutationResult | "busy";
  try {
    result = await withTaskLocks(
      { world, allocation: true, ids: [], ...(signal === undefined ? {} : { signal }) },
      async () => {
        const snapshot = await readBoard(world),
          next = addDocument(base, namespace, snapshot.board, currentTimestamp(), actor);
        const problem = relationProblem(boardWith(snapshot.board, next), null, next);
        if (problem !== null) return refused({ kind: "invalid-graph", diagnostic: problem });
        const replaced = await replaceAuthority({
          world,
          id: next.id,
          expected: null,
          next: serializeTaskDocument(next),
        });
        return replaced === "replaced"
          ? ({ kind: "accepted", value: taskView(next) } as const)
          : retry("concurrent-modification");
      },
    );
  } catch (error) {
    if (
      error instanceof TypeError &&
      /task identity (?:cannot fit the physical filename budget|contains a Windows-reserved physical segment)/u.test(
        error.message,
      )
    )
      return refused({ kind: "invalid-namespace-context", path: namespace.join("/") });
    throw error;
  }
  return result === "busy" ? retry("busy") : result;
}

export async function addTask(world: WorldRoot, input: AddTaskInput): Promise<TaskMutationResult> {
  const namespace = input.namespace ?? [];
  return create(
    world,
    {
      title: input.title,
      body: input.body ?? "",
      note: input.note ?? "",
      state: input.state ?? "open",
      priority: input.priority ?? 2,
      needs: input.needs ?? [],
      parent: input.parent ?? null,
      supersedes: input.supersedes ?? [],
      relates: input.relates ?? [],
    },
    namespace,
    input.signal,
    input.actor,
  );
}
export async function addTaskDocument(world: WorldRoot, input: AddTaskDocumentInput): Promise<TaskMutationResult> {
  const namespace = input.namespace ?? [];
  return create(world, parseTaskCreationDocument(input.markdown), namespace, input.signal, input.actor);
}

function listChange(
  current: readonly TaskId[],
  replacement: readonly TaskId[] | undefined,
  additions: readonly TaskId[] | undefined,
  removals: readonly TaskId[] | undefined,
): readonly TaskId[] {
  const next = [...(replacement ?? current)];
  for (const id of additions ?? []) if (!next.includes(id)) next.push(id);
  return next.filter((id) => !(removals ?? []).includes(id));
}
function relatedOwner(board: TaskBoard, id: TaskId, target: TaskId): TaskId | null {
  return board.tasks.get(target)?.relates.includes(id) ? target : null;
}
function appendTaskBody(current: string, addition: string): string {
  if (current.length === 0 || addition.length === 0 || current.endsWith("\n") || addition.startsWith("\n")) {
    return current + addition;
  }
  return `${current}\n${addition}`;
}
function updateDocument(board: TaskBoard, current: TaskDocument, input: UpdateTaskInput): TaskDocument | TaskRefusal {
  for (const related of input.dropRelates ?? [])
    if (!current.relates.includes(related)) {
      const owner = relatedOwner(board, current.id, related);
      if (owner !== null) return { kind: "relation-owned-by-other", taskId: current.id, related, declaringTask: owner };
    }
  return {
    ...current,
    ...(input.title === undefined ? {} : { title: input.title }),
    body:
      input.body ?? (input.appendBody === undefined ? current.body : appendTaskBody(current.body, input.appendBody)),
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    needs: listChange(current.needs, input.needs, input.addNeeds, input.dropNeeds),
    ...(input.parent === undefined ? {} : { parent: input.parent }),
    supersedes: listChange(current.supersedes, input.supersedes, input.addSupersedes, input.dropSupersedes),
    relates: listChange(current.relates, input.relates, input.addRelates, input.dropRelates),
  };
}

export async function updateTask(world: WorldRoot, id: TaskId, input: UpdateTaskInput): Promise<TaskUpdateResult> {
  const result = await withTaskLocks(
    { world, allocation: false, ids: [id], ...(input.signal === undefined ? {} : { signal: input.signal }) },
    async (): Promise<TaskUpdateResult> => {
      const snapshot = await readBoard(world),
        current = snapshot.board.tasks.get(id);
      if (current === undefined) return { kind: "refused", refusal: { kind: "task-missing", taskId: id } };
      const candidate = updateDocument(snapshot.board, current, input);
      if ("kind" in candidate) return { kind: "refused", refusal: candidate };
      const problem = relationProblem(boardWith(snapshot.board, candidate), current, candidate);
      if (problem !== null) return { kind: "refused", refusal: { kind: "invalid-graph", diagnostic: problem } };
      const predecessor = snapshot.bytes.get(id)!;
      const before = Buffer.from(predecessor).toString("utf8");
      const changed = !Buffer.from(serializeTaskDocument(candidate)).equals(Buffer.from(predecessor));
      let next = candidate;
      if (changed) {
        const at = currentTimestamp();
        next = { ...candidate, updatedAt: advanceTaskTimestamp(current.updatedAt, at) };
      }
      const afterBytes = serializeTaskDocument(next);
      const after = Buffer.from(afterBytes).toString("utf8");
      if (
        before !== after &&
        (await replaceAuthority({ world, id, expected: predecessor, next: afterBytes })) !== "replaced"
      ) {
        return { kind: "retry", reason: "concurrent-modification" };
      }
      const label = `${id}.md`;
      return {
        kind: "accepted",
        value: { task: taskView(next), documentDiff: documentDiff(label, label, before, after) },
      };
    },
  );
  return result === "busy" ? { kind: "retry", reason: "busy" } : result;
}

export { batchTasks, lifecycleTask, settleTask } from "./lifecycle-operations.js";

function readScope(
  namespace: readonly string[] | undefined,
  scope: "namespace" | "world" | undefined,
): readonly string[] | null {
  return scope === "world" ? null : (namespace ?? []);
}
export async function listTasks(
  world: WorldRoot,
  namespace: readonly string[] | undefined,
  selection: "active" | "closed" | "all",
  scope?: "namespace" | "world",
  limit?: number,
): Promise<TaskOutcome<TaskPage<TaskRow>>> {
  const selectedLimit = taskRowViewLimit(limit);
  const selected = readScope(namespace, scope);
  const board = (await readBoard(world)).board;
  return {
    kind: "accepted",
    value: projectBoundedList(projectRows(board, createTaskRelations(board), selected, selection), selectedLimit),
  };
}
export async function readTaskDetail(world: WorldRoot, id: TaskId): Promise<TaskDetailFacts | null> {
  const task = await readTaskDocument(world, id);
  if (task === undefined) return null;
  const selected = new Map<TaskId, TaskDocument>([[id, task]]);
  const references = [
    ...task.needs,
    ...(task.parent === null ? [] : [task.parent]),
    ...task.supersedes,
    ...task.relates,
  ];
  for (const reference of references) {
    if (selected.has(reference)) continue;
    const document = await readTaskDocument(world, reference);
    if (document !== undefined) selected.set(reference, document);
  }
  return projectOwnedDetailFacts({ tasks: selected }, id);
}

export async function readTaskDetails(
  world: WorldRoot,
  ids: readonly TaskId[],
): Promise<TaskOutcome<readonly TaskDetailFacts[]>> {
  const details: TaskDetailFacts[] = [];
  for (const id of ids) {
    const detail = await readTaskDetail(world, id);
    if (detail === null) return { kind: "refused", refusal: { kind: "task-missing", taskId: id } };
    details.push(detail);
  }
  return { kind: "accepted", value: details };
}
export async function observeTaskDetails(
  world: WorldRoot,
  ids: readonly TaskId[],
): Promise<TaskOutcome<readonly (Omit<TaskDetailFacts, "task"> & Readonly<{ task: TaskView }>)[]>> {
  const observed = await readTaskDetails(world, ids);
  if (observed.kind !== "accepted") return observed;
  return { kind: "accepted", value: observed.value.map((facts) => ({ ...facts, task: taskView(facts.task) })) };
}
export async function readyTasks(
  world: WorldRoot,
  namespace: readonly string[] | undefined,
  scope?: "namespace" | "world",
  parent?: TaskId,
  limit?: number,
): Promise<TaskOutcome<TaskPage<TaskRow>>> {
  const selectedLimit = taskRowViewLimit(limit);
  const selected = readScope(namespace, scope);
  const board = (await readBoard(world)).board;
  if (parent !== undefined && !board.tasks.has(parent))
    return { kind: "refused", refusal: { kind: "task-missing", taskId: parent } };
  const relations = createTaskRelations(board);
  const ready: TaskQueryExpression = { kind: "predicate", predicate: { field: "ready", operator: "=", value: true } };
  const expression: TaskQueryExpression =
    parent === undefined ? ready : { kind: "and", terms: [ready, underExpression(parent)] };
  const selectedRows = projectQueryRows(board, relations, {
    scope: selected as readonly string[] | null,
    expression,
  });
  const rows = selectedRows.map(
    ({ parent: _parent, needs: _needs, blocks: _blocks, createdAt: _createdAt, ...row }) => row,
  );
  return { kind: "accepted", value: projectBoundedList(rows, selectedLimit) };
}
export async function blockedTasks(
  world: WorldRoot,
  namespace: readonly string[] | undefined,
  scope?: "namespace" | "world",
  parent?: TaskId,
  limit?: number,
): Promise<TaskOutcome<TaskPage<BlockedTaskRow>>> {
  const selectedLimit = taskRowViewLimit(limit);
  const selected = readScope(namespace, scope);
  const board = (await readBoard(world)).board;
  if (parent !== undefined && !board.tasks.has(parent))
    return { kind: "refused", refusal: { kind: "task-missing", taskId: parent } };
  const relations = createTaskRelations(board);
  const blocked: TaskQueryExpression = {
    kind: "predicate",
    predicate: { field: "blocked", operator: "=", value: true },
  };
  const expression: TaskQueryExpression =
    parent === undefined ? blocked : { kind: "and", terms: [blocked, underExpression(parent)] };
  const selectedRows = projectQueryRows(board, relations, {
    scope: selected as readonly string[] | null,
    expression,
  });
  const ids = new Set(selectedRows.map((row) => row.id));
  return {
    kind: "accepted",
    value: projectBoundedList(
      projectBlocked(board, selected as readonly string[] | null, relations).filter((row) => ids.has(row.id)),
      selectedLimit,
    ),
  };
}
export async function queryTasks(
  input: Readonly<{
    world: WorldRoot;
    namespace?: readonly string[];
    expression: TaskQueryExpression;
    scope?: "namespace" | "world";
    sort?: TaskQuerySort;
    limit?: number;
  }>,
): Promise<TaskOutcome<TaskPage<TaskQueryRow>>> {
  const selectedLimit = taskRowViewLimit(input.limit);
  const selected = readScope(input.namespace, input.scope);
  const board = (await readBoard(input.world)).board;
  const relations = createTaskRelations(board);
  for (const target of queryUnderTargets(input.expression))
    if (!board.tasks.has(target)) {
      return { kind: "refused", refusal: { kind: "task-missing", taskId: target } };
    }
  return {
    kind: "accepted",
    value: projectQuery(board, relations, {
      scope: selected as readonly string[] | null,
      expression: input.expression,
      sort: input.sort ?? "priority",
      limit: selectedLimit,
    }),
  };
}
export async function observeTaskBoard(world: WorldRoot): Promise<TaskBoardObservation> {
  return projectTaskBoardObservation((await readBoard(world)).board);
}
