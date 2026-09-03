import type { AkuId } from "./identity.js";
export { AkumaBusyError } from "./heart/facts.js";

export class AkumaNotBornError extends Error {
  readonly kind = "akuma-not-born";
  constructor(readonly id: AkuId) {
    super(`Akuma ${id} is not born`);
    this.name = "AkumaNotBornError";
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
