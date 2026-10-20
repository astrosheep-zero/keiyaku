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
const taskRetrySchema = z
  .object({ kind: z.literal("retry"), reason: z.enum(["busy", "concurrent-modification"]) })
  .strict();
const taskCleanupFailureSchema = z
  .object({ kind: z.literal("lock-release-failed"), diagnostics: z.array(z.string()).readonly() })
  .strict();
const taskViewSchema = z
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
export const taskRefusalSchema = z.union([
  z.object({ kind: z.literal("task-missing"), taskId: taskMutationIdSchema }).strict(),
  z
    .object({
      kind: z.literal("invalid-lifecycle-transition"),
      taskId: taskMutationIdSchema,
      state: taskStateSchema,
      verb: z.enum(["done", "drop"]),
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
export const taskMutationExecutionResultSchema = z.union([
  taskBatchResultSchema,
  taskMutationResultSchema,
  taskUpdateResultSchema,
]);

export type TaskView = z.infer<typeof taskViewSchema>;
export type TaskCleanupFailure = z.infer<typeof taskCleanupFailureSchema>;
export type TaskRefusal = z.infer<typeof taskRefusalSchema>;
export type TaskRetry = z.infer<typeof taskRetrySchema>["reason"];
export type TaskMutationResult = z.infer<typeof taskMutationResultSchema>;
export type TaskUpdateResult = z.infer<typeof taskUpdateResultSchema>;
export type TaskBatchResult = z.infer<typeof taskBatchResultSchema>;
export type TaskMutationExecutionResult = z.infer<typeof taskMutationExecutionResultSchema>;
