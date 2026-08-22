export const any = (target: string, symbols?: readonly string[]) => (symbols ? { target, symbols } : { target });
export const types = (...args: Parameters<typeof any>) => ({ ...any(...args), mode: "type-only" as const });
export const factErrors = any("core/facts/errors.ts");
export const factTypes = any("core/facts/types.ts");
export const gitRepository = types("git/process.ts", ["GitRepository"]);
export const ownersFor = (symbols: readonly string[], ...sources: readonly string[]) =>
  sources.map((source) => ({ source, symbols }));
export const forbiddenFor = (source: string, guards: readonly Readonly<{ pattern: RegExp; detail: string }>[]) =>
  guards.map(({ pattern, detail }) => ({ source, pattern, detail }));
