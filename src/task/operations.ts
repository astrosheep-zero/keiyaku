import { documentDiff } from "../markdown/diff.js";
import { installNamespaceContext, readNamespaceContext } from "./context.js";
import { relationProblem, projectBlocked, projectReady, projectRows, projectStatusRows, type BlockedTaskRow, type TaskBoard, type TaskRow } from "./board.js";
import { parseTaskCreationDocument, serializeTaskDocument, type TaskCreationDocument, type TaskDocument, type TaskPriority, type TaskState } from "./document.js";
import { allocateLocalId, deriveLocalStem, formatTaskId, parseTaskId, sameNamespace, type TaskId } from "./identity.js";
import {
  authorityPath, readBoard, replaceAuthority, withTaskLocks,
} from "./store.js";
import type { WorldRoot } from "../world.js";

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
export type SettledTaskAction = "done" | "reopened";
export type SettledTaskResult =
  | Readonly<{ kind: "changed"; task: TaskView; action: SettledTaskAction }>
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{ kind: "refused"; refusal: TaskRefusal }>
  | Readonly<{ kind: "retry"; reason: TaskRetry }>;
export type AddTaskInput = Readonly<{
  title: string; namespace?: readonly string[]; body?: string; note?: string; state?: TaskState; priority?: TaskPriority; needs?: readonly TaskId[];
  parent?: TaskId | null; supersedes?: readonly TaskId[]; relates?: readonly TaskId[]; signal?: AbortSignal;
}>;
export type AddTaskDocumentInput = Readonly<{ markdown: string; namespace?: readonly string[]; signal?: AbortSignal }>;
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
function context(world: WorldRoot, explicit?: readonly string[]): readonly string[] | TaskRefusal {
  if (explicit !== undefined) return explicit;
  const current = readNamespaceContext(world);
  return current === "malformed" ? { kind: "invalid-namespace-context", path: `${world}/.keiyaku/namespace/current` }
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
function addDocument(base: TaskCreationDocument, namespace: readonly string[], board: TaskBoard, at: string): TaskDocument {
  const localId = allocateLocalId(deriveLocalStem(base.title), occupied(board, namespace));
  return { ...base, id: formatTaskId({ namespace, localId }), createdAt: at, updatedAt: at };
}
function boardWith(board: TaskBoard, document: TaskDocument): TaskBoard {
  const tasks = new Map(board.tasks); tasks.set(document.id, document); return { tasks };
}
async function create(world: WorldRoot, base: TaskCreationDocument, namespace: readonly string[], signal?: AbortSignal): Promise<TaskMutationResult> {
  const result = await withTaskLocks({ world, allocation: true, ids: [], ...(signal === undefined ? {} : { signal }) }, async () => {
    const snapshot = readBoard(world), next = addDocument(base, namespace, snapshot.board, currentTimestamp()); const problem = relationProblem(boardWith(snapshot.board, next), null, next);
    if (problem !== null) return refused({ kind: "invalid-graph", diagnostic: problem });
    const replaced = replaceAuthority({ path: authorityPath(world, next.id), expected: null, next: serializeTaskDocument(next) });
    return replaced === "replaced" ? { kind: "accepted", value: taskView(next) } as const : retry("concurrent-modification");
  });
  return result === "busy" ? retry("busy") : result;
}

export async function addTask(world: WorldRoot, input: AddTaskInput): Promise<TaskMutationResult> {
  const namespace = context(world, input.namespace); if (!Array.isArray(namespace)) return refused(namespace as TaskRefusal);
  return create(world, {
    title: input.title, body: input.body ?? "", note: input.note ?? "", state: input.state ?? "open", priority: input.priority ?? 2, needs: input.needs ?? [], parent: input.parent ?? null,
    supersedes: input.supersedes ?? [], relates: input.relates ?? [],
  }, namespace, input.signal);
}
export async function addTaskDocument(world: WorldRoot, input: AddTaskDocumentInput): Promise<TaskMutationResult> {
  const namespace = context(world, input.namespace); if (!Array.isArray(namespace)) return refused(namespace as TaskRefusal);
  return create(world, parseTaskCreationDocument(input.markdown), namespace, input.signal);
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
    const snapshot = readBoard(world), current = snapshot.board.tasks.get(id);
    if (current === undefined) return { kind: "refused", refusal: { kind: "task-missing", taskId: id } };
    const candidate = updateDocument(snapshot.board, current, input);
    if ("kind" in candidate) return { kind: "refused", refusal: candidate };
    const problem = relationProblem(boardWith(snapshot.board, candidate), current, candidate); if (problem !== null) return { kind: "refused", refusal: { kind: "invalid-graph", diagnostic: problem } };
    const predecessor = snapshot.bytes.get(id)!, before = Buffer.from(predecessor).toString("utf8");
    const changed = !Buffer.from(serializeTaskDocument(candidate)).equals(Buffer.from(predecessor));
    const next = changed ? { ...candidate, updatedAt: advancedTimestamp(current.updatedAt) } : candidate;
    const afterBytes = serializeTaskDocument(next), after = Buffer.from(afterBytes).toString("utf8");
    if (before !== after && replaceAuthority({ path: authorityPath(world, id), expected: predecessor, next: afterBytes }) !== "replaced") return { kind: "retry", reason: "concurrent-modification" };
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
    const snapshot = readBoard(world), current = snapshot.board.tasks.get(id);
    if (current === undefined) return refused({ kind: "task-missing", taskId: id });
    const state = TRANSITIONS[verb][current.state]; if (state === undefined) return refused({ kind: "invalid-lifecycle-transition", taskId: id, state: current.state, verb });
    const next = { ...current, state, ...(note === undefined ? {} : { note }), updatedAt: advancedTimestamp(current.updatedAt) }; const bytes = serializeTaskDocument(next);
    return replaceAuthority({ path: authorityPath(world, id), expected: snapshot.bytes.get(id)!, next: bytes }) === "replaced"
      ? { kind: "accepted", value: taskView(next) } : retry("concurrent-modification");
  });
  return result === "busy" ? retry("busy") : result;
}
export async function batchTasks(world: WorldRoot, verb: "done" | "drop" | "hold", ids: readonly TaskId[], signal?: AbortSignal, note?: string): Promise<TaskBatchResult> {
  const items = [];
  for (const id of ids) { signal?.throwIfAborted(); items.push({ id, outcome: await lifecycleTask(world, id, verb, signal, note) }); }
  return { items };
}

export async function settleTask(
  world: WorldRoot,
  id: TaskId,
  desired: "done" | "open-from-done",
): Promise<SettledTaskResult> {
  const result = await withTaskLocks({ world, allocation: false, ids: [id] }, async (): Promise<SettledTaskResult> => {
    const snapshot = readBoard(world), current = snapshot.board.tasks.get(id);
    if (current === undefined) return { kind: "refused", refusal: { kind: "task-missing", taskId: id } };
    if (desired === "done") {
      if (current.state === "done") return { kind: "unchanged" };
      if (current.state === "drop") {
        return { kind: "refused", refusal: { kind: "invalid-lifecycle-transition", taskId: id, state: current.state, verb: "done" } };
      }
    } else if (current.state !== "done") return { kind: "unchanged" };
    const state: TaskState = desired === "done" ? "done" : "open";
    const next = { ...current, state, updatedAt: advancedTimestamp(current.updatedAt) };
    const replaced = replaceAuthority({ path: authorityPath(world, id), expected: snapshot.bytes.get(id)!, next: serializeTaskDocument(next) });
    return replaced === "replaced"
      ? { kind: "changed", task: taskView(next), action: desired === "done" ? "done" : "reopened" }
      : { kind: "retry", reason: "concurrent-modification" };
  });
  return result === "busy" ? { kind: "retry", reason: "busy" } : result;
}

function readScope(world: WorldRoot, scope: "namespace" | "world" | undefined): readonly string[] | null | TaskRefusal {
  if (scope === "world") return null; return context(world);
}
export function listTasks(world: WorldRoot, selection: "active" | "closed" | "all", scope?: "namespace" | "world"): TaskOutcome<readonly TaskRow[]> {
  const selected = readScope(world, scope); if (selected !== null && !Array.isArray(selected)) return { kind: "refused", refusal: selected as TaskRefusal };
  return { kind: "accepted", value: projectRows(readBoard(world).board, selected as readonly string[] | null, selection) };
}
export function readyTasks(world: WorldRoot, scope?: "namespace" | "world"): TaskOutcome<readonly TaskRow[]> {
  const selected = readScope(world, scope); if (selected !== null && !Array.isArray(selected)) return { kind: "refused", refusal: selected as TaskRefusal };
  return { kind: "accepted", value: projectReady(readBoard(world).board, selected as readonly string[] | null) };
}
export function blockedTasks(world: WorldRoot, scope?: "namespace" | "world"): TaskOutcome<readonly BlockedTaskRow[]> {
  const selected = readScope(world, scope); if (selected !== null && !Array.isArray(selected)) return { kind: "refused", refusal: selected as TaskRefusal };
  return { kind: "accepted", value: projectBlocked(readBoard(world).board, selected as readonly string[] | null) };
}
/** Internal composite observation from one complete Task board read. */
export function observeTaskStatusRows(world: WorldRoot) {
  return projectStatusRows(readBoard(world).board, null);
}
export function setCurrentNamespace(world: WorldRoot, namespace: readonly string[]): void { installNamespaceContext(world, namespace); }
export function currentNamespace(world: WorldRoot): readonly string[] | TaskRefusal {
  const selected = context(world); return selected;
}
