import { documentDiff } from "../markdown/diff.js";
import { graphProblem, projectBlocked, projectReady, projectRows, type BlockedTaskRow, type TaskBoard, type TaskRow } from "./board.js";
import { parseTaskCreationDocument, serializeTaskDocument, type TaskDocument, type TaskPriority, type TaskState } from "./document.js";
import { allocateLocalId, deriveLocalStem, formatTaskId, sameNamespace, type TaskId } from "./identity.js";
import {
  authorityPath, namespaceContext, readBoard, replaceAuthority, setNamespaceContext, withTaskLocks, type TaskWorld,
} from "./store.js";

export type TaskView = Readonly<Omit<TaskDocument, "coordinate"> & { namespace: readonly string[] }>;
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
export type AddTaskInput = Readonly<{
  title: string; namespace?: readonly string[]; body?: string; priority?: TaskPriority; needs?: readonly TaskId[];
  parent?: TaskId | null; supersedes?: readonly TaskId[]; relates?: readonly TaskId[]; contractId?: string | null; signal?: AbortSignal;
}>;
export type AddTaskDocumentInput = Readonly<{ markdown: string; namespace?: readonly string[]; signal?: AbortSignal }>;
export type UpdateTaskInput = Readonly<{
  title?: string; body?: string; appendBody?: string; priority?: TaskPriority;
  needs?: readonly TaskId[]; addNeeds?: readonly TaskId[]; dropNeeds?: readonly TaskId[];
  parent?: TaskId | null; supersedes?: readonly TaskId[]; addSupersedes?: readonly TaskId[]; dropSupersedes?: readonly TaskId[];
  relates?: readonly TaskId[]; addRelates?: readonly TaskId[]; dropRelates?: readonly TaskId[];
  contractId?: string | null; signal?: AbortSignal;
}>;

export function taskView(document: TaskDocument): TaskView {
  const { coordinate, ...fields } = document; return { ...fields, namespace: coordinate.namespace };
}
function refused(refusal: TaskRefusal): TaskMutationResult { return { kind: "refused", refusal }; }
function retry(reason: TaskRetry): TaskMutationResult { return { kind: "retry", reason }; }
function context(world: TaskWorld, explicit?: readonly string[]): readonly string[] | TaskRefusal {
  if (explicit !== undefined) return explicit;
  const current = namespaceContext(world);
  return current === "malformed" ? { kind: "invalid-namespace-context", path: `${world.root}/.keiyaku/namespace/current` }
    : current === "absent" ? [] : current;
}
function occupied(board: TaskBoard, namespace: readonly string[]): Set<string> {
  return new Set([...board.tasks.values()].filter((task) => sameNamespace(task.coordinate.namespace, namespace)).map((task) => task.coordinate.localId));
}
function addDocument(base: Omit<TaskDocument, "id" | "coordinate" | "state">, namespace: readonly string[], board: TaskBoard): TaskDocument {
  const localId = allocateLocalId(deriveLocalStem(base.title), occupied(board, namespace));
  const coordinate = { namespace, localId }; return { ...base, id: formatTaskId(coordinate), coordinate, state: "open" };
}
function boardWith(board: TaskBoard, document: TaskDocument): TaskBoard {
  const tasks = new Map(board.tasks); tasks.set(document.id, document); return { tasks };
}
async function create(world: TaskWorld, base: Omit<TaskDocument, "id" | "coordinate" | "state">, namespace: readonly string[], signal?: AbortSignal): Promise<TaskMutationResult> {
  const result = await withTaskLocks({ world, graph: true, ids: [], ...(signal === undefined ? {} : { signal }) }, async () => {
    const snapshot = readBoard(world.tasksDirectory); const next = addDocument(base, namespace, snapshot.board); const problem = graphProblem(boardWith(snapshot.board, next));
    if (problem !== null) return refused({ kind: "invalid-graph", diagnostic: problem });
    const replaced = replaceAuthority({ path: authorityPath(world, next.id), expected: null, next: serializeTaskDocument(next) });
    return replaced === "replaced" ? { kind: "accepted", value: taskView(next) } as const : retry("concurrent-modification");
  });
  return result === "busy" ? retry("busy") : result;
}

export async function addTask(world: TaskWorld, input: AddTaskInput): Promise<TaskMutationResult> {
  const namespace = context(world, input.namespace); if (!Array.isArray(namespace)) return refused(namespace as TaskRefusal);
  return create(world, {
    title: input.title, body: input.body ?? "", priority: input.priority ?? 2, needs: input.needs ?? [], parent: input.parent ?? null,
    supersedes: input.supersedes ?? [], relates: input.relates ?? [], contractId: input.contractId ?? null,
  }, namespace, input.signal);
}
export async function addTaskDocument(world: TaskWorld, input: AddTaskDocumentInput): Promise<TaskMutationResult> {
  const namespace = context(world, input.namespace); if (!Array.isArray(namespace)) return refused(namespace as TaskRefusal);
  return create(world, parseTaskCreationDocument(input.markdown), namespace, input.signal);
}

function listChange(current: readonly TaskId[], replacement: readonly TaskId[] | undefined, additions: readonly TaskId[] | undefined, removals: readonly TaskId[] | undefined): readonly TaskId[] {
  const next = [...(replacement ?? current)];
  for (const id of additions ?? []) if (!next.includes(id)) next.push(id);
  return next.filter((id) => !(removals ?? []).includes(id));
}
function isGraphUpdate(input: UpdateTaskInput): boolean {
  return [input.needs, input.addNeeds, input.dropNeeds, input.parent, input.supersedes, input.addSupersedes,
    input.dropSupersedes, input.relates, input.addRelates, input.dropRelates].some((value) => value !== undefined);
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
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    needs: listChange(current.needs, input.needs, input.addNeeds, input.dropNeeds),
    ...(input.parent === undefined ? {} : { parent: input.parent }),
    supersedes: listChange(current.supersedes, input.supersedes, input.addSupersedes, input.dropSupersedes),
    relates: listChange(current.relates, input.relates, input.addRelates, input.dropRelates),
    ...(input.contractId === undefined ? {} : { contractId: input.contractId }),
  };
}

export async function updateTask(world: TaskWorld, id: TaskId, input: UpdateTaskInput): Promise<TaskUpdateResult> {
  const graph = isGraphUpdate(input);
  const result = await withTaskLocks({ world, graph, ids: [id], ...(input.signal === undefined ? {} : { signal: input.signal }) }, async (): Promise<TaskUpdateResult> => {
    const snapshot = readBoard(world.tasksDirectory), current = snapshot.board.tasks.get(id);
    if (current === undefined) return { kind: "refused", refusal: { kind: "task-missing", taskId: id } };
    const next = updateDocument(snapshot.board, current, input);
    if ("kind" in next) return { kind: "refused", refusal: next };
    const problem = graphProblem(boardWith(snapshot.board, next)); if (problem !== null) return { kind: "refused", refusal: { kind: "invalid-graph", diagnostic: problem } };
    const before = Buffer.from(snapshot.bytes.get(id)!).toString("utf8"), afterBytes = serializeTaskDocument(next), after = Buffer.from(afterBytes).toString("utf8");
    if (before !== after && replaceAuthority({ path: authorityPath(world, id), expected: snapshot.bytes.get(id)!, next: afterBytes }) !== "replaced") return { kind: "retry", reason: "concurrent-modification" };
    return { kind: "accepted", value: { task: taskView(next), documentDiff: documentDiff(authorityPath(world, id), authorityPath(world, id), before, after) } };
  });
  return result === "busy" ? { kind: "retry", reason: "busy" } : result;
}

const TRANSITIONS: Readonly<Record<TaskLifecycleVerb, Readonly<Partial<Record<TaskState, TaskState>>>>> = {
  start: { open: "in_progress" }, stop: { in_progress: "open" }, hold: { open: "on_hold", in_progress: "on_hold" },
  resume: { on_hold: "open" }, done: { open: "done", in_progress: "done", on_hold: "done" },
  drop: { open: "drop", in_progress: "drop", on_hold: "drop" },
};
export async function lifecycleTask(world: TaskWorld, id: TaskId, verb: TaskLifecycleVerb, signal?: AbortSignal): Promise<TaskMutationResult> {
  const result = await withTaskLocks({ world, graph: false, ids: [id], ...(signal === undefined ? {} : { signal }) }, async (): Promise<TaskMutationResult> => {
    const snapshot = readBoard(world.tasksDirectory), current = snapshot.board.tasks.get(id);
    if (current === undefined) return refused({ kind: "task-missing", taskId: id });
    const state = TRANSITIONS[verb][current.state]; if (state === undefined) return refused({ kind: "invalid-lifecycle-transition", taskId: id, state: current.state, verb });
    const next = { ...current, state }; const bytes = serializeTaskDocument(next);
    return replaceAuthority({ path: authorityPath(world, id), expected: snapshot.bytes.get(id)!, next: bytes }) === "replaced"
      ? { kind: "accepted", value: taskView(next) } : retry("concurrent-modification");
  });
  return result === "busy" ? retry("busy") : result;
}
export async function batchTasks(world: TaskWorld, verb: "done" | "drop" | "hold", ids: readonly TaskId[], signal?: AbortSignal): Promise<TaskBatchResult> {
  const items = [];
  for (const id of ids) { signal?.throwIfAborted(); items.push({ id, outcome: await lifecycleTask(world, id, verb, signal) }); }
  return { items };
}

function readScope(world: TaskWorld, scope: "namespace" | "world" | undefined): readonly string[] | null | TaskRefusal {
  if (scope === "world") return null; return context(world);
}
export function listTasks(world: TaskWorld, selection: "active" | "closed" | "all", scope?: "namespace" | "world"): TaskOutcome<readonly TaskRow[]> {
  const selected = readScope(world, scope); if (selected !== null && !Array.isArray(selected)) return { kind: "refused", refusal: selected as TaskRefusal };
  return { kind: "accepted", value: projectRows(readBoard(world.tasksDirectory).board, selected as readonly string[] | null, selection) };
}
export function readyTasks(world: TaskWorld, scope?: "namespace" | "world"): TaskOutcome<readonly TaskRow[]> {
  const selected = readScope(world, scope); if (selected !== null && !Array.isArray(selected)) return { kind: "refused", refusal: selected as TaskRefusal };
  return { kind: "accepted", value: projectReady(readBoard(world.tasksDirectory).board, selected as readonly string[] | null) };
}
export function blockedTasks(world: TaskWorld, scope?: "namespace" | "world"): TaskOutcome<readonly BlockedTaskRow[]> {
  const selected = readScope(world, scope); if (selected !== null && !Array.isArray(selected)) return { kind: "refused", refusal: selected as TaskRefusal };
  return { kind: "accepted", value: projectBlocked(readBoard(world.tasksDirectory).board, selected as readonly string[] | null) };
}
export function setCurrentNamespace(world: TaskWorld, namespace: readonly string[]): void { setNamespaceContext(world, namespace); }
export function currentNamespace(world: TaskWorld): readonly string[] | TaskRefusal {
  const selected = context(world); return selected;
}
