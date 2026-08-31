import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

type ExecResult = Readonly<{ stdout: string; stderr: string; code: number }>;

async function runStatus(pi: ExtensionAPI): Promise<ExecResult> {
  const bundledCli = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/cli/index.js");
  if (existsSync(bundledCli)) return await pi.exec(process.execPath, [bundledCli, "status"]);
  return await pi.exec("keiyaku", ["status"]);
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
      const inner = Math.max(1, Math.min(100, width - 2));
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
  pi.registerCommand("keiyaku", {
    description: "Open the Kanshi world status",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      let body: string[];
      try {
        const result = await runStatus(pi);
        body = result.code === 0 ? result.stdout.trimEnd().split("\n") : [result.stderr.trim() || "status unavailable"];
      } catch {
        body = ["status unavailable"];
      }
      await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => overlay(body, theme, done), {
        overlay: true,
        overlayOptions: { anchor: "center", width: 100, maxHeight: 40 },
      });
    },
  });
}
