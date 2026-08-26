import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

type Section = Readonly<{ kind?: string; value?: Readonly<{ rows?: readonly Record<string, unknown>[] }> }>;
type Report = Readonly<{
  contracts?: Section;
  tasks?: Section;
  akuma?: Section;
}>;

type ExecResult = Readonly<{ stdout: string; stderr: string; code: number }>;

const REFRESH_TIMEOUT_MS = 10_000;

function rows(section: Section | undefined): readonly Record<string, unknown>[] {
  return section?.kind === "present" && Array.isArray(section.value?.rows) ? section.value.rows : [];
}

function failed(section: Section | undefined): boolean {
  return section?.kind === "failed";
}

function contractNeedsAttention(row: Record<string, unknown>): boolean {
  const gates = row.gates;
  if (typeof gates === "object" && gates !== null && "reports" in gates && Array.isArray(gates.reports)) {
    for (const report of gates.reports) {
      if (
        typeof report === "object" &&
        report !== null &&
        "current" in report &&
        typeof report.current === "object" &&
        report.current !== null &&
        "kind" in report.current &&
        report.current.kind === "attested" &&
        "verdict" in report.current &&
        report.current.verdict === "unsatisfied"
      )
        return true;
    }
  }
  return row.targetLag !== undefined &&
    typeof row.targetLag === "object" &&
    row.targetLag !== null &&
    "kind" in row.targetLag
    ? row.targetLag.kind === "unknown"
    : false;
}

function taskNeedsAttention(row: Record<string, unknown>): boolean {
  return row.disposition === "blocked";
}

function akumaNeedsAttention(row: Record<string, unknown>): boolean {
  return row.life === "stillborn" || row.life === "hung" || row.life === "untidy";
}

function summary(report: Report): string {
  const contractRows = rows(report.contracts);
  const taskRows = rows(report.tasks);
  const akumaRows = rows(report.akuma);
  const attention =
    Number(failed(report.contracts)) +
    Number(failed(report.tasks)) +
    Number(failed(report.akuma)) +
    contractRows.filter(contractNeedsAttention).length +
    taskRows.filter(taskNeedsAttention).length +
    akumaRows.filter(akumaNeedsAttention).length;
  const parts = [`Keiyaku · ${contractRows.length} contracts`, `${akumaRows.length} fleet`, `${taskRows.length} tasks`];
  if (attention > 0) parts.push(`! ${attention}`);
  return parts.join(" · ");
}

function parseReport(result: ExecResult): Report | undefined {
  if (result.code !== 0 || result.stdout.trim().length === 0) return undefined;
  try {
    const value: unknown = JSON.parse(result.stdout);
    return typeof value === "object" && value !== null ? (value as Report) : undefined;
  } catch {
    return undefined;
  }
}

async function run(pi: ExtensionAPI, args: readonly string[], timeout = REFRESH_TIMEOUT_MS): Promise<ExecResult> {
  const bundledCli = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/cli/index.js");
  if (existsSync(bundledCli)) return await pi.exec(process.execPath, [bundledCli, ...args], { timeout });
  return await pi.exec("keiyaku", [...args], { timeout });
}

function lineForWidth(value: string, width: number): string {
  const clean = value.replaceAll(/[\u0000-\u001f\u007f]/gu, " ");
  return clean.length <= width ? clean : `${clean.slice(0, Math.max(0, width - 1))}…`;
}

function overlay(lines: readonly string[], theme: Theme, done: () => void) {
  return {
    invalidate(): void {},
    handleInput(data: string): void {
      if (data === "\u001b" || data === "q" || data === "Q" || data === "\r") done();
    },
    render(width: number): string[] {
      const inner = Math.max(20, Math.min(100, width - 4));
      const border = theme.fg("border", "+");
      const rule = theme.fg("border", "-".repeat(inner));
      return [
        `${border}${rule}${border}`,
        `${theme.fg("border", "|")}${lineForWidth("Keiyaku", inner).padEnd(inner)}${theme.fg("border", "|")}`,
        `${theme.fg("border", "|")}${" ".repeat(inner)}${theme.fg("border", "|")}`,
        ...lines.map(
          (line) => `${theme.fg("border", "|")}${lineForWidth(line, inner).padEnd(inner)}${theme.fg("border", "|")}`,
        ),
        `${theme.fg("border", "|")}${" ".repeat(inner)}${theme.fg("border", "|")}`,
        `${theme.fg("border", "|")}${lineForWidth("esc/q/enter close", inner).padEnd(inner)}${theme.fg("border", "|")}`,
        `${border}${rule}${border}`,
      ];
    },
  };
}

export default function keiyakuExtension(pi: ExtensionAPI): void {
  let refreshInFlight: Promise<void> | undefined;

  const refresh = async (ctx: Pick<ExtensionContext, "hasUI" | "ui">): Promise<void> => {
    if (!ctx.hasUI) return;
    refreshInFlight ??= (async () => {
      const result = await run(pi, ["status", "--json"]);
      const report = parseReport(result);
      if (report === undefined) {
        const diagnostic = result.stderr.trim() || "status unavailable";
        ctx.ui.setWidget("keiyaku", [`Keiyaku · ${lineForWidth(diagnostic, 100)}`]);
      } else ctx.ui.setWidget("keiyaku", [summary(report)]);
    })().finally(() => {
      refreshInFlight = undefined;
    });
    await refreshInFlight;
  };

  pi.on("session_start", async (_event, ctx) => {
    await refresh(ctx);
  });
  pi.on("turn_end", async (_event, ctx) => {
    await refresh(ctx);
  });
  pi.registerCommand("keiyaku", {
    description: "Open the Kanshi world status",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const result = await run(pi, ["status"]);
      const body =
        result.code === 0 ? result.stdout.trimEnd().split("\n") : [result.stderr.trim() || "status unavailable"];
      await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => overlay(body, theme, done), {
        overlay: true,
        overlayOptions: { anchor: "center", width: 100, maxHeight: 40 },
      });
      await refresh(ctx);
    },
  });
}
