import { any, factErrors, factTypes, types } from "./policy-helpers.js";
export const coreZones = [
  { source: "core/facts/types.ts", allow: [any("identity/coordinates.ts")] },
  { source: "core/facts/errors.ts", allow: [] },
  {
    source: "core/facts/codec.ts",
    allow: [factErrors, factTypes, any("core/subject.ts", ["parseDependencyKeySet"])],
  },
  {
    source: "core/facts/fold.ts",
    allow: [any("core/facts/eligibility.ts", ["samePrerequisites"]), factErrors, any("core/facts/gate.ts"), factTypes],
  },
  { source: "core/facts/gate.ts", allow: [any("core/subject.ts"), types("core/facts/types.ts")] },
  { source: "core/subject.ts", allow: [factErrors, factTypes] },
  {
    source: "core/facts/eligibility.ts",
    allow: [any("core/facts/observation.ts"), types("core/facts/offer.ts"), types("core/facts/types.ts")],
  },
  { source: "core/facts/offer.ts", allow: [types("core/facts/types.ts")] },
  { source: "core/facts/observation.ts", allow: [types("core/facts/types.ts")] },
  {
    source: "core/decide.ts",
    allow: [types("core/facts/observation.ts"), types("core/facts/offer.ts"), types("core/facts/types.ts")],
  },
  {
    source: "core/verbs/**",
    allow: [
      types("core/decide.ts"),
      types("core/facts/offer.ts"),
      any("core/facts/eligibility.ts", [
        "placeEligibleBounds",
        "prerequisiteStatus",
        "prerequisitesReach",
        "samePrerequisites",
      ]),
      any("core/facts/gate.ts"),
      any("core/facts/observation.ts", ["activeContract", "contractState", "documentIsCurrent", "prerequisiteStatus"]),
      types("core/facts/types.ts"),
    ],
  },
];
