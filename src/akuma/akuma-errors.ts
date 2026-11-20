import { KeiyakuError, errorCategory } from "../errors.js";
import type { AkumaId } from "./identity.js";
import type { AkumaTellResult } from "./selection-observation.js";
import type { KillEvidence } from "./heart/facts.js";

export function withTellFailureReceipt(
  reason: unknown,
  tell: AkumaTellResult,
  signal?: AbortSignal,
  cause = reason,
): KeiyakuError {
  return new KeiyakuError(errorCategory(reason, signal), cause instanceof Error ? cause.message : String(cause), {
    ...(reason instanceof KeiyakuError ? { outcome: reason.outcome, spawn: reason.spawn } : {}),
    cause,
    tell,
  });
}
export type KillAdmission = Readonly<{ id: AkumaId; outcome: KillEvidence | "stop-admitted" }>;

declare module "../errors.js" {
  interface KeiyakuError {
    readonly kill?: readonly KillAdmission[];
    readonly frozenWorkdir?: Readonly<{ id: AkumaId; cwd: string }>;
  }
}

export class AkumaKillError extends KeiyakuError {
  declare readonly kill: readonly KillAdmission[];

  constructor(reason: unknown, members: readonly KillAdmission[], signal?: AbortSignal) {
    super(errorCategory(reason, signal), reason instanceof Error ? reason.message : String(reason), { cause: reason });
    Object.defineProperty(this, "kill", {
      value: Object.freeze(members.map((member) => Object.freeze({ ...member }))),
      enumerable: true,
    });
  }
}

export { AkumaBusyError } from "./heart/facts.js";

export class AkumaNotBornError extends KeiyakuError {
  readonly kind = "akuma-not-born";
  constructor(readonly id: AkumaId) {
    super("internal", `Akuma ${id} is not born`);
  }
}

export class AkumaWorkdirMissingError extends KeiyakuError {
  readonly kind = "akuma-workdir-missing";
  readonly code = "ENOENT";
  declare readonly frozenWorkdir: NonNullable<KeiyakuError["frozenWorkdir"]>;

  constructor(
    readonly id: AkumaId,
    readonly cwd: string,
    options?: ErrorOptions,
    executableDiagnostic?: string,
  ) {
    super(
      "internal",
      `Cannot wake ${id}: frozen execution directory ${cwd} no longer exists` +
        (executableDiagnostic === undefined ? "" : `; ${executableDiagnostic}`) +
        "; an accepted or abandoned Contract may have retired the worktree. Spawn a fresh Akuma in a live workdir.",
      options,
    );
    Object.defineProperty(this, "frozenWorkdir", { value: Object.freeze({ id, cwd }), enumerable: true });
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
