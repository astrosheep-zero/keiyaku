export type ContractFlagKind = "boolean" | "value" | "repeat-value";

export type ContractCommandSpec = Readonly<{
  positional: "none" | "optional";
  stdin: "none" | "optional" | "required";
  flags: Readonly<Record<string, ContractFlagKind>>;
  usage: string;
  purpose: string;
}>;

export const AMEND_MINIMAL_STDIN_HELP = [
  "minimal stdin:",
  "  ## Replace: Design",
  "  <complete replacement>",
].join("\n");

export const CONTRACT_COMMAND_SPECS = {
  bind: { positional: "none", stdin: "required", flags: { actor: "value", task: "value", target: "value", here: "boolean", after: "repeat-value", gates: "value", json: "boolean" }, usage: "bind [--task <task/...>] [--target <ref>] [--here] [--after <kei/...> ...] [--gates <name>] [--actor <actor>] [--json] -", purpose: "Create one Contract from stdin Markdown." },
  amend: { positional: "optional", stdin: "required", flags: { actor: "value", after: "repeat-value", "clear-after": "boolean", gates: "value", json: "boolean" }, usage: "amend [<contract>|@<contract>] [--after <kei/...> ... | --clear-after] [--gates <name>] [--actor <actor>] [--json] -", purpose: "Apply stdin amendment operations to one Contract." },
  deliver: { positional: "optional", stdin: "none", flags: { actor: "value", message: "value", "include-dirty": "boolean", json: "boolean" }, usage: "deliver [<contract>|@<contract>] [--message <text>] [--include-dirty] [--actor <actor>] [--json]", purpose: "Deliver one Contract candidate." },
  review: { positional: "optional", stdin: "optional", flags: { actor: "value", satisfied: "boolean", unsatisfied: "boolean", summary: "value", json: "boolean" }, usage: "review [<contract>|@<contract>] (--satisfied | --unsatisfied) [--summary <text>] [--actor <actor>] [--json] [-]", purpose: "Record one review verdict." },
  arc: { positional: "optional", stdin: "required", flags: { actor: "value", json: "boolean" }, usage: "arc [<contract>|@<contract>] [--actor <actor>] [--json] -", purpose: "Record stdin arc Markdown for one Contract." },
  abandon: { positional: "optional", stdin: "none", flags: { actor: "value", note: "value", json: "boolean" }, usage: "abandon [<contract>|@<contract>] [--note <text>] [--actor <actor>] [--json]", purpose: "Abandon one Contract with an optional note." },
  status: { positional: "optional", stdin: "none", flags: { json: "boolean" }, usage: "status [<contract>|@name|<aku/...>] [--json]", purpose: "Read the world status board or one Contract projection." },
  show: { positional: "optional", stdin: "none", flags: { json: "boolean" }, usage: "show [<contract>|@<contract>] [--json]", purpose: "Read one Contract guidance projection." },
  ls: { positional: "optional", stdin: "none", flags: { json: "boolean" }, usage: "ls task/ [--json]\n       keiyaku ls kei/ [--json]\n       keiyaku ls aku/ [--json]\n       keiyaku ls aku/<akuma>/ [--json]\n       keiyaku ls aku/*/* [--json]", purpose: "List one identity directory." },
  audit: { positional: "optional", stdin: "none", flags: { "include-dirty": "boolean", diff: "boolean", actor: "value", json: "boolean" }, usage: "audit [<contract>|@<contract>] [--include-dirty] [--diff] [--actor <actor>] [--json]", purpose: "Ask what candidate preparation, Verification, and target placement would do." },
  reconcile: { positional: "optional", stdin: "none", flags: { "retry-hooks": "boolean", json: "boolean" }, usage: "reconcile [<contract>|@<contract>] [--retry-hooks] [--json]", purpose: "Reconcile one Contract or the invocation world." },
  settings: { positional: "none", stdin: "none", flags: { json: "boolean" }, usage: "settings [--json]", purpose: "Read user and project Settings resources." },
  region: { positional: "optional", stdin: "none", flags: { overlap: "boolean", path: "value", json: "boolean" }, usage: "region [<contract>] [--overlap] [--json]\n       region --path <repo-relative-path> [--json]", purpose: "Read active declared Contract Regions." },
} as const satisfies Readonly<Record<string, ContractCommandSpec>>;

export type ContractCommand = keyof typeof CONTRACT_COMMAND_SPECS;
