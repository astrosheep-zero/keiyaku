export const DEFAULT_FILE_LINES = 500;

export const FILE_LINE_EXEMPTIONS = Object.freeze([
  {
    file: "scripts/architecture/policy.ts",
    reason: "The centralized declarative architecture map must remain one policy authority.",
  },
  {
    file: "src/protocol/operations.ts",
    reason: "The centralized protocol operation surface remains one authority; splitting thin operation entry points would obscure that boundary.",
  },
]);
