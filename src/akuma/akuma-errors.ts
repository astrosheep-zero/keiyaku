import type { AkuId } from "./identity.js";
export { AkumaBusyError } from "./heart/facts.js";

export class AkumaNotBornError extends Error {
  readonly kind = "akuma-not-born";
  constructor(readonly id: AkuId) {
    super(`Akuma ${id} is not born`);
    this.name = "AkumaNotBornError";
  }
}
