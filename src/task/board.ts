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
export type TaskTreeNode = Readonly<{
  task: TaskRef & Readonly<{ priority: TaskPriority | null }>;
  cycle?: true;
  children: readonly TaskTreeNode[];
}>;
export type TaskBoard = Readonly<{ tasks: ReadonlyMap<TaskId, TaskDocument> }>;
type TaskRelation = "needs" | "parent" | "supersedes" | "relates";
export type TaskDoctorIssue =
  | Readonly<{ kind: "missing-target"; taskId: TaskId; relation: TaskRelation; target: TaskId }>
  | Readonly<{ kind: "self-relation"; taskId: TaskId; relation: TaskRelation }>
  | Readonly<{ kind: "cycle"; relation: "needs" | "parent" | "supersedes"; tasks: readonly TaskId[] }>;

const terminal = (state: TaskState): boolean => state === "done" || state === "drop";
const none: readonly TaskRef[] = Object.freeze([]);
const sorted = <T extends { id: string }>(values: Iterable<T>): readonly T[] => [...values].sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
export function taskRef(board: TaskBoard, id: TaskId): TaskRef {
  const task = board.tasks.get(id);
  return task === undefined ? { id, title: null, state: "missing" } : { id, title: task.title, state: task.state };
}
function append(index: Map<TaskId, TaskId[]>, key: TaskId, value: TaskId): void {
  const values = index.get(key);
  if (values === undefined) index.set(key, [value]);
  else values.push(value);
}
function freezeRefs(
  board: TaskBoard,
  index: ReadonlyMap<TaskId, readonly TaskId[]>,
): ReadonlyMap<TaskId, readonly TaskRef[]> {
  return new Map([...index].map(([id, targets]) => [id, sorted(targets.map((target) => taskRef(board, target)))]));
}
export type TaskRelationProjection = Readonly<{
  children(id: TaskId): readonly TaskRef[];
  blocks(id: TaskId): readonly TaskRef[];
  supersededBy(id: TaskId): readonly TaskRef[];
  related(id: TaskId): readonly TaskRef[];
}>;
export function createTaskRelations(board: TaskBoard): TaskRelationProjection {
  const children = new Map<TaskId, TaskId[]>();
  const blocks = new Map<TaskId, TaskId[]>();
  const supersededBy = new Map<TaskId, TaskId[]>();
  const incoming = new Map<TaskId, TaskId[]>();
  for (const task of board.tasks.values()) {
    if (task.parent !== null) append(children, task.parent, task.id);
    for (const need of task.needs) append(blocks, need, task.id);
    for (const target of task.supersedes) append(supersededBy, target, task.id);
    for (const target of task.relates) append(incoming, target, task.id);
  }
  const childRefs = freezeRefs(board, children);
  const blockRefs = freezeRefs(board, blocks);
  const successorRefs = freezeRefs(board, supersededBy);
  const incomingRefs = freezeRefs(board, incoming);
  return {
    children: (id) => childRefs.get(id) ?? none,
    blocks: (id) => blockRefs.get(id) ?? none,
    supersededBy: (id) => successorRefs.get(id) ?? none,
    related: (id) => {
      const task = board.tasks.get(id);
      const ids = new Set<TaskId>(task?.relates ?? []);
      for (const ref of incomingRefs.get(id) ?? none) ids.add(ref.id);
      return ids.size === 0 ? none : sorted([...ids].map((related) => taskRef(board, related)));
    },
  };
}
function needReleased(board: TaskBoard, id: TaskId): boolean {
  const target = board.tasks.get(id);
  return target !== undefined && terminal(target.state);
}
function hasUnresolvedNeeds(board: TaskBoard, task: TaskDocument): boolean {
  return task.needs.some((id) => !needReleased(board, id));
}
export function taskDisposition(board: TaskBoard, task: TaskDocument): TaskDisposition {
  if (task.state !== "open") return task.state;
  return hasUnresolvedNeeds(board, task) ? "blocked" : "ready";
}
export function taskBlocked(board: TaskBoard, task: TaskDocument): boolean {
  return (task.state === "open" || task.state === "in_progress") && hasUnresolvedNeeds(board, task);
}
export function projectDetailFacts(
  board: TaskBoard,
  id: TaskId,
  relations: TaskRelationProjection,
): TaskDetailFacts | null {
  const task = board.tasks.get(id); if (task === undefined) return null;
  const needs = task.needs.map((need) => ({ ...taskRef(board, need), released: needReleased(board, need) }));
  return {
    task,
    needs,
    blockers: needs.filter((need) => !need.released).map(({ released: _released, ...ref }) => ref),
    blocks: relations.blocks(id),
    parent: task.parent === null ? null : taskRef(board, task.parent), children: relations.children(id),
    supersedes: task.supersedes.map((target) => taskRef(board, target)), supersededBy: relations.supersededBy(id),
    related: relations.related(id),
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
export function projectBlocked(
  board: TaskBoard,
  scope: readonly string[] | null,
  relations: TaskRelationProjection,
): readonly BlockedTaskRow[] {
  return projectRows(board, scope, "active").flatMap((row) => {
    if (!taskBlocked(board, board.tasks.get(row.id)!)) return [];
    return [{ ...row, blockers: projectDetailFacts(board, row.id, relations)!.blockers }];
  });
}

export function projectStatusRows(board: TaskBoard, scope: readonly string[] | null) {
  const relations = createTaskRelations(board);
  const blockers = new Map(projectBlocked(board, scope, relations).map((row) => [row.id, row.blockers]));
  return projectRows(board, scope, "all").map((row) => {
    const unresolved = blockers.get(row.id);
    return unresolved === undefined ? row : { ...row, blockers: unresolved };
  });
}

export type TaskBoardObservation = Readonly<{
  statusRows: ReturnType<typeof projectStatusRows>;
  selectNamespace(namespace: readonly string[]): readonly TaskRow[];
  selectCreatedBy(createdBy: string): readonly TaskRow[];
}>;

export function projectTaskBoardObservation(board: TaskBoard): TaskBoardObservation {
  const rows = projectRows(board, null, "all");
  return {
    statusRows: projectStatusRows(board, null),
    selectNamespace: (namespace) => projectRows(board, namespace, "all"),
    selectCreatedBy: (createdBy) => rows.filter((row) => board.tasks.get(row.id)?.createdBy === createdBy),
  };
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

export function buildTree(board: TaskBoard, root: TaskId, relations: TaskRelationProjection): TaskTreeNode | null {
  if (!board.tasks.has(root)) return null;
  const walk = (id: TaskId, path: readonly TaskId[]): TaskTreeNode => {
    const ref = taskRef(board, id);
    const task = board.tasks.get(id);
    const node = { task: { ...ref, priority: task?.priority ?? null } };
    if (path.includes(id)) return { ...node, cycle: true, children: [] };
    return { ...node, children: relations.children(id).map((child) => walk(child.id, [...path, id])) };
  };
  return walk(root, []);
}
