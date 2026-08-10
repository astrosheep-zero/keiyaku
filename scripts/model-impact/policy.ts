import type { ModelImpactPolicy } from "./engine.js";

export const MODEL_IMPACT_POLICY = {
  owners: [
    { source: "src/core/facts/**", owner: "core/facts" },
    { source: "src/core/decide.ts", owner: "core/decide" },
    { source: "src/core/verbs/**", owner: "core/verbs" },
    { source: "src/git/**", owner: "git" },
    { source: "src/protocol/**", owner: "protocol" },
    { source: "src/cli/**", owner: "cli" },
    { source: "src/markdown/**", owner: "markdown" },
    { source: "src/**", owner: "other" },
  ],
} as const satisfies ModelImpactPolicy;
