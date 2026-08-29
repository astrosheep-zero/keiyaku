import type { TaskCompositionResult } from "./compose.js";
import { isTaskSegment, formatTaskId, parseTaskId } from "./identity.js";
import type { TaskBatchResult, TaskMutationResult, TaskRefusal, TaskUpdateResult, TaskView } from "./operations.js";
import { z } from "zod";

export type TaskMutationExecutionResult =
  | TaskMutationResult
  | TaskUpdateResult
  | TaskBatchResult
  | TaskCompositionResult;

const nonblankTextSchema = z.string().refine((value) => value.trim() !== "");
const timestampSchema = z.string().refine((value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}, "expected canonical UTC timestamp");
export const taskMutationIdSchema = z.string().transform((value, context) => {
  try {
    const id = formatTaskId(parseTaskId(value));
    if (id !== value) throw new Error("not canonical");
    return id;
  } catch {
    context.addIssue({ code: "custom", message: "expected canonical TaskId" });
    return z.NEVER;
  }
});
const taskIdsSchema = z.array(taskMutationIdSchema).superRefine((ids, context) => {
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "TaskIds must be unique" });
});
const taskStateSchema = z.enum(["open", "in_progress", "on_hold", "done", "drop"]);
const taskPrioritySchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const taskRetrySchema = z
  .object({ kind: z.literal("retry"), reason: z.enum(["busy", "concurrent-modification"]) })
  .strict();
const taskViewSchema = z
  .object({
    id: taskMutationIdSchema,
    namespace: z.array(z.string().refine(isTaskSegment)),
    title: nonblankTextSchema,
    state: taskStateSchema,
    priority: taskPrioritySchema,
    needs: taskIdsSchema,
    parent: taskMutationIdSchema.nullable(),
    supersedes: taskIdsSchema,
    relates: taskIdsSchema,
    note: z.string(),
    createdBy: nonblankTextSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    body: z.string(),
  })
  .strict()
  .superRefine((task, context) => {
    if (task.namespace.join("/") !== parseTaskId(task.id).namespace.join("/"))
      context.addIssue({ code: "custom", path: ["namespace"], message: "namespace must agree with task ID" });
  })
  .transform(({ createdBy, ...task }) =>
    createdBy === undefined ? task : { ...task, createdBy },
  ) satisfies z.ZodType<TaskView>;
const compositionDiagnosticSchema = z
  .object({ line: z.number().int().positive(), reason: z.string(), token: z.string() })
  .strict();
const taskRefusalSchema = z.union([
  z.object({ kind: z.literal("task-missing"), taskId: taskMutationIdSchema }).strict(),
  z
    .object({
      kind: z.literal("invalid-lifecycle-transition"),
      taskId: taskMutationIdSchema,
      state: taskStateSchema,
      verb: z.enum(["start", "stop", "hold", "resume", "done", "drop"]),
    })
    .strict(),
  z.object({ kind: z.literal("invalid-graph"), diagnostic: z.string() }).strict(),
  z.object({ kind: z.literal("invalid-namespace-context"), path: z.string() }).strict(),
  z
    .object({
      kind: z.literal("relation-owned-by-other"),
      taskId: taskMutationIdSchema,
      related: taskMutationIdSchema,
      declaringTask: taskMutationIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("invalid-composition"), diagnostics: z.array(compositionDiagnosticSchema) }).strict(),
]) satisfies z.ZodType<TaskRefusal>;
export const taskMutationResultSchema = z.union([
  z.object({ kind: z.literal("accepted"), value: taskViewSchema }).strict(),
  z.object({ kind: z.literal("refused"), refusal: taskRefusalSchema }).strict(),
  taskRetrySchema,
]) satisfies z.ZodType<TaskMutationResult>;
export const taskUpdateResultSchema = z.union([
  z
    .object({
      kind: z.literal("accepted"),
      value: z.object({ task: taskViewSchema, documentDiff: z.string() }).strict(),
    })
    .strict(),
  z.object({ kind: z.literal("refused"), refusal: taskRefusalSchema }).strict(),
  taskRetrySchema,
]) satisfies z.ZodType<TaskUpdateResult>;
export const taskBatchResultSchema = z
  .object({ items: z.array(z.object({ id: taskMutationIdSchema, outcome: taskMutationResultSchema }).strict()) })
  .strict() satisfies z.ZodType<TaskBatchResult>;
const aliasesSchema = z.array(z.object({ alias: nonblankTextSchema, taskId: taskMutationIdSchema }).strict());
const documentChangesSchema = z.array(
  z.object({ taskId: taskMutationIdSchema, kind: z.enum(["created", "updated"]), documentDiff: z.string() }).strict(),
);
const compositionFactsSchema = { aliases: aliasesSchema, admissionOrder: taskIdsSchema };
export const taskCompositionResultSchema = z.union([
  z
    .object({
      kind: z.literal("planned"),
      ...compositionFactsSchema,
      bodies: z.array(
        z
          .object({
            taskId: taskMutationIdSchema,
            bytes: z.number().int().nonnegative(),
            firstLine: z.string(),
            lastLine: z.string(),
          })
          .strict(),
      ),
    })
    .strict(),
  z.object({ kind: z.literal("accepted"), ...compositionFactsSchema, documentChanges: documentChangesSchema }).strict(),
  z
    .object({
      kind: z.literal("refused"),
      refusal: z
        .object({ kind: z.literal("invalid-composition"), diagnostics: z.array(compositionDiagnosticSchema) })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("incomplete"),
      ...compositionFactsSchema,
      documentChanges: documentChangesSchema,
      stopped: z.union([taskRefusalSchema, taskRetrySchema]),
      draft: z.string(),
    })
    .strict(),
]) satisfies z.ZodType<TaskCompositionResult>;

export const taskMutationExecutionResultSchema = z.union([
  taskBatchResultSchema,
  taskMutationResultSchema,
  taskUpdateResultSchema,
  taskCompositionResultSchema,
]) satisfies z.ZodType<TaskMutationExecutionResult>;

export function isTaskMutationExecutionResult(value: unknown): value is TaskMutationExecutionResult {
  return taskMutationExecutionResultSchema.safeParse(value).success;
}
