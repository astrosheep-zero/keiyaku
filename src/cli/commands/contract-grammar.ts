import { validateAkumaName } from "../../identity/normalize.js";
import { parseAkumaId } from "../../akuma/identity.js";
import { canonicalDebtId } from "../../debt/identity.js";
import { contractId } from "../../core/facts/types.js";
import type { CliRequest, PendingRequest, VerbRequest } from "../parse.js";
import { CliUsageError, commandGuide } from "../usage.js";
import { CONTRACT_COMMAND_SPECS, type ContractCommand } from "./contract-help.js";

export type ContractTokens = Readonly<{
  command: ContractCommand;
  flags: Readonly<Record<string, string | true | readonly string[]>>;
  positionals: readonly string[];
  stdin: boolean;
  output: "text" | "json";
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
  const input = {
    ...(contract === undefined ? {} : { contract }),
    ...(parts.flags["clear-after"] === true ? { after: [] } : parts.flags.after === undefined ? {} : { after }),
    ...(gates === undefined ? {} : { gates }),
  };
  if (parts.stdin) return { name: "amend", input, acquire: { markdown: true }, output: parts.output };
  return {
    name: "amend",
    input: gates === undefined ? { ...input, after } : { ...input, gates },
    output: parts.output,
  };
}

function parseDeliver(parts: ContractTokens): VerbRequest<"deliver"> {
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
  return {
    name: "deliver",
    input: dryRun
      ? { ...selected, dryRun: true, showDiff: parts.flags["show-diff"] === true }
      : {
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
  };
  return summary === undefined
    ? { name: "review", input, acquire: { summary: true }, output: parts.output }
    : { name: "review", input: { ...input, summary }, output: parts.output };
}

function showSelector(parts: ContractTokens): string | undefined {
  const selected = parts.positionals[0];
  if (selected !== undefined && ["aku/", "kei", "kei/", "kei/*"].includes(selected))
    refuse("show", "show cannot select a category");
  if (parts.positionals.length > 1) refuse("show", "show accepts at most one Contract selector");
  if (selected === "aku" || selected?.startsWith("aku/") === true) refuse("show", "show cannot select an Akuma");
  if (selected !== undefined && !selected.startsWith("@") && /[*?\[\]]/u.test(selected))
    refuse("show", `unsupported show glob: ${selected}`);
  return selected;
}

function parseStatus(parts: ContractTokens): CliRequest {
  if (parts.positionals.length > 1) refuse("status", "status accepts at most one complete identity or @name");
  const selector = parts.positionals[0];
  if (selector === undefined) refuse("status", "status requires one subject; use kanshi for the World board");
  if (/[*?\[\]]/u.test(selector)) refuse("status", `unsupported status glob: ${selector}`);
  if (selector.startsWith("@")) return { name: "status", input: {}, acquire: { selector }, output: parts.output };
  try {
    if (selector.startsWith("kei/"))
      return { name: "status", input: { id: contractId(selector) }, output: parts.output };
    if (selector.startsWith("aku/"))
      return { name: "status", input: { id: parseAkumaId(selector).id }, output: parts.output };
  } catch (error) {
    refuse("status", error instanceof Error ? error.message : String(error));
  }
  refuse("status", "status requires one complete Contract or Akuma identity or @name");
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

function listLimit(parts: ContractTokens): number | undefined {
  const limit = optionalFlag(parts.flags, "limit");
  if (limit !== undefined && (!/^[1-9][0-9]*$/u.test(limit) || !Number.isSafeInteger(Number(limit))))
    refuse("ls", "--limit requires a positive safe integer");
  return limit === undefined ? undefined : Number(limit);
}

function validateInstanceCatalogue(selector: string): void {
  const match = /^aku\/([^/]+)(?:\/\*|\/)?$/u.exec(selector);
  if (match === null || (match[1] === "*" && selector === "aku/*/"))
    refuse("ls", "ls requires a supported identity directory selector");
  if (match[1] === "*") return;
  try {
    validateAkumaName(match[1]!);
  } catch (error) {
    refuse("ls", error instanceof Error ? error.message : String(error));
  }
}

function parseLs(parts: ContractTokens): VerbRequest<"ls"> {
  const selector = parts.positionals[0] ?? (parts.flags.mine === true ? "aku/*" : undefined);
  if (selector === undefined) refuse("ls", "ls requires a selector");
  const limit = listLimit(parts);
  const bound = limit === undefined ? {} : { limit };
  const mine = parts.flags.mine === true;
  const all = parts.flags.all === true,
    closed = parts.flags.closed === true;
  if (all && closed) refuse("ls", "--all and --closed are mutually exclusive");
  if (selector === "debt" || selector === "debt/") {
    if (mine) refuse("ls", "--mine selects Akuma instances only");
    return {
      name: "ls",
      input: { selector, ...bound, ...(all ? { selection: "all" } : closed ? { selection: "closed" } : {}) },
      output: parts.output,
    };
  }
  if (all || closed) refuse("ls", "--all and --closed select Debts only");
  if (["kei", "kei/", "aku", "aku/"].includes(selector)) {
    if (mine) refuse("ls", "--mine selects Akuma instances only");
  } else validateInstanceCatalogue(selector);
  return {
    name: "ls",
    input: { selector, ...bound, ...(mine ? { mine: true } : {}) },
    output: parts.output,
  };
}

export function parseContractCommand(parts: ContractTokens): CliRequest {
  const contract = parts.positionals[0];
  const selected = contract === undefined ? {} : { contract };
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
      return { name: "arc", input: selected, acquire: { markdown: true }, output };
    case "abandon": {
      const note = optionalFlag(parts.flags, "note");
      return { name: "abandon", input: { ...selected, ...(note === undefined ? {} : { note }) }, output };
    }
    case "show": {
      if (parts.positionals.some((selector) => selector.startsWith("debt/"))) {
        if (parts.positionals.some((selector) => !selector.startsWith("debt/")))
          refuse("show", "show cannot mix Debt and Contract selectors");
        try {
          for (const selector of parts.positionals) canonicalDebtId(selector);
        } catch (error) {
          refuse("show", error instanceof Error ? error.message : String(error));
        }
        const ids = parts.positionals;
        return { name: "show", input: { ids }, output };
      }
      const contract = showSelector(parts);
      return { name: "show", input: contract === undefined ? {} : { ids: parts.positionals }, output };
    }
    case "kanshi":
      return { name: "kanshi", input: {}, output };
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
