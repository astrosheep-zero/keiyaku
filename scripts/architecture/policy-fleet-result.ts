import { any, types } from "./policy-helpers.js";

export const fleetResultZones = [
  {
    source: "library/fleet-result.ts",
    allow: [
      types("akuma/index.ts", ["AkumaStatus", "KillEvidence", "TellResult"]),
      types("core/facts/types.ts", ["ContractId"]),
      types("task/index.ts", ["TaskRow"]),
      any("library/fleet-status-result.ts", [
        "canonicalFleetAkuId",
        "exactFleetKeys",
        "fleetCount",
        "isFleetStatus",
        "isFleetTaskRows",
        "record",
      ]),
    ],
  },
  {
    source: "library/fleet-status-result.ts",
    allow: [types("akuma/index.ts", ["AkumaStatus"]), any("akuma/identity.ts", ["parseAkuId"])],
  },
];
