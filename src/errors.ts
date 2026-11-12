export type KeiyakuErrorCategory = "invalid-input" | "authority-corruption" | "aborted" | "internal";

/** Receipt types are augmented by the composition owner without an upward dependency. */
export interface KeiyakuErrorOptions extends ErrorOptions {}

export class KeiyakuError extends Error {
  readonly category: KeiyakuErrorCategory;

  constructor(category: KeiyakuErrorCategory, message: string, options: KeiyakuErrorOptions = {}) {
    super(message, options);
    this.name = new.target.name;
    this.category = category;
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
