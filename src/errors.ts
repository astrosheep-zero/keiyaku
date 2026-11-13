export type KeiyakuErrorCategory = "invalid-input" | "authority-corruption" | "aborted" | "internal";

export type NextCall =
  | Readonly<{ verb: "ls"; input: Readonly<{ selector: "aku/" }> }>
  | Readonly<{ verb: "deliver"; input: Readonly<{ includeDirty: true; materializeConflict?: true }> }>
  | Readonly<{ verb: "verify"; input: Readonly<{ includeDirty: true }> }>;

/** Receipt types are augmented by the composition owner without an upward dependency. */
export interface KeiyakuErrorOptions extends ErrorOptions {
  readonly next?: NextCall;
}

export class KeiyakuError extends Error {
  readonly category: KeiyakuErrorCategory;
  declare readonly next?: NextCall;

  constructor(category: KeiyakuErrorCategory, message: string, options: KeiyakuErrorOptions = {}) {
    super(message, options);
    this.name = new.target.name;
    this.category = category;
    if (options.next !== undefined) {
      const next = Object.freeze({ ...options.next, input: Object.freeze({ ...options.next.input }) });
      Object.defineProperty(this, "next", { value: next, enumerable: true });
    }
    for (const key of ["outcome", "spawn", "tell"] as const) {
      const value = options[key];
      if (value !== undefined) Object.defineProperty(this, key, { value: Object.freeze(value), enumerable: true });
    }
  }
}

export function errorCategory(error: unknown, signal?: AbortSignal): KeiyakuErrorCategory {
  if (error instanceof KeiyakuError) return error.category;
  if (signal?.aborted === true && error === signal.reason) return "aborted";
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return "aborted";
  return "internal";
}
