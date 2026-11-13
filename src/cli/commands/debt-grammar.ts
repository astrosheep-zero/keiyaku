import {
  CliUsageError,
  commonInvocationOptions,
  DEBT_FAMILY_USAGE_GUIDE,
  unknownCommandGuide,
  type CliUsageGuide,
} from "../usage.js";
import { scanArgs, type ScanFlagKind, type ScanSpec, type ScannedArgs } from "../scan.js";
import { canonicalDebtId } from "../../debt/identity.js";

export type DebtAction = "add" | "doctor" | "update";
type DebtFlagValue = string | true | readonly string[];
type DebtStdin = "document" | "body";

export type ParsedDebtCommand = Readonly<{
  command: "debt";
  action: DebtAction;
  output: "text" | "json";
  positionals: readonly string[];
  flags: Readonly<Record<string, DebtFlagValue>>;
  stdin?: DebtStdin;
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
      priority: "value",
      needs: "raw-value",
      body: "raw-value",
    },
    usage: `debt add <TITLE> [--priority 0..3] [--needs <debt/...,debt/...>] [--body <text>]
debt add -`,
    purpose: "Create open work from flags or a Debt document on stdin.",
    details:
      "The stdin document is YAML front matter (title, priority, needs) followed by a Markdown body. --needs takes one comma-separated value.",
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
      body: "raw-value",
      note: "raw-value",
      state: "value",
      priority: "value",
      needs: "raw-value",
    },
    usage: `debt update <debt/...> [--title <text>] [--body <text>|-]
  [--note <text>] [--state open|done|drop]
  [--priority 0..3] [--needs <debt/...,debt/...>]`,
    purpose: "Replace a Debt's fields or change its disposition, including reopening.",
    details: [
      "Omitted fields are preserved. --needs replaces prerequisites with one comma-separated value.",
      '--body "", --note "", and --needs "" clear their fields.',
      "--body - reads replacement text from stdin, including an empty stream.",
    ].join("\n"),
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
  if (Object.keys(flags).every((name) => name === "json")) fail("debt update requires at least one update option");
}

/** Actions whose positionals are all addressed DebtIds validated by the native owner. */
const DEBT_ID_ACTIONS: ReadonlySet<DebtAction> = new Set(["update"]);

/** Validate every addressed DebtId positional through the native owner before any read or write. */
function validateDebtIdPositionals(positionals: readonly string[], fail: (message: string) => never): void {
  for (const debtId of positionals) {
    try {
      canonicalDebtId(debtId);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
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
  if (action === "add" && stdin === "document" && Object.keys(flags).some((name) => name !== "json"))
    fail("debt add document input owns its creation fields");
  if (DEBT_ID_ACTIONS.has(action)) validateDebtIdPositionals(positionals, fail);
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
  return {
    command: "debt",
    action,
    output: scanned.flags.json === true ? "json" : "text",
    ...scanned,
  };
}
