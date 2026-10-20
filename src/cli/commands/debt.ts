import { CliUsageError, isBlankInput } from "../usage.js";
import { parseDebtNamespaceSelector } from "../../debt/catalog.js";
import type { ParsedDebtCommand } from "./debt-grammar.js";
import {
  Debts,
  debtsWithExecution,
  debtRowViewLimit,
  type DebtDetail,
  type DebtId,
  type DebtMutationResult,
  type DebtPriority,
  type DebtQuerySort,
  type DebtState,
  type DebtUpdateResult,
} from "../../debt/index.js";
import { installNamespaceContext, resolveDebtNamespaceContext } from "../../debt/context.js";
import { displayContext, emit, writeJson } from "../streams.js";
import type { CliRuntime } from "../runtime.js";
import type { CliCoordinates } from "../coordinates.js";
import {
  renderDoctor,
  renderDebtContext,
  renderDebtLifecycle,
  renderDebtList,
  renderDebtMutation,
  renderDebtShow,
  renderDebtTree,
  renderDebtUpdate,
  debtExitCode,
  type DebtListScope,
  type DebtShowResult,
} from "../render/debt.js";
import { actorFromEdge } from "../actor.js";
import { debtQuerySelection } from "../../debt/query.js";

// ---------------------------------------------------------------------------
// Leaf dispatch: acquisition, one public SDK invocation, direct rendering
// ---------------------------------------------------------------------------

type DebtProduct = ReturnType<typeof Debts.of>;
type DebtContext = Readonly<{ directory: string; boundary: string; writeRoot?: string; managed?: boolean }>;

type DebtInput = Readonly<{
  debts: DebtProduct;
  command: ParsedDebtCommand;
  context: DebtContext;
  actor?: string;
  current?: readonly string[];
  stdin?: string;
}>;

function value(command: ParsedDebtCommand, name: string): string | undefined {
  const item = command.flags[name];
  return typeof item === "string" ? item : undefined;
}
function values(command: ParsedDebtCommand, name: string): readonly string[] | undefined {
  const item = command.flags[name];
  return Array.isArray(item) ? item : undefined;
}
function namespace(raw: string | undefined): readonly string[] | undefined {
  return raw === undefined ? undefined : raw === "/" ? [] : raw.split("/");
}
function priority(raw: string | undefined): DebtPriority | undefined {
  if (raw === undefined) return undefined;
  return Number(raw) as DebtPriority;
}
function ids(items: readonly string[] | undefined): readonly DebtId[] | undefined {
  return items as readonly DebtId[] | undefined;
}
function limit(command: ParsedDebtCommand): number | undefined {
  const raw = value(command, "limit");
  return raw === undefined ? undefined : Number(raw);
}

function validateDebtRowView(command: ParsedDebtCommand): void {
  if (
    command.action === "ls" ||
    command.action === "ready" ||
    command.action === "blocked" ||
    command.action === "query"
  )
    debtRowViewLimit(limit(command));
}

function explicitListNamespace(command: ParsedDebtCommand): readonly string[] | undefined {
  return command.action === "ls" && command.positionals.length === 1
    ? parseDebtNamespaceSelector(command.positionals[0]!)
    : undefined;
}

function debtStdinDiagnostic(command: ParsedDebtCommand): string | undefined {
  switch (command.stdin) {
    case "document":
      return "debt add requires a nonblank stdin document";
    case "body":
      return "debt update --body requires a nonblank value";
    case "append":
      return "debt update --append requires a nonblank value";
    case "note":
      return "debt update --note requires a nonblank value";
    default:
      return undefined;
  }
}

async function invokeAdd(input: DebtInput): Promise<DebtMutationResult> {
  const { debts, command, current = [] } = input;
  const selectedNamespace = namespace(value(command, "namespace")) ?? current;
  const actor = input.actor;
  if (command.stdin === "document") {
    return debts.addDocument({
      markdown: input.stdin!,
      ...(selectedNamespace === undefined ? {} : { namespace: selectedNamespace }),
      ...(actor === undefined ? {} : { actor }),
    });
  }
  const body = value(command, "body"),
    note = value(command, "note"),
    initialState = value(command, "state") as DebtState | undefined,
    selectedPriority = priority(value(command, "priority"));
  const needs = ids(values(command, "needs")),
    parent = value(command, "parent");
  const supersedes = ids(values(command, "supersedes")),
    relates = ids(values(command, "relates"));
  return debts.add({
    title: command.positionals[0]!,
    ...(selectedNamespace === undefined ? {} : { namespace: selectedNamespace }),
    ...(body === undefined ? {} : { body }),
    ...(note === undefined ? {} : { note }),
    ...(initialState === undefined ? {} : { state: initialState }),
    ...(selectedPriority === undefined ? {} : { priority: selectedPriority }),
    ...(needs === undefined ? {} : { needs }),
    ...(parent === undefined ? {} : { parent: parent as DebtId }),
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(relates === undefined ? {} : { relates }),
    ...(actor === undefined ? {} : { actor }),
  });
}

function invokeUpdate(input: DebtInput): Promise<DebtUpdateResult> {
  const { debts, command, stdin } = input;
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
  return debts.debt({ id: command.positionals[0]! }).update({
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
        : { parent: parent as DebtId }),
    ...(addSupersedes === undefined ? {} : { addSupersedes }),
    ...(dropSupersedes === undefined ? {} : { dropSupersedes }),
    ...(addRelates === undefined ? {} : { addRelates }),
    ...(dropRelates === undefined ? {} : { dropRelates }),
  });
}

function readScope(
  command: ParsedDebtCommand,
  current?: readonly string[],
): Readonly<{ scope: "world" }> | Readonly<{ namespace: readonly string[] }> {
  return command.flags.world === true ? { scope: "world" } : { namespace: current ?? [] };
}

/** One addressed read per caller-supplied id, in caller order; the native null survives to JSON. */
async function runShow(command: ParsedDebtCommand, debts: DebtProduct): Promise<number> {
  const handles = command.positionals.map((debtId) => debts.debt({ id: debtId }).id);
  const details: (DebtDetail | null)[] = [];
  for (const id of handles) details.push(await debts.debt({ id }).read());
  const missing = details.findIndex((detail) => detail === null);
  const code = missing >= 0 ? 1 : 0;
  const projected = handles.length === 1 ? details[0] : details;
  if (missing >= 0) {
    const refusal: DebtShowResult = { kind: "refused", refusal: { kind: "debt-missing", debtId: handles[missing]! } };
    return emit(command.output, projected, () => renderDebtShow(refusal, displayContext()), code);
  }
  const found = details.filter((detail): detail is DebtDetail => detail !== null);
  const result: DebtShowResult = found.length === 1 ? found[0]! : found;
  return emit(command.output, projected, () => renderDebtShow(result, displayContext()), code);
}

/** Presentation-only list scope the leaf acquired, never part of the native answer. */
function listPresentation(command: ParsedDebtCommand): DebtListScope {
  if (command.flags.world === true) return "world";
  const first = command.positionals[0];
  return command.action === "ls" && first !== undefined ? { namespace: first } : "current";
}

async function runRead(input: DebtInput): Promise<number> {
  const { debts, command, current } = input;
  const id = command.positionals[0]!;
  const scope = listPresentation(command);
  switch (command.action) {
    case "ls": {
      const result = await debts.list({
        selection: command.flags.all === true ? "all" : command.flags.closed === true ? "closed" : "active",
        ...(explicitListNamespace(command) === undefined
          ? readScope(command, current)
          : { namespace: explicitListNamespace(command)! }),
        ...(limit(command) === undefined ? {} : { limit: limit(command)! }),
      });
      return emit(
        command.output,
        result,
        () => renderDebtList("ls", scope, result, displayContext()),
        debtExitCode(result),
      );
    }
    case "ready":
    case "blocked": {
      const action = command.action;
      const result = await debts[action]({
        ...readScope(command, current),
        ...(value(command, "parent") === undefined ? {} : { parent: value(command, "parent")! }),
        ...(limit(command) === undefined ? {} : { limit: limit(command)! }),
      });
      return emit(
        command.output,
        result,
        () => renderDebtList(action, scope, result, displayContext()),
        debtExitCode(result),
      );
    }
    case "query": {
      const result = await debts.query({
        where: debtQuerySelection(
          command.flags.all === true ? "all" : command.flags.closed === true ? "closed" : "active",
          command.where,
        ),
        ...readScope(command, current),
        ...(value(command, "sort") === undefined ? {} : { sort: value(command, "sort") as DebtQuerySort }),
        ...(limit(command) === undefined ? {} : { limit: limit(command)! }),
      });
      return emit(
        command.output,
        result,
        () => renderDebtList("query", scope, result, displayContext()),
        debtExitCode(result),
      );
    }
    case "tree": {
      const result = await debts.debt({ id }).tree();
      return emit(command.output, result, () => renderDebtTree(result, displayContext()), debtExitCode(result));
    }
    case "doctor": {
      const result = await debts.doctor();
      return emit(command.output, result, () => renderDoctor(result), debtExitCode(result));
    }
    default:
      throw new Error(`debt action is not a read: ${command.action}`);
  }
}

function isWorldObservationAction(command: ParsedDebtCommand): boolean {
  return (
    command.action === "ls" ||
    command.action === "ready" ||
    command.action === "blocked" ||
    command.action === "query" ||
    command.action === "doctor"
  );
}

function missingDebt(id: string): Extract<DebtMutationResult, { kind: "refused" }> {
  return { kind: "refused", refusal: { kind: "debt-missing", debtId: id as DebtId } };
}

/**
 * The one CLI edge mapping a Debt action with no World to its native refusal answer, then through
 * the matching action renderer and the native exit classifier.
 */
function missingWorld(command: ParsedDebtCommand): number {
  const output = command.output;
  if (command.action === "show") {
    // An addressed missing read keeps its native null in JSON; text refuses without partial output.
    if (output === "json") {
      writeJson(command.positionals.length === 1 ? null : command.positionals.map(() => null));
      return 1;
    }
    const refusal: DebtShowResult = missingDebt(command.positionals[0]!);
    return emit(output, refusal, () => renderDebtShow(refusal, displayContext()), 1);
  }
  if (isWorldObservationAction(command)) {
    return emit(output, { kind: "absent" }, () => "debt world absent", 1);
  }
  if (command.action === "context") {
    const result = { kind: "accepted" as const, value: { namespace: [], source: "default-root" as const } };
    return emit(output, result, () => renderDebtContext(result, displayContext()), debtExitCode(result));
  }
  if (command.action === "tree") {
    const result = missingDebt(command.positionals[0]!);
    return emit(output, result, () => renderDebtTree(result, displayContext()), debtExitCode(result));
  }
  if (command.action === "update") {
    const result = missingDebt(command.positionals[0]!);
    return emit(output, result, () => renderDebtUpdate(result, displayContext()), debtExitCode(result));
  }
  if (command.action !== "done" && command.action !== "drop")
    throw new Error(`debt action has no missing-world answer: ${command.action}`);
  const result = {
    items: command.positionals.map((id) => ({ id: id as DebtId, outcome: missingDebt(id) })),
  };
  return emit(
    output,
    result,
    () => renderDebtLifecycle(command.action, result, displayContext()),
    debtExitCode(result),
  );
}

/** One plural Debt lifecycle answer: every verb shares the same batch shape and renderer. */
async function runBatchLifecycle(
  debts: DebtProduct,
  command: ParsedDebtCommand,
  verb: "done" | "drop",
): Promise<number> {
  const note = value(command, "note");
  const result = await debts.batch({
    verb,
    ids: command.positionals,
    ...(note === undefined ? {} : { note }),
  });
  return emit(command.output, result, () => renderDebtLifecycle(verb, result, displayContext()), debtExitCode(result));
}

async function runMutation(input: DebtInput): Promise<number> {
  const { debts, command, current } = input;
  if (isWorldObservationAction(command) || command.action === "tree") return await runRead(input);
  switch (command.action) {
    case "add": {
      const result = await invokeAdd(input);
      return emit(
        command.output,
        result,
        () => renderDebtMutation("add", result, displayContext()),
        debtExitCode(result),
      );
    }
    case "update": {
      const result = await invokeUpdate(input);
      return emit(command.output, result, () => renderDebtUpdate(result, displayContext()), debtExitCode(result));
    }
    case "done":
    case "drop":
      return await runBatchLifecycle(debts, command, command.action);
    case "context": {
      const selected = namespace(command.positionals[0]);
      if (selected !== undefined) {
        await installNamespaceContext(input.context.writeRoot ?? input.context.directory, selected);
        const resolved = await resolveDebtNamespaceContext(input.context);
        if (typeof resolved === "object" && "kind" in resolved) {
          const result = { kind: "refused" as const, refusal: resolved };
          return emit(command.output, result, () => renderDebtContext(result, displayContext()), debtExitCode(result));
        }
        const result = { kind: "accepted" as const, value: resolved };
        return emit(command.output, result, () => renderDebtContext(result, displayContext()), debtExitCode(result));
      }
      const result = {
        kind: "accepted" as const,
        value: { namespace: current ?? [], source: "default-root" as const },
      };
      return emit(command.output, result, () => renderDebtContext(result, displayContext()), debtExitCode(result));
    }
    default:
      throw new Error(`debt action has no invocation: ${command.action}`);
  }
}

function establishesWorld(command: ParsedDebtCommand): boolean {
  return command.action === "add" || (command.action === "context" && command.positionals.length > 0);
}

/**
 * One CLI edge turning a namespace-context refusal into the addressed action's native refusal
 * answer, rendered through the matching action renderer and classified natively.
 */
function refuseNamespace(
  command: ParsedDebtCommand,
  refusal: Readonly<{ kind: "invalid-namespace-context"; path: string }>,
): number {
  const result = { kind: "refused" as const, refusal };
  switch (command.action) {
    case "ls":
    case "ready":
    case "blocked":
    case "query": {
      const action = command.action;
      return emit(
        command.output,
        result,
        () => renderDebtList(action, listPresentation(command), result, displayContext()),
        debtExitCode(result),
      );
    }
    case "add":
      return emit(
        command.output,
        result,
        () => renderDebtMutation("add", result, displayContext()),
        debtExitCode(result),
      );
    case "context":
      return emit(command.output, result, () => renderDebtContext(result, displayContext()), debtExitCode(result));
    default:
      throw new Error(`debt action has no namespace refusal: ${command.action}`);
  }
}

// eslint-disable-next-line complexity -- this is the single CLI edge ordering world, context, forwarding, and local execution.
export async function runDebtCommand(
  command: ParsedDebtCommand,
  coordinates: CliCoordinates,
  runtime: CliRuntime,
): Promise<number> {
  validateDebtRowView(command);
  const stdinDiagnostic = debtStdinDiagnostic(command);
  const stdin = stdinDiagnostic === undefined ? undefined : await runtime.readStdin();
  if (stdinDiagnostic !== undefined && isBlankInput(stdin ?? "")) throw new CliUsageError(stdinDiagnostic);
  const explicitNamespace = command.action === "add" ? namespace(value(command, "namespace")) : undefined;
  const actor = actorFromEdge(
    typeof command.flags.actor === "string" ? command.flags.actor : undefined,
    runtime.environment,
  );
  const world = coordinates.world ?? (establishesWorld(command) ? await coordinates.establishWorld() : null);
  if (world === null) return missingWorld(command);
  const debts = debtsWithExecution(world, runtime.execution);
  const contextSensitive =
    command.action === "context" ||
    (command.action === "add" && explicitNamespace === undefined) ||
    (((command.action === "ls" && explicitListNamespace(command) === undefined) ||
      command.action === "ready" ||
      command.action === "blocked" ||
      command.action === "query") &&
      command.flags.world !== true);
  let current: readonly string[] | undefined;
  if (contextSensitive) {
    const resolved = await resolveDebtNamespaceContext(coordinates.debtContext);
    if (typeof resolved === "object" && "kind" in resolved) return refuseNamespace(command, resolved);
    current = resolved.namespace;
    if (command.action === "context" && command.positionals.length === 0) {
      const result = { kind: "accepted" as const, value: resolved };
      return emit(command.output, result, () => renderDebtContext(result, displayContext()), debtExitCode(result));
    }
  }
  if (command.action === "show") return await runShow(command, debts);
  return await runMutation({
    debts,
    command,
    context: coordinates.debtContext,
    ...(actor === undefined ? {} : { actor }),
    ...(current === undefined ? {} : { current }),
    ...(stdin === undefined ? {} : { stdin }),
  });
}
