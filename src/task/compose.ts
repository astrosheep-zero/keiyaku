import { documentDiff } from "../markdown/diff.js";
import type { WorldRoot } from "../world.js";
import {
  planTaskComposition,
  type PlannedTask,
  type TaskCompositionAlias,
  type TaskCompositionBodyPreview,
  type TaskCompositionPlan,
} from "./compose-language.js";
import { serializeTaskDocument } from "./document.js";
import type { TaskId } from "./identity.js";
import type { TaskCompositionDiagnostic, TaskRefusal, TaskRetry } from "./operations.js";
import { authorityPath, readBoard, replaceAuthority, withTaskLocks } from "./store.js";

export type { TaskCompositionAlias, TaskCompositionBodyPreview } from "./compose-language.js";
export { taskCompositionNamespaceHeader } from "./compose-language.js";

export type TaskDocumentChange = Readonly<{
  taskId: TaskId;
  kind: "created" | "updated";
  documentDiff: string;
}>;
export type TaskCompositionFacts = Readonly<{
  aliases: readonly TaskCompositionAlias[];
  admissionOrder: readonly TaskId[];
}>;
export type TaskCompositionResult =
  | Readonly<{
      kind: "planned";
      aliases: readonly TaskCompositionAlias[];
      admissionOrder: readonly TaskId[];
      bodies: readonly TaskCompositionBodyPreview[];
    }>
  | Readonly<{ kind: "accepted"; documentChanges: readonly TaskDocumentChange[] } & TaskCompositionFacts>
  | Readonly<{ kind: "refused"; refusal: Extract<TaskRefusal, { kind: "invalid-composition" }> }>
  | (Readonly<{
      kind: "incomplete";
      documentChanges: readonly TaskDocumentChange[];
      stopped: TaskRefusal | Readonly<{ kind: "retry"; reason: TaskRetry }>;
      draft: string;
    }> &
      TaskCompositionFacts);

function refusal(
  diagnostics: readonly TaskCompositionDiagnostic[],
): Extract<TaskCompositionResult, { kind: "refused" }> {
  return { kind: "refused", refusal: { kind: "invalid-composition", diagnostics } };
}

function currentTimestamp(): string {
  return new Date().toISOString();
}

function facts(plan: TaskCompositionPlan): TaskCompositionFacts {
  return { aliases: plan.aliases, admissionOrder: plan.admissionOrder };
}

function reference(id: TaskId, remainingAliases: ReadonlyMap<TaskId, string>): string {
  const alias = remainingAliases.get(id);
  return alias === undefined ? `@${id}` : `^${alias}`;
}

function bodyToken(body: string): string {
  const lines = new Set(body.split(/\r\n|\n|\r/u));
  for (let suffix = 0; Number.isSafeInteger(suffix); suffix += 1) {
    const token = suffix === 0 ? "END_BODY" : `END_BODY_${suffix}`;
    if (token.length > 32) break;
    if (!lines.has(token)) return token;
  }
  throw new Error("compose recovery body token space exhausted");
}

function taskDraft(task: PlannedTask, remainingAliases: ReadonlyMap<TaskId, string>): readonly string[] {
  const document = task.after;
  const lines = [task.kind === "new" ? `+ ${document.title}` : `@${document.id}`];
  if (task.kind === "new" && task.alias !== undefined) lines.push(`as = ${task.alias}`);
  if (task.kind === "new") lines.push(`state = ${document.state}`);
  lines.push(
    `pri = ${document.priority}`,
    `needs = ${document.needs.map((id) => reference(id, remainingAliases)).join(", ")}`,
    `parent = ${document.parent === null ? "" : reference(document.parent, remainingAliases)}`,
    `supersedes = ${document.supersedes.map((id) => reference(id, remainingAliases)).join(", ")}`,
    `relates = ${document.relates.map((id) => reference(id, remainingAliases)).join(", ")}`,
  );
  if (document.body === "") lines.push("body =");
  else {
    const token = bodyToken(document.body);
    lines.push(`body <<${token}`, document.body, token);
  }
  return lines;
}

function recoveryDraft(namespace: readonly string[], remaining: readonly PlannedTask[]): string {
  const aliases = new Map<TaskId, string>();
  for (const task of remaining) {
    if (task.kind === "new" && task.alias !== undefined) aliases.set(task.after.id, task.alias);
  }
  const lines = [`ns=${namespace.length === 0 ? "/" : namespace.join("/")}`];
  for (const task of remaining) lines.push("", ...taskDraft(task, aliases));
  return `${lines.join("\n")}\n`;
}

function plannedResult(plan: TaskCompositionPlan): Extract<TaskCompositionResult, { kind: "planned" }> {
  return { kind: "planned", ...facts(plan), bodies: plan.bodies };
}

function planAgainst(
  markdown: string,
  board: Awaited<ReturnType<typeof readBoard>>["board"],
  namespace: readonly string[],
  at: string,
  actor?: string,
) {
  return planTaskComposition({ markdown, board, namespace, at, ...(actor === undefined ? {} : { actor }) });
}

async function admitPlan(
  world: WorldRoot,
  snapshot: Awaited<ReturnType<typeof readBoard>>,
  plan: TaskCompositionPlan,
  signal?: AbortSignal,
): Promise<TaskCompositionResult> {
  const changes: TaskDocumentChange[] = [];
  for (let index = 0; index < plan.tasks.length; index += 1) {
    signal?.throwIfAborted();
    const item = plan.tasks[index]!;
    const beforeBytes = item.before === null ? null : (snapshot.bytes.get(item.after.id) ?? null);
    const afterBytes = serializeTaskDocument(item.after);
    const before = beforeBytes === null ? "" : Buffer.from(beforeBytes).toString("utf8");
    const after = Buffer.from(afterBytes).toString("utf8");
    const replaced = await replaceAuthority({
      path: authorityPath(world, item.after.id),
      expected: beforeBytes,
      next: afterBytes,
    });
    if (replaced !== "replaced") {
      return {
        kind: "incomplete",
        ...facts(plan),
        documentChanges: changes,
        stopped: { kind: "retry", reason: "concurrent-modification" },
        draft: recoveryDraft(plan.namespace, plan.tasks.slice(index)),
      };
    }
    const label = `${item.after.id}.md`;
    changes.push({
      taskId: item.after.id,
      kind: item.before === null ? "created" : "updated",
      documentDiff: documentDiff(label, label, before, after),
    });
  }
  return { kind: "accepted", ...facts(plan), documentChanges: changes };
}

type ComposeInput = Readonly<{
  world: WorldRoot;
  markdown: string;
  namespace: readonly string[];
  at: string;
  actor?: string;
  signal?: AbortSignal;
}>;

async function composeUnderLocks(input: ComposeInput): Promise<TaskCompositionResult | "busy"> {
  const snapshot = await readBoard(input.world);
  const planned = planAgainst(input.markdown, snapshot.board, input.namespace, input.at, input.actor);
  if (planned.kind === "refused") return refusal(planned.diagnostics);
  return await withTaskLocks(
    {
      world: input.world,
      allocation: false,
      ids: planned.plan.admissionOrder,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
    async () => {
      const fresh = await readBoard(input.world);
      const replanned = planAgainst(input.markdown, fresh.board, input.namespace, input.at, input.actor);
      if (replanned.kind === "refused") return refusal(replanned.diagnostics);
      return await admitPlan(input.world, fresh, replanned.plan, input.signal);
    },
  );
}

function composeInput(input: ComposeInput): ComposeInput {
  return input;
}

export async function composeTasks(
  input: Readonly<{
    world: WorldRoot;
    markdown: string;
    signal?: AbortSignal;
    actor?: string;
    defaultNamespace?: readonly string[];
    planOnly?: boolean;
  }>,
): Promise<TaskCompositionResult> {
  const { world, markdown, signal, actor, defaultNamespace = [], planOnly = false } = input;
  const at = currentTimestamp();
  const initial = await readBoard(world);
  const initialPlan = planAgainst(markdown, initial.board, defaultNamespace, at, actor);
  if (initialPlan.kind === "refused") return refusal(initialPlan.diagnostics);
  if (planOnly) return plannedResult(initialPlan.plan);
  const request = composeInput({
    world,
    markdown,
    namespace: defaultNamespace,
    at,
    ...(actor === undefined ? {} : { actor }),
    ...(signal === undefined ? {} : { signal }),
  });
  const allocation = initialPlan.plan.tasks.some((task) => task.kind === "new");
  const admitted = allocation
    ? await withTaskLocks(
        { world, allocation: true, ids: [], ...(signal === undefined ? {} : { signal }) },
        async () => await composeUnderLocks(request),
      )
    : await composeUnderLocks(request);
  if (admitted !== "busy") return admitted;
  return {
    kind: "incomplete",
    ...facts(initialPlan.plan),
    documentChanges: [],
    stopped: { kind: "retry", reason: "busy" },
    draft: recoveryDraft(initialPlan.plan.namespace, initialPlan.plan.tasks),
  };
}
