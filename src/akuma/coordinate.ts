export type ResumeCoordinate =
  | Readonly<{ sessionId: string; sessionFile?: never }>
  | Readonly<{ sessionFile: string; sessionId?: string }>;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
}

export function decodeResumeCoordinate(value: unknown): ResumeCoordinate | null {
  const coordinate = record(value);
  if (coordinate === null) return null;
  const keys = Object.keys(coordinate);
  if (typeof coordinate.sessionFile === "string" && coordinate.sessionFile.trim().length > 0
    && (coordinate.sessionId === undefined || (typeof coordinate.sessionId === "string" && coordinate.sessionId.trim().length > 0))
    && keys.every((key) => key === "sessionFile" || key === "sessionId")) {
    return { sessionFile: coordinate.sessionFile, ...(coordinate.sessionId === undefined ? {} : { sessionId: coordinate.sessionId }) };
  }
  return typeof coordinate.sessionId === "string" && coordinate.sessionId.trim().length > 0 && keys.length === 1
    ? { sessionId: coordinate.sessionId } : null;
}

export function encodeResumeCoordinate(coordinate: ResumeCoordinate): unknown {
  return "sessionFile" in coordinate
    ? { sessionFile: coordinate.sessionFile, ...(coordinate.sessionId === undefined ? {} : { sessionId: coordinate.sessionId }) }
    : { sessionId: coordinate.sessionId };
}
