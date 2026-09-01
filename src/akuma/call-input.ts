import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

export function callReadonly(
  value: unknown,
  diagnostic = "Akuma call readonly must be true",
): Readonly<{ readonly?: true }> {
  if (value === undefined) return {};
  if (value !== true) throw new TypeError(diagnostic);
  return { readonly: true };
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
    throw new Error(diagnostic);
  }
}
