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
    purpose: "Create one Contract from stdin Markdown or a sibling fork.",
    details: [
      "stdin is Contract Markdown:",
      "  # <title>",
      "  ## Context       motivation, authority, baseline, and boundaries",
      "  ## Objective    one observable end state",
      "  ## Design       closed decisions and ordering",
      "  ## Region       one fenced path-pattern declaration",
      "  ## Criteria     one or more ### <criterion> entries",
      "  ## Verification optional fenced executor declarations",
      "",
      "Region uses one closed fence with no info string or exactly 'txt'; put one",
      "repository-relative path pattern on each nonblank line. A trailing '/'",
      "is directory shorthand for 'path/**'.",
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
    purpose: "Amend one Contract's document operations or structured terms.",
    details: [
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
    purpose: "Deliver your work as this Contract's candidate.",
    details: [
      "The subject is the whole Contract. An Arc names the chapter you are in — it",
      "frames the work, it never shrinks what the Contract accepts. Finishing a chapter",
      "is progress; deliver is the different claim that the worktree, as it stands, is",
      "the Contract's candidate.",
      "Verification, placement, and cleanup progress is printed to stderr; stdout stays one final text or JSON result.",
      "",
      "A clean worktree delivers its HEAD. --include-dirty captures the complete final",
      "non-ignored worktree bytes through a private index, even while the shared index",
      "is unmerged (UU); the branch and real index stay untouched, so no git add or",
      "git commit is required.",
      "",
      "After a delivery fact is admitted, delivering the same captured content",
      "continues its non-terminal completion using the recorded delivery and target",
      "base without another delivery fact. Changed content replaces the candidate.",
      "Workers without .git custody use the existing forwarded contract.deliver path;",
      "private-index capture never grants access to the administration index.",
      "",
      "Delivering records the candidate and requests placement. If prerequisites and",
      "every declared gate already hold, this same invocation places and the Contract is",
      "claimed; otherwise the candidate stays recorded and the Contract is tendered.",
      "Only changed candidate content stales earlier review evidence.",
      "When the current candidate has no terminal Verification result, delivery recovers",
      "that admitted candidate instead; --overwrite explicitly replaces it.",
      "Deliver never satisfies a review gate — review is someone's independent verdict,",
      "not a side effect of delivering.",
      "Deliver records no review verdict.",
      "",
      "  --include-dirty         Capture complete non-ignored worktree bytes through a",
      "                          private index, even when the shared index is unmerged (UU).",
      "  --materialize-conflict  Project an integration conflict with the observed target",
      "                          into the worktree as an uncommitted merge. Not a delivery.",
      "                          With --include-dirty, captured non-ignored bytes are preserved",
      "                          as the handoff base before the conflict is projected.",
      "                          --include-dirty reads complete final non-ignored worktree",
      "                          bytes without requiring git add or commit.",
      "  --overwrite             Replace an admitted candidate that has no terminal",
      "                          Verification result instead of recovering it.",
    ].join("\n"),
  },
  review: {
    positional: "optional",
    stdin: "optional",
    flags: { satisfied: "boolean", unsatisfied: "boolean", summary: "value", json: "boolean" },
    usage: "review [<contract>|@<contract>] (--satisfied | --unsatisfied) (--summary <text> | -)",
    purpose: "Record one review verdict over this Contract's current subject.",
    details: [
      "You are judging the whole Contract, not the current Arc. The subject is whatever",
      "the Contract binds right now: the delivered candidate if one exists, or the current",
      "document and worktree state before any delivery. Pre-delivery review is real",
      "testimony over that subject — it creates no candidate, and without a delivered",
      "candidate it can never place.",
      "",
      "The question --satisfied answers is: does the complete current subject meet",
      "everything this Contract's acceptance asks — now, on evidence you already hold?",
      "A finished chapter is never grounds for satisfied.",
      "",
      "--satisfied records that verdict and requests placement. If a delivered candidate,",
      "prerequisites, and every declared gate hold, this same invocation places and the",
      "Contract is claimed — a terminal state; a verdict that places cannot be taken back.",
      "A blocked placement leaves the verdict recorded and the Contract active.",
      "",
      "--unsatisfied records what is not met and never requests placement.",
      "",
      "--summary is your testimony, not decoration. Satisfied: the conclusion that the",
      "whole Contract is complete, and the evidence it rests on. Unsatisfied: the specific",
      "blocker, missing evidence, or unmet term.",
      "Confirmed admission and later work are shown on stderr; stdout remains one final result.",
    ].join("\n"),
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
    usage: "status [<contract>|@name|<aku/...>]...",
    purpose: "Read the world status board or one or more Contract and Akuma projections.",
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
    flags: { limit: "value", json: "boolean" },
    usage:
      'ls task[/] [--limit <count>]\nls kei[/] [--limit <count>]\nls aku[/]\nls aku/<akuma>[/] [--limit <count>]\nls "aku/*/*" [--limit <count>]',
    purpose: "List one identity directory.",
  },
  audit: {
    positional: "optional",
    stdin: "none",
    flags: { "include-dirty": "boolean", diff: "boolean", json: "boolean" },
    usage: "audit [<contract>|@<contract>] [--include-dirty] [--diff]",
    purpose: "Ask what candidate preparation, Verification, and target placement would do; progress is on stderr.",
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
    usage: "nuke [--confirm <WorldRoot>]",
    purpose: "Remove Keiyaku-owned data from one confirmed World.",
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
    purpose: "Read active declared Contract Regions.",
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
      "effort, readonly, network, sandbox, allowed, systemPromptMode, and",
      "description; the body is an optional system prompt. sandbox:",
      "full-access disables a supporting provider's native command",
      "sandbox for future births; it grants no extra operating-system",
      "permissions and cannot combine with readonly or network: disabled.",
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
