import type { Soul } from "./heart/index.js";

/** Association is supplied by composition, never read or persisted by Akuma. */
export type ExecutionAssociation = Readonly<{ contractId: string }>;

export type ExecutionAssociationReader = () => Promise<ExecutionAssociation | undefined>;

/** One current execution section; provider adapters only choose its native channel. */
export function keiyakuExecutionInstructions(soul: Soul, association?: ExecutionAssociation): string | undefined {
  if (soul.bare !== false) {
    return soul.bare === true && soul.origin.kind === "fork"
      ? "Any inherited Keiyaku execution context is inactive for this execution."
      : undefined;
  }
  return [
    "<keiyaku>",
    "This context supersedes any earlier Keiyaku execution context.",
    `Akuma: ${soul.id}`,
    `Archetype: ${soul.archetype}`,
    ...(association === undefined ? [] : [`Contract context (not a Dispatch receipt): ${association.contractId}`]),
    'Use `keiyaku report "..."` to share updates without stopping your work.',
    "</keiyaku>",
  ].join("\n");
}
