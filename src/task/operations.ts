import { documentDiff } from "../markdown/diff.js";
import {
  createTaskRelations,
  projectDetailFacts,
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
  type TaskPriority,
  type TaskState,
} from "./document.js";
import { allocateLocalId, deriveLocalStem, formatTaskId, parseTaskId, sameNamespace, type TaskId } from "./identity.js";
import {
  authorityBytesMatch,
  authorityPath,
  nukeTaskAuthority,
  readBoard,
  replaceAuthority,
  withTaskLocks,
} from "./store.js";
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

export type TaskView = Readonly<TaskDocument & { namespace: readonly string[] }>;
export async function nukeTask(world: WorldRoot, options?: Readonly<{ timeoutMs?: number }>): Promise<void> {
  if ((await nukeTaskAuthority(world, options)) === "busy") throw new Error("Task reset lock contention");
}

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
  | Readonly<{ kind: "accepted"; value: A }>
  | Readonly<{ kind: "refused"; refusal: TaskRefusal }>
  | Readonly<{ kind: "retry"; reason: TaskRetry }>;
export type TaskMutationResult = TaskOutcome<TaskView>;
export type TaskUpdateResult = TaskOutcome<Readonly<{ task: TaskView; documentDiff: string }>>;
export type TaskLifecycleVerb = "start" | "stop" | "hold" | "resume" | "done" | "drop";
export type TaskBatchResult = Readonly<{ items: readonly Readonly<{ id: TaskId; outcome: TaskMutationResult }>[] }>;
export type SettledTaskAction = "done";
export type SettledTaskResult =
  | Readonly<{ kind: "changed"; task: TaskView; action: SettledTaskAction }>
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

export function taskView(document: TaskDocument): TaskView {
  return { ...document, namespace: parseTaskId(document.id).namespace };
}
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
export function advanceTaskTimestamp(previous: string, candidate: string): string {
  return candidate > previous ? candidate : new Date(Date.parse(previous) + 1).toISOString();
}
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
  const result = await withTaskLocks(
    { world, allocation: true, ids: [], ...(signal === undefined ? {} : { signal }) },
    async () => {
      const snapshot = await readBoard(world),
        next = addDocument(base, namespace, snapshot.board, currentTimestamp(), actor);
      const problem = relationProblem(boardWith(snapshot.board, next), null, next);
      if (problem !== null) return refused({ kind: "invalid-graph", diagnostic: problem });
      const replaced = await replaceAuthority({
        path: authorityPath(world, next.id),
        expected: null,
        next: serializeTaskDocument(next),
      });
      return replaced === "replaced"
        ? ({ kind: "accepted", value: taskView(next) } as const)
        : retry("concurrent-modification");
    },
  );
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
        (await replaceAuthority({ path: authorityPath(world, id), expected: predecessor, next: afterBytes })) !==
          "replaced"
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

const TRANSITIONS: Readonly<Record<TaskLifecycleVerb, Readonly<Partial<Record<TaskState, TaskState>>>>> = {
  start: { open: "in_progress" },
  stop: { in_progress: "open" },
  hold: { open: "on_hold", in_progress: "on_hold" },
  resume: { on_hold: "open" },
  done: { open: "done", in_progress: "done", on_hold: "done" },
  drop: { open: "drop", in_progress: "drop", on_hold: "drop" },
};

type CurrentTaskBoard = {
  board: TaskBoard;
  bytes: Map<TaskId, Uint8Array>;
};
type LifecycleFreshness = "batch" | "none";

function currentTaskBoard(board: TaskBoard, bytes: ReadonlyMap<TaskId, Uint8Array>): CurrentTaskBoard {
  return { board, bytes: new Map(bytes) };
}

async function transitionLifecycle(
  world: WorldRoot,
  id: TaskId,
  verb: TaskLifecycleVerb,
  currentBoard: CurrentTaskBoard,
  note?: string,
  freshness: LifecycleFreshness = "none",
): Promise<TaskMutationResult> {
  const current = currentBoard.board.tasks.get(id);
  if (current === undefined) {
    return freshness === "batch" && !(await authorityBytesMatch(world, id, null))
      ? retry("concurrent-modification")
      : refused({ kind: "task-missing", taskId: id });
  }
  const state = TRANSITIONS[verb][current.state];
  if (state === undefined) {
    return freshness === "batch" && !(await authorityBytesMatch(world, id, currentBoard.bytes.get(id)!))
      ? retry("concurrent-modification")
      : refused({ kind: "invalid-lifecycle-transition", taskId: id, state: current.state, verb });
  }
  const at = currentTimestamp();
  const next = {
    ...current,
    state,
    ...(note === undefined ? {} : { note }),
    updatedAt: advanceTaskTimestamp(current.updatedAt, at),
  };
  const bytes = serializeTaskDocument(next);
  if (
    (await replaceAuthority({
      path: authorityPath(world, id),
      expected: currentBoard.bytes.get(id)!,
      next: bytes,
    })) !== "replaced"
  ) {
    return retry("concurrent-modification");
  }
  currentBoard.board = boardWith(currentBoard.board, next);
  currentBoard.bytes.set(id, bytes);
  return { kind: "accepted", value: taskView(next) };
}

async function lifecycleFromCurrentBoard(
  world: WorldRoot,
  id: TaskId,
  verb: TaskLifecycleVerb,
  currentBoard: CurrentTaskBoard,
  signal?: AbortSignal,
  note?: string,
): Promise<TaskMutationResult> {
  const result = await withTaskLocks(
    { world, allocation: false, ids: [id], ...(signal === undefined ? {} : { signal }) },
    async () => transitionLifecycle(world, id, verb, currentBoard, note, "batch"),
  );
  return result === "busy" ? retry("busy") : result;
}

export async function lifecycleTask(
  world: WorldRoot,
  id: TaskId,
  verb: TaskLifecycleVerb,
  signal?: AbortSignal,
  note?: string,
): Promise<TaskMutationResult> {
  const result = await withTaskLocks(
    { world, allocation: false, ids: [id], ...(signal === undefined ? {} : { signal }) },
    async (): Promise<TaskMutationResult> => {
      const snapshot = await readBoard(world);
      return transitionLifecycle(world, id, verb, currentTaskBoard(snapshot.board, snapshot.bytes), note);
    },
  );
  return result === "busy" ? retry("busy") : result;
}
export async function batchTasks(
  world: WorldRoot,
  verb: "start" | "done" | "drop" | "hold",
  ids: readonly TaskId[],
  signal?: AbortSignal,
  note?: string,
): Promise<TaskBatchResult> {
  signal?.throwIfAborted();
  const snapshot = await readBoard(world);
  const currentBoard = currentTaskBoard(snapshot.board, snapshot.bytes);
  const items = [];
  for (const id of ids) {
    signal?.throwIfAborted();
    items.push({ id, outcome: await lifecycleFromCurrentBoard(world, id, verb, currentBoard, signal, note) });
  }
  return { items };
}

export async function settleTask(world: WorldRoot, id: TaskId): Promise<SettledTaskResult> {
  const result = await withTaskLocks({ world, allocation: false, ids: [id] }, async (): Promise<SettledTaskResult> => {
    const snapshot = await readBoard(world),
      current = snapshot.board.tasks.get(id);
    if (current === undefined) return { kind: "refused", refusal: { kind: "task-missing", taskId: id } };
    if (current.state === "done") return { kind: "unchanged" };
    if (current.state === "drop") {
      return {
        kind: "refused",
        refusal: { kind: "invalid-lifecycle-transition", taskId: id, state: current.state, verb: "done" },
      };
    }
    const at = currentTimestamp();
    const next: TaskDocument = {
      ...current,
      state: "done",
      updatedAt: advanceTaskTimestamp(current.updatedAt, at),
    };
    const replaced = await replaceAuthority({
      path: authorityPath(world, id),
      expected: snapshot.bytes.get(id)!,
      next: serializeTaskDocument(next),
    });
    return replaced === "replaced"
      ? { kind: "changed", task: taskView(next), action: "done" }
      : { kind: "retry", reason: "concurrent-modification" };
  });
  return result === "busy" ? { kind: "retry", reason: "busy" } : result;
}

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
export async function readTaskDetails(
  world: WorldRoot,
  ids: readonly TaskId[],
): Promise<TaskOutcome<readonly TaskDetailFacts[]>> {
  const board = (await readBoard(world)).board;
  const relations = createTaskRelations(board);
  const details = ids.map((id) => projectDetailFacts(board, id, relations));
  const missing = details.findIndex((detail) => detail === null);
  return missing < 0
    ? { kind: "accepted", value: details as readonly TaskDetailFacts[] }
    : { kind: "refused", refusal: { kind: "task-missing", taskId: ids[missing]! } };
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
