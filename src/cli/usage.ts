export class CliUsageError extends Error {
  constructor(
    readonly diagnostic: string,
    readonly projection?: string,
  ) {
    super(projection === undefined ? diagnostic : `${diagnostic}\n${projection}`);
    this.name = "CliUsageError";
  }
}

export function isBlankInput(value: string): boolean {
  return value.trim().length === 0;
}

export function usageLine(usage: string): string {
  return usage
    .split("\n")
    .map((line, index) => {
      if (index === 0) return `usage: keiyaku ${line}`;
      const continuation = line.trimStart();
      return `       keiyaku ${continuation.startsWith("keiyaku ") ? continuation.slice("keiyaku ".length) : continuation}`;
    })
    .join("\n");
}
