/**
 * Unwrap only complete provider transport launchers. This is deliberately not
 * a shell parser: uncertainty preserves the persisted command's presentation.
 */

const HORIZONTAL_WHITESPACE = new Set([" ", "\t"]);
const UNSUPPORTED_UNQUOTED = new Set(["$", "`", "|", "&", ";", "<", ">", "(", ")"]);
const POWERSHELL_OPTION_FLAGS = new Set(["-nologo", "-noprofile"]);
const POWERSHELL_COMMAND_FLAGS = new Set(["-command", "-c"]);

function isAbsoluteExecutable(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value);
}

function executableName(value: string): string {
  const segments = value.split(/[\\/]/u);
  return segments[segments.length - 1]!.toLowerCase();
}

function isBashOrZsh(value: string): boolean {
  const name = executableName(value);
  return (value === "bash" || value === "zsh" || isAbsoluteExecutable(value))
    && (name === "bash" || name === "zsh");
}

function isPowerShell(value: string): boolean {
  const name = executableName(value);
  return (value.toLowerCase() === "powershell" || value.toLowerCase() === "pwsh" || isAbsoluteExecutable(value))
    && (name === "powershell" || name === "powershell.exe" || name === "pwsh" || name === "pwsh.exe");
}

function parseTransportArgv(command: string): string[] | undefined {
  const argv: string[] = [];
  let index = 0;

  while (index < command.length) {
    while (HORIZONTAL_WHITESPACE.has(command[index]!)) index += 1;
    if (index === command.length) break;
    if (command[index] === "\n" || command[index] === "\r") return undefined;

    let value = "";
    let consumed = false;
    while (index < command.length && !HORIZONTAL_WHITESPACE.has(command[index]!)) {
      const character = command[index]!;
      if (character === "\n" || character === "\r" || UNSUPPORTED_UNQUOTED.has(character)) return undefined;
      if (character === "'") {
        const end = command.indexOf("'", index + 1);
        if (end < 0) return undefined;
        value += command.slice(index + 1, end);
        index = end + 1;
        consumed = true;
        continue;
      }
      if (character === '"') {
        index += 1;
        consumed = true;
        let closed = false;
        while (index < command.length) {
          const quoted = command[index]!;
          if (quoted === '"') {
            index += 1;
            closed = true;
            break;
          }
          if (quoted === "$") return undefined;
          if (quoted === "`") return undefined;
          if (quoted === "\\") {
            const next = command[index + 1];
            if (next === undefined || next === "\n" || next === "\r") return undefined;
            if (next === '"' || next === "\\" || next === "$" || next === "`") {
              value += next;
            } else {
              value += `\\${next}`;
            }
            index += 2;
            continue;
          }
          value += quoted;
          index += 1;
        }
        if (!closed) return undefined;
        continue;
      }
      if (character === "\\") {
        const next = command[index + 1];
        if (next === undefined || next === "\n" || next === "\r") return undefined;
        value += next;
        index += 2;
        consumed = true;
        continue;
      }
      value += character;
      index += 1;
      consumed = true;
    }
    if (!consumed) return undefined;
    argv.push(value);
  }
  return argv;
}

function unwrapBashOrZsh(argv: readonly string[]): string | undefined {
  const [shell, flag, script] = argv;
  if (argv.length !== 3 || !shell || !script || !isBashOrZsh(shell)) return undefined;
  return flag === "-c" || flag === "-lc" ? script : undefined;
}

function unwrapPowerShell(argv: readonly string[]): string | undefined {
  const [shell, ...arguments_] = argv;
  if (!shell || !isPowerShell(shell) || arguments_.length < 2) return undefined;
  const options = new Set<string>();
  for (let index = 0; index < arguments_.length - 1; index += 1) {
    const flag = arguments_[index]!.toLowerCase();
    if (POWERSHELL_COMMAND_FLAGS.has(flag)) {
      return index === arguments_.length - 2 && arguments_[index + 1] ? arguments_[index + 1] : undefined;
    }
    if (!POWERSHELL_OPTION_FLAGS.has(flag) || options.has(flag)) return undefined;
    options.add(flag);
  }
  return undefined;
}

/** Return a display subject only when the full transport shape is unambiguous. */
export function normalizeToolCommand(command: string): string {
  const argv = parseTransportArgv(command);
  if (!argv) return command;
  return unwrapBashOrZsh(argv) ?? unwrapPowerShell(argv) ?? command;
}
