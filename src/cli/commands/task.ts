import { CliUsageError, isBlankInput } from "../usage.js";
import { parseTaskNamespaceSelector } from "../../task/catalog.js";
import type { ParsedTaskCommand } from "./task-grammar.js";
import {
  Tasks,
  taskRowViewLimit,
  tasksWithExecution,
  type TaskBatchResult,
  type TaskDetail,
  type TaskId,
  type TaskMutationResult,
  type TaskPriority,
  type TaskQuerySort,
  type TaskState,
  type TaskCompositionResult,
  type TaskUpdateResult,
} from "../../task/index.js";
import { taskCompositionNamespaceHeader } from "../../task/compose-language.js";
import { resolveTaskNamespaceContext, writeTaskNamespaceContext } from "../../task/context.js";
import { displayContext, writeJson, writeStderr, writeStdout } from "../streams.js";
import type { CliRuntime } from "../runtime.js";
import type { CliCoordinates } from "../coordinates.js";
import {
  renderTaskCompose,
  renderTaskContext,
  renderTaskDoctor,
  renderTaskFailure,
  renderTaskIncompleteDiagnostic,
  renderTaskLifecycle,
  renderTaskList,
  renderTaskMutation,
  renderTaskShow,
  renderTaskTree,
  renderTaskUpdate,
  taskExitCode,
  type TaskListScope,
  type TaskShowResult,
} from "../render/task.js";
import { actorFromEdge } from "../actor.js";
import type { TaskQueryExpression } from "./task-query.js";
export { renderTaskHelp } from "./task-grammar.js";

// ---------------------------------------------------------------------------
// Leaf dispatch: acquisition, one public SDK invocation, direct rendering
// ---------------------------------------------------------------------------

type TaskProduct = ReturnType<typeof Tasks.of>;
type TaskContext = Readonly<{ directory: string; boundary: string; writeRoot?: string; managed?: boolean }>;

type TaskInput = Readonly<{
  tasks: TaskProduct;
  command: ParsedTaskCommand;
  runtime: CliRuntime;
  context: TaskContext;
  actor?: string;
  current?: readonly string[];
  stdin?: string;
  composeMarkdown?: string;
  composeNamespace?: readonly string[];
}>;

function value(command: ParsedTaskCommand, name: string): string | undefined {
  const item = command.flags[name];
  return typeof item === "string" ? item : undefined;
}
function values(command: ParsedTaskCommand, name: string): readonly string[] | undefined {
  const item = command.flags[name];
  return Array.isArray(item) ? item : undefined;
}
function namespace(raw: string | undefined): readonly string[] | undefined {
  return raw === undefined ? undefined : raw === "/" ? [] : raw.split("/");
}
function priority(raw: string | undefined): TaskPriority | undefined {
  if (raw === undefined) return undefined;
  return Number(raw) as TaskPriority;
}
function ids(items: readonly string[] | undefined): readonly TaskId[] | undefined {
  return items as readonly TaskId[] | undefined;
}
function limit(command: ParsedTaskCommand): number | undefined {
  const raw = value(command, "limit");
  return raw === undefined ? undefined : Number(raw);
}

function validateTaskRowView(command: ParsedTaskCommand): void {
  if (
    command.action === "ls" ||
    command.action === "ready" ||
    command.action === "blocked" ||
    command.action === "query"
  )
    taskRowViewLimit(limit(command));
}

function explicitListNamespace(command: ParsedTaskCommand): readonly string[] | undefined {
  return command.action === "ls" && command.positionals.length === 1
    ? parseTaskNamespaceSelector(command.positionals[0]!)
    : undefined;
}

function taskStdinDiagnostic(command: ParsedTaskCommand): string | undefined {
  switch (command.stdin) {
    case "document":
      return "task add requires a nonblank stdin document";
    case "compose":
      return "task compose requires a nonblank stdin document";
    case "body":
      return "task update --body requires a nonblank value";
    case "append":
      return "task update --append requires a nonblank value";
    case "note":
      return "task update --note requires a nonblank value";
    default:
      return undefined;
  }
}

/**
 * The shared output primitive: one native answer, its matching rendered text, and the native exit
 * classifier's verdict. JSON writes the untouched native value; text writes the rendered lines.
 */
function emitTask<Result>(output: "text" | "json", result: Result, project: () => string, code: number): number {
  if (output === "json") writeJson(result);
  else writeStdout(project());
  return code;
}

async function invokeAdd(input: TaskInput): Promise<TaskMutationResult> {
  const { tasks, command, current = [] } = input;
  const selectedNamespace = namespace(value(command, "namespace")) ?? current;
  const actor = input.actor;
  if (command.stdin === "document") {
    return tasks.addDocument({
      markdown: input.stdin!,
      ...(selectedNamespace === undefined ? {} : { namespace: selectedNamespace }),
      ...(actor === undefined ? {} : { actor }),
    });
  }
  const body = value(command, "body"),
    note = value(command, "note"),
    initialState = value(command, "state") as TaskState | undefined,
    selectedPriority = priority(value(command, "priority"));
  const needs = ids(values(command, "needs")),
    parent = value(command, "parent");
  const supersedes = ids(values(command, "supersedes")),
    relates = ids(values(command, "relates"));
  return tasks.add({
    title: command.positionals[0]!,
    ...(selectedNamespace === undefined ? {} : { namespace: selectedNamespace }),
    ...(body === undefined ? {} : { body }),
    ...(note === undefined ? {} : { note }),
    ...(initialState === undefined ? {} : { state: initialState }),
    ...(selectedPriority === undefined ? {} : { priority: selectedPriority }),
    ...(needs === undefined ? {} : { needs }),
    ...(parent === undefined ? {} : { parent: parent as TaskId }),
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(relates === undefined ? {} : { relates }),
    ...(actor === undefined ? {} : { actor }),
  });
}

function invokeUpdate(input: TaskInput): Promise<TaskUpdateResult> {
  const { tasks, command, stdin } = input;
  const body = command.stdin === "body" ? stdin : value(command, "body"),
    appendBody = command.stdin === "append" ? stdin : value(command, "append");
  const note = command.stdin === "note" ? stdin : value(command, "note");
  const title = value(command, "title"),
    selectedPriority = priority(value(command, "priority"));
  const addNeeds = ids(values(command, "needs")),
    dropNeeds = ids(values(command, "drop-needs"));
  const parent = value(command, "parent"),
    addSupersedes = ids(values(command, "supersedes"));
  const dropSupersedes = ids(values(command, "drop-supersedes")),
    addRelates = ids(values(command, "relates"));
  const dropRelates = ids(values(command, "drop-relates"));
  return tasks.task({ id: command.positionals[0]! }).update({
    ...(title === undefined ? {} : { title }),
    ...(body === undefined ? {} : { body }),
    ...(appendBody === undefined ? {} : { appendBody }),
    ...(note === undefined ? {} : { note }),
    ...(selectedPriority === undefined ? {} : { priority: selectedPriority }),
    ...(addNeeds === undefined ? {} : { addNeeds }),
    ...(dropNeeds === undefined ? {} : { dropNeeds }),
    ...(command.flags["no-parent"] === true
      ? { parent: null }
      : parent === undefined
        ? {}
        : { parent: parent as TaskId }),
    ...(addSupersedes === undefined ? {} : { addSupersedes }),
    ...(dropSupersedes === undefined ? {} : { dropSupersedes }),
    ...(addRelates === undefined ? {} : { addRelates }),
    ...(dropRelates === undefined ? {} : { dropRelates }),
  });
}

function readScope(
  command: ParsedTaskCommand,
  current?: readonly string[],
): Readonly<{ scope: "world" }> | Readonly<{ namespace: readonly string[] }> {
  return command.flags.world === true ? { scope: "world" } : { namespace: current ?? [] };
}

function querySelection(command: ParsedTaskCommand): TaskQueryExpression | undefined {
  const state = (value: "done" | "drop", operator: "=" | "!="): TaskQueryExpression => ({
    kind: "predicate",
    predicate: { field: "state", operator, value },
  });
  const selection: TaskQueryExpression =
    command.flags.all === true
      ? { kind: "predicate", predicate: { field: "priority", operator: ">=", value: 0 } }
      : command.flags.closed === true
        ? { kind: "or", terms: [state("done", "="), state("drop", "=")] }
        : { kind: "and", terms: [state("done", "!="), state("drop", "!=")] };
  return command.where === undefined ? selection : { kind: "and", terms: [selection, command.where] };
}

/** One addressed read per caller-supplied id, in caller order; the native null survives to JSON. */
async function runShow(command: ParsedTaskCommand, tasks: TaskProduct): Promise<number> {
  const handles = command.positionals.map((taskId) => tasks.task({ id: taskId }).id);
  const details: (TaskDetail | null)[] = [];
  for (const id of handles) details.push(await tasks.task({ id }).read());
  const missing = details.findIndex((detail) => detail === null);
  const code = missing >= 0 ? 1 : 0;
  if (command.output === "json") {
    writeJson(handles.length === 1 ? details[0] : details);
    return code;
  }
  if (missing >= 0) {
    const refusal: TaskShowResult = { kind: "refused", refusal: { kind: "task-missing", taskId: handles[missing]! } };
    return emitTask(command.output, refusal, () => renderTaskShow(refusal, displayContext()), code);
  }
  const found = details.filter((detail): detail is TaskDetail => detail !== null);
  const result: TaskShowResult = found.length === 1 ? found[0]! : found;
  return emitTask(command.output, result, () => renderTaskShow(result, displayContext()), code);
}

/** Presentation-only list scope the leaf acquired, never part of the native answer. */
function listPresentation(command: ParsedTaskCommand): TaskListScope {
  if (command.flags.world === true) return "world";
  const first = command.positionals[0];
  return command.action === "ls" && first !== undefined ? { namespace: first } : "current";
}

async function runRead(input: TaskInput): Promise<number> {
  const { tasks, command, current } = input;
  const id = command.positionals[0]!;
  const scope = listPresentation(command);
  switch (command.action) {
    case "ls": {
      const result = await tasks.list({
        selection: command.flags.all === true ? "all" : command.flags.closed === true ? "closed" : "active",
        ...(explicitListNamespace(command) === undefined
          ? readScope(command, current)
          : { namespace: explicitListNamespace(command)! }),
        ...(limit(command) === undefined ? {} : { limit: limit(command)! }),
      });
      return emitTask(
        command.output,
        result,
        () => renderTaskList("ls", scope, result, displayContext()),
        taskExitCode(result),
      );
    }
    case "ready": {
      const result = await tasks.ready({
        ...readScope(command, current),
        ...(value(command, "parent") === undefined ? {} : { parent: value(command, "parent")! }),
        ...(limit(command) === undefined ? {} : { limit: limit(command)! }),
      });
      return emitTask(
        command.output,
        result,
        () => renderTaskList("ready", scope, result, displayContext()),
        taskExitCode(result),
      );
    }
    case "blocked": {
      const result = await tasks.blocked({
        ...readScope(command, current),
        ...(value(command, "parent") === undefined ? {} : { parent: value(command, "parent")! }),
        ...(limit(command) === undefined ? {} : { limit: limit(command)! }),
      });
      return emitTask(
        command.output,
        result,
        () => renderTaskList("blocked", scope, result, displayContext()),
        taskExitCode(result),
      );
    }
    case "query": {
      const result = await tasks.query({
        ...(querySelection(command) === undefined ? {} : { where: querySelection(command)! }),
        ...readScope(command, current),
        ...(value(command, "sort") === undefined ? {} : { sort: value(command, "sort") as TaskQuerySort }),
        ...(limit(command) === undefined ? {} : { limit: limit(command)! }),
      });
      return emitTask(
        command.output,
        result,
        () => renderTaskList("query", scope, result, displayContext()),
        taskExitCode(result),
      );
    }
    case "tree": {
      const result = await tasks.task({ id }).tree();
      return emitTask(command.output, result, () => renderTaskTree(result, displayContext()), taskExitCode(result));
    }
    case "doctor": {
      const result = await tasks.doctor();
      return emitTask(command.output, result, () => renderTaskDoctor(result), taskExitCode(result));
    }
    default:
      throw new Error(`task action is not a read: ${command.action}`);
  }
}

function isWorldObservationAction(command: ParsedTaskCommand): boolean {
  return (
    command.action === "ls" ||
    command.action === "ready" ||
    command.action === "blocked" ||
    command.action === "query" ||
    command.action === "doctor"
  );
}

function missingTask(id: string): Extract<TaskMutationResult, { kind: "refused" }> {
  return { kind: "refused", refusal: { kind: "task-missing", taskId: id as TaskId } };
}

/**
 * The one CLI edge mapping a Task action with no World to its native refusal answer, then through
 * the matching action renderer and the native exit classifier.
 */
function missingWorld(command: ParsedTaskCommand): number {
  const output = command.output;
  if (command.action === "show") {
    // An addressed missing read keeps its native null in JSON; text refuses without partial output.
    if (output === "json") {
      writeJson(command.positionals.length === 1 ? null : command.positionals.map(() => null));
      return 1;
    }
    const refusal: TaskShowResult = missingTask(command.positionals[0]!);
    return emitTask(output, refusal, () => renderTaskShow(refusal, displayContext()), 1);
  }
  if (isWorldObservationAction(command) || (command.action === "compose" && command.flags.plan === true)) {
    if (output === "json") writeJson({ kind: "absent" });
    else writeStdout("task world absent");
    return 1;
  }
  if (command.action === "context") {
    const result = { kind: "accepted" as const, value: { namespace: [], source: "default-root" as const } };
    return emitTask(output, result, () => renderTaskContext(result, displayContext()), taskExitCode(result));
  }
  if (command.action === "tree") {
    const result = missingTask(command.positionals[0]!);
    return emitTask(output, result, () => renderTaskTree(result, displayContext()), taskExitCode(result));
  }
  if (command.action === "update") {
    const result = missingTask(command.positionals[0]!);
    return emitTask(output, result, () => renderTaskUpdate(result, displayContext()), taskExitCode(result));
  }
  if (
    command.action === "start" ||
    command.action === "stop" ||
    command.action === "hold" ||
    command.action === "resume"
  ) {
    if (command.positionals.length === 1) {
      const result = missingTask(command.positionals[0]!);
      return emitTask(
        output,
        result,
        () => renderTaskMutation(command.action, result, displayContext()),
        taskExitCode(result),
      );
    }
    const result = {
      items: command.positionals.map((id) => ({ id: id as TaskId, outcome: missingTask(id) })),
    };
    return emitTask(
      output,
      result,
      () => renderTaskLifecycle(command.action, result, displayContext()),
      taskExitCode(result),
    );
  }
  if (command.action === "done" || command.action === "drop") {
    const result = {
      items: command.positionals.map((id) => ({ id: id as TaskId, outcome: missingTask(id) })),
    };
    return emitTask(
      output,
      result,
      () => renderTaskLifecycle(command.action, result, displayContext()),
      taskExitCode(result),
    );
  }
  throw new Error(`task action has no missing-world answer: ${command.action}`);
}

/**
 * One compose execution outcome: JSON keeps the untouched native value, while an incomplete text
 * answer recovers its draft and puts the diagnostic on stderr.
 */
function emitCompose(output: "text" | "json", result: TaskCompositionResult): number {
  if (output === "json") {
    writeJson(result);
    return taskExitCode(result);
  }
  if (result.kind === "incomplete") {
    const diagnostic = renderTaskIncompleteDiagnostic(result);
    if (diagnostic.length > 0) writeStderr(diagnostic);
    process.stdout.write(result.draft);
    return taskExitCode(result);
  }
  writeStdout(renderTaskCompose(result, displayContext()));
  return taskExitCode(result);
}

/** One plural Task lifecycle answer: every verb shares the same batch shape and renderer. */
async function runBatchLifecycle(
  tasks: TaskProduct,
  command: ParsedTaskCommand,
  verb: "hold" | "done" | "drop",
): Promise<number> {
  const note = value(command, "note");
  const result = await tasks.batch({
    verb,
    ids: command.positionals,
    ...(note === undefined ? {} : { note }),
  });
  return emitTask(
    command.output,
    result,
    () => renderTaskLifecycle(verb, result, displayContext()),
    taskExitCode(result),
  );
}

async function runMutation(input: TaskInput): Promise<number> {
  const { tasks, command, current, stdin, composeMarkdown, composeNamespace } = input;
  if (isWorldObservationAction(command) || command.action === "tree") return await runRead(input);
  switch (command.action) {
    case "add": {
      const result = await invokeAdd(input);
      return emitTask(
        command.output,
        result,
        () => renderTaskMutation("add", result, displayContext()),
        taskExitCode(result),
      );
    }
    case "update": {
      const result = await invokeUpdate(input);
      return emitTask(command.output, result, () => renderTaskUpdate(result, displayContext()), taskExitCode(result));
    }
    case "start":
    case "stop":
    case "resume": {
      const result = await invokeLifecycle(tasks, command.positionals, command.positionals[0]!, command.action);
      return emitTask(
        command.output,
        result,
        () => renderTaskLifecycle(command.action, result, displayContext()),
        taskExitCode(result),
      );
    }
    case "hold":
    case "done":
    case "drop":
      return await runBatchLifecycle(tasks, command, command.action);
    case "context": {
      const selected = namespace(command.positionals[0]);
      if (selected !== undefined) {
        await writeTaskNamespaceContext(input.context.writeRoot ?? input.context.directory, selected);
        const resolved = await resolveTaskNamespaceContext(input.context);
        if (typeof resolved === "object" && "kind" in resolved) {
          const result = { kind: "refused" as const, refusal: resolved };
          return emitTask(
            command.output,
            result,
            () => renderTaskContext(result, displayContext()),
            taskExitCode(result),
          );
        }
        const result = { kind: "accepted" as const, value: resolved };
        return emitTask(
          command.output,
          result,
          () => renderTaskContext(result, displayContext()),
          taskExitCode(result),
        );
      }
      const result = {
        kind: "accepted" as const,
        value: { namespace: current ?? [], source: "default-root" as const },
      };
      return emitTask(command.output, result, () => renderTaskContext(result, displayContext()), taskExitCode(result));
    }
    case "compose": {
      const result = await tasks.compose({
        markdown: composeMarkdown ?? stdin ?? "",
        namespace: composeNamespace ?? current ?? [],
        ...(input.actor === undefined ? {} : { actor: input.actor }),
        ...(command.flags.plan === true ? { plan: true } : {}),
      });
      return emitCompose(command.output, result);
    }
    default:
      throw new Error(`task action has no invocation: ${command.action}`);
  }
}

function invokeLifecycle(
  tasks: TaskProduct,
  taskIds: readonly string[],
  firstId: string,
  verb: "start" | "stop" | "hold" | "resume",
): Promise<TaskMutationResult | TaskBatchResult> {
  return taskIds.length === 1 ? tasks.task({ id: firstId })[verb]() : tasks.batch({ verb, ids: taskIds });
}

function establishesWorld(command: ParsedTaskCommand): boolean {
  return (
    command.action === "add" ||
    (command.action === "compose" && command.flags.plan !== true) ||
    (command.action === "context" && command.positionals.length > 0)
  );
}

/**
 * One CLI edge turning a namespace-context refusal into the addressed action's native refusal
 * answer, rendered through the matching action renderer and classified natively.
 */
function refuseNamespace(
  command: ParsedTaskCommand,
  refusal: Readonly<{ kind: "invalid-namespace-context"; path: string }>,
): number {
  const result = { kind: "refused" as const, refusal };
  switch (command.action) {
    case "ls":
    case "ready":
    case "blocked":
    case "query": {
      const action = command.action;
      return emitTask(
        command.output,
        result,
        () => renderTaskList(action, listPresentation(command), result, displayContext()),
        taskExitCode(result),
      );
    }
    case "add":
      return emitTask(
        command.output,
        result,
        () => renderTaskMutation("add", result, displayContext()),
        taskExitCode(result),
      );
    case "context":
      return emitTask(command.output, result, () => renderTaskContext(result, displayContext()), taskExitCode(result));
    case "compose":
      return emitTask(
        command.output,
        result,
        () => renderTaskFailure("compose", result, displayContext()),
        taskExitCode(result),
      );
    default:
      throw new Error(`task action has no namespace refusal: ${command.action}`);
  }
}

// eslint-disable-next-line complexity -- this is the single CLI edge ordering world, context, forwarding, and local execution.
export async function runTaskCommand(
  command: ParsedTaskCommand,
  coordinates: CliCoordinates,
  runtime: CliRuntime,
): Promise<number> {
  validateTaskRowView(command);
  const stdinDiagnostic = taskStdinDiagnostic(command);
  const stdin = stdinDiagnostic === undefined ? undefined : await runtime.readStdin();
  if (stdinDiagnostic !== undefined && isBlankInput(stdin ?? "")) throw new CliUsageError(stdinDiagnostic);
  const planOnly = command.action === "compose" && command.flags.plan === true;
  const composeMarkdown = command.action === "compose" ? stdin : undefined;
  const composition = composeMarkdown === undefined ? undefined : taskCompositionNamespaceHeader(composeMarkdown);
  const explicitNamespace =
    command.action === "add"
      ? namespace(value(command, "namespace"))
      : command.action === "compose" && composition?.specified
        ? composition.namespace
        : undefined;
  const actor = actorFromEdge(
    typeof command.flags.actor === "string" ? command.flags.actor : undefined,
    runtime.environment,
  );
  const world =
    coordinates.world ??
    (planOnly ? coordinates.candidateWorld : establishesWorld(command) ? await coordinates.establishWorld() : null);
  if (world === null) return missingWorld(command);
  const tasks = tasksWithExecution(world, runtime.execution);
  const contextSensitive =
    command.action === "context" ||
    (command.action === "add" && explicitNamespace === undefined) ||
    (command.action === "compose" && composition?.specified !== true) ||
    (((command.action === "ls" && explicitListNamespace(command) === undefined) ||
      command.action === "ready" ||
      command.action === "blocked" ||
      command.action === "query") &&
      command.flags.world !== true);
  let current: readonly string[] | undefined;
  if (contextSensitive) {
    const resolved = await resolveTaskNamespaceContext(coordinates.taskContext);
    if (typeof resolved === "object" && "kind" in resolved) return refuseNamespace(command, resolved);
    current = resolved.namespace;
    if (command.action === "context" && command.positionals.length === 0) {
      const result = { kind: "accepted" as const, value: resolved };
      return emitTask(command.output, result, () => renderTaskContext(result, displayContext()), taskExitCode(result));
    }
  }
  if (command.action === "show") return await runShow(command, tasks);
  return await runMutation({
    tasks,
    command,
    runtime,
    context: coordinates.taskContext,
    ...(actor === undefined ? {} : { actor }),
    ...(current === undefined ? {} : { current }),
    ...(stdin === undefined ? {} : { stdin }),
    ...(composeMarkdown === undefined ? {} : { composeMarkdown }),
    ...(explicitNamespace === undefined ? {} : { composeNamespace: explicitNamespace }),
  });
}
