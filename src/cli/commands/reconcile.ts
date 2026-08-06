import type { ContractId, Keiyaku, Repo } from "../../index.js";
import type { Effect, InvocationResult, Lag } from "../result.js";

function errorBytes(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (Buffer.isBuffer(stderr) && stderr.length > 0) return stderr.toString("utf8");
  }
  return error instanceof Error ? error.message : String(error);
}

export async function reconcileFromCommand(contract: ContractId, keiyaku: Keiyaku): Promise<InvocationResult> {
  try {
    return { kind: "observation", command: "reconcile", effects: (await keiyaku.reconcile()).effects };
  } catch (error) {
    return {
      kind: "observation",
      command: "reconcile",
      effects: [],
      lag: [{ kind: "reconcile", contract, error: errorBytes(error) }],
    };
  }
}

export async function reconcileAllFromCommand(repo: Repo): Promise<InvocationResult> {
  const effects: Effect[] = [];
  const lag: Lag[] = [];
  const reconciled = await repo.reconcile();
  for (const item of reconciled.contracts) {
    if (item.kind === "reconciled") effects.push(...item.report.effects);
    else lag.push({ kind: "reconcile", contract: item.contractId, error: item.error });
  }
  return { kind: "observation", command: "reconcile", effects, ...(lag.length === 0 ? {} : { lag }) };
}
