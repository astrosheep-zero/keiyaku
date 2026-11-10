import { z } from "zod";

const coordinateText = z.string().refine((value) => value.trim() !== "");
// File coordinates take precedence, including coordinates that also name a session.
export const resumeCoordinateSchema = z.union([
  z
    .object({ sessionFile: coordinateText, sessionId: coordinateText.optional() })
    .strict()
    .transform(({ sessionFile, sessionId }) =>
      sessionId === undefined ? { sessionFile } : { sessionFile, sessionId },
    ),
  z.object({ sessionId: coordinateText }).strict(),
]);
export type ResumeCoordinate = z.infer<typeof resumeCoordinateSchema>;
// The published form names which coordinate is usable instead of dispatching on field presence.
export const publicSessionCoordinateSchema = z.union([
  z.strictObject({ kind: z.literal("file"), sessionFile: coordinateText }).readonly(),
  z.strictObject({ kind: z.literal("session"), sessionId: coordinateText }).readonly(),
]);
export type PublicSessionCoordinate = z.output<typeof publicSessionCoordinateSchema>;

export function decodeResumeCoordinate(value: unknown): ResumeCoordinate | null {
  const result = resumeCoordinateSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function publicSessionCoordinate(coordinate: ResumeCoordinate): PublicSessionCoordinate {
  return "sessionFile" in coordinate
    ? {
        kind: "file",
        sessionFile: coordinate.sessionFile,
      }
    : { kind: "session", sessionId: coordinate.sessionId };
}

export function encodeResumeCoordinate(coordinate: ResumeCoordinate): unknown {
  return "sessionFile" in coordinate
    ? {
        sessionFile: coordinate.sessionFile,
        ...(coordinate.sessionId === undefined ? {} : { sessionId: coordinate.sessionId }),
      }
    : { sessionId: coordinate.sessionId };
}
