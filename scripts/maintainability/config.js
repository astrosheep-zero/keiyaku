export const FILE_LINES = Object.freeze({ warning: 400, error: 500 });

export const FILE_LINE_EXEMPTIONS = Object.freeze([
  {
    file: "scripts/architecture/policy.ts",
    reason: "The centralized declarative architecture map must remain one policy authority.",
  },
  {
    file: "src/protocol/operations.ts",
    reason: "The centralized protocol operation surface remains one authority; splitting thin operation entry points would obscure that boundary.",
  },
  {
    file: "src/git/repository.ts",
    reason: "The centralized Git plumbing owner keeps repository coordinates and object/ref operations coherent; splitting thin wrappers would obscure that boundary.",
  },
  {
    file: "src/git/reconcile.ts",
    reason: "Git reconciliation is one serialized effect owner; the terminal physical-absence proof belongs with topology, hooks, and custody rather than a packed companion file.",
  },
  {
    file: "src/akuma/body.ts",
    reason: "The Body is the single live supervisor for provider setup, turn consumption, durable control, and owned descendant cleanup.",
  },
]);
