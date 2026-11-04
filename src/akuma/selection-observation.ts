import type { CreatedDebtObservation } from "../debt/created-observation.js";
import type { AkumaStatus } from "./akuma.js";
import type { TellResult } from "./call-initial-tell.js";
import type { DispatchAssociation } from "./dispatch-association.js";
import type { KillEvidence } from "./heart/index.js";
import type { AkuId } from "./identity.js";

export type AkumaObservation = Readonly<{
  status: AkumaStatus;
  contract: DispatchAssociation;
  createdDebts: CreatedDebtObservation;
}>;
export type AkumaObservationStage =
  | (Readonly<{ kind: "observed" }> & AkumaObservation)
  | Readonly<{ kind: "unobserved"; diagnostic: string }>;
export type AkumaUnobserved = Readonly<{ id: AkuId; diagnostic: string }>;
export type AkumaWaitResult = Readonly<{
  mode: "any" | "all";
  reason: "completed" | "deadline";
  observations: readonly AkumaObservation[];
  unobserved: readonly AkumaUnobserved[];
}>;
export type AkumaKillResult = Readonly<{
  results: readonly Readonly<{ id: AkuId; evidence: KillEvidence }>[];
}>;
export type AkumaTellResult = Readonly<{ akuma: AkuId; tell: TellResult }>;
export type AkumaAskObservation<T = unknown> =
  | Readonly<{ reason: "answered"; answer: T }>
  | Readonly<{ reason: "failed"; diagnostic: string }>
  | Readonly<{ reason: "invalid-output"; diagnostic: string; answer: string }>
  | Readonly<{ reason: "unanswered" }>
  | Readonly<{ reason: "deadline" }>;
export type AkumaAskResult<T = unknown> = Readonly<{
  akuma: AkuId;
  tell: TellResult;
  observation: AkumaAskObservation<T>;
  completedAt?: string | null;
}>;
