import type { AkumaStatus, KillEvidence, TellResult } from "../akuma/index.js";
import type { ContractId } from "../core/facts/types.js";
import type { TaskRow } from "../task/index.js";
import {
  canonicalFleetAkuId,
  exactFleetKeys,
  fleetCount,
  isFleetStatus,
  isFleetTaskRows,
  record,
} from "./fleet-status-result.js";

export type CreatedTaskObservation =
  | Readonly<{ kind: "present"; rows: readonly TaskRow[] }>
  | Readonly<{ kind: "failed"; diagnostic: string }>;

export type DispatchAssociation =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "associated"; contractId: ContractId }>
  | Readonly<{ kind: "failed"; diagnostic: string }>;

export type AkumaObservation = Readonly<{
  status: AkumaStatus;
  contract: DispatchAssociation;
  createdTasks: CreatedTaskObservation;
}>;

export type AkumaObservationStage =
  | (Readonly<{ kind: "observed" }> & AkumaObservation)
  | Readonly<{ kind: "unobserved"; diagnostic: string }>;

export type AkumaUnobserved = Readonly<{
  id: AkumaStatus["id"];
  diagnostic: string;
}>;

export type AkumaWaitResult = Readonly<{
  completion: "any" | "all";
  observations: readonly AkumaObservation[];
  unobserved: readonly AkumaUnobserved[];
}>;

export type AkumaKillResult = Readonly<{
  results: readonly Readonly<{
    id: AkumaStatus["id"];
    evidence: KillEvidence;
    observation: AkumaObservationStage;
  }>[];
}>;

export type AkumaTellResult = Readonly<{
  akuma: AkumaStatus["id"];
  tell: TellResult;
  observation: AkumaObservationStage;
}>;

function isKillEvidence(value: unknown): value is KillEvidence {
  return (
    value === "killed" ||
    value === "already-killed" ||
    value === "already-stopped" ||
    value === "hung" ||
    value === "untidy" ||
    value === "unavailable"
  );
}

function isDispatchAssociation(value: unknown): value is DispatchAssociation {
  const association = record(value);
  if (association === null || typeof association.kind !== "string") return false;
  if (association.kind === "none") return exactFleetKeys(association, ["kind"]);
  if (association.kind === "associated")
    return (
      exactFleetKeys(association, ["contractId", "kind"]) &&
      typeof association.contractId === "string" &&
      association.contractId.trim() !== ""
    );
  return (
    association.kind === "failed" &&
    exactFleetKeys(association, ["diagnostic", "kind"]) &&
    typeof association.diagnostic === "string"
  );
}

function isCreatedTaskObservation(value: unknown): value is CreatedTaskObservation {
  const observation = record(value);
  if (observation === null || typeof observation.kind !== "string") return false;
  if (observation.kind === "present")
    return exactFleetKeys(observation, ["kind", "rows"]) && isFleetTaskRows(observation.rows);
  return (
    observation.kind === "failed" &&
    exactFleetKeys(observation, ["diagnostic", "kind"]) &&
    typeof observation.diagnostic === "string"
  );
}

function isAkumaObservation(value: unknown): value is AkumaObservation {
  const observation = record(value);
  return (
    observation !== null &&
    exactFleetKeys(observation, ["contract", "createdTasks", "status"]) &&
    isFleetStatus(observation.status) &&
    isDispatchAssociation(observation.contract) &&
    isCreatedTaskObservation(observation.createdTasks)
  );
}

function isObservationStage(value: unknown): value is AkumaObservationStage {
  const observation = record(value);
  if (observation === null || typeof observation.kind !== "string") return false;
  if (observation.kind === "observed")
    return (
      exactFleetKeys(observation, ["contract", "createdTasks", "kind", "status"]) && isAkumaObservation(observation)
    );
  return (
    observation.kind === "unobserved" &&
    exactFleetKeys(observation, ["diagnostic", "kind"]) &&
    typeof observation.diagnostic === "string"
  );
}

export function isWaitResult(value: unknown): value is AkumaWaitResult {
  const result = record(value);
  return (
    result !== null &&
    exactFleetKeys(result, ["completion", "observations", "unobserved"]) &&
    (result.completion === "any" || result.completion === "all") &&
    Array.isArray(result.observations) &&
    result.observations.every(isAkumaObservation) &&
    Array.isArray(result.unobserved) &&
    result.unobserved.every((item) => {
      const unobserved = record(item);
      return (
        unobserved !== null &&
        exactFleetKeys(unobserved, ["diagnostic", "id"]) &&
        canonicalFleetAkuId(unobserved.id) !== null &&
        typeof unobserved.diagnostic === "string"
      );
    })
  );
}

export function isKillResult(value: unknown): value is AkumaKillResult {
  const result = record(value);
  return (
    result !== null &&
    exactFleetKeys(result, ["results"]) &&
    Array.isArray(result.results) &&
    result.results.every((item) => {
      const entry = record(item);
      return (
        entry !== null &&
        exactFleetKeys(entry, ["evidence", "id", "observation"]) &&
        canonicalFleetAkuId(entry.id) !== null &&
        isKillEvidence(entry.evidence) &&
        isObservationStage(entry.observation)
      );
    })
  );
}

export function isTellResult(value: unknown): value is AkumaTellResult {
  const result = record(value);
  return (
    result !== null &&
    exactFleetKeys(result, ["akuma", "observation", "tell"]) &&
    canonicalFleetAkuId(result.akuma) !== null &&
    isTellResultValue(result.tell) &&
    isObservationStage(result.observation)
  );
}

function isTellResultValue(value: unknown): boolean {
  const tell = record(value);
  const admission = record(tell?.admission);
  return (
    tell !== null &&
    exactFleetKeys(tell, ["admission", "wake"]) &&
    admission !== null &&
    exactFleetKeys(admission, ["fact", "tellId"]) &&
    admission.fact === "recorded" &&
    typeof admission.tellId === "string" &&
    admission.tellId.trim() !== "" &&
    fleetTellWake(tell.wake)
  );
}

function fleetTellWake(value: unknown): boolean {
  const wake = record(value);
  if (wake === null || typeof wake.kind !== "string") return false;
  if (["told", "held"].includes(wake.kind)) return exactFleetKeys(wake, ["kind"]);
  if (wake.kind === "pursuing") return exactFleetKeys(wake, ["bodySequence", "kind"]) && fleetCount(wake.bodySequence);
  if (wake.kind !== "failed") return false;
  const child = record(wake.child);
  return (
    exactFleetKeys(wake, ["diagnostic", "kind", ...(wake.child === undefined ? [] : ["child"])]) &&
    typeof wake.diagnostic === "string" &&
    (wake.child === undefined ||
      (child !== null &&
        exactFleetKeys(child, ["code", "log", "signal"]) &&
        (child.code === null || (typeof child.code === "number" && Number.isSafeInteger(child.code))) &&
        (child.signal === null || typeof child.signal === "string") &&
        record(child.log) !== null))
  );
}
