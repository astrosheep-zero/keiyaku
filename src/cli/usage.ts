export type CliUsageGuide = Readonly<{
  scope: string;
  accepts: string;
  help: string;
  given?: string;
  hideDiagnostic?: boolean;
}>;

export const ROOT_USAGE_GUIDE: CliUsageGuide = {
  scope: "keiyaku",
  accepts: "keiyaku <command> [options]",
  help: "keiyaku --help",
};

export const TASK_FAMILY_USAGE_GUIDE: CliUsageGuide = {
  scope: "keiyaku task",
  accepts: "keiyaku task <command> ...",
  help: "keiyaku task --help",
};

export function acceptsFromUsage(usage: string): string {
  return usage
    .split("\n")
    .map((line) => {
      const continuation = line.trimStart();
      const body = continuation.startsWith("keiyaku ") ? continuation.slice("keiyaku ".length) : continuation;
      return `keiyaku ${body}`;
    })
    .join("\n");
}

export function commandGuide(commandPath: string, usage: string): CliUsageGuide {
  return {
    scope: `keiyaku ${commandPath}`,
    accepts: acceptsFromUsage(usage),
    help: `keiyaku ${commandPath} --help`,
  };
}

export function unknownCommandGuide(guide: CliUsageGuide, given: string): CliUsageGuide {
  return {
    ...guide,
    ...(given.length > 0 ? { given } : {}),
    hideDiagnostic: true,
  };
}

export function renderUsageMessage(
  diagnostic: string,
  guide?: CliUsageGuide,
  kind: "usage" | "selector" = "usage",
): string {
  if (guide === undefined) {
    return `✕ ${kind}\n  diagnostic  ${diagnostic}`;
  }
  const lines = [`✕ ${kind}  ${guide.scope}`];
  if (!guide.hideDiagnostic && diagnostic.length > 0) {
    lines.push(`  diagnostic  ${diagnostic}`);
  }
  if (guide.given !== undefined) {
    lines.push(`  given  ${guide.given}`);
  }
  const accepts = guide.accepts.split("\n");
  lines.push(`  accepts  ${accepts[0]!}`);
  for (const part of accepts.slice(1)) {
    lines.push(`           ${part}`);
  }
  lines.push(`  help  ${guide.help}`);
  return lines.join("\n");
}

export class CliUsageError extends Error {
  constructor(
    readonly diagnostic: string,
    readonly guide?: CliUsageGuide,
  ) {
    super(renderUsageMessage(diagnostic, guide));
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
      if (index === 0) return `usage  keiyaku ${line}`;
      const continuation = line.trimStart();
      return `      keiyaku ${continuation.startsWith("keiyaku ") ? continuation.slice("keiyaku ".length) : continuation}`;
    })
    .join("\n");
}
