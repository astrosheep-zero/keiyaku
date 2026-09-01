export const any = (target: string, symbols?: readonly string[]) => (symbols ? { target, symbols } : { target });
export const types = (...args: Parameters<typeof any>) => ({ ...any(...args), mode: "type-only" as const });
export const runtime = (...args: Parameters<typeof any>) => ({ ...any(...args), mode: "runtime-only" as const });
