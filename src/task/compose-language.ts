import type { TaskBoard } from "./board.js";
import { serializeTaskDocument, type TaskDocument, type TaskPriority } from "./document.js";
import { allocateLocalId, deriveLocalStem, formatTaskId, parseTaskId, sameNamespace, type TaskId } from "./identity.js";
import { parseTaskComposition, type Assignment, type ParsedComposition, type ParsedNode } from "./compose-parser.js";
import { advanceTaskTimestamp, type TaskCompositionDiagnostic } from "./operations.js";

export function taskCompositionNamespaceHeader(markdown: string): Readonly<{
  specified: boolean;
  namespace?: readonly string[];
}> {
  const parsed = parseTaskComposition(markdown);
  return {
    specified: parsed.namespaceSpecified,
    ...(parsed.namespace === undefined ? {} : { namespace: parsed.namespace }),
  };
}

export type TaskCompositionAlias = Readonly<{ alias: string; taskId: TaskId }>;
export type TaskCompositionBodyPreview = Readonly<{
  taskId: TaskId;
  bytes: number;
  firstLine: string;
  lastLine: string;
}>;
export type PlannedTask = Readonly<{
  index: number;
  line: number;
  kind: "new" | "existing";
  alias?: string;
  before: TaskDocument | null;
  after: TaskDocument;
}>;
export type TaskCompositionPlan = Readonly<{
  namespace: readonly string[];
  aliases: readonly TaskCompositionAlias[];
  admissionOrder: readonly TaskId[];
  bodies: readonly TaskCompositionBodyPreview[];
  tasks: readonly PlannedTask[];
}>;
export type TaskCompositionPlanning =
  | Readonly<{ kind: "planned"; plan: TaskCompositionPlan }>
  | Readonly<{ kind: "refused"; diagnostics: readonly TaskCompositionDiagnostic[] }>;

function diagnostic(line: number, reason: string, token: string): TaskCompositionDiagnostic {
  return { line, reason, token };
}

function occupied(board: TaskBoard, namespace: readonly string[]): Set<string> {
  return new Set(
    [...board.tasks.values()].flatMap((task) => {
      const coordinate = parseTaskId(task.id);
      return sameNamespace(coordinate.namespace, namespace) ? [coordinate.localId] : [];
    }),
  );
}

function createdTask(id: TaskId, title: string, at: string, actor?: string): TaskDocument {
  return {
    id,
    title,
    state: "open",
    priority: 2,
    needs: [],
    parent: null,
    supersedes: [],
    relates: [],
    note: "",
    ...(actor === undefined ? {} : { createdBy: actor }),
    createdAt: at,
    updatedAt: at,
    body: "",
  };
}

function aliasFor(node: ParsedNode): Assignment | undefined {
  return node.assignments.find((item) => item.field === "as");
}

function allocateNodes(
  input: Readonly<{
    parsed: ParsedComposition;
    board: TaskBoard;
    namespace: readonly string[];
    at: string;
    actor?: string;
  }>,
  diagnostics: TaskCompositionDiagnostic[],
): ReadonlyMap<number, TaskDocument> {
  const ids = occupied(input.board, input.namespace);
  const allocations = new Map<number, TaskDocument>();
  for (const node of input.parsed.nodes) {
    if (node.kind !== "new") continue;
    try {
      const localId = allocateLocalId(deriveLocalStem(node.title!), ids);
      ids.add(localId);
      const id = formatTaskId({ namespace: input.namespace, localId });
      allocations.set(node.index, createdTask(id, node.title!, input.at, input.actor));
    } catch (error) {
      diagnostics.push(diagnostic(node.line, error instanceof Error ? error.message : String(error), node.title!));
    }
  }
  return allocations;
}

function collectAliases(
  nodes: readonly ParsedNode[],
  allocations: ReadonlyMap<number, TaskDocument>,
  diagnostics: TaskCompositionDiagnostic[],
): ReadonlyMap<string, TaskId> {
  const aliases = new Map<string, TaskId>();
  for (const node of nodes) {
    const declarations = node.assignments.filter((item) => item.field === "as");
    for (const duplicate of declarations.slice(1)) {
      diagnostics.push(diagnostic(duplicate.line, "alias is assigned more than once", duplicate.token));
    }
    const declaration = declarations[0];
    if (declaration === undefined) continue;
    if (node.kind !== "new") {
      diagnostics.push(diagnostic(declaration.line, "only a new task may declare an alias", declaration.token));
      continue;
    }
    if (declaration.operator !== "=" || !/^[a-z0-9-]+$/u.test(declaration.value)) {
      diagnostics.push(diagnostic(declaration.line, "alias must use as = [a-z0-9-]+", declaration.token));
      continue;
    }
    if (aliases.has(declaration.value)) {
      diagnostics.push(diagnostic(declaration.line, "alias must be unique in the composition", declaration.value));
      continue;
    }
    const allocated = allocations.get(node.index);
    if (allocated !== undefined) aliases.set(declaration.value, allocated.id);
  }
  return aliases;
}

function resolveReference(
  raw: string,
  line: number,
  board: TaskBoard,
  aliases: ReadonlyMap<string, TaskId>,
  diagnostics: TaskCompositionDiagnostic[],
): TaskId | undefined {
  if (raw.startsWith("^")) {
    const alias = raw.slice(1);
    const resolved = aliases.get(alias);
    if (resolved === undefined) diagnostics.push(diagnostic(line, "new-task alias is not declared", raw));
    return resolved;
  }
  if (!raw.startsWith("@task/")) {
    diagnostics.push(diagnostic(line, "reference must be @task/... or ^alias", raw));
    return undefined;
  }
  try {
    const id = raw.slice(1) as TaskId;
    parseTaskId(id);
    if (!board.tasks.has(id)) diagnostics.push(diagnostic(line, "@ reference must name a pre-existing task", raw));
    return board.tasks.has(id) ? id : undefined;
  } catch (error) {
    diagnostics.push(diagnostic(line, error instanceof Error ? error.message : String(error), raw));
    return undefined;
  }
}

function referenceList(
  assignment: Assignment,
  board: TaskBoard,
  aliases: ReadonlyMap<string, TaskId>,
  diagnostics: TaskCompositionDiagnostic[],
): readonly TaskId[] | undefined {
  if (assignment.value === "") return [];
  const raw = assignment.value.split(",").map((item) => item.trim());
  if (raw.some((item) => item.length === 0)) {
    diagnostics.push(diagnostic(assignment.line, "reference list contains an empty item", assignment.token));
    return undefined;
  }
  const resolved = raw.map((item) => resolveReference(item, assignment.line, board, aliases, diagnostics));
  if (resolved.some((item) => item === undefined)) return undefined;
  const ids = resolved as readonly TaskId[];
  if (new Set(ids).size !== ids.length) {
    diagnostics.push(diagnostic(assignment.line, "reference list contains a duplicate", assignment.token));
    return undefined;
  }
  return ids;
}

function patchRelation(
  current: readonly TaskId[],
  assignment: Assignment,
  values: readonly TaskId[],
  diagnostics: TaskCompositionDiagnostic[],
): readonly TaskId[] {
  if (assignment.operator === "=") return values;
  if (assignment.operator === "+=") return [...current, ...values.filter((id) => !current.includes(id))];
  const missing = values.filter((id) => !current.includes(id));
  for (const id of missing) diagnostics.push(diagnostic(assignment.line, "cannot remove an absent relation", `@${id}`));
  return missing.length === 0 ? current.filter((id) => !values.includes(id)) : current;
}

function applyAssignments(
  node: ParsedNode,
  base: TaskDocument,
  board: TaskBoard,
  aliases: ReadonlyMap<string, TaskId>,
  diagnostics: TaskCompositionDiagnostic[],
): TaskDocument {
  let next = base;
  const scalar = new Set<string>();
  for (const assignment of node.assignments) {
    if (assignment.field === "as") continue;
    if (assignment.field === "pri" || assignment.field === "parent") {
      if (scalar.has(assignment.field)) {
        diagnostics.push(
          diagnostic(assignment.line, `${assignment.field} is assigned more than once`, assignment.token),
        );
      }
      scalar.add(assignment.field);
    }
    if (assignment.field === "pri") {
      if (assignment.operator !== "=" || !/^[0-3]$/u.test(assignment.value)) {
        diagnostics.push(diagnostic(assignment.line, "pri must use = with a value from 0 through 3", assignment.token));
      } else next = { ...next, priority: Number(assignment.value) as TaskPriority };
      continue;
    }
    if (assignment.field === "parent") {
      if (assignment.operator !== "=") {
        diagnostics.push(diagnostic(assignment.line, "parent accepts only =", assignment.token));
      } else if (assignment.value === "") next = { ...next, parent: null };
      else {
        const id = resolveReference(assignment.value.trim(), assignment.line, board, aliases, diagnostics);
        if (id !== undefined) next = { ...next, parent: id };
      }
      continue;
    }
    const values = referenceList(assignment, board, aliases, diagnostics);
    if (values === undefined) continue;
    if (assignment.operator !== "=" && values.length === 0) {
      diagnostics.push(
        diagnostic(assignment.line, `${assignment.operator} requires at least one reference`, assignment.token),
      );
      continue;
    }
    next = { ...next, [assignment.field]: patchRelation(next[assignment.field], assignment, values, diagnostics) };
  }
  if (node.body !== undefined) next = { ...next, body: node.body.value };
  for (const field of ["needs", "supersedes", "relates"] as const) {
    if (next[field].includes(next.id))
      diagnostics.push(diagnostic(node.line, `${field} cannot reference the task itself`, next.id));
  }
  if (next.parent === next.id)
    diagnostics.push(diagnostic(node.line, "parent cannot reference the task itself", next.id));
  return next;
}

function relationTargets(document: TaskDocument, relation: "needs" | "parent"): readonly TaskId[] {
  return relation === "needs" ? document.needs : document.parent === null ? [] : [document.parent];
}

function pathExists(board: TaskBoard, start: TaskId, goal: TaskId, relation: "needs" | "parent"): boolean {
  const seen = new Set<TaskId>();
  const pending = [start];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (id === goal) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const task = board.tasks.get(id);
    if (task !== undefined) pending.push(...relationTargets(task, relation));
  }
  return false;
}

function diagnoseIntroducedCycles(
  after: TaskBoard,
  tasks: readonly PlannedTask[],
  diagnostics: TaskCompositionDiagnostic[],
): void {
  for (const task of tasks) {
    for (const relation of ["needs", "parent"] as const) {
      const old = task.before === null ? [] : relationTargets(task.before, relation);
      for (const target of relationTargets(task.after, relation)) {
        if (!old.includes(target) && pathExists(after, target, task.after.id, relation)) {
          diagnostics.push(diagnostic(task.line, `${relation} edge creates a cycle`, `${task.after.id} -> ${target}`));
        }
      }
    }
  }
}

function changed(task: PlannedTask): boolean {
  return (
    task.before === null ||
    !Buffer.from(serializeTaskDocument(task.before)).equals(Buffer.from(serializeTaskDocument(task.after)))
  );
}

function stableAdmissionOrder(
  tasks: readonly PlannedTask[],
  diagnostics: TaskCompositionDiagnostic[],
): readonly PlannedTask[] {
  const candidates = tasks.filter(changed);
  const byId = new Map(candidates.map((task) => [task.after.id, task]));
  const dependencies = new Map(candidates.map((task) => [task.after.id, new Set<TaskId>()]));
  for (const task of candidates) {
    const targets = [...task.after.needs, ...(task.after.parent === null ? [] : [task.after.parent])];
    for (const target of targets) {
      const plannedTarget = byId.get(target);
      if (plannedTarget?.before === null) dependencies.get(task.after.id)!.add(target);
    }
  }
  const remaining = new Set(candidates.map((task) => task.after.id));
  const ordered: PlannedTask[] = [];
  while (remaining.size > 0) {
    const ready = candidates.find(
      (task) => remaining.has(task.after.id) && [...dependencies.get(task.after.id)!].every((id) => !remaining.has(id)),
    );
    if (ready === undefined) {
      const first = candidates.find((task) => remaining.has(task.after.id))!;
      diagnostics.push(diagnostic(first.line, "needs and parent references create an admission cycle", first.after.id));
      return [];
    }
    remaining.delete(ready.after.id);
    ordered.push(ready);
  }
  return ordered;
}

function bodyPreview(node: ParsedNode, id: TaskId): TaskCompositionBodyPreview | null {
  if (node.body?.kind !== "replace") return null;
  const lines = node.body.value.split(/\r\n|\n|\r/u);
  return {
    taskId: id,
    bytes: Buffer.byteLength(node.body.value),
    firstLine: lines[0] ?? "",
    lastLine: lines.at(-1) ?? "",
  };
}

export function planTaskComposition(
  input: Readonly<{
    markdown: string;
    board: TaskBoard;
    namespace: readonly string[];
    at: string;
    actor?: string;
  }>,
): TaskCompositionPlanning {
  const parsed = parseTaskComposition(input.markdown);
  const diagnostics = [...parsed.diagnostics];
  const namespace = parsed.namespace ?? input.namespace;
  const allocationInput = {
    parsed,
    board: input.board,
    namespace,
    at: input.at,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
  };
  const allocations = allocateNodes(allocationInput, diagnostics);
  const aliases = collectAliases(parsed.nodes, allocations, diagnostics);
  const addressed = new Set<TaskId>();
  const tasks: PlannedTask[] = [];
  for (const node of parsed.nodes) {
    const before = node.kind === "new" ? null : (input.board.tasks.get(node.id!) ?? null);
    const base = node.kind === "new" ? allocations.get(node.index) : before;
    if (base === null || base === undefined) {
      diagnostics.push(diagnostic(node.line, "existing task does not exist before composition", `@${node.id}`));
      continue;
    }
    if (addressed.has(base.id)) {
      diagnostics.push(diagnostic(node.line, "task is addressed more than once", base.id));
      continue;
    }
    addressed.add(base.id);
    let after = applyAssignments(node, base, input.board, aliases, diagnostics);
    if (before !== null && changed({ index: node.index, line: node.line, kind: node.kind, before, after })) {
      after = { ...after, updatedAt: advanceTaskTimestamp(before.updatedAt, input.at) };
    }
    tasks.push({
      index: node.index,
      line: node.line,
      kind: node.kind,
      ...(aliasFor(node) === undefined ? {} : { alias: aliasFor(node)!.value }),
      before,
      after,
    });
  }
  const post = new Map(input.board.tasks);
  for (const task of tasks) post.set(task.after.id, task.after);
  diagnoseIntroducedCycles({ tasks: post }, tasks, diagnostics);
  const ordered = stableAdmissionOrder(tasks, diagnostics);
  if (diagnostics.length > 0) return { kind: "refused", diagnostics };
  const aliasBindings = [...aliases].map(([alias, taskId]) => ({ alias, taskId }));
  const bodies = parsed.nodes.flatMap((node) => {
    const task = tasks.find((candidate) => candidate.index === node.index);
    if (task === undefined) return [];
    const preview = bodyPreview(node, task.after.id);
    return preview === null ? [] : [preview];
  });
  return {
    kind: "planned",
    plan: {
      namespace,
      aliases: aliasBindings,
      admissionOrder: ordered.map((task) => task.after.id),
      bodies,
      tasks: ordered,
    },
  };
}
