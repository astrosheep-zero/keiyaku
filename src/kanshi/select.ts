import type { KanshiReport } from "./report.js";

export type KanshiSelection = Readonly<{ contract: string }>;

export function selectKanshi(input: Readonly<{
  report: KanshiReport;
  contract: string;
}>): KanshiReport {
  const { report, contract } = input;
  return {
    ...report,
    contracts: report.contracts.kind === "present"
      ? { kind: "present", value: { ...report.contracts.value, rows: report.contracts.value.rows.filter((row) => row.id === contract) } }
      : report.contracts,
    tasks: report.tasks.kind === "present"
      ? { kind: "present", value: { ...report.tasks.value, rows: report.tasks.value.rows.filter((row) => row.contract?.id === contract) } }
      : report.tasks,
    akuma: report.akuma.kind === "present"
      ? {
          kind: "present",
          value: {
            ...report.akuma.value,
            rows: report.akuma.value.rows.filter((row) => "contract" in row && row.contract?.id === contract),
          },
        }
      : report.akuma,
  };
}
