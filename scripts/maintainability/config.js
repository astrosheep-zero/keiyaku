export const FILE_LINES = Object.freeze({ warning: 400, error: 500 });
export const MARKDOWN_CHARACTERS = Object.freeze({ warning: 20_000, error: 30_000 });

export const FILE_LINE_EXEMPTIONS = Object.freeze([
  {
    file: "scripts/architecture/policy.ts",
    reason: "The centralized declarative architecture map must remain one policy authority.",
    maxEffectiveLines: 1350,
  },
  {
    file: "scripts/architecture/engine.ts",
    reason: "The centralized TypeScript architecture analyzer keeps parsing and all enforced dependency and capability rules in one implementation owner.",
    maxEffectiveLines: 550,
  },
  {
    file: "src/git/reconcile.ts",
    reason: "Git reconciliation is one serialized effect owner; the terminal physical-absence proof belongs with topology, hooks, and custody rather than a packed companion file.",
    maxEffectiveLines: 650,
  },
  {
    file: "src/akuma/body.ts",
    reason: "The Body is the single live supervisor for provider setup, turn consumption, durable control, and owned descendant cleanup.",
    maxEffectiveLines: 750,
  },
  {
    file: "src/akuma/request-serve.ts",
    reason: "admission, reservation/spawn, owner dispatch, durable receipt projection, live pump, and predecessor recovery share one parent Heart lease, serial admission boundary, and cancellation fence; splitting would create wrappers or duplicate lifecycle authority.",
    maxEffectiveLines: 600,
  },
  {
    file: "src/akuma/akuma.ts",
    reason: "The low-level Akuma owner keeps birth, handles, lifecycle controls, and fleet reads coherent; splitting those operations would obscure that boundary.",
    maxEffectiveLines: 600,
  },
  {
    file: "src/library/contract.ts",
    reason: "The package-root Contract handle remains one operations owner.",
    maxEffectiveLines: 700,
  },
  {
    file: "src/cli/invoke.ts",
    reason: "CLI invocation and adaptation stay one command boundary.",
    maxEffectiveLines: 600,
  },
]);
