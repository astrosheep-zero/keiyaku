type DiagnosticInput = Readonly<{
  kind: string;
  code?: number;
  diagnostic?: string;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
}>;

const DIAGNOSTIC_BYTES = 4096;

/** One bounded diagnosis; stream tails never become a second public process result. */
export function processDiagnostic(outcome: DiagnosticInput): string {
  const head =
    outcome.kind === "exit" || outcome.kind === "terminal" ? `exit ${outcome.code}` : outcome.kind.replaceAll("-", " ");
  const output = [
    outcome.diagnostic,
    ...(outcome.stdout ? [`stdout:\n${outcome.stdout}`] : []),
    ...(outcome.stderr ? [`stderr:\n${outcome.stderr}`] : []),
  ]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n");
  const bytes = Buffer.from(output);
  const truncated = outcome.truncated === true || bytes.length > DIAGNOSTIC_BYTES;
  let start = Math.max(0, bytes.length - DIAGNOSTIC_BYTES);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return [head, ...(truncated ? ["[output truncated]"] : []), bytes.subarray(start).toString("utf8")]
    .filter((part) => part.length > 0)
    .join("\n");
}
