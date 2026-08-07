import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";

export function resolveContextRoot(input: Readonly<{ from: string; marker: string }>): string {
  const origin = realpathSync(resolve(input.from));
  for (let candidate = origin;; candidate = dirname(candidate)) {
    const marker = resolve(candidate, input.marker);
    if (existsSync(marker)) {
      if (!statSync(marker).isDirectory()) throw new Error(`context marker is not a directory: ${marker}`);
      return candidate;
    }
    if (candidate === parse(candidate).root) return origin;
  }
}
