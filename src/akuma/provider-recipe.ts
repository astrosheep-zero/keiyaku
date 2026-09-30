import { z } from "zod";

const modelText = z
  .string({ error: "provider option model must be a nonblank string" })
  .refine((value) => value.trim() !== "", "provider option model must be a nonblank string");
const effortText = z
  .string({ error: "provider option effort must be a nonblank string" })
  .refine((value) => value.trim() !== "", "provider option effort must be a nonblank string");
export const systemPromptModeSchema = z.enum(["append", "replace"], {
  error: "provider option systemPromptMode must be append, replace",
});
export type SystemPromptMode = z.infer<typeof systemPromptModeSchema>;
export const providerOptionsSchema = z
  .object({
    model: modelText.optional(),
    effort: effortText.optional(),
    network: z.enum(["disabled", "enabled"], { error: "provider option network must be disabled, enabled" }).optional(),
    systemPrompt: z.string({ error: "provider option systemPrompt must be a string" }).optional(),
    systemPromptMode: systemPromptModeSchema.optional(),
  })
  .refine(
    (value) => value.systemPromptMode === undefined || value.systemPrompt !== undefined,
    "provider option systemPromptMode requires systemPrompt",
  )
  .transform(({ model, effort, network, systemPrompt, systemPromptMode }) =>
    Object.freeze({
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(network === undefined ? {} : { network }),
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
      ...(systemPromptMode === undefined ? {} : { systemPromptMode }),
    }),
  );
export type ProviderOptions = z.infer<typeof providerOptionsSchema>;

// Recipe configuration deliberately stays adapter-owned opaque data, including historical keys.
function snapshot(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(snapshot));
  if (value === null || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item)])));
}
export const providerRecipeSchema = z
  .object({
    name: z.string().refine((value) => value.trim() !== "", "provider execution name must be a nonblank string"),
    kind: z.enum(["acp", "claude-agent-sdk", "codex-app-server", "grok-build", "opencode-sdk", "pi"], {
      error: "provider execution has unknown kind",
    }),
    executable: z
      .string()
      .refine((value) => value.trim() !== "", "provider execution executable must be a nonblank string")
      .optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .transform(({ name, kind, executable, config, env }) =>
    Object.freeze({
      name,
      kind,
      ...(executable === undefined ? {} : { executable }),
      ...(config === undefined ? {} : { config: snapshot(config) as Readonly<Record<string, unknown>> }),
      ...(env === undefined ? {} : { env: Object.freeze(env) }),
    }),
  );
export type ProviderExecution = z.infer<typeof providerRecipeSchema>;

export function decodeProviderOptions(value: unknown): ProviderOptions {
  const parsed = providerOptionsSchema.safeParse(value);
  if (!parsed.success)
    throw new TypeError(parsed.error.issues[0]?.message ?? "provider options must be an object", {
      cause: parsed.error,
    });
  return parsed.data;
}
export function decodeProviderRecipe(value: unknown): ProviderExecution {
  const parsed = providerRecipeSchema.safeParse(value);
  if (!parsed.success)
    throw new TypeError(parsed.error.issues[0]?.message ?? "provider execution must be an object", {
      cause: parsed.error,
    });
  return parsed.data;
}
