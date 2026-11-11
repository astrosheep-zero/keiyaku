import { CliUsageError, isBlankInput } from "../usage.js";
import type { DebtId, DebtPriority, DebtQuerySort, DebtState } from "../../debt/index.js";
import type { ParsedDebtCommand } from "./debt-grammar.js";
import type { CliRuntime } from "../runtime.js";
import { displayContext, emit, type CliOutcome } from "../streams.js";
import {
  classifyVerb,
  type VerbName,
  type VerbInput,
  type VerbOutput,
  type VerbRunFor,
} from "../../library/keiyaku-verbs.js";
import { renderVerb } from "../render/verbs.js";

async function execute<K extends VerbName>(
  name: K,
  input: VerbInput<K>,
  command: ParsedDebtCommand,
  runtime: CliRuntime,
): Promise<CliOutcome> {
  const result: VerbOutput<K> = await runtime.facet.run(name, input, { signal: runtime.signal } as VerbRunFor<K>);
  const completion = { kind: "returned", value: result } as const;
  return emit(
    command.output,
    result,
    () => renderVerb(name, input, completion, { ...displayContext(), now: Date.now() }),
    classifyVerb(name, input, completion),
  );
}

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
  const raw = value(command, "limit");
  return {
    ...(command.flags.world === true ? { scope: "world" as const } : {}),
    ...(raw === undefined ? {} : { limit: Number(raw) }),
  };
}
function selection(command: ParsedDebtCommand) {
  return command.flags.all === true
    ? ("all" as const)
    : command.flags.closed === true
      ? ("closed" as const)
      : ("active" as const);
}

async function addDebt(
  command: ParsedDebtCommand,
  runtime: CliRuntime,
  stdin: string | undefined,
): Promise<CliOutcome> {
  const ns = namespace(value(command, "namespace")),
    actor = value(command, "actor");
  if (command.stdin === "document") {
    const input = { markdown: stdin!, ...optional("namespace", ns), ...optional("actor", actor) };
    return execute("debt.addDocument", input, command, runtime);
  }
  const input = {
    title: command.positionals[0]!,
    ...optional("namespace", ns),
    ...optional("actor", actor),
    ...optional("body", value(command, "body")),
    ...optional("note", value(command, "note")),
    ...optional("state", value(command, "state") as DebtState | undefined),
    ...optional(
      "priority",
      value(command, "priority") === undefined ? undefined : (Number(value(command, "priority")) as DebtPriority),
    ),
    ...optional("needs", values(command, "needs")),
    ...optional("parent", value(command, "parent") as DebtId | undefined),
    ...optional("supersedes", values(command, "supersedes")),
    ...optional("relates", values(command, "relates")),
  };
  return execute("debt.add", input, command, runtime);
}

async function updateDebt(
  command: ParsedDebtCommand,
  runtime: CliRuntime,
  stdin: string | undefined,
): Promise<CliOutcome> {
  const input = {
    id: command.positionals[0]!,
    ...optional("title", value(command, "title")),
    ...optional("body", command.stdin === "body" ? stdin : value(command, "body")),
    ...optional("appendBody", command.stdin === "append" ? stdin : value(command, "append")),
    ...optional("note", command.stdin === "note" ? stdin : value(command, "note")),
    ...optional("state", value(command, "state") as DebtState | undefined),
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
  };
  return execute("debt.update", input, command, runtime);
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
  switch (command.action) {
    case "add":
      return addDebt(command, runtime, stdin);
    case "update":
      return updateDebt(command, runtime, stdin);
    case "query":
      return execute(
        "debt.query",
        {
          ...scope(command),
          selection: selection(command),
          ...optional("where", command.where),
          ...optional("sort", value(command, "sort") as DebtQuerySort | undefined),
        },
        command,
        runtime,
      );
    case "tree":
      return execute("debt.tree", { id: command.positionals[0]! }, command, runtime);
    case "doctor":
      return execute("debt.doctor", {}, command, runtime);
  }
}
