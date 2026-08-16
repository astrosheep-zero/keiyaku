import { resolve } from "node:path";
import { documentDiff } from "../markdown/diff.js";
import { readNamespaceContext } from "./context.js";
import { relationProblem, type TaskBoard } from "./board.js";
import { serializeTaskDocument, type TaskDocument, type TaskPriority } from "./document.js";
import { allocateLocalId, deriveLocalStem, formatTaskId, parseTaskId, sameNamespace, type TaskId } from "./identity.js";
import { authorityPath, readBoard, replaceAuthority, withTaskLocks } from "./store.js";
import type { WorldRoot } from "../world.js";
import type { TaskRefusal, TaskRetry } from "./operations.js";

type TaskDocumentChange = Readonly<{ taskId: TaskId; kind: "created" | "updated"; documentDiff: string }>;
export type TaskCompositionResult =
  | Readonly<{ kind: "accepted"; documentChanges: readonly TaskDocumentChange[] }>
  | Readonly<{ kind: "refused"; refusal: TaskRefusal }>
  | Readonly<{ kind: "incomplete"; documentChanges: readonly TaskDocumentChange[]; stopped: TaskRefusal | Readonly<{ kind: "retry"; reason: TaskRetry }>; draft: string }>;

type Assignment = Readonly<{ field: "parent" | "needs" | "supersedes" | "relates" | "pri" | "body"; append: boolean; value: string }>;
type SketchNode = Readonly<{ index: number; depth: number; kind: "new" | "existing"; title?: string; id?: TaskId; assignments: readonly Assignment[]; body?: string }>;
type Sketch = Readonly<{ namespace?: readonly string[]; nodes: readonly SketchNode[] }>;
type Planned = Readonly<{ node: SketchNode; before: TaskDocument | null; after: TaskDocument }>;

function failure(diagnostic: string): TaskRefusal { return { kind: "invalid-composition", diagnostic }; }
function parseNamespace(value: string): readonly string[] {
  if (value === "") return [];
  const coordinate = parseTaskId(`task/${value}/placeholder`); return coordinate.namespace;
}
function assignment(token: string): Assignment | null {
  const matched = /^(parent|needs|supersedes|relates|pri|body)(\+=|=)(.*)$/u.exec(token);
  if (matched === null) return null;
  const field = matched[1] as Assignment["field"], append = matched[2] === "+=", value = matched[3]!;
  if (append && (field === "parent" || field === "pri" || field === "body")) throw new TypeError(`${field} does not accept +=`);
  if (field === "body" && (append || value !== "")) throw new TypeError("body accepts only bare body=");
  return { field, append, value };
}
function parseNode(text: string, depth: number, index: number): SketchNode {
  const tokens = text.split(/ +/u);
  if (text.startsWith("+ ")) {
    const values = tokens.slice(1); const at = values.findIndex((token) => assignment(token) !== null);
    const title = values.slice(0, at < 0 ? values.length : at).join(" ");
    if (title.trim().length === 0) throw new TypeError("compose + node requires a title");
    return { index, depth, kind: "new", title, assignments: (at < 0 ? [] : values.slice(at)).map((token) => assignment(token) ?? (() => { throw new TypeError(`invalid assignment token: ${token}`); })()) };
  }
  const [rawId, ...rest] = tokens; if (rawId === undefined || !rawId.startsWith("@task/")) throw new TypeError("compose node must begin with + or @task/");
  const id = `task/${rawId.slice(1).slice(5)}` as TaskId; parseTaskId(id);
  return { index, depth, kind: "existing", id, assignments: rest.map((token) => assignment(token) ?? (() => { throw new TypeError(`invalid assignment token: ${token}`); })()) };
}

function parseSketch(markdown: string): Sketch | TaskRefusal {
  try {
    const lines = markdown.replace(/\r\n?/gu, "\n").split("\n"); let namespace: readonly string[] | undefined; let start = 0;
    if (lines[0]?.startsWith("ns=")) { namespace = parseNamespace(lines[0].slice(3)); start = 1; }
    const mutable: { node: SketchNode; body: string[] }[] = [];
    for (let line = start; line < lines.length; line += 1) {
      const raw = lines[line]!; if (line === lines.length - 1 && raw === "") continue;
      const leading = /^(?:\t| )*/u.exec(raw)![0]!.replace(/\t/gu, "  ");
      const text = raw.slice(/^(?:\t| )*/u.exec(raw)![0]!.length);
      const nodeLine = text.startsWith("+ ") || text.startsWith("@task/");
      if (nodeLine) {
        if (leading.length % 2 !== 0) throw new TypeError(`compose line ${line + 1} has invalid indentation`);
        const depth = leading.length / 2;
        if (depth > 0 && !mutable.some((entry) => entry.node.depth === depth - 1)) throw new TypeError(`compose line ${line + 1} skips a parent depth`);
        mutable.push({ node: parseNode(text, depth, mutable.length), body: [] }); continue;
      }
      const current = mutable.at(-1); if (current === undefined) { if (text.trim() === "") continue; throw new TypeError(`compose line ${line + 1} has body before a node`); }
      current.body.push(text.startsWith("\\") ? text.slice(1) : text);
    }
    const nodes = mutable.map(({ node, body }) => ({ ...node, ...(body.length === 0 ? {} : { body: body.join("\n") }) }));
    return { ...(namespace === undefined ? {} : { namespace }), nodes };
  } catch (error) { return failure(error instanceof Error ? error.message : String(error)); }
}

function ids(value: string): readonly TaskId[] {
  if (value === "") return [];
  const parsed = value.split(",").map((raw) => { if (!raw.startsWith("@task/")) throw new TypeError("relation values must be @TaskId"); const id = raw.slice(1) as TaskId; parseTaskId(id); return id; });
  if (new Set(parsed).size !== parsed.length) throw new TypeError("relation values must not contain duplicates");
  return parsed;
}
function scalarId(value: string): TaskId | null { const values = ids(value); if (values.length > 1) throw new TypeError("parent accepts at most one TaskId"); return values[0] ?? null; }
function changed(current: readonly TaskId[], value: readonly TaskId[], append: boolean): readonly TaskId[] {
  return append ? [...current, ...value.filter((id) => !current.includes(id))] : value;
}
function applyAssignments(document: TaskDocument, assignments: readonly Assignment[], body: string | undefined): TaskDocument {
  let next = document; const seen = new Set<string>();
  for (const item of assignments) {
    const mode = `${item.field}:${item.append}`; if (seen.has(mode) || [...seen].some((value) => value.startsWith(`${item.field}:`) && value !== mode)) throw new TypeError(`duplicate compose assignment: ${item.field}`);
    seen.add(mode);
    if (item.field === "pri") { const priority = Number(item.value); if (!Number.isInteger(priority) || priority < 0 || priority > 3) throw new TypeError("pri must be 0..3"); next = { ...next, priority: priority as TaskPriority }; }
    else if (item.field === "parent") next = { ...next, parent: scalarId(item.value) };
    else if (item.field === "body") next = { ...next, body: "" };
    else next = { ...next, [item.field]: changed(next[item.field], ids(item.value), item.append) };
  }
  return body === undefined ? next : { ...next, body };
}

function currentTimestamp(): string { return new Date().toISOString(); }
function advancedTimestamp(previous: string, current: string): string { return current > previous ? current : new Date(Date.parse(previous) + 1).toISOString(); }
function plan(sketch: Sketch, board: TaskBoard, defaultNamespace: readonly string[], at: string): readonly Planned[] | TaskRefusal {
  try {
    const namespace = sketch.namespace ?? defaultNamespace; const occupied = new Set([...board.tasks.values()].flatMap((task) => {
      const coordinate = parseTaskId(task.id);
      return sameNamespace(coordinate.namespace, namespace) ? [coordinate.localId] : [];
    }));
    const allocations = new Map<number, TaskDocument>();
    for (const node of sketch.nodes) if (node.kind === "new") {
      const localId = allocateLocalId(deriveLocalStem(node.title!), occupied); occupied.add(localId); const coordinate = { namespace, localId };
      allocations.set(node.index, { id: formatTaskId(coordinate), title: node.title!, state: "open", priority: 2, needs: [], parent: null, supersedes: [], relates: [], note: "", createdAt: at, updatedAt: at, body: "" });
    }
    const all = new Map(board.tasks); for (const allocated of allocations.values()) all.set(allocated.id, allocated);
    const byDepth: TaskId[] = [], addressed = new Set<TaskId>(); const planned: Planned[] = [];
    for (const node of sketch.nodes) {
      const before = node.kind === "new" ? null : board.tasks.get(node.id!) ?? null;
      let current = node.kind === "new" ? allocations.get(node.index)! : all.get(node.id!);
      if (current === undefined) throw new TypeError(`compose task does not exist: ${node.id}`);
      if (addressed.has(current.id)) throw new TypeError(`compose addresses ${current.id} more than once`);
      addressed.add(current.id);
      if (node.depth > 0) {
        const parent = byDepth[node.depth - 1]; if (parent === undefined) throw new TypeError("compose parent is unavailable");
        if (node.assignments.some((item) => item.field === "parent")) throw new TypeError("indented node cannot also assign parent");
        current = { ...current, parent };
      }
      current = applyAssignments(current, node.assignments, node.body);
      if (before !== null && !Buffer.from(serializeTaskDocument(current)).equals(Buffer.from(serializeTaskDocument(before)))) current = { ...current, updatedAt: advancedTimestamp(before.updatedAt, at) };
      byDepth[node.depth] = current.id; byDepth.length = node.depth + 1;
      all.set(current.id, current); planned.push({ node, before, after: current });
    }
    for (const item of planned) {
      const problem = relationProblem({ tasks: all }, item.before, item.after);
      if (problem !== null) return failure(problem);
    }
    return planned;
  } catch (error) { return failure(error instanceof Error ? error.message : String(error)); }
}

function ref(id: TaskId): string { return `@${id}`; }
function bodyLines(body: string): readonly string[] { return body.split("\n").map((line) => /^[\\]|^\+ |^@task\//u.test(line) ? `\\${line}` : line); }
function draft(namespace: readonly string[], remaining: readonly Planned[]): string {
  const lines = [`ns=${namespace.join("/")}`];
  for (const item of remaining) {
    const task = item.after; const assignments = [
      `pri=${task.priority}`, `needs=${task.needs.map(ref).join(",")}`, `parent=${task.parent === null ? "" : ref(task.parent)}`,
      `supersedes=${task.supersedes.map(ref).join(",")}`, `relates=${task.relates.map(ref).join(",")}`,
    ];
    lines.push(`${item.node.kind === "new" ? `+ ${task.title}` : ref(task.id)} ${assignments.join(" ")}${task.body === "" ? " body=" : ""}`);
    if (task.body !== "") lines.push(...bodyLines(task.body));
  }
  return `${lines.join("\n")}\n`;
}

export async function composeTasks(world: WorldRoot, markdown: string, signal?: AbortSignal): Promise<TaskCompositionResult> {
  const sketch = parseSketch(markdown); if ("kind" in sketch) return { kind: "refused", refusal: sketch };
  const at = currentTimestamp();
  const context = sketch.namespace ?? await readNamespaceContext(world);
  if (context === "malformed") return { kind: "refused", refusal: { kind: "invalid-namespace-context", path: resolve(world, ".keiyaku", "namespace", "current") } };
  const namespace = context === "absent" ? [] : context;
  const initial = await readBoard(world); const planned = plan(sketch, initial.board, namespace, at); if ("kind" in planned) return { kind: "refused", refusal: planned };
  const ordered = [...planned].sort((a, b) => Buffer.compare(Buffer.from(a.after.id), Buffer.from(b.after.id)));
  const allocation = sketch.nodes.some((node) => node.kind === "new");
  const result = await withTaskLocks({ world, allocation, ids: ordered.map((item) => item.after.id), ...(signal === undefined ? {} : { signal }) }, async (): Promise<TaskCompositionResult> => {
    const fresh = await readBoard(world); const replanned = plan(sketch, fresh.board, namespace, at); if ("kind" in replanned) return { kind: "refused", refusal: replanned };
    const queue = [...replanned].sort((a, b) => Buffer.compare(Buffer.from(a.after.id), Buffer.from(b.after.id))), changes: TaskDocumentChange[] = [];
    for (let index = 0; index < queue.length; index += 1) {
      signal?.throwIfAborted(); const item = queue[index]!, path = authorityPath(world, item.after.id);
      const beforeBytes = item.before === null ? null : fresh.bytes.get(item.after.id) ?? null; const afterBytes = serializeTaskDocument(item.after);
      const before = beforeBytes === null ? "" : Buffer.from(beforeBytes).toString("utf8"), after = Buffer.from(afterBytes).toString("utf8");
      if (before === after) continue;
      if (await replaceAuthority({ path, expected: beforeBytes, next: afterBytes }) !== "replaced") return {
        kind: "incomplete", documentChanges: changes, stopped: { kind: "retry", reason: "concurrent-modification" }, draft: draft(namespace, queue.slice(index)),
      };
      const label = `${item.after.id}.md`;
      changes.push({ taskId: item.after.id, kind: item.before === null ? "created" : "updated", documentDiff: documentDiff(label, label, before, after) });
    }
    return { kind: "accepted", documentChanges: changes };
  });
  return result === "busy" ? { kind: "incomplete", documentChanges: [], stopped: { kind: "retry", reason: "busy" }, draft: draft(namespace, ordered) } : result;
}
