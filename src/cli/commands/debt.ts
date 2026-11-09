import { CliUsageError, isBlankInput } from "../usage.js";
import { parseDebtNamespaceSelector } from "../../debt/catalog.js";
import type { DebtId, DebtPriority, DebtQuerySort, DebtState } from "../../debt/index.js";
import type { ParsedDebtCommand } from "./debt-grammar.js";
import type { CliRuntime } from "../runtime.js";
import { displayContext, emit, type CliOutcome } from "../streams.js";
import {
  debtOutcome,
  renderDebtContext,
  renderDebtLifecycle,
  renderDebtList,
  renderDebtMutation,
  renderDebtShow,
  renderDebtTree,
  renderDebtUpdate,
  renderDoctor,
  type DebtListScope,
} from "../render/debt.js";

function value(command: ParsedDebtCommand, name: string): string | undefined {
  const item = command.flags[name];
  return typeof item === "string" ? item : undefined;
}
function values(command: ParsedDebtCommand, name: string): readonly DebtId[] | undefined {
  const item = command.flags[name];
  return Array.isArray(item) ? (item as readonly DebtId[]) : undefined;
}
function namespace(raw: string | undefined): readonly string[] | undefined {
  return raw === undefined ? undefined : raw === "/" ? [] : raw.split("/");
}
function optional<K extends string, T>(key: K, val: T | undefined): { [P in K]?: T } {
  return val === undefined ? {} : ({ [key]: val } as { [P in K]: T });
}
function scope(command: ParsedDebtCommand) {
  const ns =
    command.action === "ls" && command.positionals.length === 1
      ? parseDebtNamespaceSelector(command.positionals[0]!)
      : undefined;
  const raw = value(command, "limit");
  return {
    ...(command.flags.world === true ? { scope: "world" as const } : ns === undefined ? {} : { namespace: ns }),
    ...(raw === undefined ? {} : { limit: Number(raw) }),
  };
}
function presentation(command: ParsedDebtCommand): DebtListScope {
  if (command.flags.world === true) return "world";
  return command.action === "ls" && command.positionals[0] !== undefined
    ? { namespace: command.positionals[0] }
    : "current";
}
function selection(command: ParsedDebtCommand) {
  return command.flags.all === true
    ? ("all" as const)
    : command.flags.closed === true
      ? ("closed" as const)
      : ("active" as const);
}

export async function runDebtCommand(command: ParsedDebtCommand, runtime: CliRuntime): Promise<CliOutcome> {
  const diagnostic =
    command.stdin === "document"
      ? "debt add requires a nonblank stdin document"
      : command.stdin === "body"
        ? "debt update --body requires a nonblank value"
        : command.stdin === "append"
          ? "debt update --append requires a nonblank value"
          : command.stdin === "note"
            ? "debt update --note requires a nonblank value"
            : undefined;
  const stdin = diagnostic === undefined ? undefined : await runtime.readStdin();
  if (diagnostic !== undefined && isBlankInput(stdin ?? "")) throw new CliUsageError(diagnostic);
  const facet = runtime.facet,
    ctx = displayContext();
  switch (command.action) {
    case "add": {
      const ns = namespace(value(command, "namespace")),
        actor = value(command, "actor");
      const result =
        command.stdin === "document"
          ? await facet.debtAddDocument({ markdown: stdin!, ...optional("namespace", ns), ...optional("actor", actor) })
          : await facet.debtAdd({
              title: command.positionals[0]!,
              ...optional("namespace", ns),
              ...optional("actor", actor),
              ...optional("body", value(command, "body")),
              ...optional("note", value(command, "note")),
              ...optional("state", value(command, "state") as DebtState | undefined),
              ...optional(
                "priority",
                value(command, "priority") === undefined
                  ? undefined
                  : (Number(value(command, "priority")) as DebtPriority),
              ),
              ...optional("needs", values(command, "needs")),
              ...optional("parent", value(command, "parent") as DebtId | undefined),
              ...optional("supersedes", values(command, "supersedes")),
              ...optional("relates", values(command, "relates")),
            });
      return emit(command.output, result, () => renderDebtMutation("add", result, ctx), debtOutcome(result));
    }
    case "update": {
      const result = await facet.debtUpdate({
        id: command.positionals[0]!,
        ...optional("title", value(command, "title")),
        ...optional("body", command.stdin === "body" ? stdin : value(command, "body")),
        ...optional("appendBody", command.stdin === "append" ? stdin : value(command, "append")),
        ...optional("note", command.stdin === "note" ? stdin : value(command, "note")),
        ...optional(
          "priority",
          value(command, "priority") === undefined ? undefined : (Number(value(command, "priority")) as DebtPriority),
        ),
        ...optional("addNeeds", values(command, "needs")),
        ...optional("dropNeeds", values(command, "drop-needs")),
        ...optional(
          "parent",
          command.flags["no-parent"] === true ? null : (value(command, "parent") as DebtId | undefined),
        ),
        ...optional("addSupersedes", values(command, "supersedes")),
        ...optional("dropSupersedes", values(command, "drop-supersedes")),
        ...optional("addRelates", values(command, "relates")),
        ...optional("dropRelates", values(command, "drop-relates")),
      });
      return emit(command.output, result, () => renderDebtUpdate(result, ctx), debtOutcome(result));
    }
    case "show": {
      const ids = command.positionals;
      const result = ids.length === 1 ? await facet.debtShow({ id: ids[0]! }) : await facet.debtShow({ ids });
      return emit(command.output, result, () => renderDebtShow(result, ids, ctx), debtOutcome(result));
    }
    case "done":
    case "drop": {
      const result = await (command.action === "done"
        ? facet.debtDone({ ids: command.positionals, ...optional("note", value(command, "note")) })
        : facet.debtDrop({ ids: command.positionals, ...optional("note", value(command, "note")) }));
      return emit(command.output, result, () => renderDebtLifecycle(command.action, result, ctx), debtOutcome(result));
    }
    case "ls":
    case "ready":
    case "blocked":
    case "query": {
      const args = scope(command),
        action = command.action;
      const result =
        action === "ls"
          ? await facet.ls({ of: "debt", ...args, selection: selection(command) })
          : action === "query"
            ? await facet.debtQuery({
                ...args,
                selection: selection(command),
                ...optional("where", command.where),
                ...optional("sort", value(command, "sort") as DebtQuerySort | undefined),
              })
            : action === "ready"
              ? await facet.debtReady({ ...args, ...optional("parent", value(command, "parent")) })
              : await facet.debtBlocked({ ...args, ...optional("parent", value(command, "parent")) });
      return emit(
        command.output,
        result,
        () => renderDebtList(action, presentation(command), result, ctx),
        debtOutcome(result),
      );
    }
    case "tree": {
      const result = await facet.debtTree({ id: command.positionals[0]! });
      return emit(command.output, result, () => renderDebtTree(result, ctx), debtOutcome(result));
    }
    case "doctor": {
      const result = await facet.debtDoctor();
      return emit(command.output, result, () => renderDoctor(result), debtOutcome(result));
    }
    case "context": {
      const result = await facet.debtContext({ ...optional("namespace", namespace(command.positionals[0])) });
      return emit(command.output, result, () => renderDebtContext(result, ctx), debtOutcome(result));
    }
  }
}
