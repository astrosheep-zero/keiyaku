import { resolve } from "node:path";
import { documentDiff } from "../markdown/diff.js";
import { installNamespaceContext, readNamespaceContext } from "./context.js";
import {
  createTaskRelations, projectTaskBoardObservation, relationProblem, projectBlocked, projectRows,
  type BlockedTaskRow, type TaskBoard, type TaskBoardObservation, type TaskRow,
} from "./board.js";
import { parseTaskCreationDocument, serializeTaskDocument, type TaskCreationDocument, type TaskDocument, type TaskPriority, type TaskState } from "./document.js";
import { allocateLocalId, deriveLocalStem, formatTaskId, parseTaskId, sameNamespace, type TaskId } from "./identity.js";
import {
  authorityPath, readBoard, replaceAuthority, withTaskLocks,
} from "./store.js";
import type { WorldRoot } from "../world.js";
import { DEFAULT_TASK_LIMIT, projectPage, projectQuery, queryUnderTargets, type TaskPage, type TaskQueryExpression, type TaskQueryRow, type TaskQuerySort, underExpression } from "./query.js";

export type TaskView = Readonly<TaskDocument & { namespace: readonly string[] }>;
export type TaskRefusal =
  | Readonly<{ kind: "task-missing"; taskId: TaskId }>
  | Readonly<{ kind: "invalid-lifecycle-transition"; taskId: TaskId; state: TaskState; verb: TaskLifecycleVerb }>
  | Readonly<{ kind: "invalid-graph"; diagnostic: string }>
  | Readonly<{ kind: "invalid-namespace-context"; path: string }>
  | Readonly<{ kind: "relation-owned-by-other"; taskId: TaskId; related: TaskId; declaringTask: TaskId }>
  | Readonly<{ kind: "invalid-composition"; diagnostic: string }>;
export type TaskRetry = "busy" | "concurrent-modification";
export type TaskOutcome<A> = Readonly<{ kind: "accepted"; value: A }> | Readonly<{ kind: "refused"; refusal: TaskRefusal }> | Readonly<{ kind: "retry"; reason: TaskRetry }>;
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
  title: string; namespace?: readonly string[]; body?: string; note?: string; state?: TaskState; priority?: TaskPriority; needs?: readonly TaskId[];
  parent?: TaskId | null; supersedes?: readonly TaskId[]; relates?: readonly TaskId[]; actor?: string; signal?: AbortSignal;
}>;
export type AddTaskDocumentInput = Readonly<{ markdown: string; namespace?: readonly string[]; actor?: string; signal?: AbortSignal }>;
export type UpdateTaskInput = Readonly<{
  title?: string; body?: string; appendBody?: string; note?: string; priority?: TaskPriority;
  needs?: readonly TaskId[]; addNeeds?: readonly TaskId[]; dropNeeds?: readonly TaskId[];
  parent?: TaskId | null; supersedes?: readonly TaskId[]; addSupersedes?: readonly TaskId[]; dropSupersedes?: readonly TaskId[];
  relates?: readonly TaskId[]; addRelates?: readonly TaskId[]; dropRelates?: readonly TaskId[];
  signal?: AbortSignal;
}>;

export function taskView(document: TaskDocument): TaskView {
  return { ...document, namespace: parseTaskId(document.id).namespace };
}
function refused(refusal: TaskRefusal): TaskMutationResult { return { kind: "refused", refusal }; }
function retry(reason: TaskRetry): TaskMutationResult { return { kind: "retry", reason }; }
async function context(world: WorldRoot, explicit?: readonly string[]): Promise<readonly string[] | TaskRefusal> {
  if (explicit !== undefined) return explicit;
  const current = await readNamespaceContext(world);
  return current === "malformed" ? { kind: "invalid-namespace-context", path: resolve(world, ".keiyaku", "namespace", "current") }
    : current === "absent" ? [] : current;
}
function occupied(board: TaskBoard, namespace: readonly string[]): Set<string> {
  return new Set([...board.tasks.values()].flatMap((task) => {
    const coordinate = parseTaskId(task.id);
    return sameNamespace(coordinate.namespace, namespace) ? [coordinate.localId] : [];
  }));
}
function currentTimestamp(): string { return new Date().toISOString(); }
function advancedTimestamp(previous: string): string {
  const current = currentTimestamp(); return current > previous ? current : new Date(Date.parse(previous) + 1).toISOString();
}
function addDocument(base: TaskCreationDocument, namespace: readonly string[], board: TaskBoard, at: string, actor?: string): TaskDocument {
  const localId = allocateLocalId(deriveLocalStem(base.title), occupied(board, namespace));
  return {
    ...base, id: formatTaskId({ namespace, localId }),
    ...(actor === undefined ? {} : { createdBy: actor }),
    createdAt: at, updatedAt: at,
  };
}
function boardWith(board: TaskBoard, document: TaskDocument): TaskBoard {
  const tasks = new Map(board.tasks); tasks.set(document.id, document); return { tasks };
}
async function create(world: WorldRoot, base: TaskCreationDocument, namespace: readonly string[], signal?: AbortSignal, actor?: string): Promise<TaskMutationResult> {
  const result = await withTaskLocks({ world, allocation: true, ids: [], ...(signal === undefined ? {} : { signal }) }, async () => {
    const snapshot = await readBoard(world), next = addDocument(base, namespace, snapshot.board, currentTimestamp(), actor); const problem = relationProblem(boardWith(snapshot.board, next), null, next);
    if (problem !== null) return refused({ kind: "invalid-graph", diagnostic: problem });
    const replaced = await replaceAuthority({ path: authorityPath(world, next.id), expected: null, next: serializeTaskDocument(next) });
    return replaced === "replaced" ? { kind: "accepted", value: taskView(next) } as const : retry("concurrent-modification");
  });
  return result === "busy" ? retry("busy") : result;
}

export async function addTask(world: WorldRoot, input: AddTaskInput): Promise<TaskMutationResult> {
  const namespace = await context(world, input.namespace); if (!Array.isArray(namespace)) return refused(namespace as TaskRefusal);
  return create(world, {
    title: input.title, body: input.body ?? "", note: input.note ?? "", state: input.state ?? "open", priority: input.priority ?? 2, needs: input.needs ?? [], parent: input.parent ?? null,
    supersedes: input.supersedes ?? [], relates: input.relates ?? [],
  }, namespace, input.signal, input.actor);
}
export async function addTaskDocument(world: WorldRoot, input: AddTaskDocumentInput): Promise<TaskMutationResult> {
  const namespace = await context(world, input.namespace); if (!Array.isArray(namespace)) return refused(namespace as TaskRefusal);
  return create(world, parseTaskCreationDocument(input.markdown), namespace, input.signal, input.actor);
}

function listChange(current: readonly TaskId[], replacement: readonly TaskId[] | undefined, additions: readonly TaskId[] | undefined, removals: readonly TaskId[] | undefined): readonly TaskId[] {
  const next = [...(replacement ?? current)];
  for (const id of additions ?? []) if (!next.includes(id)) next.push(id);
  return next.filter((id) => !(removals ?? []).includes(id));
}
function relatedOwner(board: TaskBoard, id: TaskId, target: TaskId): TaskId | null {
  return board.tasks.get(target)?.relates.includes(id) ? target : null;
}
function updateDocument(board: TaskBoard, current: TaskDocument, input: UpdateTaskInput): TaskDocument | TaskRefusal {
  for (const related of input.dropRelates ?? []) if (!current.relates.includes(related)) {
    const owner = relatedOwner(board, current.id, related);
    if (owner !== null) return { kind: "relation-owned-by-other", taskId: current.id, related, declaringTask: owner };
  }
  return {
    ...current,
    ...(input.title === undefined ? {} : { title: input.title }),
    body: input.body ?? (input.appendBody === undefined ? current.body : current.body + input.appendBody),
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    needs: listChange(current.needs, input.needs, input.addNeeds, input.dropNeeds),
    ...(input.parent === undefined ? {} : { parent: input.parent }),
    supersedes: listChange(current.supersedes, input.supersedes, input.addSupersedes, input.dropSupersedes),
    relates: listChange(current.relates, input.relates, input.addRelates, input.dropRelates),
  };
}

export async function updateTask(world: WorldRoot, id: TaskId, input: UpdateTaskInput): Promise<TaskUpdateResult> {
  const result = await withTaskLocks({ world, allocation: false, ids: [id], ...(input.signal === undefined ? {} : { signal: input.signal }) }, async (): Promise<TaskUpdateResult> => {
    const snapshot = await readBoard(world), current = snapshot.board.tasks.get(id);
    if (current === undefined) return { kind: "refused", refusal: { kind: "task-missing", taskId: id } };
    const candidate = updateDocument(snapshot.board, current, input);
    if ("kind" in candidate) return { kind: "refused", refusal: candidate };
    const problem = relationProblem(boardWith(snapshot.board, candidate), current, candidate); if (problem !== null) return { kind: "refused", refusal: { kind: "invalid-graph", diagnostic: problem } };
    const predecessor = snapshot.bytes.get(id)!, before = Buffer.from(predecessor).toString("utf8");
    const changed = !Buffer.from(serializeTaskDocument(candidate)).equals(Buffer.from(predecessor));
    const next = changed ? { ...candidate, updatedAt: advancedTimestamp(current.updatedAt) } : candidate;
    const afterBytes = serializeTaskDocument(next), after = Buffer.from(afterBytes).toString("utf8");
    if (before !== after && await replaceAuthority({ path: authorityPath(world, id), expected: predecessor, next: afterBytes }) !== "replaced") return { kind: "retry", reason: "concurrent-modification" };
    const label = `${id}.md`;
    return { kind: "accepted", value: { task: taskView(next), documentDiff: documentDiff(label, label, before, after) } };
  });
  return result === "busy" ? { kind: "retry", reason: "busy" } : result;
}

const TRANSITIONS: Readonly<Record<TaskLifecycleVerb, Readonly<Partial<Record<TaskState, TaskState>>>>> = {
  start: { open: "in_progress" }, stop: { in_progress: "open" }, hold: { open: "on_hold", in_progress: "on_hold" },
  resume: { on_hold: "open" }, done: { open: "done", in_progress: "done", on_hold: "done" },
  drop: { open: "drop", in_progress: "drop", on_hold: "drop" },
};
export async function lifecycleTask(world: WorldRoot, id: TaskId, verb: TaskLifecycleVerb, signal?: AbortSignal, note?: string): Promise<TaskMutationResult> {
  const result = await withTaskLocks({ world, allocation: false, ids: [id], ...(signal === undefined ? {} : { signal }) }, async (): Promise<TaskMutationResult> => {
    const snapshot = await readBoard(world), current = snapshot.board.tasks.get(id);
    if (current === undefined) return refused({ kind: "task-missing", taskId: id });
    const state = TRANSITIONS[verb][current.state]; if (state === undefined) return refused({ kind: "invalid-lifecycle-transition", taskId: id, state: current.state, verb });
    const next = { ...current, state, ...(note === undefined ? {} : { note }), updatedAt: advancedTimestamp(current.updatedAt) }; const bytes = serializeTaskDocument(next);
    return await replaceAuthority({ path: authorityPath(world, id), expected: snapshot.bytes.get(id)!, next: bytes }) === "replaced"
      ? { kind: "accepted", value: taskView(next) } : retry("concurrent-modification");
  });
  return result === "busy" ? retry("busy") : result;
}
export async function batchTasks(world: WorldRoot, verb: "done" | "drop" | "hold", ids: readonly TaskId[], signal?: AbortSignal, note?: string): Promise<TaskBatchResult> {
  const items = [];
  for (const id of ids) { signal?.throwIfAborted(); items.push({ id, outcome: await lifecycleTask(world, id, verb, signal, note) }); }
  return { items };
}

export async function settleTask(world: WorldRoot, id: TaskId): Promise<SettledTaskResult> {
  const result = await withTaskLocks({ world, allocation: false, ids: [id] }, async (): Promise<SettledTaskResult> => {
    const snapshot = await readBoard(world), current = snapshot.board.tasks.get(id);
    if (current === undefined) return { kind: "refused", refusal: { kind: "task-missing", taskId: id } };
    if (current.state === "done") return { kind: "unchanged" };
    if (current.state === "drop") {
      return { kind: "refused", refusal: { kind: "invalid-lifecycle-transition", taskId: id, state: current.state, verb: "done" } };
    }
    const next: TaskDocument = { ...current, state: "done", updatedAt: advancedTimestamp(current.updatedAt) };
    const replaced = await replaceAuthority({ path: authorityPath(world, id), expected: snapshot.bytes.get(id)!, next: serializeTaskDocument(next) });
    return replaced === "replaced"
      ? { kind: "changed", task: taskView(next), action: "done" }
      : { kind: "retry", reason: "concurrent-modification" };
  });
  return result === "busy" ? { kind: "retry", reason: "busy" } : result;
}

async function readScope(world: WorldRoot, scope: "namespace" | "world" | undefined): Promise<readonly string[] | null | TaskRefusal> {
  if (scope === "world") return null; return await context(world);
}
export async function listTasks(world: WorldRoot, selection: "active" | "closed" | "all", scope?: "namespace" | "world", limit = DEFAULT_TASK_LIMIT): Promise<TaskOutcome<TaskPage<TaskRow>>> {
  const selected = await readScope(world, scope); if (selected !== null && !Array.isArray(selected)) return { kind: "refused", refusal: selected as TaskRefusal };
  return { kind: "accepted", value: projectPage(projectRows((await readBoard(world)).board, selected as readonly string[] | null, selection), limit) };
}
export async function readyTasks(world: WorldRoot, scope?: "namespace" | "world", parent?: TaskId, limit = DEFAULT_TASK_LIMIT): Promise<TaskOutcome<TaskPage<TaskRow>>> {
  const selected = await readScope(world, scope); if (selected !== null && !Array.isArray(selected)) return { kind: "refused", refusal: selected as TaskRefusal };
  const board = (await readBoard(world)).board;
  if (parent !== undefined && !board.tasks.has(parent)) return { kind: "refused", refusal: { kind: "task-missing", taskId: parent } };
  const relations = createTaskRelations(board);
  const ready: TaskQueryExpression = { kind: "predicate", predicate: { field: "ready", operator: "=", value: true } };
  const expression: TaskQueryExpression = parent === undefined ? ready : { kind: "and", terms: [ready, underExpression(parent)] };
  const selectedRows = projectQuery(board, relations, {
    scope: selected as readonly string[] | null,
    expression,
    limit: Math.max(1, board.tasks.size),
  }).rows;
  const rows = selectedRows.map(({ parent: _parent, needs: _needs, blocks: _blocks, createdAt: _createdAt, updatedAt: _updatedAt, ...row }) => row);
  return { kind: "accepted", value: projectPage(rows, limit) };
}
export async function blockedTasks(world: WorldRoot, scope?: "namespace" | "world", parent?: TaskId, limit = DEFAULT_TASK_LIMIT): Promise<TaskOutcome<TaskPage<BlockedTaskRow>>> {
  const selected = await readScope(world, scope); if (selected !== null && !Array.isArray(selected)) return { kind: "refused", refusal: selected as TaskRefusal };
  const board = (await readBoard(world)).board;
  if (parent !== undefined && !board.tasks.has(parent)) return { kind: "refused", refusal: { kind: "task-missing", taskId: parent } };
  const relations = createTaskRelations(board);
  const blocked: TaskQueryExpression = { kind: "predicate", predicate: { field: "blocked", operator: "=", value: true } };
  const expression: TaskQueryExpression = parent === undefined ? blocked : { kind: "and", terms: [blocked, underExpression(parent)] };
  const selectedRows = projectQuery(board, relations, {
    scope: selected as readonly string[] | null,
    expression,
    limit: Math.max(1, board.tasks.size),
  }).rows;
  const ids = new Set(selectedRows.map((row) => row.id));
  return {
    kind: "accepted",
    value: projectPage(
      projectBlocked(board, selected as readonly string[] | null, relations).filter((row) => ids.has(row.id)),
      limit,
    ),
  };
}
export async function queryTasks(
  world: WorldRoot,
  expression: TaskQueryExpression,
  scope?: "namespace" | "world",
  sort: TaskQuerySort = "priority",
  limit = DEFAULT_TASK_LIMIT,
): Promise<TaskOutcome<TaskPage<TaskQueryRow>>> {
  const selected = await readScope(world, scope); if (selected !== null && !Array.isArray(selected)) return { kind: "refused", refusal: selected as TaskRefusal };
  const board = (await readBoard(world)).board;
  const relations = createTaskRelations(board);
  for (const target of queryUnderTargets(expression)) if (!board.tasks.has(target)) {
    return { kind: "refused", refusal: { kind: "task-missing", taskId: target } };
  }
  return {
    kind: "accepted",
    value: projectQuery(board, relations, {
      scope: selected as readonly string[] | null,
      expression,
      sort,
      limit,
    }),
  };
}
/** Internal composite observation from one complete Task board read. */
export async function observeTaskBoard(world: WorldRoot): Promise<TaskBoardObservation> {
  return projectTaskBoardObservation((await readBoard(world)).board);
}
/** Internal identity catalog from one complete Task board read. */
export async function observeTaskCatalogRows(world: WorldRoot): Promise<readonly TaskRow[]> {
  return projectRows((await readBoard(world)).board, null, "all");
}
export async function setCurrentNamespace(world: WorldRoot, namespace: readonly string[]): Promise<void> { await installNamespaceContext(world, namespace); }
export async function currentNamespace(world: WorldRoot): Promise<readonly string[] | TaskRefusal> {
  const selected = await context(world); return selected;
}
