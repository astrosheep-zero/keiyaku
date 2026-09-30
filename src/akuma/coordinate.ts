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

export function decodeResumeCoordinate(value: unknown): ResumeCoordinate | null {
  const result = resumeCoordinateSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function encodeResumeCoordinate(coordinate: ResumeCoordinate): unknown {
  return "sessionFile" in coordinate
    ? {
        sessionFile: coordinate.sessionFile,
        ...(coordinate.sessionId === undefined ? {} : { sessionId: coordinate.sessionId }),
      }
    : { sessionId: coordinate.sessionId };
}
