import { validateAkumaName } from "../../identity/normalize.js";
import { decodeAkumaCaller, type AkumaCaller } from "../../akuma/caller.js";
import { parseAkuId, type AkuId } from "../../akuma/identity.js";
import { parseDebtNamespaceSelector } from "../../debt/catalog.js";
import { CliUsageError, commandGuide } from "../usage.js";
import { CONTRACT_COMMAND_SPECS, type ContractCommand } from "./contract-help.js";

type AkumaCallerSelector =
  | Readonly<{ kind: "mine" }>
  | Readonly<{ kind: "external"; caller: AkumaCaller }>
  | Readonly<{ kind: "akuma"; akuId: AkuId }>;
type CatalogQuery =
  | Readonly<{ kind: "debts"; namespace?: readonly string[]; limit?: number }>
  | Readonly<{ kind: "contracts"; limit?: number }>
  | Readonly<{ kind: "archetypes"; limit?: number }>
  | Readonly<{ kind: "akuma"; archetype?: string; caller?: AkumaCallerSelector; limit?: number }>;
type Output = Readonly<{ output: "text" | "json" }>;
type Actor = Readonly<{ actor?: string }>;

function parseAkumaCatalogPath(
  value: string,
): Readonly<{ kind: "archetypes" } | { kind: "akuma"; archetype?: string }> | null {
  if (value === "aku" || value === "aku/") return { kind: "archetypes" };
  if (value === "aku/*/*") return { kind: "akuma" };
  const scopedGlob = /^aku\/([^/]+)\/\*$/u.exec(value);
  if (scopedGlob !== null) return { kind: "akuma", archetype: validateAkumaName(scopedGlob[1]!) };
  const match = /^aku\/([^/]+)\/?$/u.exec(value);
  if (match === null) return null;
  return { kind: "akuma", archetype: validateAkumaName(match[1]!) };
}

export type ParsedBind = Output &
  Actor &
  Readonly<{
    command: "bind";
    forkOf?: string;
    debt?: string;
    /** A literal target branch, or `null` for a deliberately targetless bind. */
    target?: string | null;
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
  Readonly<{
    command: "deliver";
    contract?: string;
    dryRun: boolean;
    showDiff: boolean;
    message?: string;
    includeDirty: boolean;
    materializeConflict: boolean;
    overwrite: boolean;
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
export type ParsedShow = Output & Readonly<{ command: "show"; contract?: string }>;
export type ParsedStatus = Output &
  (
    | Readonly<{
        command: "status";
        contract?: string;
        selectors?: readonly string[];
        akuma?: never;
        category?: never;
        limit?: never;
      }>
    | Readonly<{ command: "status"; contract: string; akuma: true; category?: never; limit?: never }>
    | Readonly<{
        command: "status";
        category: StatusCategory;
        limit?: number;
        contract?: never;
        selectors?: never;
        akuma?: never;
      }>
  );
export type ParsedLs = Output & Readonly<{ command: "ls"; query: CatalogQuery }>;
export type ParsedReconcile = Output & Readonly<{ command: "reconcile"; contract?: string; retryHooks: boolean }>;
export type ParsedNuke = Output & Readonly<{ command: "nuke"; confirm?: string }>;
export type ParsedSettings = Output & Readonly<{ command: "settings" }>;
export type ParsedRegion = Output &
  Readonly<{
    command: "region";
    contract?: string;
    paths?: readonly [string, ...string[]];
  }>;

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
  | ParsedShow
  | ParsedStatus
  | ParsedLs
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
  throw new CliUsageError(message, commandGuide(command, CONTRACT_COMMAND_SPECS[command].usage));
}

// The CLI restates the literal gate-word grammar its help prints; the corpus
// pin in cli-parse.test.ts keeps this shape honest against the owner's gateWord.
const GATE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

function parseGateNames(parts: ParsedContractParts, command: "bind" | "amend"): readonly string[] | undefined {
  const value = optionalFlag(parts.flags, "gates");
  if (value === undefined) return undefined;
  if (value === "") return [];
  const names = value.split(",");
  if (names.some((name) => name.length === 0)) {
    refuse(command, '--gates requires comma-separated names or "" to clear gates');
  }
  const invalid = names.find((name) => !GATE_NAME_PATTERN.test(name));
  if (invalid !== undefined) {
    refuse(command, `--gates name must match ^[a-z][a-z0-9-]{0,63}$: ${invalid}`);
  }
  return names;
}

function parseBindTarget(parts: ParsedContractParts): string | null | undefined {
  const target = optionalFlag(parts.flags, "target");
  const noTarget = parts.flags["no-target"] === true;
  if (target !== undefined && noTarget) refuse("bind", "--target and --no-target are mutually exclusive");
  return noTarget ? null : target;
}

function parseBind(parts: ParsedContractParts): ParsedBind {
  const forkOf = optionalFlag(parts.flags, "fork-of");
  if (forkOf !== undefined) {
    if (parts.stdin) refuse("bind", "fork bind reads no stdin");
    for (const option of ["debt", "after", "gates"]) {
      if (parts.flags[option] !== undefined) refuse("bind", `--${option} is not valid with --fork-of`);
    }
    const target = parseBindTarget(parts);
    return {
      command: "bind",
      forkOf,
      ...(target === undefined ? {} : { target }),
      ...(parts.actor === undefined ? {} : { actor: parts.actor }),
      output: parts.output,
    };
  }
  if (!parts.stdin) refuse("bind", "bind requires stdin");
  const debt = optionalFlag(parts.flags, "debt");
  const target = parseBindTarget(parts);
  const after =
    parts.flags.after === undefined ? [] : Array.isArray(parts.flags.after) ? parts.flags.after : [parts.flags.after];
  const gates = parseGateNames(parts, "bind");
  return {
    command: "bind",
    ...(debt === undefined ? {} : { debt }),
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
  const gates = parseGateNames(parts, "amend");
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
  const dryRun = parts.flags["dry-run"] === true;
  if (dryRun) {
    for (const flag of ["materialize-conflict", "overwrite", "message"]) {
      if (parts.flags[flag] !== undefined) refuse("deliver", `--${flag} is not valid with --dry-run`);
    }
  } else if (parts.flags["show-diff"] === true) {
    refuse("deliver", "--show-diff requires --dry-run");
  }
  return {
    command: "deliver",
    dryRun,
    showDiff: parts.flags["show-diff"] === true,
    ...(contract === undefined ? {} : { contract }),
    ...(message === undefined ? {} : { message }),
    includeDirty: parts.flags["include-dirty"] === true,
    materializeConflict: parts.flags["materialize-conflict"] === true,
    overwrite: parts.flags.overwrite === true,
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

// Only these fixed category forms are status selectors.
const STATUS_CATEGORY_SELECTORS: ReadonlyMap<string, StatusCategory> = new Map([
  ["aku", "akuma"],
  ["aku/", "akuma"],
  ["aku/*", "akuma"],
  ["kei", "contract"],
  ["kei/", "contract"],
  ["kei/*", "contract"],
]);

export type StatusCategory = "akuma" | "contract";

function rejectStatusGlobs(positionals: readonly string[]): void {
  for (const selector of positionals) {
    if (!STATUS_CATEGORY_SELECTORS.has(selector) && !selector.startsWith("@") && /[*?\[\]]/u.test(selector))
      refuse("status", `unsupported status glob: ${selector}`);
  }
}

function showSelector(parts: ParsedContractParts): string | undefined {
  const selected = parts.positionals[0];
  if (selected !== undefined && STATUS_CATEGORY_SELECTORS.has(selected))
    refuse("show", "show cannot select a category");
  if (parts.positionals.length > 1) refuse("show", "show accepts at most one Contract selector");
  if (selected?.startsWith("aku/") === true) refuse("show", "show cannot select an Akuma");
  if (selected !== undefined && !selected.startsWith("@") && /[*?\[\]]/u.test(selected))
    refuse("show", `unsupported show glob: ${selected}`);
  return selected;
}

function parseStatus(parts: ParsedContractParts): ParsedStatus {
  const limit = listLimit(parts, "status");
  rejectStatusGlobs(parts.positionals);
  if (parts.positionals.length > 1) {
    if (limit !== undefined) refuse("status", "--limit is valid only for one category selector");
    if (parts.positionals.some((selector) => STATUS_CATEGORY_SELECTORS.has(selector)))
      refuse("status", "a category selector cannot combine with other selectors");
    return { command: "status", selectors: parts.positionals, output: parts.output };
  }
  const selected = parts.positionals[0];
  const category = selected === undefined ? undefined : STATUS_CATEGORY_SELECTORS.get(selected);
  if (category !== undefined)
    return { command: "status", category, ...(limit === undefined ? {} : { limit }), output: parts.output };
  if (limit !== undefined) refuse("status", "--limit is valid only for a category selector");
  if (selected?.startsWith("aku/") === true)
    return { command: "status", contract: selected, akuma: true, output: parts.output };
  return { command: "status", ...(selected === undefined ? {} : { contract: selected }), output: parts.output };
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

function listLimit(parts: ParsedContractParts, command: "ls" | "status" = "ls"): number | undefined {
  const limit = optionalFlag(parts.flags, "limit");
  if (limit !== undefined && (!/^[1-9][0-9]*$/u.test(limit) || !Number.isSafeInteger(Number(limit))))
    refuse(command, "--limit requires a positive safe integer");
  return limit === undefined ? undefined : Number(limit);
}

function debtCatalogQuery(path: string, limit: number | undefined): CatalogQuery | null {
  if (path === "debt" || path === "debt/") {
    return { kind: "debts", namespace: [], ...(limit === undefined ? {} : { limit }) };
  }
  if (!path.startsWith("debt/")) return null;
  if (!path.endsWith("/")) refuse("ls", `invalid Debt namespace selector: ${path}`);
  const body = path.slice("debt/".length, -1);
  if (body.length === 0 || body.split("/").some((segment) => segment.length === 0))
    refuse("ls", `invalid Debt namespace selector: ${path}`);
  try {
    const namespace = parseDebtNamespaceSelector(path);
    return { kind: "debts", namespace, ...(limit === undefined ? {} : { limit }) };
  } catch (error) {
    refuse("ls", error instanceof Error ? error.message : `invalid Debt namespace selector: ${path}`);
  }
}

function parseCallerSelector(parts: ParsedContractParts): AkumaCallerSelector | undefined {
  const mine = parts.flags.mine === true;
  const value = optionalFlag(parts.flags, "caller");
  if (mine && value !== undefined) refuse("ls", "--mine and --caller are mutually exclusive");
  if (mine) return { kind: "mine" };
  if (value === undefined) return undefined;
  const text = value.trim();
  if (text.startsWith("aku/")) {
    try {
      return { kind: "akuma", akuId: parseAkuId(text).id };
    } catch (error) {
      refuse("ls", `--caller has an invalid Akuma identity: ${error instanceof Error ? error.message : text}`);
    }
  }
  const colon = text.indexOf(":");
  if (colon < 0) refuse("ls", "--caller requires <integration>:<id> or aku/<name>/<suffix>");
  try {
    const caller = decodeAkumaCaller({
      kind: "external",
      integration: text.slice(0, colon),
      id: text.slice(colon + 1),
    });
    if (caller === undefined) refuse("ls", "--caller requires <integration>:<id> or aku/<name>/<suffix>");
    return { kind: "external", caller };
  } catch (error) {
    refuse("ls", `--caller is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseLs(parts: ParsedContractParts): ParsedLs {
  const path = parts.positionals[0];
  const limit = listLimit(parts);
  const caller = parseCallerSelector(parts);
  const callerRefusal = "--mine and --caller select Akuma instances only";
  if (path !== undefined) {
    const debtQuery = debtCatalogQuery(path, limit);
    if (debtQuery !== null) {
      if (caller !== undefined) refuse("ls", callerRefusal);
      return { command: "ls", query: debtQuery, output: parts.output };
    }
    if (path === "kei" || path === "kei/") {
      if (caller !== undefined) refuse("ls", callerRefusal);
      return {
        command: "ls",
        query: { kind: "contracts", ...(limit === undefined ? {} : { limit }) },
        output: parts.output,
      };
    }
    if (caller !== undefined && (path === "aku" || path === "aku/"))
      refuse("ls", "--mine and --caller need an Akuma instance catalogue, not Akuma names");
  }
  if (path === undefined && caller === undefined) refuse("ls", "ls requires a selector");
  try {
    const query = path === undefined ? ({ kind: "akuma" } as const) : parseAkumaCatalogPath(path);
    if (query === null) refuse("ls", "ls requires a supported identity directory selector");
    return {
      command: "ls",
      query: { ...query, ...(limit === undefined ? {} : { limit }), ...(caller === undefined ? {} : { caller }) },
      output: parts.output,
    };
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    refuse("ls", error instanceof Error ? error.message : "invalid ls directory");
  }
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
    case "show": {
      const contract = showSelector(parts);
      return { command: "show", ...(contract === undefined ? {} : { contract }), output: parts.output };
    }
    case "status":
      return parseStatus(parts);
    case "ls":
      return parseLs(parts);
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
