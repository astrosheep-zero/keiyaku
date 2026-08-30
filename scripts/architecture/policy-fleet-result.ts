import { any, types } from "./policy-helpers.js";

export const fleetResultZones = [
  {
    source: "library/fleet-result.ts",
    allow: [
      types("akuma/index.ts", ["AkumaStatus", "KillEvidence", "TellResult"]),
      any("akuma/akuma.ts", ["akumaIdSchema", "akumaStatusSchema"]),
      any("akuma/projection.ts", ["tellRowSchema"]),
      any("core/facts/types.ts", ["contractId", "ContractId"]),
      any("task/board.ts", ["taskRowsSchema"]),
    ],
  },
];
