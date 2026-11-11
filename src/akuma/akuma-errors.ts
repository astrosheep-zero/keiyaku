import type { AkumaId } from "./identity.js";
import type { AkumaTellResult } from "./selection-observation.js";

const confirmedTellFailures = new WeakMap<Error, Readonly<{ cause: Error; receipt: AkumaTellResult }>>();
export function tellFailure(error: unknown) {
  return error instanceof Error ? confirmedTellFailures.get(error) : undefined;
}
export function withTellFailureReceipt(reason: unknown, receipt: AkumaTellResult): Error {
  const cause = reason instanceof Error ? reason : new Error(String(reason));
  const previous = confirmedTellFailures.get(cause);
  const error = previous === undefined ? cause : new Error(cause.message, { cause: previous.cause });
  confirmedTellFailures.set(error, { cause: previous?.cause ?? cause, receipt });
  return error;
}
export { AkumaBusyError } from "./heart/facts.js";

export class AkumaNotBornError extends Error {
  readonly kind = "akuma-not-born";
  constructor(readonly id: AkumaId) {
    super(`Akuma ${id} is not born`);
    this.name = "AkumaNotBornError";
  }
}

export class AkumaObservationError extends Error {
  readonly kind = "akuma-observation";
  constructor(
    readonly id: AkumaId,
    readonly diagnostic: string,
  ) {
    super(`Akuma ${id} observation failed: ${diagnostic}`);
    this.name = "AkumaObservationError";
  }
}

export class AkumaDecodeError extends Error {
  readonly kind = "akuma-decode";
  constructor(
    readonly diagnostic: string,
    readonly answer?: string,
  ) {
    super(diagnostic);
    this.name = "AkumaDecodeError";
  }
}

export class AkumaProviderError extends Error {
  readonly kind = "akuma-provider";
  constructor(readonly diagnostic: string) {
    super(diagnostic);
    this.name = "AkumaProviderError";
  }
}
