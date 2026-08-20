export type ContractFlagKind = "boolean" | "value" | "raw-value" | "repeat-value";

export type ContractCommandSpec = Readonly<{
  positional: "none" | "optional";
  stdin: "none" | "optional" | "required";
  flags: Readonly<Record<string, ContractFlagKind>>;
  usage: string;
  purpose: string;
  help?: string;
}>;

export const CONTRACT_COMMAND_SPECS = {
  bind: { positional: "none", stdin: "required", flags: { actor: "value", task: "value", target: "value", here: "boolean", after: "repeat-value", gates: "raw-value", json: "boolean" }, usage: "bind [--task <task/...>] [--target <ref>] [--here] [--after <kei/...> ...] [--gates <name,...>] [--actor <actor>] -", purpose: "Create one Contract from stdin Markdown." },
  amend: {
    positional: "optional", stdin: "optional", flags: { actor: "value", after: "repeat-value", "clear-after": "boolean", gates: "raw-value", json: "boolean" }, usage: "amend [<contract>|@<contract>] [--after <kei/...> ... | --clear-after] [--gates <name,...>] [--actor <actor>] [-]", purpose: "Amend one Contract's document operations or structured terms.",
    help: [
      "  ## Replace: Context|Objective|Design|Region|Criteria|Verification|<extension>",
      "  ## Append: Context|Objective|Design|Criteria|<extension>",
      "  ## Add: Criteria|<new-extension-title>",
      "  ## Update: <existing-extension-title>",
      "  ## Remove: Criterion <existing-title>",
      "  ## Remove: <existing-extension-title>",
    ].join("\n"),
  },
  deliver: {
    positional: "optional", stdin: "none", flags: { actor: "value", message: "value", "include-dirty": "boolean", "materialize-conflict": "boolean", json: "boolean" }, usage: "deliver [<contract>|@<contract>] [--message <text>] [--include-dirty] [--materialize-conflict] [--actor <actor>]", purpose: "Deliver one Contract candidate from the appointed worktree.",
    help: [
      "  --include-dirty         Capture the complete non-ignored worktree tree as the",
      "                          candidate; stages nothing, commits nothing. Refused",
      "                          while unmerged paths exist.",
      "  --materialize-conflict  After a conflict result, project the judged targetHead",
      "                          into the worktree as an uncommitted merge. Not a",
      "                          delivery: resolve, stage, deliver again.",
    ].join("\n"),
  },
  review: { positional: "optional", stdin: "optional", flags: { actor: "value", satisfied: "boolean", unsatisfied: "boolean", summary: "value", json: "boolean" }, usage: "review [<contract>|@<contract>] (--satisfied | --unsatisfied) (--summary <text> | -) [--actor <actor>]", purpose: "Record one review verdict." },
  arc: { positional: "optional", stdin: "required", flags: { actor: "value", json: "boolean" }, usage: "arc [<contract>|@<contract>] [--actor <actor>] -", purpose: "Record stdin arc Markdown for one Contract." },
  abandon: { positional: "optional", stdin: "none", flags: { actor: "value", note: "value", json: "boolean" }, usage: "abandon [<contract>|@<contract>] [--note <text>] [--actor <actor>]", purpose: "Abandon one Contract with an optional note." },
  status: { positional: "optional", stdin: "none", flags: { json: "boolean" }, usage: "status [<contract>|@name|<aku/...>]", purpose: "Read the world status board or one Contract projection." },
  show: { positional: "optional", stdin: "none", flags: { json: "boolean" }, usage: "show [<contract>|@<contract>]", purpose: "Read one Contract guidance projection." },
  ls: { positional: "optional", stdin: "none", flags: { json: "boolean" }, usage: "ls task[/]\n       keiyaku ls kei[/]\n       keiyaku ls aku[/]\n       keiyaku ls aku/<akuma>[/]\n       keiyaku ls \"aku/*/*\"", purpose: "List one identity directory." },
  audit: { positional: "optional", stdin: "none", flags: { "include-dirty": "boolean", diff: "boolean", actor: "value", json: "boolean" }, usage: "audit [<contract>|@<contract>] [--include-dirty] [--diff] [--actor <actor>]", purpose: "Ask what candidate preparation, Verification, and target placement would do." },
  reconcile: { positional: "optional", stdin: "none", flags: { "retry-hooks": "boolean", json: "boolean" }, usage: "reconcile [<contract>|@<contract>] [--retry-hooks]", purpose: "Reconcile one Contract or the invocation world." },
  nuke: { positional: "none", stdin: "none", flags: { confirm: "value", json: "boolean" }, usage: "nuke [--confirm <WorldRoot>] [--json]", purpose: "Remove Keiyaku-owned data from one confirmed World." },
  settings: { positional: "none", stdin: "none", flags: { json: "boolean" }, usage: "settings", purpose: "Read user and project Settings resources." },
  region: { positional: "optional", stdin: "none", flags: { overlap: "boolean", path: "value", json: "boolean" }, usage: "region [<contract>] [--overlap]\n       region --path <repo-relative-path>", purpose: "Read active declared Contract Regions." },
} as const satisfies Readonly<Record<string, ContractCommandSpec>>;

export type ContractCommand = keyof typeof CONTRACT_COMMAND_SPECS;
