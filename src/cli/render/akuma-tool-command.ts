/**
 * Unwrap only complete provider transport launchers. This is deliberately not
 * a shell parser: uncertainty preserves the persisted command's presentation.
 */

const HORIZONTAL_WHITESPACE = new Set([" ", "\t"]);
const UNSUPPORTED_UNQUOTED = new Set(["$", "`", "|", "&", ";", "<", ">", "(", ")"]);
const DOUBLE_QUOTE_ESCAPES = new Set(["\"", "\\", "$", "`"]);
const POWERSHELL_OPTION_FLAGS = new Set(["-nologo", "-noprofile"]);
const POWERSHELL_COMMAND_FLAGS = new Set(["-command", "-c"]);

type Scan =
  | { readonly ok: true; readonly index: number; readonly value: string }
  | { readonly ok: false };

const SCAN_FAIL: Scan = { ok: false };

function scanned(index: number, value: string): Scan {
  return { ok: true, index, value };
}

function isLineBoundary(character: string | undefined): boolean {
  return character === "\n" || character === "\r";
}

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

function scanSingleQuoted(command: string, index: number): Scan {
  const end = command.indexOf("'", index + 1);
  return end < 0 ? SCAN_FAIL : scanned(end + 1, command.slice(index + 1, end));
}

function scanDoubleQuotedEscape(command: string, index: number): Scan {
  const next = command[index + 1];
  if (next === undefined || isLineBoundary(next)) return SCAN_FAIL;
  return scanned(index + 2, DOUBLE_QUOTE_ESCAPES.has(next) ? next : `\\${next}`);
}

function scanDoubleQuoted(command: string, index: number): Scan {
  let cursor = index + 1;
  let value = "";
  while (cursor < command.length) {
    const quoted = command[cursor]!;
    if (quoted === "\"") return scanned(cursor + 1, value);
    if (quoted === "$" || quoted === "`") return SCAN_FAIL;
    if (quoted === "\\") {
      const escaped = scanDoubleQuotedEscape(command, cursor);
      if (!escaped.ok) return SCAN_FAIL;
      value += escaped.value;
      cursor = escaped.index;
      continue;
    }
    value += quoted;
    cursor += 1;
  }
  return SCAN_FAIL;
}

function scanUnquotedEscape(command: string, index: number): Scan {
  const next = command[index + 1];
  if (next === undefined || isLineBoundary(next)) return SCAN_FAIL;
  return scanned(index + 2, next);
}

function scanTokenSegment(command: string, index: number): Scan {
  const character = command[index]!;
  if (isLineBoundary(character) || UNSUPPORTED_UNQUOTED.has(character)) return SCAN_FAIL;
  if (character === "'") return scanSingleQuoted(command, index);
  if (character === "\"") return scanDoubleQuoted(command, index);
  if (character === "\\") return scanUnquotedEscape(command, index);
  return scanned(index + 1, character);
}

function scanToken(command: string, index: number): Scan {
  let cursor = index;
  let value = "";
  let consumed = false;
  while (cursor < command.length && !HORIZONTAL_WHITESPACE.has(command[cursor]!)) {
    const segment = scanTokenSegment(command, cursor);
    if (!segment.ok) return SCAN_FAIL;
    value += segment.value;
    cursor = segment.index;
    consumed = true;
  }
  return consumed ? scanned(cursor, value) : SCAN_FAIL;
}

function parseTransportArgv(command: string): string[] | undefined {
  const argv: string[] = [];
  let index = 0;
  while (index < command.length) {
    while (HORIZONTAL_WHITESPACE.has(command[index]!)) index += 1;
    if (index === command.length) break;
    if (isLineBoundary(command[index])) return undefined;
    const token = scanToken(command, index);
    if (!token.ok) return undefined;
    argv.push(token.value);
    index = token.index;
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
