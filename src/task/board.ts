import type { TaskDocument, TaskPriority, TaskState } from "./document.js";
import { sameNamespace, type TaskId } from "./identity.js";

export type TaskRef = Readonly<{ id: TaskId; title: string | null; state: TaskState | "missing" }>;
export type TaskDisposition = "ready" | "blocked" | "in_progress" | "on_hold" | "done" | "drop";
export type TaskRow = Readonly<{ id: TaskId; title: string; state: TaskState; priority: TaskPriority; disposition: TaskDisposition; contractId: string | null }>;
export type BlockedTaskRow = TaskRow & Readonly<{ blockers: readonly TaskRef[] }>;
export type TaskDetailFacts = Readonly<{
  task: TaskDocument; needs: readonly (TaskRef & Readonly<{ released: boolean }>)[]; blockers: readonly TaskRef[];
  blocks: readonly TaskRef[]; parent: TaskRef | null; children: readonly TaskRef[];
  supersedes: readonly TaskRef[]; supersededBy: readonly TaskRef[]; related: readonly TaskRef[];
}>;
export type TaskCycle = readonly TaskId[];
export type TaskTreeNode = Readonly<{ task: TaskRef & Readonly<{ priority: TaskPriority | null }>; cycle?: true; reference?: true; needs: readonly TaskTreeNode[] }>;
export type TaskBoard = Readonly<{ tasks: ReadonlyMap<TaskId, TaskDocument> }>;

const terminal = (state: TaskState): boolean => state === "done" || state === "drop";
const sorted = <T extends { id: string }>(values: Iterable<T>): readonly T[] => [...values].sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
export function taskRef(board: TaskBoard, id: TaskId): TaskRef {
  const task = board.tasks.get(id);
  return task === undefined ? { id, title: null, state: "missing" } : { id, title: task.title, state: task.state };
}
function outgoing(document: TaskDocument, relation: "needs" | "supersedes"): readonly TaskId[] { return document[relation]; }
function reverse(board: TaskBoard, id: TaskId, relation: "needs" | "supersedes"): readonly TaskRef[] {
  return sorted([...board.tasks.values()].filter((task) => outgoing(task, relation).includes(id)).map((task) => taskRef(board, task.id)));
}
function children(board: TaskBoard, id: TaskId): readonly TaskRef[] {
  return sorted([...board.tasks.values()].filter((task) => task.parent === id).map((task) => taskRef(board, task.id)));
}
function related(board: TaskBoard, task: TaskDocument): readonly TaskRef[] {
  const ids = new Set<TaskId>(task.relates);
  for (const candidate of board.tasks.values()) if (candidate.relates.includes(task.id)) ids.add(candidate.id);
  return sorted([...ids].map((id) => taskRef(board, id)));
}
export function disposition(board: TaskBoard, task: TaskDocument): TaskDisposition {
  if (task.state !== "open") return task.state;
  return task.needs.every((id) => { const target = board.tasks.get(id); return target !== undefined && terminal(target.state); }) ? "ready" : "blocked";
}
export function projectDetailFacts(board: TaskBoard, id: TaskId): TaskDetailFacts | null {
  const task = board.tasks.get(id); if (task === undefined) return null;
  const needs = task.needs.map((need) => ({ ...taskRef(board, need), released: board.tasks.has(need) && terminal(board.tasks.get(need)!.state) }));
  return {
    task, needs, blockers: needs.filter((need) => !need.released), blocks: reverse(board, id, "needs"),
    parent: task.parent === null ? null : taskRef(board, task.parent), children: children(board, id),
    supersedes: task.supersedes.map((target) => taskRef(board, target)), supersededBy: reverse(board, id, "supersedes"),
    related: related(board, task),
  };
}
function inScope(task: TaskDocument, scope: readonly string[] | null): boolean { return scope === null || sameNamespace(task.coordinate.namespace, scope); }
export function projectRows(board: TaskBoard, scope: readonly string[] | null, selection: "active" | "closed" | "all"): readonly TaskRow[] {
  return [...board.tasks.values()].filter((task) => inScope(task, scope)).filter((task) => selection === "all"
    || (selection === "closed") === terminal(task.state)).map((task) => ({
      id: task.id, title: task.title, state: task.state, priority: task.priority,
      disposition: disposition(board, task), contractId: task.contractId,
    })).sort((a, b) => a.priority - b.priority || Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
}
export function projectReady(board: TaskBoard, scope: readonly string[] | null): readonly TaskRow[] {
  return projectRows(board, scope, "active").filter((row) => row.disposition === "ready");
}
export function projectBlocked(board: TaskBoard, scope: readonly string[] | null): readonly BlockedTaskRow[] {
  return projectRows(board, scope, "active").flatMap((row) => {
    if (row.state !== "open" && row.state !== "in_progress") return [];
    const blockers = projectDetailFacts(board, row.id)!.blockers;
    return blockers.length === 0 ? [] : [{ ...row, blockers }];
  });
}

function relationIds(task: TaskDocument, relation: "needs" | "supersedes" | "parent"): readonly TaskId[] {
  return relation === "parent" ? task.parent === null ? [] : [task.parent] : task[relation];
}
function cyclesFor(board: TaskBoard, relation: "needs" | "supersedes" | "parent"): readonly TaskCycle[] {
  const found = new Map<string, TaskCycle>();
  const visit = (id: TaskId, path: readonly TaskId[]): void => {
    const at = path.indexOf(id);
    if (at >= 0) {
      const cycle = path.slice(at); const rotations = cycle.map((_, i) => [...cycle.slice(i), ...cycle.slice(0, i)] as TaskId[]);
      rotations.sort((a, b) => Buffer.compare(Buffer.from(a.join("\0")), Buffer.from(b.join("\0"))));
      found.set(rotations[0]!.join("\0"), rotations[0]!); return;
    }
    const task = board.tasks.get(id); if (task === undefined) return;
    for (const next of relationIds(task, relation)) visit(next, [...path, id]);
  };
  for (const id of board.tasks.keys()) visit(id, []);
  return [...found.values()].sort((a, b) => Buffer.compare(Buffer.from(a.join("\0")), Buffer.from(b.join("\0"))));
}
export function findNeedsCycles(board: TaskBoard): readonly TaskCycle[] { return cyclesFor(board, "needs"); }

export function graphProblem(board: TaskBoard): string | null {
  for (const task of board.tasks.values()) for (const [name, ids] of [["needs", task.needs], ["supersedes", task.supersedes], ["relates", task.relates], ["parent", task.parent === null ? [] : [task.parent]]] as const) {
    for (const id of ids) {
      if (id === task.id) return `${task.id} has a self ${name} relation`;
      if (!board.tasks.has(id)) return `${task.id} ${name} target does not exist: ${id}`;
    }
  }
  for (const relation of ["needs", "parent", "supersedes"] as const) if (cyclesFor(board, relation).length > 0) return `${relation} graph contains a cycle`;
  return null;
}

export function buildTree(board: TaskBoard, root: TaskId, full: boolean): TaskTreeNode | null {
  if (!board.tasks.has(root)) return null;
  const expanded = new Set<TaskId>();
  const walk = (id: TaskId, path: readonly TaskId[]): TaskTreeNode => {
    const ref = taskRef(board, id); const task = board.tasks.get(id);
    if (path.includes(id)) return { task: { ...ref, priority: task?.priority ?? null }, cycle: true, needs: [] };
    if (!full && expanded.has(id)) return { task: { ...ref, priority: task?.priority ?? null }, reference: true, needs: [] };
    expanded.add(id);
    return { task: { ...ref, priority: task?.priority ?? null }, needs: task === undefined ? [] : task.needs.map((need) => walk(need, [...path, id])) };
  };
  return walk(root, []);
}
