import type { TaskDocument, TaskPriority, TaskState } from "./document.js";
import { parseTaskId, sameNamespace, type TaskId } from "./identity.js";

export type TaskRef = Readonly<{ id: TaskId; title: string | null; state: TaskState | "missing" }>;
export type TaskDisposition = "ready" | "blocked" | "in_progress" | "on_hold" | "done" | "drop";
export type TaskRow = Readonly<{ id: TaskId; title: string; state: TaskState; priority: TaskPriority; disposition: TaskDisposition }>;
export type BlockedTaskRow = TaskRow & Readonly<{ blockers: readonly TaskRef[] }>;
export type TaskDetailFacts = Readonly<{
  task: TaskDocument; needs: readonly (TaskRef & Readonly<{ released: boolean }>)[]; blockers: readonly TaskRef[];
  blocks: readonly TaskRef[]; parent: TaskRef | null; children: readonly TaskRef[];
  supersedes: readonly TaskRef[]; supersededBy: readonly TaskRef[]; related: readonly TaskRef[];
}>;
export type TaskTreeNode = Readonly<{ task: TaskRef & Readonly<{ priority: TaskPriority | null }>; cycle?: true; reference?: true; needs: readonly TaskTreeNode[] }>;
export type TaskBoard = Readonly<{ tasks: ReadonlyMap<TaskId, TaskDocument> }>;
type TaskRelation = "needs" | "parent" | "supersedes" | "relates";
export type TaskDoctorIssue =
  | Readonly<{ kind: "missing-target"; taskId: TaskId; relation: TaskRelation; target: TaskId }>
  | Readonly<{ kind: "self-relation"; taskId: TaskId; relation: TaskRelation }>
  | Readonly<{ kind: "cycle"; relation: "needs" | "parent" | "supersedes"; tasks: readonly TaskId[] }>;

const terminal = (state: TaskState): boolean => state === "done" || state === "drop";
const sorted = <T extends { id: string }>(values: Iterable<T>): readonly T[] => [...values].sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
function taskRef(board: TaskBoard, id: TaskId): TaskRef {
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
export function taskDisposition(board: TaskBoard, task: TaskDocument): TaskDisposition {
  if (task.state !== "open") return task.state;
  return task.needs.every((id) => { const target = board.tasks.get(id); return target !== undefined && terminal(target.state); }) ? "ready" : "blocked";
}
export function projectDetailFacts(board: TaskBoard, id: TaskId): TaskDetailFacts | null {
  const task = board.tasks.get(id); if (task === undefined) return null;
  const needs = task.needs.map((need) => ({ ...taskRef(board, need), released: board.tasks.has(need) && terminal(board.tasks.get(need)!.state) }));
  return {
    task,
    needs,
    blockers: needs.filter((need) => !need.released).map(({ released: _released, ...ref }) => ref),
    blocks: reverse(board, id, "needs"),
    parent: task.parent === null ? null : taskRef(board, task.parent), children: children(board, id),
    supersedes: task.supersedes.map((target) => taskRef(board, target)), supersededBy: reverse(board, id, "supersedes"),
    related: related(board, task),
  };
}
function inScope(task: TaskDocument, scope: readonly string[] | null): boolean { return scope === null || sameNamespace(parseTaskId(task.id).namespace, scope); }
export function projectRows(board: TaskBoard, scope: readonly string[] | null, selection: "active" | "closed" | "all"): readonly TaskRow[] {
  return [...board.tasks.values()].filter((task) => inScope(task, scope)).filter((task) => selection === "all"
    || (selection === "closed") === terminal(task.state)).map((task) => ({
      id: task.id, title: task.title, state: task.state, priority: task.priority,
      disposition: taskDisposition(board, task),
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

export function projectStatusRows(board: TaskBoard, scope: readonly string[] | null) {
  const blockers = new Map(projectBlocked(board, scope).map((row) => [row.id, row.blockers]));
  return projectRows(board, scope, "all").map((row) => {
    const unresolved = blockers.get(row.id);
    return unresolved === undefined ? row : { ...row, blockers: unresolved };
  });
}

function relationIds(task: TaskDocument, relation: TaskRelation): readonly TaskId[] {
  return relation === "parent" ? task.parent === null ? [] : [task.parent] : task[relation];
}
export function relationProblem(board: TaskBoard, before: TaskDocument | null, after: TaskDocument): string | null {
  for (const relation of ["needs", "parent", "supersedes", "relates"] as const) {
    const previous = new Set(before === null ? [] : relationIds(before, relation));
    for (const target of relationIds(after, relation)) {
      if (previous.has(target)) continue;
      if (target === after.id) return `${after.id} has a self ${relation} relation`;
      if (!board.tasks.has(target)) return `${after.id} ${relation} target does not exist: ${target}`;
    }
  }
  return null;
}

function cycleComponents(board: TaskBoard, relation: "needs" | "parent" | "supersedes"): readonly (readonly TaskId[])[] {
  const ids = sorted([...board.tasks.keys()].map((id) => ({ id }))).map(({ id }) => id as TaskId);
  const edges = new Map(ids.map((id) => [id, relationIds(board.tasks.get(id)!, relation).filter((target) => board.tasks.has(target))]));
  const reverse = new Map(ids.map((id) => [id, [] as TaskId[]]));
  for (const [id, targets] of edges) for (const target of targets) reverse.get(target)!.push(id);

  const visited = new Set<TaskId>(), finished: TaskId[] = [];
  for (const root of ids) {
    if (visited.has(root)) continue;
    visited.add(root);
    const stack: { id: TaskId; index: number }[] = [{ id: root, index: 0 }];
    while (stack.length > 0) {
      const frame = stack.at(-1)!, targets = edges.get(frame.id)!;
      if (frame.index < targets.length) {
        const target = targets[frame.index++]!;
        if (!visited.has(target)) { visited.add(target); stack.push({ id: target, index: 0 }); }
      } else { finished.push(frame.id); stack.pop(); }
    }
  }

  const assigned = new Set<TaskId>(), components: TaskId[][] = [];
  for (const root of finished.reverse()) {
    if (assigned.has(root)) continue;
    const component: TaskId[] = [], stack = [root]; assigned.add(root);
    while (stack.length > 0) {
      const id = stack.pop()!; component.push(id);
      for (const target of reverse.get(id)!) if (!assigned.has(target)) { assigned.add(target); stack.push(target); }
    }
    if (component.length > 1) components.push(sorted(component.map((id) => ({ id }))).map(({ id }) => id as TaskId));
  }
  return components.sort((left, right) => Buffer.compare(Buffer.from(left.join("\0")), Buffer.from(right.join("\0"))));
}

export function diagnoseBoard(board: TaskBoard): readonly TaskDoctorIssue[] {
  const issues: TaskDoctorIssue[] = [];
  for (const task of sorted(board.tasks.values())) for (const relation of ["needs", "parent", "supersedes", "relates"] as const) {
    for (const target of relationIds(task, relation)) {
      if (target === task.id) issues.push({ kind: "self-relation", taskId: task.id, relation });
      else if (!board.tasks.has(target)) issues.push({ kind: "missing-target", taskId: task.id, relation, target });
    }
  }
  for (const relation of ["needs", "parent", "supersedes"] as const) {
    for (const tasks of cycleComponents(board, relation)) issues.push({ kind: "cycle", relation, tasks });
  }
  return issues;
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
