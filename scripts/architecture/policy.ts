import type { ArchitecturePolicy } from "./engine.js";

const any = (target: string, symbols?: readonly string[]) => symbols ? { target, symbols } : { target };
const types = (target: string) => ({ target, mode: "type-only" as const });

export const KEIYAKU_ARCHITECTURE_POLICY = {
  zones: [
    { source: "core/facts/types.ts", allow: [] },
    { source: "core/facts/codec.ts", allow: [any("core/facts/types.ts")] },
    { source: "core/facts/fold.ts", allow: [any("core/facts/gate.ts"), any("core/facts/types.ts")] },
    { source: "core/facts/gate.ts", allow: [any("core/facts/types.ts")] },
    {
      source: "core/facts/admission.ts",
      allow: [
        any("core/facts/codec.ts"),
        any("core/facts/fold.ts"),
        any("core/facts/repository.ts"),
        any("core/facts/types.ts"),
      ],
    },
    { source: "core/facts/repository.ts", allow: [] },
    { source: "core/protocol/**", allow: [any("core/facts/**"), any("core/protocol/**")] },
    {
      source: "core/verbs/**",
      allow: [
        any("core/facts/gate.ts"),
        any("core/facts/types.ts"),
        types("core/protocol/run.ts"),
      ],
    },
    { source: "core/read/**", allow: [any("core/facts/**"), any("core/protocol/observe.ts"), any("core/read/**")] },
    { source: "core/reconcile.ts", allow: [any("core/facts/**"), any("core/protocol/observe.ts")] },
    { source: "core/actor.ts", allow: [] },
    {
      source: "task/**",
      allow: [
        any("task/**"),
        any("core/facts/types.ts", ["TaskId", "taskCoordinates"]),
      ],
    },
    {
      source: "cli/commands/**",
      allow: [
        any("cli/parse.ts"),
        any("cli/commands/**"),
        any("core/facts/types.ts"),
        types("core/verbs/**"),
      ],
    },
    {
      source: "cli/render/**",
      allow: [
        any("cli/render/**"),
        types("cli/**"),
        types("core/**"),
      ],
    },
    {
      source: "cli/invoke.ts",
      allow: [
        any("cli/commands/**"),
        any("cli/parse.ts"),
        any("core/**"),
        any("task/cli.ts"),
        types("task/model.ts"),
      ],
    },
    { source: "cli/main.ts", allow: [any("cli/**"), any("core/actor.ts")] },
    { source: "cli/index.ts", allow: [any("cli/**")] },
    { source: "cli/parse.ts", allow: [] },
    { source: "scripts/architecture/**", allow: [any("scripts/architecture/**")] },
    { source: "scripts/check-architecture.ts", allow: [any("scripts/architecture/**")] },
    { source: "scripts/model-impact/**", allow: [any("scripts/model-impact/**")] },
    { source: "scripts/model-change-impact.ts", allow: [any("scripts/model-impact/**")] },
  ],
  sensitiveImports: [
    { module: "node:module", owners: [] },
    { module: "module", owners: [] },
    {
      module: "node:child_process",
      owners: [
        { source: "core/facts/repository.ts", symbols: ["execFileSync"] },
        { source: "scripts/model-change-impact.ts", symbols: ["execFileSync"] },
      ],
    },
    { module: "child_process", owners: [] },
    {
      module: "node:fs",
      owners: [
        { source: "scripts/check-architecture.ts", symbols: ["readFileSync", "readdirSync"] },
        { source: "scripts/model-change-impact.ts", symbols: ["readFileSync", "readdirSync"] },
        { source: "cli/invoke.ts", symbols: ["readFileSync"] },
        { source: "core/reconcile.ts", symbols: ["existsSync", "mkdirSync", "realpathSync"] },
        { source: "task/store.ts", symbols: ["readFileSync", "renameSync", "rmSync", "writeFileSync"] },
      ],
    },
    { module: "fs", owners: [] },
    { module: "node:fs/promises", owners: [] },
    { module: "fs/promises", owners: [] },
    {
      module: "node:crypto",
      owners: [
        { source: "cli/invoke.ts", symbols: ["randomBytes"] },
        { source: "core/facts/codec.ts", symbols: ["createHash"] },
        { source: "task/store.ts", symbols: ["randomBytes"] },
      ],
    },
    { module: "crypto", owners: [] },
  ],
  forbiddenModules: [
    "better-sqlite3",
    "sqlite3",
    "node:sqlite",
  ],
  capabilityRules: [
    { capability: "dynamic-import-nonliteral", owners: [] },
    { capability: "eval", owners: [] },
    { capability: "function-constructor", owners: [] },
    { capability: "math-random", owners: [] },
    { capability: "module-mutable-state", owners: [] },
    { capability: "date-now", owners: ["cli/invoke.ts"] },
    { capability: "new-date-current", owners: ["cli/invoke.ts"] },
    { capability: "process-argv", owners: ["cli/main.ts", "cli/index.ts", "scripts/check-architecture.ts", "scripts/model-change-impact.ts"] },
    { capability: "process-cwd", owners: ["core/facts/repository.ts", "scripts/check-architecture.ts", "scripts/model-change-impact.ts"] },
    { capability: "process-environment", owners: ["cli/invoke.ts", "core/facts/repository.ts"] },
    { capability: "process-output", owners: ["cli/main.ts", "cli/index.ts", "scripts/check-architecture.ts", "scripts/model-change-impact.ts"] },
    { capability: "process-pid", owners: ["task/store.ts"] },
    { capability: "require", owners: [] },
  ],
  forbiddenFileNames: [
    "approval-preparation.ts",
    "claim.ts",
    "forfeit.ts",
    "open.ts",
    "petition-preparation.ts",
    "petition.ts",
    "pipeline.ts",
    "renew.ts",
    "seal.ts",
  ],
  forbiddenDeclarations: [
    /(?:Open|Seal|Renew|Petition|Claim|Forfeit)(?:Data|Entry|Input|Refusal|Decision|Offer|State|Result)$/,
  ],
  verbDirectory: "core/verbs/",
} as const satisfies ArchitecturePolicy;
