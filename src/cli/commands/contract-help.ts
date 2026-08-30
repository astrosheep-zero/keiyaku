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
      "bind [--task <task/...>] [--target <ref>] [--after <kei/...> ...] [--gates <name,...>] [--actor <actor>] [--json] - | bind --fork-of <kei/...> [--target <ref>] [--actor <actor>] [--json]",
    purpose: "Create one Contract from stdin Markdown or a sibling fork.",
  },
  amend: {
    positional: "optional",
    stdin: "optional",
    flags: { actor: "value", after: "repeat-value", "clear-after": "boolean", gates: "raw-value", json: "boolean" },
    usage:
      "amend [<contract>|@<contract>] [--after <kei/...> ... | --clear-after] [--gates <name,...>] [--actor <actor>] [--json] [-]",
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
      json: "boolean",
    },
    usage: "deliver [<contract>|@<contract>] [--message <text>] [--include-dirty] [--materialize-conflict] [--json]",
    purpose: "Deliver your work as this Contract's candidate.",
    details: [
      "A clean worktree delivers its HEAD; --include-dirty captures every non-ignored",
      "byte as an immutable commit object without changing the appointed worktree's HEAD",
      "or real index. Runs or reuses Verification and requests placement: when every",
      "prerequisite and declared gate is current, the same invocation places and claims.",
      "Otherwise the candidate is recorded and the Contract is tendered. A prior git",
      "commit is optional preparation — it never delivers, and delivering never",
      "satisfies a review gate.",
      "",
      "  --include-dirty         Include all non-ignored worktree bytes, including an",
      "                          unmerged shared index, in the candidate commit.",
      "  --materialize-conflict  After a conflict result, project the judged targetHead",
      "                          into the worktree as an uncommitted merge. Not a",
      "                          delivery: resolve, then deliver with --include-dirty.",
    ].join("\n"),
  },
  review: {
    positional: "optional",
    stdin: "optional",
    flags: { satisfied: "boolean", unsatisfied: "boolean", summary: "value", json: "boolean" },
    usage: "review [<contract>|@<contract>] (--satisfied | --unsatisfied) (--summary <text> | -) [--json]",
    purpose: "Record one review verdict.",
  },
  arc: {
    positional: "optional",
    stdin: "required",
    flags: { actor: "value", json: "boolean" },
    usage: "arc [<contract>|@<contract>] [--actor <actor>] [--json] -",
    purpose: "Record stdin arc Markdown for one Contract.",
  },
  abandon: {
    positional: "optional",
    stdin: "none",
    flags: { actor: "value", note: "value", json: "boolean" },
    usage: "abandon [<contract>|@<contract>] [--note <text>] [--actor <actor>] [--json]",
    purpose: "Abandon one Contract with an optional note.",
  },
  status: {
    positional: "optional",
    stdin: "none",
    flags: { json: "boolean" },
    usage: "status [<contract>|@name|<aku/...>]... [--json]",
    purpose: "Read the world status board or one or more Contract and Akuma projections.",
  },
  show: {
    positional: "optional",
    stdin: "none",
    flags: { json: "boolean" },
    usage: "show [<contract>|@<contract>] [--json]",
    purpose: "Read one Contract guidance projection.",
  },
  ls: {
    positional: "optional",
    stdin: "none",
    flags: { json: "boolean" },
    usage:
      'ls task[/] [--json]\nls kei[/] [--json]\nls aku[/] [--json]\nls aku/<akuma>[/] [--json]\nls "aku/*/*" [--json]',
    purpose: "List one identity directory.",
  },
  audit: {
    positional: "optional",
    stdin: "none",
    flags: { "include-dirty": "boolean", diff: "boolean", json: "boolean" },
    usage: "audit [<contract>|@<contract>] [--include-dirty] [--diff] [--json]",
    purpose: "Ask what candidate preparation, Verification, and target placement would do.",
  },
  reconcile: {
    positional: "optional",
    stdin: "none",
    flags: { "retry-hooks": "boolean", json: "boolean" },
    usage: "reconcile [<contract>|@<contract>] [--retry-hooks] [--json]",
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
    usage: "settings [--json]",
    purpose: "Show effective Settings (user + project, read-only)",
  },
  region: {
    positional: "optional",
    stdin: "none",
    flags: { path: "repeat-value", json: "boolean" },
    usage: "region [<contract>] [--json]\nregion --path <pattern> [--path <pattern> ...] [--json]",
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
      usageLine(spec.usage),
    ].join("\n");
  }
  const help = `${spec.purpose}\n\n${usageLine(spec.usage)}`;
  return spec.details === undefined ? help : `${help}\n\n${spec.details}`;
}

export function renderContractUsage(command: ContractCommand): string {
  return usageLine(CONTRACT_COMMAND_SPECS[command].usage);
}
