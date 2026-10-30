import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export function bareOption(value: unknown): boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") throw new TypeError("bare must be a boolean");
  return value;
}

export async function writableDirectoriesOption(value: unknown): Promise<readonly string[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("writableDirectories must be an array of canonical directories");
  const directories = await Promise.all(
    value.map(async (path: unknown) => {
      if (typeof path !== "string" || path.trim() === "" || !isAbsolute(path))
        throw new TypeError("writableDirectories must contain nonblank canonical absolute directories");
      const canonical = await canonicalBirthCwd(path);
      if (canonical !== path) throw new TypeError(`writableDirectories path is not canonical: ${path}`);
      return canonical;
    }),
  );
  return Object.freeze([...new Set(directories)]);
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
