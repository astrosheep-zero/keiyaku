import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

export function callReadonly(value: unknown): Readonly<{ readonly?: true }> {
  if (value === undefined) return {};
  if (value !== true) throw new TypeError("Akuma call readonly must be true");
  return { readonly: true };
}

export async function canonicalBirthCwd(input: string): Promise<string> {
  const selected = resolve(input);
  try {
    const canonical = await realpath(selected);
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw new Error(`cwd is not an existing directory: ${input}`);
  }
}
