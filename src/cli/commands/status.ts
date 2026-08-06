import type { ContractId, StatusReport } from "../../index.js";
import type { ParsedStatus } from "../parse.js";
import type { InvocationResult } from "../result.js";

export function statusFromCommand(
  status: StatusReport,
  _command: ParsedStatus,
  contract?: ContractId,
): InvocationResult {
  return {
    kind: "observation",
    command: "status",
    scope: status.scope,
    contracts: contract === undefined
      ? status.contracts
      : status.contracts.filter((item) => item.contractId === contract),
  };
}
