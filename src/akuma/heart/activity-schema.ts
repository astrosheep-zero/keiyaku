import { z } from "zod";

import { resumeCoordinateSchema } from "../coordinate.js";

const nonnegativeInteger = z.number().int().safe().nonnegative();
const positiveInteger = z.number().int().safe().positive();
const text = z.string();
const truncated = z.literal(true).optional();

export const searchScopeSchema = z.enum(["content", "files", "web"]);

export const toolInputSchema = z.object({ json: text, truncated: z.boolean() });
export const diffstatSchema = z.object({ added: nonnegativeInteger, removed: nonnegativeInteger });
export const fileChangeSchema = z.object({
  op: z.enum(["add", "update", "delete", "unspecified"]),
  path: text,
  diffstat: diffstatSchema.optional(),
});
export const toolCallSchema = z.union([
  z.object({ kind: z.literal("run"), command: text }),
  z.object({
    kind: z.literal("read"),
    path: text,
    offset: positiveInteger.optional(),
    limit: positiveInteger.optional(),
  }),
  z.object({
    kind: z.literal("search"),
    query: text,
    scope: searchScopeSchema.optional(),
    path: text.optional(),
    glob: text.optional(),
  }),
  z.object({ kind: z.literal("fileChange"), changes: z.array(fileChangeSchema).readonly() }),
  z.object({ kind: z.literal("other"), display: text, input: toolInputSchema.optional() }),
]);

export const toolResultSchema = z.object({
  status: z.enum(["ok", "error"]),
  message: text.optional(),
  exitCode: z.number().int().safe().optional(),
});

const toolFields = { type: z.literal("tool"), id: text, name: text, call: toolCallSchema, truncated };
const toolEventSchema = z.union([
  z.object({ ...toolFields, phase: z.literal("started"), result: z.never().optional() }),
  z.object({ ...toolFields, phase: z.literal("completed"), result: toolResultSchema }),
]);

export const agentEventSchema = z.union([
  z.object({ type: z.literal("session"), coordinate: resumeCoordinateSchema }),
  z.object({ type: z.literal("assistant"), text, truncated }),
  z.object({ type: z.literal("thought"), text, truncated }),
  toolEventSchema,
  z.object({ type: z.literal("note"), text, truncated }),
  z.object({ type: z.literal("unknown"), kind: text, truncated }),
]);

export type SearchScope = z.infer<typeof searchScopeSchema>;
export type ToolInput = z.infer<typeof toolInputSchema>;
export type ToolCall = z.infer<typeof toolCallSchema>;
export type ToolResult = z.infer<typeof toolResultSchema>;
export type ToolEvent = z.infer<typeof toolEventSchema>;
export type AgentEvent = z.infer<typeof agentEventSchema>;

export function decodeAgentEvent(value: unknown): AgentEvent {
  return agentEventSchema.parse(value);
}
