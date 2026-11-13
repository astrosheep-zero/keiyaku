import { KeiyakuError } from "../errors.js";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const durationDiagnostic = "timeoutMs must be a nonnegative finite millisecond duration";
export const durationSchema = z
  .number({ error: durationDiagnostic })
  .nonnegative({ error: durationDiagnostic })
  .multipleOf(1, { error: durationDiagnostic });
const tellObservationSchema = z.union([
  z.strictObject({ wait: z.literal(true), timeoutMs: durationSchema.max(Number.MAX_SAFE_INTEGER).exactOptional() }),
  z.strictObject({ wait: z.literal(false).exactOptional() }),
]);

export function validateTellObservation(input: Readonly<{ wait?: unknown; timeoutMs?: unknown }>): void {
  validateAkumaInput(tellObservationSchema, {
    ...(input.wait === undefined ? {} : { wait: input.wait }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
}

/** Native input errors stay caller errors; invocation translates its own schema errors to usage. */
export function validateAkumaInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new KeiyakuError("invalid-input", parsed.error.message);
  return parsed.data;
}

export function bareOption(value: unknown): boolean | undefined {
  if (value !== undefined && typeof value !== "boolean")
    throw new KeiyakuError("invalid-input", "bare must be a boolean");
  return value;
}

export async function canonicalBirthCwd(
  input: string,
  diagnostic = `cwd is not an existing directory: ${input}`,
): Promise<string> {
  const selected = resolve(input);
  try {
    const canonical = await realpath(selected);
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw new KeiyakuError("invalid-input", diagnostic);
  }
}
