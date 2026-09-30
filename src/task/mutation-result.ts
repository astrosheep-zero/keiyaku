import { taskIdSchema as taskMutationIdSchema, taskIdsSchema, taskNamespaceSchema, parseTaskId } from "./identity.js";
import { taskNonblankTextSchema, taskStateSchema, taskPrioritySchema } from "./document.js";
import { z } from "zod";
export { taskIdSchema as taskMutationIdSchema } from "./identity.js";

type WithoutUndefined<Value> = {
  [Key in keyof Value as undefined extends Value[Key] ? never : Key]: Value[Key];
} & {
  [Key in keyof Value as undefined extends Value[Key] ? Key : never]?: Exclude<Value[Key], undefined>;
};
function withoutUndefined<Value extends Record<string, unknown>>(
  value: Value,
  keys: readonly (keyof Value & string)[],
): WithoutUndefined<Value> {
  const result: Record<string, unknown> = { ...value };
  for (const key of keys) {
    const field = result[key];
    delete result[key];
    if (field !== undefined) result[key] = field;
  }
  return result as WithoutUndefined<Value>;
}
const timestampSchema = z.string().refine((value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}, "expected canonical UTC timestamp");
export const taskRetrySchema = z
  .object({ kind: z.literal("retry"), reason: z.enum(["busy", "concurrent-modification"]) })
  .strict();
export const taskCleanupFailureSchema = z
  .object({ kind: z.literal("lock-release-failed"), diagnostics: z.array(z.string()).readonly() })
  .strict();
export const taskViewSchema = z
  .object({
    id: taskMutationIdSchema,
    namespace: taskNamespaceSchema,
    title: taskNonblankTextSchema,
    state: taskStateSchema,
    priority: taskPrioritySchema,
    needs: taskIdsSchema,
    parent: taskMutationIdSchema.nullable(),
    supersedes: taskIdsSchema,
    relates: taskIdsSchema,
    note: z.string(),
    createdBy: taskNonblankTextSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    body: z.string(),
  })
  .strict()
  .superRefine((task, context) => {
    if (task.namespace.join("/") !== parseTaskId(task.id).namespace.join("/"))
      context.addIssue({ code: "custom", path: ["namespace"], message: "namespace must agree with task ID" });
  })
  .transform(({ createdBy, ...task }) => withoutUndefined({ ...task, createdBy }, ["createdBy"]));
export const compositionDiagnosticSchema = z
  .object({ line: z.number().int().positive(), reason: z.string(), token: z.string() })
  .strict();
const invalidCompositionRefusalSchema = z
  .object({ kind: z.literal("invalid-composition"), diagnostics: z.array(compositionDiagnosticSchema).readonly() })
  .strict();
export const taskRefusalSchema = z.union([
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
  invalidCompositionRefusalSchema,
]);
const taskRefusedResultSchema = z.object({ kind: z.literal("refused"), refusal: taskRefusalSchema }).strict();
export const taskMutationResultSchema = z.union([
  z
    .object({ kind: z.literal("accepted"), value: taskViewSchema, cleanup: taskCleanupFailureSchema.optional() })
    .strict()
    .transform((value) => withoutUndefined(value, ["cleanup"])),
  taskRefusedResultSchema,
  taskRetrySchema,
]);
export const taskUpdateResultSchema = z.union([
  z
    .object({
      kind: z.literal("accepted"),
      value: z
        .object({
          task: taskViewSchema,
          documentDiff: z.string(),
          changedFields: z
            .array(
              z
                .object({ field: z.string(), action: z.enum(["added", "replaced", "cleared", "changed", "appended"]) })
                .strict(),
            )
            .readonly(),
        })
        .strict(),
      cleanup: taskCleanupFailureSchema.optional(),
    })
    .strict()
    .transform((value) => withoutUndefined(value, ["cleanup"])),
  taskRefusedResultSchema,
  taskRetrySchema,
]);
export const taskBatchResultSchema = z
  .object({
    items: z.array(z.object({ id: taskMutationIdSchema, outcome: taskMutationResultSchema }).strict()).readonly(),
  })
  .strict();
const aliasesSchema = z
  .array(z.object({ alias: taskNonblankTextSchema, taskId: taskMutationIdSchema }).strict())
  .readonly();
const planAliasesSchema = z
  .array(z.object({ alias: taskNonblankTextSchema, position: z.number().int().positive() }).strict())
  .readonly();
const planOrderSchema = z
  .array(
    z
      .object({
        position: z.number().int().positive(),
        alias: taskNonblankTextSchema.optional(),
        taskId: taskMutationIdSchema.optional(),
      })
      .strict(),
  )
  .readonly();
const admissionsSchema = z
  .array(
    z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("new"),
          position: z.number().int().positive(),
          alias: taskNonblankTextSchema.optional(),
          title: z.string(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("existing"),
          position: z.number().int().positive(),
          taskId: taskMutationIdSchema,
          title: z.string(),
        })
        .strict(),
    ]),
  )
  .readonly();
const documentChangesSchema = z
  .array(
    z.object({ taskId: taskMutationIdSchema, kind: z.enum(["created", "updated"]), documentDiff: z.string() }).strict(),
  )
  .readonly();
const compositionFactsSchema = { aliases: aliasesSchema, admissionOrder: taskIdsSchema, admissions: admissionsSchema };
export const taskCompositionResultSchema = z.union([
  z
    .object({
      kind: z.literal("planned"),
      aliases: planAliasesSchema,
      admissionOrder: planOrderSchema,
      admissions: admissionsSchema,
      bodies: z
        .array(
          z
            .object({
              position: z.number().int().positive(),
              title: z.string(),
              bytes: z.number().int().nonnegative(),
              firstLine: z.string(),
              lastLine: z.string(),
            })
            .strict(),
        )
        .readonly(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("accepted"),
      ...compositionFactsSchema,
      documentChanges: documentChangesSchema,
      cleanup: taskCleanupFailureSchema.optional(),
    })
    .strict()
    .transform((value) => withoutUndefined(value, ["cleanup"])),
  z.object({ kind: z.literal("refused"), refusal: invalidCompositionRefusalSchema }).strict(),
  z
    .object({
      kind: z.literal("incomplete"),
      ...compositionFactsSchema,
      documentChanges: documentChangesSchema,
      cleanup: taskCleanupFailureSchema.optional(),
      stopped: z.union([taskRefusalSchema, taskRetrySchema]),
      draft: z.string(),
    })
    .strict()
    .transform((value) => withoutUndefined(value, ["cleanup"])),
]);

export const taskMutationExecutionResultSchema = z.union([
  taskBatchResultSchema,
  taskMutationResultSchema,
  taskUpdateResultSchema,
  taskCompositionResultSchema,
]);

export function isTaskMutationExecutionResult(value: unknown): value is TaskMutationExecutionResult {
  return taskMutationExecutionResultSchema.safeParse(value).success;
}

export type TaskView = z.infer<typeof taskViewSchema>;
export type TaskCleanupFailure = z.infer<typeof taskCleanupFailureSchema>;
export type TaskCompositionDiagnostic = z.infer<typeof compositionDiagnosticSchema>;
export type TaskRefusal = z.infer<typeof taskRefusalSchema>;
export type TaskRetry = z.infer<typeof taskRetrySchema>["reason"];
export type TaskMutationResult = z.infer<typeof taskMutationResultSchema>;
export type TaskUpdateResult = z.infer<typeof taskUpdateResultSchema>;
export type TaskBatchResult = z.infer<typeof taskBatchResultSchema>;
export type TaskCompositionResult = z.infer<typeof taskCompositionResultSchema>;
export type TaskMutationExecutionResult = z.infer<typeof taskMutationExecutionResultSchema>;
