import { z } from "zod";
import type { AkumaId, AkumaTellResult } from "@astrosheep/keiyaku";

const text = z.string();
const nonblank = text.refine((value) => value.trim() !== "");
const count = z.number().int().nonnegative();
const sequence = count.positive().safe();
const timestamp = text.refine((value) => Number.isFinite(Date.parse(value)));
const truncated = z.literal(true).exactOptional();
const identity = z.object({ kind: text.min(1), sequence, at: timestamp }).passthrough();
const turn = { sequence, at: timestamp, turnSequence: count };
const diffstat = z.strictObject({ added: count.safe(), removed: count.safe() });
const change = z.strictObject({
  op: z.enum(["add", "update", "delete", "unspecified"]), path: text,
  diffstat: diffstat.exactOptional(), patch: text.exactOptional(),
});
const call = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("run"), command: text }),
  z.strictObject({ kind: z.literal("read"), path: text, offset: count.exactOptional(), limit: count.exactOptional() }),
  z.strictObject({ kind: z.literal("search"), query: text, scope: z.enum(["content", "files", "web"]).exactOptional(),
    path: text.exactOptional(), glob: text.exactOptional() }),
  z.strictObject({ kind: z.literal("fileChange"), changes: z.array(change) }),
  z.strictObject({ kind: z.literal("other"), input: z.strictObject({ json: text, truncated }).exactOptional() }),
]);
const result = z.strictObject({ status: z.enum(["ok", "error"]), message: text.exactOptional(),
  output: text.exactOptional(), exitCode: z.number().int().safe().exactOptional() });
const outcome = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("answered"), answer: text, foldedSaidSequence: count.exactOptional() }),
  z.strictObject({ kind: z.literal("failed"), diagnostic: text }),
  z.strictObject({ kind: z.literal("canceled") }),
]);
const supportedRow = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("turn"), sequence, at: timestamp, bodySequence: count }),
  z.strictObject({ kind: z.literal("call"), ...turn, text }),
  z.strictObject({ kind: z.literal("report"), ...turn, bodySequence: sequence, turnSequence: sequence, text: nonblank }),
  z.strictObject({ kind: z.literal("said"), ...turn, text, truncated }),
  z.strictObject({ kind: z.literal("thought"), ...turn, text, truncated }),
  z.strictObject({ kind: z.literal("note"), ...turn, text, truncated }),
  z.strictObject({ kind: z.literal("tell"), sequence, at: timestamp, tellId: nonblank, text,
    state: z.enum(["pending", "told"]), deliveries: z.array(z.strictObject({
      deliveredAt: timestamp, route: z.enum(["launch", "live"]), turnSequence: count,
    })) }),
  z.strictObject({ kind: z.literal("tool"), ...turn, name: nonblank, toolId: text, call,
    state: z.union([z.enum(["active", "unsettled"]), result]),
    durationMs: z.number().finite().nonnegative().exactOptional(), truncated }),
  z.strictObject({ kind: z.literal("outcome"), ...turn, outcome }),
]);

// Validate identity before isolating an unsupported row. Never retain its payload.
const row = identity.transform((value) => {
  const decoded = supportedRow.safeParse(value);
  if (decoded.success) return decoded.data;
  return { kind: "adapter-diagnostic" as const, sequence: value.sequence, at: value.at,
    recordKind: value.kind.slice(0, 80).replace(/[^a-zA-Z0-9_.-]/gu, "?") };
});
export const historySchema = z.strictObject({
  rows: z.array(row), omitted: z.number(), hasEarlier: z.boolean(), hasLater: z.boolean(),
  historyLost: z.boolean(), lowestRetained: z.number().nullable(), highest: z.number().nullable(),
});

const subject = {
  akumaId: text.regex(/^aku\/[^/\s]+\/[0-9a-f]{8}$/u).transform((value) => value as AkumaId),
  tellId: text,
  interrupt: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("pending") }),
    z.strictObject({ kind: z.literal("unavailable"), evidence: z.enum(["hung", "untidy"]) }),
  ]).exactOptional(),
  wake: z.strictObject({ kind: z.literal("pending") }).exactOptional(),
  input: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("answered"), answer: text }),
    z.strictObject({ kind: z.literal("unanswered") }),
    z.strictObject({ kind: z.literal("deadline") }),
  ]).exactOptional(),
};
const failure = z.discriminatedUnion("stage", [
  z.strictObject({ stage: z.literal("wake"), diagnostic: text, logPath: text.exactOptional() }),
  z.strictObject({ stage: z.literal("observation"), diagnostic: text }),
]);
export const tellSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("admitted"), ...subject }),
  z.strictObject({ kind: z.literal("failed"), ...subject, failures: z.tuple([failure], failure).readonly() }),
]) satisfies z.ZodType<AkumaTellResult>;
export type History = z.output<typeof historySchema>;
export type Row = History["rows"][number];
