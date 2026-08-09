import { CliUsageError, usageLine } from "../usage.js";

type Output = Readonly<{ output: "text" | "json" }>;
type Addressed = Readonly<{ id: string }>;

export type ParsedAkumaCommand = Output & (
  | Readonly<{ command: "akuma"; action: "call"; persona: string; cwd?: string; contract?: string }>
  | (Readonly<{ command: "akuma"; action: "status" | "follow" | "wait" | "kill" }> & Addressed)
  | (Readonly<{ command: "akuma"; action: "fork"; at: string }> & Addressed)
  | Readonly<{ command: "akuma"; action: "list" }>
  | (Readonly<{ command: "akuma"; action: "tell" | "interrupt" }> & Addressed)
);

export type AkumaAction = ParsedAkumaCommand["action"];
type FlagValue = string | true;

const AKUMA_COMMAND_SPECS: Readonly<Record<AkumaAction, Readonly<{
  arity: number;
  stdin: boolean;
  flags: Readonly<Record<string, "boolean" | "value">>;
  usage: string;
  purpose: string;
}>>> = {
  call: { arity: 0, stdin: true, flags: { persona: "value", cwd: "value", contract: "value", json: "boolean" }, usage: "akuma call --persona <name> [--cwd <path>] [--contract <contract-id>] [--json] -", purpose: "Summon an Akuma from a Persona and stdin body." },
  list: { arity: 0, stdin: false, flags: { json: "boolean" }, usage: "akuma list [--json]", purpose: "List Akuma in the invocation world." },
  status: { arity: 1, stdin: false, flags: { json: "boolean" }, usage: "akuma status <aku/...> [--json]", purpose: "Read one Akuma's current status and retained history." },
  follow: { arity: 1, stdin: false, flags: { json: "boolean" }, usage: "akuma follow <aku/...> [--json]", purpose: "Observe one Akuma's public activity sequence." },
  wait: { arity: 1, stdin: false, flags: { json: "boolean" }, usage: "akuma wait <aku/...> [--json]", purpose: "Wait until one Akuma is no longer running." },
  tell: { arity: 1, stdin: true, flags: { json: "boolean" }, usage: "akuma tell <aku/...> [--json] -", purpose: "Record and wake one Akuma with an stdin body." },
  interrupt: { arity: 1, stdin: true, flags: { json: "boolean" }, usage: "akuma interrupt <aku/...> [--json] -", purpose: "Put down the current body and deliver an stdin body." },
  fork: { arity: 1, stdin: false, flags: { at: "value", json: "boolean" }, usage: "akuma fork <aku/...> --at <historyId> [--json]", purpose: "Fork one Akuma at a retained answered history point." },
  kill: { arity: 1, stdin: false, flags: { json: "boolean" }, usage: "akuma kill <aku/...> [--json]", purpose: "Record death and put down one Akuma." },
};

export function isAkumaAction(value: string | undefined): value is AkumaAction {
  return value !== undefined && Object.hasOwn(AKUMA_COMMAND_SPECS, value);
}

export function renderAkumaHelp(action?: AkumaAction): string {
  if (action !== undefined) {
    const spec = AKUMA_COMMAND_SPECS[action];
    return `${spec.purpose}\n\n${usageLine(spec.usage)}`;
  }
  return [
    "usage: keiyaku-v4 akuma <command> ...",
    "",
    "commands:",
    ...Object.values(AKUMA_COMMAND_SPECS).flatMap((spec) => [`  ${spec.usage}`, `    ${spec.purpose}`]),
  ].join("\n");
}

export function renderAkumaUsage(action: AkumaAction): string {
  return usageLine(AKUMA_COMMAND_SPECS[action].usage);
}

type Scanned = Readonly<{ flags: Readonly<Record<string, FlagValue>>; positionals: readonly string[]; stdin: boolean }>;

function scanAkuma(
  action: AkumaAction,
  argv: readonly string[],
  fail: (message: string) => never,
): Scanned {
  const spec = AKUMA_COMMAND_SPECS[action];
  const flags: Record<string, FlagValue> = {};
  const positionals: string[] = [];
  let stdin = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "-") {
      if (stdin || index !== argv.length - 1 || !spec.stdin) fail(`stdin marker '-' is not valid for akuma ${action}`);
      stdin = true;
    } else if (!token.startsWith("--")) positionals.push(token);
    else {
      const name = token.slice(2), kind = spec.flags[name];
      if (kind === undefined) fail(`option ${token} is not valid for akuma ${action}`);
      if (flags[name] !== undefined) fail(`duplicate option: ${token}`);
      if (kind === "boolean") flags[name] = true;
      else {
        const value = argv[index + 1];
        if (value === undefined || value === "-" || value.startsWith("--")) fail(`${token} requires a value`);
        flags[name] = value;
        index += 1;
      }
    }
  }
  return { flags, positionals, stdin };
}

export function parseAkumaCommand(argv: readonly string[]): ParsedAkumaCommand {
  const candidate = argv[0];
  if (!isAkumaAction(candidate)) throw new CliUsageError(`unknown akuma command: ${candidate ?? ""}`, renderAkumaHelp());
  const action = candidate as AkumaAction;
  const spec = AKUMA_COMMAND_SPECS[action];
  const fail = (message: string): never => { throw new CliUsageError(message, renderAkumaUsage(action)); };
  const { flags, positionals, stdin } = scanAkuma(action, argv, fail);
  if (positionals.length !== spec.arity) fail(`akuma ${action} has invalid positional arguments`);
  if (stdin !== spec.stdin) fail(`akuma ${action} ${spec.stdin ? "requires" : "reads no"} stdin`);
  const output = flags.json === true ? "json" as const : "text" as const;
  if (action === "call") {
    const persona = flags.persona;
    if (typeof persona !== "string") throw new CliUsageError("akuma call requires --persona <name>", renderAkumaUsage(action));
    return {
      command: "akuma",
      action,
      persona,
      ...(typeof flags.cwd === "string" ? { cwd: flags.cwd } : {}),
      ...(typeof flags.contract === "string" ? { contract: flags.contract } : {}),
      output,
    };
  }
  if (action === "list") return { command: "akuma", action, output };
  const id = positionals[0]!;
  if (action === "tell" || action === "interrupt") return { command: "akuma", action, id, output };
  if (action === "fork") {
    const at = flags.at;
    if (typeof at !== "string" || at.trim().length === 0) throw new CliUsageError("akuma fork requires --at <historyId>", renderAkumaUsage(action));
    return { command: "akuma", action, id, at, output };
  }
  return { command: "akuma", action, id, output };
}
