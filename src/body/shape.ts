export const CONTRACT_SECTIONS = {
  context: { title: "Context", required: true },
  objective: { title: "Objective", required: true },
  design: { title: "Design", required: true },
  region: { title: "Region", required: true },
  criteria: { title: "Criteria", required: true },
  verification: { title: "Verification", required: false },
} as const;

export const RESERVED_SECTIONS: ReadonlySet<string> = new Set(["gates", "pipeline", "after", "arc", "fulfillment"]);

export type ContractSectionName = keyof typeof CONTRACT_SECTIONS;

export function contractSectionName(title: string): ContractSectionName | null {
  for (const name of Object.keys(CONTRACT_SECTIONS) as ContractSectionName[]) {
    if (CONTRACT_SECTIONS[name].title === title) return name;
  }
  return null;
}
