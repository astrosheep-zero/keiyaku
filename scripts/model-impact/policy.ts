import type { ModelImpactPolicy } from "./engine.js";

export const MODEL_IMPACT_POLICY = {
  owners: [
    { source: "src/core/facts/**", owner: "core/facts" },
    { source: "src/core/protocol/**", owner: "core/protocol" },
    { source: "src/core/verbs/**", owner: "core/verbs" },
    { source: "src/core/read/**", owner: "core/read" },
    { source: "src/core/reconcile.ts", owner: "core/reconcile" },
    { source: "src/core/actor.ts", owner: "core/actor" },
    { source: "src/cli/**", owner: "cli" },
    { source: "src/task/**", owner: "task" },
    { source: "src/markdown/**", owner: "markdown" },
    { source: "src/**", owner: "other" },
  ],
} as const satisfies ModelImpactPolicy;
