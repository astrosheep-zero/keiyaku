import { archetypeName } from "../../akuma/identity.js";
import type { CatalogQuery } from "../../library/catalog.js";
import { CliUsageError, usageLine } from "../usage.js";

export type ContractFlagKind = "boolean" | "value" | "raw-value" | "repeat-value";

export type ContractCommandSpec = Readonly<{
  positional: "none" | "optional";
  stdin: "none" | "optional" | "required";
  flags: Readonly<Record<string, ContractFlagKind>>;
  usage: string;
  purpose: string;
  details?: string;
}>;

type Output = Readonly<{ output: "text" | "json" }>;
type Actor = Readonly<{ actor?: string }>;

function parseAkumaCatalogPath(
  value: string,
): Readonly<{ kind: "archetypes" } | { kind: "akuma"; archetype?: string }> | null {
  if (value === "aku" || value === "aku/") return { kind: "archetypes" };
  if (value === "aku/*/*") return { kind: "akuma" };
  const match = /^aku\/([^/]+)\/?$/u.exec(value);
  if (match === null) return null;
  return { kind: "akuma", archetype: archetypeName(match[1]!) };
}

export type ParsedBind = Output &
  Actor &
  Readonly<{
    command: "bind";
    forkOf?: string;
    task?: string;
    target?: string;
    after?: readonly string[];
    gates?: readonly string[];
  }>;
export type ParsedAmend = Output &
  Actor &
  Readonly<{
    command: "amend";
    contract?: string;
    after?: readonly string[];
    clearAfter?: true;
    gates?: readonly string[];
    stdin?: true;
  }>;
export type ParsedDeliver = Output &
  Actor &
  Readonly<{
    command: "deliver";
    contract?: string;
    message?: string;
    includeDirty: boolean;
    materializeConflict: boolean;
  }>;
export type ParsedReview = Output &
  Actor &
  Readonly<{
    command: "review";
    contract?: string;
    verdict: "satisfied" | "unsatisfied";
    summary?: string;
    summaryFromStdin?: true;
  }>;
export type ParsedArc = Output &
  Actor &
  Readonly<{
    command: "arc";
    contract?: string;
  }>;
export type ParsedAbandon = Output &
  Actor &
  Readonly<{
    command: "abandon";
    contract?: string;
    note?: string;
  }>;
export type ParsedStatus = Output &
  (
    | Readonly<{ command: "status"; contract?: string; akuma?: never }>
    | Readonly<{ command: "status"; contract: string; akuma: true }>
  );
export type ParsedLs = Output & Readonly<{ command: "ls"; query: CatalogQuery }>;
export type ParsedAudit = Output &
  Readonly<{
    command: "audit";
    contract?: string;
    includeDirty: boolean;
    showDiff: boolean;
    actor?: string;
  }>;
export type ParsedReconcile = Output & Readonly<{ command: "reconcile"; contract?: string; retryHooks: boolean }>;
export type ParsedNuke = Output & Readonly<{ command: "nuke"; confirm?: string }>;
export type ParsedSettings = Output & Readonly<{ command: "settings" }>;
export type ParsedRegion = Output &
  Readonly<{
    command: "region";
    contract?: string;
    paths?: readonly [string, ...string[]];
  }>;
export type ParsedShow = Output & Readonly<{ command: "show"; contract?: string }>;

export const CONTRACT_COMMAND_SPECS = {
  bind: {
    positional: "none",
    stdin: "optional",
    flags: {
      actor: "value",
      task: "value",
      target: "value",
      after: "repeat-value",
      gates: "raw-value",
      "fork-of": "value",
      json: "boolean",
    },
    usage:
      "bind [--task <task/...>] [--target <ref>] [--after <kei/...> ...] [--gates <name,...>] [--actor <actor>] - | bind --fork-of <kei/...> [--target <ref>] [--actor <actor>]",
    purpose: "Create one Contract from stdin Markdown or a sibling fork.",
  },
  amend: {
    positional: "optional",
    stdin: "optional",
    flags: { actor: "value", after: "repeat-value", "clear-after": "boolean", gates: "raw-value", json: "boolean" },
    usage:
      "amend [<contract>|@<contract>] [--after <kei/...> ... | --clear-after] [--gates <name,...>] [--actor <actor>] [-]",
    purpose: "Amend one Contract's document operations or structured terms.",
    details: [
      "  ## Replace: Context|Objective|Design|Region|Criteria|Verification|<extension>",
      "  ## Append: Context|Objective|Design|Criteria|<extension>",
      "  ## Add: Criteria|<new-extension-title>",
      "  ## Update: <existing-extension-title>",
      "  ## Remove: Criterion <existing-title>",
      "  ## Remove: <existing-extension-title>",
    ].join("\n"),
  },
  deliver: {
    positional: "optional",
    stdin: "none",
    flags: {
      actor: "value",
      message: "value",
      "include-dirty": "boolean",
      "materialize-conflict": "boolean",
      json: "boolean",
    },
    usage:
      "deliver [<contract>|@<contract>] [--message <text>] [--include-dirty] [--materialize-conflict] [--actor <actor>]",
    purpose: "Deliver one Contract candidate from the appointed worktree.",
    details: [
      "  --include-dirty         Capture the complete non-ignored worktree tree as the",
      "                          candidate; stages nothing, commits nothing. Refused",
      "                          while unmerged paths exist.",
      "  --materialize-conflict  After a conflict result, project the judged targetHead",
      "                          into the worktree as an uncommitted merge. Not a",
      "                          delivery: resolve, stage, deliver again.",
    ].join("\n"),
  },
  review: {
    positional: "optional",
    stdin: "optional",
    flags: { actor: "value", satisfied: "boolean", unsatisfied: "boolean", summary: "value", json: "boolean" },
    usage: "review [<contract>|@<contract>] (--satisfied | --unsatisfied) (--summary <text> | -) [--actor <actor>]",
    purpose: "Record one review verdict.",
  },
  arc: {
    positional: "optional",
    stdin: "required",
    flags: { actor: "value", json: "boolean" },
    usage: "arc [<contract>|@<contract>] [--actor <actor>] -",
    purpose: "Record stdin arc Markdown for one Contract.",
  },
  abandon: {
    positional: "optional",
    stdin: "none",
    flags: { actor: "value", note: "value", json: "boolean" },
    usage: "abandon [<contract>|@<contract>] [--note <text>] [--actor <actor>]",
    purpose: "Abandon one Contract with an optional note.",
  },
  status: {
    positional: "optional",
    stdin: "none",
    flags: { json: "boolean" },
    usage: "status [<contract>|@name|<aku/...>]",
    purpose: "Read the world status board or one Contract projection.",
  },
  show: {
    positional: "optional",
    stdin: "none",
    flags: { json: "boolean" },
    usage: "show [<contract>|@<contract>]",
    purpose: "Read one Contract guidance projection.",
  },
  ls: {
    positional: "optional",
    stdin: "none",
    flags: { json: "boolean" },
    usage:
      'ls task[/]\n       keiyaku ls kei[/]\n       keiyaku ls aku[/]\n       keiyaku ls aku/<akuma>[/]\n       keiyaku ls "aku/*/*"',
    purpose: "List one identity directory.",
  },
  audit: {
    positional: "optional",
    stdin: "none",
    flags: { "include-dirty": "boolean", diff: "boolean", actor: "value", json: "boolean" },
    usage: "audit [<contract>|@<contract>] [--include-dirty] [--diff] [--actor <actor>]",
    purpose: "Ask what candidate preparation, Verification, and target placement would do.",
  },
  reconcile: {
    positional: "optional",
    stdin: "none",
    flags: { "retry-hooks": "boolean", json: "boolean" },
    usage: "reconcile [<contract>|@<contract>] [--retry-hooks]",
    purpose: "Reconcile one Contract or the invocation world.",
  },
  nuke: {
    positional: "none",
    stdin: "none",
    flags: { confirm: "value", json: "boolean" },
    usage: "nuke [--confirm <WorldRoot>] [--json]",
    purpose: "Remove Keiyaku-owned data from one confirmed World.",
  },
  settings: {
    positional: "none",
    stdin: "none",
    flags: { json: "boolean" },
    usage: "settings",
    purpose: "Read user and project Settings resources.",
  },
  region: {
    positional: "optional",
    stdin: "none",
    flags: { path: "repeat-value", json: "boolean" },
    usage: "region [<contract>]\n       region --path <pattern> [--path <pattern> ...]",
    purpose: "Read active declared Contract Regions.",
  },
} as const satisfies Readonly<Record<string, ContractCommandSpec>>;

export type ContractCommand = keyof typeof CONTRACT_COMMAND_SPECS;

export type ParsedContractParts = Readonly<{
  command: ContractCommand;
  flags: Readonly<Record<string, string | true | readonly string[]>>;
  positionals: readonly string[];
  stdin: boolean;
  output: "text" | "json";
  actor?: string;
}>;

export type ParsedContractCommand =
  | ParsedBind
  | ParsedAmend
  | ParsedDeliver
  | ParsedReview
  | ParsedArc
  | ParsedAbandon
  | ParsedStatus
  | ParsedShow
  | ParsedLs
  | ParsedAudit
  | ParsedReconcile
  | ParsedNuke
  | ParsedSettings
  | ParsedRegion;

function optionalFlag(
  flags: Readonly<Record<string, string | true | readonly string[]>>,
  name: string,
): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function refuse(command: ContractCommand, message: string): never {
  throw new CliUsageError(message, renderContractUsage(command));
}

function parseGateBundleNames(parts: ParsedContractParts, command: "bind" | "amend"): readonly string[] | undefined {
  const value = optionalFlag(parts.flags, "gates");
  if (value === undefined) return undefined;
  const names = value.split(",");
  if (names.some((name) => name.length === 0)) {
    refuse(command, "--gates requires nonempty comma-separated names");
  }
  return names;
}

function parseBind(parts: ParsedContractParts): ParsedBind {
  const forkOf = optionalFlag(parts.flags, "fork-of");
  if (forkOf !== undefined) {
    if (parts.stdin) refuse("bind", "fork bind reads no stdin");
    for (const option of ["task", "after", "gates"]) {
      if (parts.flags[option] !== undefined) refuse("bind", `--${option} is not valid with --fork-of`);
    }
    const target = optionalFlag(parts.flags, "target");
    return {
      command: "bind",
      forkOf,
      ...(target === undefined ? {} : { target }),
      ...(parts.actor === undefined ? {} : { actor: parts.actor }),
      output: parts.output,
    };
  }
  if (!parts.stdin) refuse("bind", "bind requires stdin");
  const task = optionalFlag(parts.flags, "task");
  const target = optionalFlag(parts.flags, "target");
  const after =
    parts.flags.after === undefined ? [] : Array.isArray(parts.flags.after) ? parts.flags.after : [parts.flags.after];
  const gates = parseGateBundleNames(parts, "bind");
  return {
    command: "bind",
    ...(task === undefined ? {} : { task }),
    ...(target === undefined ? {} : { target }),
    ...(parts.flags.after === undefined ? {} : { after }),
    ...(gates === undefined ? {} : { gates }),
    ...(parts.actor === undefined ? {} : { actor: parts.actor }),
    output: parts.output,
  };
}

function parseAmend(parts: ParsedContractParts): ParsedAmend {
  const contract = parts.positionals[0];
  const after =
    parts.flags.after === undefined ? [] : Array.isArray(parts.flags.after) ? parts.flags.after : [parts.flags.after];
  if (parts.flags["clear-after"] === true && after.length > 0)
    refuse("amend", "--clear-after and --after are mutually exclusive");
  const gates = parseGateBundleNames(parts, "amend");
  if (!parts.stdin && parts.flags.after === undefined && parts.flags["clear-after"] !== true && gates === undefined) {
    refuse("amend", "amend requires stdin or --after, --clear-after, or --gates");
  }
  return {
    command: "amend",
    ...(contract === undefined ? {} : { contract }),
    ...(parts.flags.after === undefined ? {} : { after }),
    ...(parts.flags["clear-after"] === true ? { clearAfter: true as const } : {}),
    ...(gates === undefined ? {} : { gates }),
    ...(parts.actor === undefined ? {} : { actor: parts.actor }),
    ...(parts.stdin ? { stdin: true as const } : {}),
    output: parts.output,
  };
}

function parseDeliver(parts: ParsedContractParts): ParsedDeliver {
  const contract = parts.positionals[0];
  const message = optionalFlag(parts.flags, "message");
  return {
    command: "deliver",
    ...(contract === undefined ? {} : { contract }),
    ...(parts.actor === undefined ? {} : { actor: parts.actor }),
    ...(message === undefined ? {} : { message }),
    includeDirty: parts.flags["include-dirty"] === true,
    materializeConflict: parts.flags["materialize-conflict"] === true,
    output: parts.output,
  };
}

function parseReview(parts: ParsedContractParts): ParsedReview {
  if (Number(parts.flags.satisfied === true) + Number(parts.flags.unsatisfied === true) !== 1) {
    refuse("review", "review requires exactly one verdict flag");
  }
  const summary = optionalFlag(parts.flags, "summary");
  if (parts.stdin === (summary !== undefined)) {
    refuse("review", "review requires exactly one of --summary <text> or stdin '-'");
  }
  const contract = parts.positionals[0];
  return {
    command: "review",
    ...(contract === undefined ? {} : { contract }),
    verdict: parts.flags.satisfied === true ? "satisfied" : "unsatisfied",
    ...(summary === undefined ? {} : { summary }),
    ...(parts.stdin ? { summaryFromStdin: true as const } : {}),
    ...(parts.actor === undefined ? {} : { actor: parts.actor }),
    output: parts.output,
  };
}

function parseStatus(parts: ParsedContractParts): ParsedStatus {
  const contract = parts.positionals[0];
  if (contract?.startsWith("aku/") === true) {
    return { command: "status", contract, akuma: true, output: parts.output };
  }
  return { command: "status", ...(contract === undefined ? {} : { contract }), output: parts.output };
}

function parseRegion(parts: ParsedContractParts): ParsedRegion {
  const contract = parts.positionals[0];
  const pathFlag = parts.flags.path;
  const paths = pathFlag === undefined ? undefined : Array.isArray(pathFlag) ? pathFlag : [pathFlag];
  if (paths !== undefined && contract !== undefined) refuse("region", "--path cannot combine with a contract");
  return {
    command: "region",
    ...(contract === undefined ? {} : { contract }),
    ...(paths === undefined ? {} : { paths: paths as [string, ...string[]] }),
    output: parts.output,
  };
}

function parseLs(parts: ParsedContractParts): ParsedLs {
  const path = parts.positionals[0]!;
  if (path === "task" || path === "task/") return { command: "ls", query: { kind: "tasks" }, output: parts.output };
  if (path === "kei" || path === "kei/") return { command: "ls", query: { kind: "contracts" }, output: parts.output };
  try {
    const query = parseAkumaCatalogPath(path);
    if (query === null) refuse("ls", "ls requires a supported identity directory selector");
    return { command: "ls", query, output: parts.output };
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    refuse("ls", error instanceof Error ? error.message : "invalid ls directory");
  }
}

export function renderContractHelp(command: ContractCommand): string {
  const spec: ContractCommandSpec = CONTRACT_COMMAND_SPECS[command];
  const help = `${spec.purpose}\n\n${usageLine(spec.usage)}`;
  return spec.details === undefined ? help : `${help}\n\n${spec.details}`;
}

export function renderContractUsage(command: ContractCommand): string {
  return usageLine(CONTRACT_COMMAND_SPECS[command].usage);
}

export function parseContractCommand(parts: ParsedContractParts): ParsedContractCommand {
  switch (parts.command) {
    case "bind":
      return parseBind(parts);
    case "amend":
      return parseAmend(parts);
    case "deliver":
      return parseDeliver(parts);
    case "review":
      return parseReview(parts);
    case "arc": {
      const contract = parts.positionals[0];
      return {
        command: "arc",
        ...(contract === undefined ? {} : { contract }),
        ...(parts.actor === undefined ? {} : { actor: parts.actor }),
        output: parts.output,
      };
    }
    case "abandon": {
      const contract = parts.positionals[0];
      const note = optionalFlag(parts.flags, "note");
      return {
        command: "abandon",
        ...(contract === undefined ? {} : { contract }),
        ...(note === undefined ? {} : { note }),
        ...(parts.actor === undefined ? {} : { actor: parts.actor }),
        output: parts.output,
      };
    }
    case "status":
      return parseStatus(parts);
    case "show": {
      const contract = parts.positionals[0];
      return { command: "show", ...(contract === undefined ? {} : { contract }), output: parts.output };
    }
    case "ls":
      return parseLs(parts);
    case "audit": {
      const contract = parts.positionals[0];
      return {
        command: "audit",
        ...(contract === undefined ? {} : { contract }),
        includeDirty: parts.flags["include-dirty"] === true,
        showDiff: parts.flags.diff === true,
        ...(parts.actor === undefined ? {} : { actor: parts.actor }),
        output: parts.output,
      };
    }
    case "reconcile": {
      const contract = parts.positionals[0];
      return {
        command: "reconcile",
        ...(contract === undefined ? {} : { contract }),
        retryHooks: parts.flags["retry-hooks"] === true,
        output: parts.output,
      };
    }
    case "nuke": {
      const confirm = optionalFlag(parts.flags, "confirm");
      return { command: "nuke", ...(confirm === undefined ? {} : { confirm }), output: parts.output };
    }
    case "settings":
      return { command: "settings", output: parts.output };
    case "region":
      return parseRegion(parts);
  }
}
