/**
 * One Stop attempt's honest verdict. Only `stopped` proves the Akuma's current
 * execution settled; `not-stopped` carries the public evidence's own refusal or
 * unsettled outcome, and `uncertain` admits that no decided answer exists — a
 * timeout or lost receipt never proves either outcome.
 */
export type StopAttempt =
  | Readonly<{ kind: "stopped" }>
  | Readonly<{ kind: "not-stopped"; message: string }>
  | Readonly<{ kind: "uncertain"; message: string }>;

const settledEvidence = new Set(["killed", "already-killed", "already-stopped"]);

/**
 * One public kill evidence's honest verdict. Only settled evidence proves the
 * Akuma's current execution ended; every other evidence names a refusal or an
 * unsettled outcome in Keiyaku's own words.
 */
export function stopAttempt(evidence: string, akuId: string): StopAttempt {
  return settledEvidence.has(evidence)
    ? { kind: "stopped" }
    : { kind: "not-stopped", message: `Keiyaku reported ${evidence} for ${akuId}` };
}

/** Stop one Akuma and return its verdict; transport failure rejects. */
export type Stop = (world: string, akuId: string, signal: AbortSignal) => Promise<StopAttempt>;
