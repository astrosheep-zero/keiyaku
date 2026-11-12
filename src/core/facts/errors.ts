import { KeiyakuError } from "../../errors.js";

export class AuthorityCorruptionError extends KeiyakuError {
  constructor(message: string, options?: ErrorOptions) {
    super("authority-corruption", message, options);
  }
}
