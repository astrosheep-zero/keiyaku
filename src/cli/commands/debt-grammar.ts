import {
  CliUsageError,
  commonInvocationOptions,
  DEBT_FAMILY_USAGE_GUIDE,
  unknownCommandGuide,
  type CliUsageGuide,
} from "../usage.js";
import { scanArgs, type ScanFlagKind, type ScanSpec, type ScannedArgs } from "../scan.js";
import { parseDebtNamespaceSelector } from "../../debt/catalog.js";
import { parseDebtId } from "../../debt/identity.js";
import {
  parseDebtQueryExpression,
  validateDebtLimit,
  validateDebtParent,
  type DebtQueryExpression,
} from "./debt-query.js";

export type DebtAction =
  | "add"
  | "show"
  | "ls"
  | "ready"
  | "blocked"
  | "tree"
  | "doctor"
  | "update"
  | "query"
  | "done"
  | "drop"
  | "context";
type DebtFlagValue = string | true | readonly string[];
type DebtStdin = "document" | "body" | "append" | "note";

export type ParsedDebtCommand = Readonly<{
  command: "debt";
  action: DebtAction;
  output: "text" | "json";
  positionals: readonly string[];
  flags: Readonly<Record<string, DebtFlagValue>>;
  stdin?: DebtStdin;
  where?: DebtQueryExpression;
}>;

type DebtCommandSpec = Readonly<{
  arity: readonly [minimum: number, maximum: number];
  flags: Readonly<Record<string, ScanFlagKind>>;
  stdin?: "document";
  usage: string;
  purpose: string;
  details?: string;
}>;

const COMMON = { json: "boolean" } as const;
const DEBT_COMMAND_SPECS: Readonly<Record<DebtAction, DebtCommandSpec>> = {
  add: {
    arity: [0, 1],
    stdin: "document",
    flags: {
      ...COMMON,
      namespace: "value",
      state: "value",
      priority: "value",
      needs: "repeat",
      parent: "value",
      supersedes: "repeat",
      relates: "repeat",
      body: "value",
      note: "value",
      actor: "value",
    },
    usage: `debt add <TITLE> [--namespace <ns>] [--priority 0..3]
  [--state open|done|drop]
  [--note <text>] [--actor <actor>]
  [--needs <DebtId>]... [--parent <DebtId>]
  [--supersedes <DebtId>]... [--relates <DebtId>]...
  [--body <text>]
debt add [--namespace <ns>] [--actor <actor>] -`,
    purpose: "Create a Debt from flags or a Debt document on stdin.",
    details:
      "The stdin document is YAML front matter (title, state, priority, needs, parent, supersedes, relates, note) followed by a Markdown body.",
  },
  show: {
    arity: [1, Number.POSITIVE_INFINITY],
    flags: COMMON,
    usage: "debt show <DebtId>...",
    purpose: "Read one or more Debts and their relationships.",
  },
  ls: {
    arity: [0, 1],
    flags: { ...COMMON, closed: "boolean", all: "boolean", world: "boolean", limit: "value" },
    usage: "debt ls [<namespace-selector>] [--closed | --all] [--world] [--limit <n>]",
    purpose: "List Debts in the selected namespace.",
    details: [
      "With no selector, lists the current directory Debt context.",
      "debt/ selects the root namespace; --world lists every namespace in the current Debt world.",
    ].join("\n"),
  },
  ready: {
    arity: [0, 0],
    flags: { ...COMMON, world: "boolean", parent: "value", limit: "value" },
    usage: "debt ready [--world] [--parent <DebtId>] [--limit <n>]",
    purpose: "List open Debts whose every dependency is complete or dropped.",
    details: "--world lists every namespace in the current Debt world.",
  },
  blocked: {
    arity: [0, 0],
    flags: { ...COMMON, world: "boolean", parent: "value", limit: "value" },
    usage: "debt blocked [--world] [--parent <DebtId>] [--limit <n>]",
    purpose: "List Debts with unmet dependencies.",
    details: "--world lists every namespace in the current Debt world.",
  },
  query: {
    arity: [0, 0],
    flags: {
      ...COMMON,
      where: "value",
      world: "boolean",
      closed: "boolean",
      all: "boolean",
      sort: "value",
      limit: "value",
    },
    usage: `debt query [--where <expression>] [--closed | --all] [--world]
  [--sort priority|created|updated|id] [--limit <n>]`,
    purpose: "Filter and sort Debts with a boolean expression.",
    details: [
      "fields: state priority title id parent under needs blocks ready blocked created updated",
      "operators: = != < > <= >= ~ and or not ( )",
      "sort: priority and created ascend; updated descends; id is lexical. Default: priority.",
      "--world lists every namespace in the current Debt world.",
      "By default only active Debts match; --closed selects terminal Debts, --all includes both.",
      "examples:",
      "  keiyaku debt query --where 'priority <= 1 and ready' --world",
      "  keiyaku debt query --where 'updated < 2026-08-06T00:00:00.000Z' --world",
    ].join("\n"),
  },
  tree: {
    arity: [1, 1],
    flags: COMMON,
    usage: "debt tree <DebtId>",
    purpose: "Show a Debt and its parent/child breakdown.",
  },
  doctor: {
    arity: [0, 0],
    flags: COMMON,
    usage: "debt doctor",
    purpose: "Check Debts for inconsistencies without changing them.",
  },
  update: {
    arity: [1, 1],
    flags: {
      ...COMMON,
      title: "value",
      body: "value",
      append: "value",
      note: "value",
      priority: "value",
      needs: "repeat",
      "drop-needs": "repeat",
      parent: "value",
      "no-parent": "boolean",
      supersedes: "repeat",
      "drop-supersedes": "repeat",
      relates: "repeat",
      "drop-relates": "repeat",
    },
    usage: `debt update <DebtId> [--title <text>] [--body <text>|- | --append <text>]
  [--note <text>]
  [--priority 0..3] [--needs <DebtId>]... [--drop-needs <DebtId>]...
  [--parent <DebtId> | --no-parent]
  [--supersedes <DebtId>]... [--drop-supersedes <DebtId>]...
  [--relates <DebtId>]... [--drop-relates <DebtId>]...`,
    purpose: "Change a Debt's fields and relationships.",
    details: [
      "--body replaces the body; --append adds text after it, separated by a newline when needed.",
      "--body - reads replacement body text from stdin.",
    ].join("\n"),
  },
  done: {
    arity: [1, Number.POSITIVE_INFINITY],
    flags: { ...COMMON, note: "value" },
    usage: "debt done <DebtId>... [--note <text>]",
    purpose: "Mark one or more Debts done.",
  },
  drop: {
    arity: [1, Number.POSITIVE_INFINITY],
    flags: { ...COMMON, note: "value" },
    usage: "debt drop <DebtId>... [--note <text>]",
    purpose: "Mark one or more Debts as no longer needed.",
  },
  context: {
    arity: [0, 1],
    flags: COMMON,
    usage: "debt context [<namespace>]",
    purpose: "Set or read the default Debt namespace for this directory.",
    details: "Omit <namespace> to read the current context; use / to reset it to the root namespace.",
  },
};

export function isDebtAction(value: string | undefined): value is DebtAction {
  return value !== undefined && Object.hasOwn(DEBT_COMMAND_SPECS, value);
}

export function renderDebtHelp(action?: DebtAction): string {
  if (action !== undefined) {
    const spec = DEBT_COMMAND_SPECS[action];
    return `${spec.purpose}\n\n${renderDebtUsage(action)}${spec.details === undefined ? "" : `\n\n${spec.details}`}`;
  }
  const nameWidth = Math.max(...Object.keys(DEBT_COMMAND_SPECS).map((name) => name.length));
  return [
    "usage  keiyaku debt <command> ...",
    "      keiyaku debt <command> --help   shows that command's complete usage",
    "",
    ...Object.entries(DEBT_COMMAND_SPECS).map(([name, spec]) => `  ${name.padEnd(nameWidth)}  ${spec.purpose}`),
  ].join("\n");
}

function renderDebtUsage(action: DebtAction): string {
  return debtUsage(action)
    .split("\n")
    .map((line, index) => `${index === 0 ? "usage  " : "      "}${line.trimStart()}`)
    .join("\n");
}

function debtUsage(action: DebtAction): string {
  const usage = DEBT_COMMAND_SPECS[action].usage;
  const lines = usage.split("\n").map((line, index) => {
    if (index === 0 || line.trimStart().startsWith("debt ")) return `keiyaku ${line.trim()}`;
    return line.trim();
  });
  return [...lines, commonInvocationOptions(usage)].join("\n");
}

export function debtUsageGuide(action: DebtAction): CliUsageGuide {
  return {
    scope: `keiyaku debt ${action}`,
    accepts: debtUsage(action),
    help: `keiyaku debt ${action} --help`,
  };
}

type ScannedDebt = ScannedArgs<DebtStdin>;

/** One scan spec per Debt action: `-` reads the document, or `--body -` replaces an update body. */
function scanSpec(action: DebtAction, spec: DebtCommandSpec): ScanSpec<DebtStdin> {
  return {
    subject: `debt ${action}`,
    flags: spec.flags,
    ...(spec.stdin === undefined ? {} : { stdin: spec.stdin }),
    stdinRefusal: "stdin marker '-' is not valid here",
    ...(action === "update" ? { stdinValue: "body" } : {}),
  };
}

function validateUpdate(scanned: ScannedDebt, fail: (message: string) => never): void {
  const flags = scanned.flags;
  if (flags.body !== undefined && flags.append !== undefined) fail("--body and --append are mutually exclusive");
  if (flags.parent !== undefined && flags["no-parent"] === true)
    fail("--parent and --no-parent are mutually exclusive");
  if (Object.keys(flags).every((name) => name === "json")) fail("debt update requires at least one patch option");
}

function validateDebtReadFlags(
  action: DebtAction,
  flags: Readonly<Record<string, DebtFlagValue>>,
  fail: (message: string) => never,
): void {
  if ((action === "ls" || action === "query") && flags.closed === true && flags.all === true)
    fail("--closed and --all are mutually exclusive");
  if (action === "ls" && flags.world === true) {
    // An explicit selector is checked below, after positional shape is known.
  }
  if (typeof flags.limit === "string") {
    try {
      validateDebtLimit(flags.limit);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
  if (
    typeof flags.sort === "string" &&
    flags.sort !== "priority" &&
    flags.sort !== "created" &&
    flags.sort !== "updated" &&
    flags.sort !== "id"
  ) {
    fail("--sort must be priority, created, updated, or id");
  }
  if ((action === "ready" || action === "blocked") && typeof flags.parent === "string") {
    try {
      validateDebtParent(flags.parent);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}

/** Actions whose positionals are all addressed DebtIds validated by the native owner. */
const DEBT_ID_ACTIONS: ReadonlySet<DebtAction> = new Set(["show", "tree", "update", "done", "drop"]);

/** Validate every addressed DebtId positional through the native owner before any read or write. */
function validateDebtIdPositionals(positionals: readonly string[], fail: (message: string) => never): void {
  for (const debtId of positionals) {
    try {
      parseDebtId(debtId);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}

/** Validate an explicit `debt ls` namespace selector through the native owner. */
function validateListSelector(selector: string, fail: (message: string) => never): void {
  if (selector !== "debt/" && (!selector.startsWith("debt/") || !selector.endsWith("/")))
    fail(`invalid Debt namespace selector: ${selector}`);
  if (selector === "debt/") return;
  try {
    parseDebtNamespaceSelector(selector);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function validateDebtScan(action: DebtAction, scanned: ScannedDebt, fail: (message: string) => never): void {
  const spec = DEBT_COMMAND_SPECS[action],
    { positionals, flags, stdin } = scanned;
  if (positionals.length < spec.arity[0])
    fail(spec.arity[1] === 1 ? `debt ${action} requires a DebtId` : `debt ${action} requires at least one DebtId`);
  if (positionals.length > spec.arity[1])
    fail(
      spec.arity[1] === 0
        ? `debt ${action} accepts no positional arguments`
        : `debt ${action} accepts at most ${spec.arity[1]} positional argument${spec.arity[1] === 1 ? "" : "s"}`,
    );
  if (action === "add" && (stdin === "document") === (positionals.length === 1))
    fail("debt add requires either TITLE or '-' input");
  if (
    action === "add" &&
    stdin === "document" &&
    Object.keys(flags).some((name) => name !== "json" && name !== "namespace" && name !== "actor")
  )
    fail("debt add document input owns its creation fields");
  if (DEBT_ID_ACTIONS.has(action)) validateDebtIdPositionals(positionals, fail);
  if (action === "ls" && positionals.length === 1) {
    validateListSelector(positionals[0]!, fail);
    if (flags.world === true) fail("--world cannot be combined with an explicit Debt namespace selector");
  }
  validateDebtReadFlags(action, flags, fail);
  if (action === "update") validateUpdate(scanned, fail);
}

export function parseDebtCommand(argv: readonly string[]): ParsedDebtCommand {
  const candidate = argv[0];
  if (!isDebtAction(candidate)) {
    throw new CliUsageError(
      `unknown debt command: ${candidate ?? ""}`,
      unknownCommandGuide(DEBT_FAMILY_USAGE_GUIDE, candidate ?? ""),
    );
  }
  const action = candidate;
  const fail = (message: string): never => {
    throw new CliUsageError(message, debtUsageGuide(action));
  };
  const scanned = scanArgs(argv, scanSpec(action, DEBT_COMMAND_SPECS[action]), fail);
  validateDebtScan(action, scanned, fail);
  let where: DebtQueryExpression | undefined;
  if (action === "query" && typeof scanned.flags.where === "string") {
    try {
      where = parseDebtQueryExpression(scanned.flags.where);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    command: "debt",
    action,
    output: scanned.flags.json === true ? "json" : "text",
    ...scanned,
    ...(where === undefined ? {} : { where }),
  };
}
