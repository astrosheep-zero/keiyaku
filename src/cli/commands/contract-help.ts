import { usageLine } from "../usage.js";

export type ContractFlagKind = "boolean" | "value" | "raw-value" | "repeat-value";

export type ContractCommandSpec = Readonly<{
  positional: "none" | "optional";
  stdin: "none" | "optional" | "required";
  flags: Readonly<Record<string, ContractFlagKind>>;
  usage: string;
  purpose: string;
  details?: string;
}>;

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
    purpose: "Create a Contract from stdin Markdown or copy an existing Contract as a starting point.",
    details: [
      "--gates <name,...> accepts gate words and configured bundle names together.",
      "A matching bundle expands; otherwise the name is a literal gate. Duplicates",
      "are removed in first-seen order. Gate words match ^[a-z][a-z0-9-]{0,63}$.",
      "Omitting --gates selects gates.default, or reviewed when no default exists.",
      '--gates "" explicitly binds without gates; --gates reviewed needs no bundle.',
      "",
      "stdin is Contract Markdown:",
      "  # <title>",
      "  ## Context       motivation, authority, baseline, and boundaries",
      "  ## Objective    one observable end state",
      "  ## Design       the approach, important decisions, and ordering",
      "                  leave implementation details to the person doing the work",
      "  ## Region       narrowest justified intended writes for this approach, one pattern per line",
      "  ## Criteria     one or more ### <criterion> entries",
      "  ## Verification optional fenced executor declarations",
      "",
      "Region accepts the narrowest justified intended writes for this approach, not every potentially",
      "involved file. Do not use broad directory fallbacks or redundant parent/child patterns. Patterns",
      "are fenced lines, list items, or bare lines; the three forms union. Put one repository-relative",
      "path pattern on each nonblank line. A trailing '/' is directory shorthand for 'path/**'.",
      "A pattern containing whitespace binds with a warning. A fence carries no",
      "info string or exactly 'txt'.",
      "",
      "Verification uses one or more closed bash, zsh, or pwsh fences. Its fence",
      "may add timeout=<integer><ms|s|m|h>; the section contains no other prose.",
      "Unknown ## sections are retained as extensions; reserved section names are refused.",
    ].join("\n"),
  },
  amend: {
    positional: "optional",
    stdin: "optional",
    flags: { actor: "value", after: "repeat-value", "clear-after": "boolean", gates: "raw-value", json: "boolean" },
    usage:
      "amend [<contract>|@<contract>] [--after <kei/...> ... | --clear-after] [--gates <name,...>] [--actor <actor>] [-]",
    purpose: "Change a Contract's document, prerequisites, or acceptance gates.",
    details: [
      "--gates <name,...> replaces gates using gate words and configured bundle names.",
      "A matching bundle expands; otherwise the name is a literal gate. Duplicates",
      "are removed in first-seen order. Gate words match ^[a-z][a-z0-9-]{0,63}$.",
      'Omitting --gates leaves gates unchanged; --gates "" clears them.',
      "",
      "  ## Context|Objective|Design|Region|Criteria|Verification|<extension>  (replace, or add new extension)",
      "  ## Replace: Context|Objective|Design|Region|Criteria|Verification|<extension>",
      "  ## Append: Context|Objective|Design|Criteria|<extension>",
      "  ## Add: Criteria|<new-extension-title>",
      "  ## Update: <existing-extension-title>",
      "  ## Remove: <existing-extension-title>",
    ].join("\n"),
  },
  deliver: {
    positional: "optional",
    stdin: "none",
    flags: {
      message: "value",
      "include-dirty": "boolean",
      "materialize-conflict": "boolean",
      overwrite: "boolean",
      json: "boolean",
    },
    usage:
      "deliver [<contract>|@<contract>] [--message <text>] [--include-dirty] [--materialize-conflict] [--overwrite]",
    purpose: "Submit work for a Contract and integrate it when its requirements are met.",
    details: [
      "The Contract, not the current Arc, sets what delivery must satisfy. An Arc records progress; it does not narrow acceptance.",
      "Verification, integration, and cleanup progress appears on stderr; stdout contains one final result.",
      "By default, delivery uses HEAD. --include-dirty includes all non-ignored worktree changes, staged or not; it leaves your branch and index unchanged, so staging or committing is unnecessary.",
      "Repeating delivery with unchanged work resumes unfinished verification or integration. Changed work replaces the candidate.",
      "Delivery requests integration. If prerequisites and gates pass, it integrates now and claims the Contract; otherwise the candidate remains waiting.",
      "Only changed candidate work invalidates earlier review. If Verification did not finish, repeating delivery resumes that candidate; --overwrite replaces it.",
      "Delivery never counts as an independent review verdict.",
      "",
      "  --materialize-conflict  Write the observed integration conflict into the worktree as an uncommitted merge.",
      "                          With --include-dirty, current non-ignored changes are preserved first.",
      "  --overwrite             Replace a candidate whose Verification has not finished.",
    ].join("\n"),
  },
  review: {
    positional: "optional",
    stdin: "optional",
    flags: { satisfied: "boolean", unsatisfied: "boolean", summary: "value", json: "boolean" },
    usage: "review [<contract>|@<contract>] (--satisfied | --unsatisfied) (--summary <text> | -)",
    purpose: "Record whether a Contract meets its acceptance criteria based on the current work.",
    details: [
      "A review checks the whole Contract, not just one Arc. After delivery it checks the candidate; before delivery it checks the current Contract and worktree, but cannot integrate.",
      "--satisfied means every acceptance criterion is met. It records the verdict and requests integration; if the candidate, prerequisites, and gates are ready, this invocation integrates and claims the Contract. Otherwise the Contract stays active.",
      "--unsatisfied records what is missing and does not request integration.",
      "--summary gives the conclusion and evidence for --satisfied, or the specific blocker for --unsatisfied.",
      "Progress appears on stderr; stdout contains one final result.",
    ].join("\n"),
  },
  arc: {
    positional: "optional",
    stdin: "required",
    flags: { actor: "value", json: "boolean" },
    usage: "arc [<contract>|@<contract>] [--actor <actor>] -",
    purpose: "Add a progress note to a Contract's work history (an Arc).",
  },
  abandon: {
    positional: "optional",
    stdin: "none",
    flags: { actor: "value", note: "value", json: "boolean" },
    usage: "abandon [<contract>|@<contract>] [--note <text>] [--actor <actor>]",
    purpose: "End work on a Contract without delivering it; optionally record why.",
  },
  status: {
    positional: "optional",
    stdin: "none",
    flags: { json: "boolean" },
    usage: "status [<contract>|@name|<aku/...>]...",
    purpose: "Show the world overview or selected Contract and Akuma status.",
    details: "Akuma entries show the directory each Akuma works in.",
  },
  show: {
    positional: "optional",
    stdin: "none",
    flags: { json: "boolean" },
    usage: "show [<contract>|@<contract>]",
    purpose: "Show one Contract's requirements, current state, and work guidance.",
  },
  ls: {
    positional: "optional",
    stdin: "none",
    flags: { limit: "value", json: "boolean" },
    usage:
      'ls task[/] [--limit <count>]\nls kei[/] [--limit <count>]\nls aku[/]\nls aku/<akuma>[/] [--limit <count>]\nls "aku/*/*" [--limit <count>]',
    purpose: "List Tasks, Contracts, or Akumas in a selected scope.",
  },
  audit: {
    positional: "optional",
    stdin: "none",
    flags: { "include-dirty": "boolean", "show-diff": "boolean", json: "boolean" },
    usage: "audit [<contract>|@<contract>] [--include-dirty] [--show-diff]",
    purpose: "Preview what would happen if you delivered a Contract now; progress is on stderr.",
    details: [
      "--include-dirty checks all non-ignored worktree changes, staged or not.",
      "--show-diff includes the proposed candidate diff when one can be prepared.",
    ].join("\n"),
  },
  reconcile: {
    positional: "optional",
    stdin: "none",
    flags: { "retry-hooks": "boolean", json: "boolean" },
    usage: "reconcile [<contract>|@<contract>] [--retry-hooks]",
    purpose: "Restore a Contract's Git workspace from its recorded state, or reconcile workspaces across this World.",
    details:
      "--retry-hooks reruns configured setup commands even when a Contract workspace already exists; otherwise they run when reconciliation creates it.",
  },
  nuke: {
    positional: "none",
    stdin: "none",
    flags: { confirm: "value", json: "boolean" },
    usage: "nuke [--confirm <world-directory>]",
    purpose: "Remove Keiyaku-owned data from a confirmed World.",
    details:
      "Stops Akumas and removes this World's Tasks and Keiyaku-created worktrees and Git references. --confirm must exactly match this World's directory; source files are not deleted.",
  },
  settings: {
    positional: "none",
    stdin: "none",
    flags: { json: "boolean" },
    usage: "settings",
    purpose: "Show effective Settings (user + project, read-only)",
  },
  region: {
    positional: "optional",
    stdin: "none",
    flags: { path: "repeat-value", json: "boolean" },
    usage: "region [<contract>]\nregion --path <pattern> [--path <pattern> ...]",
    purpose: "Show declared Contract file patterns, optionally for selected paths.",
  },
} as const satisfies Readonly<Record<string, ContractCommandSpec>>;

export type ContractCommand = keyof typeof CONTRACT_COMMAND_SPECS;

export function renderContractHelp(command: ContractCommand): string {
  const spec: ContractCommandSpec = CONTRACT_COMMAND_SPECS[command];
  if (command === "settings") {
    return [
      "Show effective Settings — the merged read-only view of:",
      "  user      ~/.keiyaku/settings.json",
      "  project   <WorldRoot>/.keiyaku/settings.json",
      "A project record wholly shadows the same-name user record.",
      "",
      "Shape: namespace -> entry -> JSON value. There is no write",
      "command; edit the files directly.",
      "",
      "Recognized settings:",
      "  gates                            gate bundles selected by bind and amend",
      "  worktree                         commands run when worktrees are created or destroyed",
      "  git.requireBranchesToBeUpToDate  whether deliver and audit require up-to-date target branches",
      "  providers                        the available Akuma and how each is run",
      "",
      "Each entry is validated by the feature that reads it. A rejected",
      "value's diagnostic states the expected shape.",
      "",
      "Akuma definitions are Markdown files, one per name:",
      "  user      ~/.keiyaku/akuma/<name>.md",
      "  project   <WorldRoot>/.keiyaku/akuma/<name>.md",
      "A project file wholly shadows the same-name user file. YAML",
      "frontmatter selects the provider and may declare base, model,",
      "effort, network, allowed, systemPromptMode, and description; the body is",
      "an optional system prompt.",
      "",
      usageLine(spec.usage),
    ].join("\n");
  }
  const help = `${spec.purpose}\n\n${usageLine(spec.usage)}`;
  return spec.details === undefined ? help : `${help}\n\n${spec.details}`;
}

export function renderContractUsage(command: ContractCommand): string {
  return usageLine(CONTRACT_COMMAND_SPECS[command].usage);
}
