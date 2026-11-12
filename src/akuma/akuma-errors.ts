import { KeiyakuError, errorCategory } from "../errors.js";
import type { AkumaId } from "./identity.js";
import type { AkumaTellResult } from "./selection-observation.js";

export function withTellFailureReceipt(reason: unknown, tell: AkumaTellResult, signal?: AbortSignal): KeiyakuError {
  return new KeiyakuError(errorCategory(reason, signal), reason instanceof Error ? reason.message : String(reason), {
    ...(reason instanceof KeiyakuError ? { outcome: reason.outcome, spawn: reason.spawn } : {}),
    cause: reason,
    tell,
  });
}
export { AkumaBusyError } from "./heart/facts.js";

export class AkumaNotBornError extends KeiyakuError {
  readonly kind = "akuma-not-born";
  constructor(readonly id: AkumaId) {
    super("internal", `Akuma ${id} is not born`);
  }
}

export class AkumaObservationError extends KeiyakuError {
  readonly kind = "akuma-observation";
  constructor(
    readonly id: AkumaId,
    readonly diagnostic: string,
  ) {
    super("internal", `Akuma ${id} observation failed: ${diagnostic}`);
  }
}

export class AkumaDecodeError extends KeiyakuError {
  readonly kind = "akuma-decode";
  constructor(
    readonly diagnostic: string,
    readonly answer?: string,
  ) {
    super("internal", diagnostic);
  }
}

export class AkumaProviderError extends KeiyakuError {
  readonly kind = "akuma-provider";
  constructor(readonly diagnostic: string) {
    super("internal", diagnostic);
  }
}
