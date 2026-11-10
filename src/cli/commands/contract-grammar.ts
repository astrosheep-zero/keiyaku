import { validateAkumaName } from "../../identity/normalize.js";
import { decodeAkumaCaller } from "../../akuma/caller.js";
import { parseAkumaId } from "../../akuma/identity.js";
import { parseDebtNamespaceSelector } from "../../debt/catalog.js";
import { parseDebtId } from "../../debt/identity.js";
import type { VerbInput } from "../../library/keiyaku-verbs.js";
import type { CliRequest, PendingRequest, VerbRequest } from "../parse.js";
import { CliUsageError, commandGuide } from "../usage.js";
import { CONTRACT_COMMAND_SPECS, type ContractCommand } from "./contract-help.js";

type CatalogInput = VerbInput<"ls">;
type AkumaCallerSelector = Extract<CatalogInput, { of: "aku" }>["caller"];

function parseAkumaCatalogPath(value: string): CatalogInput | null {
  if (value === "aku" || value === "aku/") return { of: "akuma-name" };
  if (value === "aku/*/*") return { of: "aku" };
  const scopedGlob = /^aku\/([^/]+)\/\*$/u.exec(value);
  if (scopedGlob !== null) return { of: "aku", akumaName: validateAkumaName(scopedGlob[1]!) };
  const match = /^aku\/([^/]+)\/?$/u.exec(value);
  if (match === null) return null;
  return { of: "aku", akumaName: validateAkumaName(match[1]!) };
}

export type ContractTokens = Readonly<{
  command: ContractCommand;
  flags: Readonly<Record<string, string | true | readonly string[]>>;
  positionals: readonly string[];
  stdin: boolean;
  output: "text" | "json";
  actor?: string;
}>;

function optionalFlag(flags: ContractTokens["flags"], name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function refuse(command: ContractCommand, message: string): never {
  throw new CliUsageError(message, commandGuide(command, CONTRACT_COMMAND_SPECS[command].usage));
}

// The CLI restates the literal gate-word grammar its help prints; the corpus
// pin in cli-parse.test.ts keeps this shape honest against the owner's gateWord.
const GATE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

function parseGateNames(parts: ContractTokens, command: "bind" | "amend"): readonly string[] | undefined {
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

function parseBindTarget(parts: ContractTokens): string | null | undefined {
  const target = optionalFlag(parts.flags, "target");
  const noTarget = parts.flags["no-target"] === true;
  if (target !== undefined && noTarget) refuse("bind", "--target and --no-target are mutually exclusive");
  return noTarget ? null : target;
}

function parseBind(parts: ContractTokens): VerbRequest<"bind"> | Extract<PendingRequest, { name: "bind" }> {
  const forkOf = optionalFlag(parts.flags, "fork-of");
  if (forkOf !== undefined) {
    if (parts.stdin) refuse("bind", "fork bind reads no stdin");
    for (const option of ["debt", "after", "gates"]) {
      if (parts.flags[option] !== undefined) refuse("bind", `--${option} is not valid with --fork-of`);
    }
    const target = parseBindTarget(parts);
    return {
      name: "bind",
      input: {
        forkOf,
        ...(target === undefined ? {} : { target }),
        ...(parts.actor === undefined ? {} : { actor: parts.actor }),
      },
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
    name: "bind",
    input: {
      ...(debt === undefined ? {} : { debt }),
      ...(target === undefined ? {} : { target }),
      ...(parts.flags.after === undefined ? {} : { after }),
      ...(gates === undefined ? {} : { gates }),
      ...(parts.actor === undefined ? {} : { actor: parts.actor }),
    },
    acquire: { markdown: true },
    output: parts.output,
  };
}

function parseAmend(parts: ContractTokens): CliRequest {
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
    name: "amend",
    input: {
      ...(contract === undefined ? {} : { contract }),
      ...(parts.flags["clear-after"] === true ? { after: [] } : parts.flags.after === undefined ? {} : { after }),
      ...(gates === undefined ? {} : { gates }),
      ...(parts.actor === undefined ? {} : { actor: parts.actor }),
    },
    ...(parts.stdin ? { acquire: { markdown: true as const } } : {}),
    output: parts.output,
  };
}

function parseDeliver(parts: ContractTokens): VerbRequest<"deliver" | "deliver.preview"> {
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
  const selected = {
    ...(contract === undefined ? {} : { contract }),
    includeDirty: parts.flags["include-dirty"] === true,
  };
  return dryRun
    ? {
        name: "deliver.preview",
        input: { ...selected, showDiff: parts.flags["show-diff"] === true },
        output: parts.output,
      }
    : {
        name: "deliver",
        input: {
          ...selected,
          ...(message === undefined ? {} : { message }),
          materializeConflict: parts.flags["materialize-conflict"] === true,
          overwrite: parts.flags.overwrite === true,
        },
        output: parts.output,
      };
}

function parseVerify(parts: ContractTokens): VerbRequest<"verify"> {
  const contract = parts.positionals[0];
  const index = optionalFlag(parts.flags, "index");
  if (index !== undefined && (!/^[1-9][0-9]*$/u.test(index) || !Number.isSafeInteger(Number(index))))
    refuse("verify", "--index requires a positive safe integer");
  return {
    name: "verify",
    input: {
      ...(contract === undefined ? {} : { contract }),
      ...(index === undefined ? {} : { index: Number(index) }),
      includeDirty: parts.flags["include-dirty"] === true,
    },
    output: parts.output,
  };
}

function parseReview(parts: ContractTokens): CliRequest {
  if (Number(parts.flags.satisfied === true) + Number(parts.flags.unsatisfied === true) !== 1) {
    refuse("review", "review requires exactly one verdict flag");
  }
  const summary = optionalFlag(parts.flags, "summary");
  if (parts.stdin === (summary !== undefined)) {
    refuse("review", "review requires exactly one of --summary <text> or stdin '-'");
  }
  const contract = parts.positionals[0];
  const input = {
    ...(contract === undefined ? {} : { contract }),
    verdict: parts.flags.satisfied === true ? ("satisfied" as const) : ("unsatisfied" as const),
    ...(parts.actor === undefined ? {} : { actor: parts.actor }),
  };
  return summary === undefined
    ? { name: "review", input, acquire: { summary: true }, output: parts.output }
    : { name: "review", input: { ...input, summary }, output: parts.output };
}

// Only these fixed category forms are status selectors.
const STATUS_CATEGORY_SELECTORS: ReadonlyMap<string, "akuma" | "contract"> = new Map([
  ["aku/", "akuma"],
  ["kei", "contract"],
  ["kei/", "contract"],
  ["kei/*", "contract"],
]);

function rejectStatusGlobs(positionals: readonly string[]): void {
  for (const selector of positionals) {
    if (selector === "aku" || selector === "aku/*") refuse("status", "Akuma category selector must be aku/");
    if (!STATUS_CATEGORY_SELECTORS.has(selector) && !selector.startsWith("@") && /[*?\[\]]/u.test(selector))
      refuse("status", `unsupported status glob: ${selector}`);
  }
}

function showSelector(parts: ContractTokens): string | undefined {
  const selected = parts.positionals[0];
  if (selected !== undefined && STATUS_CATEGORY_SELECTORS.has(selected))
    refuse("show", "show cannot select a category");
  if (parts.positionals.length > 1) refuse("show", "show accepts at most one Contract selector");
  if (selected === "aku" || selected?.startsWith("aku/") === true) refuse("show", "show cannot select an Akuma");
  if (selected !== undefined && !selected.startsWith("@") && /[*?\[\]]/u.test(selected))
    refuse("show", `unsupported show glob: ${selected}`);
  return selected;
}

function parseStatus(parts: ContractTokens): VerbRequest<"status"> {
  const limit = listLimit(parts, "status");
  rejectStatusGlobs(parts.positionals);
  if (parts.positionals.length > 1) {
    if (limit !== undefined) refuse("status", "--limit is valid only for one category selector");
    if (parts.positionals.some((selector) => STATUS_CATEGORY_SELECTORS.has(selector)))
      refuse("status", "a category selector cannot combine with other selectors");
    return { name: "status", input: { selectors: parts.positionals }, output: parts.output };
  }
  const selector = parts.positionals[0];
  const category = selector === undefined ? undefined : STATUS_CATEGORY_SELECTORS.get(selector);
  if (category !== undefined)
    return { name: "status", input: { category, ...(limit === undefined ? {} : { limit }) }, output: parts.output };
  if (limit !== undefined) refuse("status", "--limit is valid only for a category selector");
  return { name: "status", input: selector === undefined ? {} : { selector }, output: parts.output };
}

function parseRegion(parts: ContractTokens): VerbRequest<"region"> {
  const contract = parts.positionals[0];
  const pathFlag = parts.flags.path;
  const paths = pathFlag === undefined ? undefined : Array.isArray(pathFlag) ? pathFlag : [pathFlag];
  if (paths !== undefined && contract !== undefined) refuse("region", "--path cannot combine with a contract");
  return {
    name: "region",
    input: paths !== undefined ? { paths } : contract === undefined ? {} : { contract },
    output: parts.output,
  };
}

function listLimit(parts: ContractTokens, command: "ls" | "status" = "ls"): number | undefined {
  const limit = optionalFlag(parts.flags, "limit");
  if (limit !== undefined && (!/^[1-9][0-9]*$/u.test(limit) || !Number.isSafeInteger(Number(limit))))
    refuse(command, "--limit requires a positive safe integer");
  return limit === undefined ? undefined : Number(limit);
}

function debtCatalogQuery(path: string, limit: number | undefined): Extract<CatalogInput, { of: "debt" }> | null {
  if (path === "debt" || path === "debt/")
    return { of: "debt", namespace: [], ...(limit === undefined ? {} : { limit }) };
  if (!path.startsWith("debt/")) return null;
  if (!path.endsWith("/")) refuse("ls", `invalid Debt namespace selector: ${path}`);
  const body = path.slice("debt/".length, -1);
  if (body.length === 0 || body.split("/").some((segment) => segment.length === 0))
    refuse("ls", `invalid Debt namespace selector: ${path}`);
  try {
    const namespace = parseDebtNamespaceSelector(path);
    return { of: "debt", namespace, ...(limit === undefined ? {} : { limit }) };
  } catch (error) {
    refuse("ls", error instanceof Error ? error.message : `invalid Debt namespace selector: ${path}`);
  }
}

function parseCallerSelector(parts: ContractTokens): AkumaCallerSelector {
  const mine = parts.flags.mine === true;
  const value = optionalFlag(parts.flags, "caller");
  if (mine && value !== undefined) refuse("ls", "--mine and --caller are mutually exclusive");
  if (mine) return { kind: "mine" };
  if (value === undefined) return undefined;
  const text = value.trim();
  if (text.startsWith("aku/")) {
    try {
      return { kind: "akuma", akumaId: parseAkumaId(text).id };
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

function parseAkumaLs(
  parts: ContractTokens,
  path: string | undefined,
  limit: number | undefined,
  caller: AkumaCallerSelector,
): VerbRequest<"ls"> {
  if (path === undefined && caller === undefined) refuse("ls", "ls requires a selector");
  try {
    const query = path === undefined ? { of: "aku" as const } : parseAkumaCatalogPath(path);
    if (query === null) refuse("ls", "ls requires a supported identity directory selector");
    return {
      name: "ls",
      input: { ...query, ...(limit === undefined ? {} : { limit }), ...(caller === undefined ? {} : { caller }) },
      output: parts.output,
    };
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    refuse("ls", error instanceof Error ? error.message : "invalid ls directory");
  }
}

function parseLs(parts: ContractTokens): VerbRequest<"ls"> {
  const path = parts.positionals[0];
  const limit = listLimit(parts);
  const caller = parseCallerSelector(parts);
  const callerRefusal = "--mine and --caller select Akuma instances only";
  const all = parts.flags.all === true,
    closed = parts.flags.closed === true;
  if (all && closed) refuse("ls", "--all and --closed are mutually exclusive");
  if (path !== undefined) {
    const debtQuery = debtCatalogQuery(path, limit);
    if (debtQuery !== null) {
      if (caller !== undefined) refuse("ls", callerRefusal);
      return {
        name: "ls",
        input: { ...debtQuery, ...(all ? { selection: "all" } : closed ? { selection: "closed" } : {}) },
        output: parts.output,
      };
    }
    if (all || closed) refuse("ls", "--all and --closed select Debts only");
    if (path === "kei" || path === "kei/") {
      if (caller !== undefined) refuse("ls", callerRefusal);
      return { name: "ls", input: { of: "kei", ...(limit === undefined ? {} : { limit }) }, output: parts.output };
    }
    if (caller !== undefined && (path === "aku" || path === "aku/"))
      refuse("ls", "--mine and --caller need an Akuma instance catalogue, not Akuma names");
  }
  if (all || closed) refuse("ls", "--all and --closed select Debts only");
  return parseAkumaLs(parts, path, limit, caller);
}

export function parseContractCommand(parts: ContractTokens): CliRequest {
  const contract = parts.positionals[0];
  const selected = contract === undefined ? {} : { contract };
  const actor = parts.actor === undefined ? {} : { actor: parts.actor };
  const output = parts.output;
  switch (parts.command) {
    case "bind":
      return parseBind(parts);
    case "amend":
      return parseAmend(parts);
    case "deliver":
      return parseDeliver(parts);
    case "verify":
      return parseVerify(parts);
    case "review":
      return parseReview(parts);
    case "arc":
      return { name: "arc", input: { ...selected, ...actor }, acquire: { markdown: true }, output };
    case "abandon": {
      const note = optionalFlag(parts.flags, "note");
      return { name: "abandon", input: { ...selected, ...actor, ...(note === undefined ? {} : { note }) }, output };
    }
    case "show": {
      if (parts.positionals.some((selector) => selector.startsWith("debt/"))) {
        if (parts.positionals.some((selector) => !selector.startsWith("debt/")))
          refuse("show", "show cannot mix Debt and Contract selectors");
        try {
          for (const selector of parts.positionals) parseDebtId(selector);
        } catch (error) {
          refuse("show", error instanceof Error ? error.message : String(error));
        }
        const ids = parts.positionals;
        return { name: "debt.show", input: ids.length === 1 ? { id: ids[0]! } : { ids }, output };
      }
      const contract = showSelector(parts);
      return { name: "show", input: contract === undefined ? {} : { contract }, output };
    }
    case "status":
      return parseStatus(parts);
    case "ls":
      return parseLs(parts);
    case "reconcile":
      return { name: "reconcile", input: { ...selected, retryHooks: parts.flags["retry-hooks"] === true }, output };
    case "nuke": {
      const confirm = optionalFlag(parts.flags, "confirm");
      return { name: "nuke", input: confirm === undefined ? {} : { confirm }, output };
    }
    case "settings":
      return { name: "settings", input: {}, output };
    case "region":
      return parseRegion(parts);
  }
}
