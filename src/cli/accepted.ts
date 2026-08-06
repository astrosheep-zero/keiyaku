import {
  ContractBody,
  type ContractId,
  type Keiyaku,
  type Outcome,
} from "../index.js";
import { unifiedDiff } from "./diff.js";
import type { AcceptedFact, InvocationResult, Lag } from "./result.js";

function errorBytes(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (Buffer.isBuffer(stderr) && stderr.length > 0) return stderr.toString("utf8");
  }
  return error instanceof Error ? error.message : String(error);
}

function outcomeContract(outcome: Exclude<Outcome<unknown>, { kind: "accepted" }>, fallback?: ContractId): ContractId {
  if (fallback !== undefined) return fallback;
  const source = outcome.kind === "refused" ? outcome.refusal : outcome.reason;
  if (typeof source === "object" && source !== null && "contractId" in source) {
    const contractId = (source as { contractId?: unknown }).contractId;
    if (typeof contractId === "string") return contractId as ContractId;
  }
  throw new TypeError("public outcome does not identify its contract");
}

export async function resultFromOutcome<A>(
  verb: string,
  outcome: Outcome<A>,
  contract: Keiyaku | null,
  fallback?: ContractId,
  report?: import("../index.js").AuditReport,
): Promise<InvocationResult> {
  if (outcome.kind === "refused") {
    return { kind: "refused", verb, contract: outcomeContract(outcome, fallback), refusal: outcome.refusal };
  }
  if (outcome.kind === "retry") {
    return { kind: "retry", verb, contract: outcomeContract(outcome, fallback), detail: outcome.reason };
  }

  if (contract === null) throw new TypeError("accepted outcome is missing its contract");
  const accepted = outcome.receipt;
  const effects: Array<Awaited<ReturnType<Keiyaku["reconcile"]>>["effects"][number]> = [];
  const lag: Lag[] = [];
  try {
    effects.push(...(await contract.reconcile()).effects);
  } catch (error) {
    lag.push({ kind: "reconcile", contract: accepted.snapshot.id, error: errorBytes(error) });
  }
  const replacement = accepted.snapshot.body;
  const predecessor = accepted.prior?.body;
  const diff = predecessor === undefined || predecessor === null || replacement === null
    ? undefined
    : unifiedDiff(ContractBody.render({ body: predecessor }), ContractBody.render({ body: replacement }));
  return {
    kind: "accepted",
    verb,
    contract: accepted.snapshot.id,
    head: accepted.snapshot.head,
    facts: accepted.facts.map((fact): AcceptedFact => ({
      contract: fact.contract,
      entry: fact.entry,
      kind: fact.kind,
    })),
    effects,
    ...(report === undefined ? {} : { report }),
    ...(diff === undefined || diff.length === 0 ? {} : { diff }),
    ...(lag.length === 0 ? {} : { lag }),
  };
}
