import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { Kanshi, NoGitWorldError, Repo, World } from "@astrosheep/keiyaku";
import { registerAkumaTools } from "./akuma-tools.ts";

type ExecResult = Readonly<{ stdout: string; stderr: string; code: number }>;

async function runStatus(pi: ExtensionAPI): Promise<ExecResult> {
  return await pi.exec("keiyaku", ["kanshi"]);
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

type StatusReaders = {
  repo: typeof Repo.at;
  world: typeof World.resolve;
  counts: (scope: Parameters<typeof Kanshi.of>[0]) => ReturnType<Kanshi["counts"]>;
};

export default function keiyakuExtension(
  pi: ExtensionAPI,
  readers: StatusReaders = { repo: Repo.at, world: World.resolve, counts: (scope) => Kanshi.of(scope).counts() },
): void {
  pi.registerMcpServer("keiyaku", {
    command: process.execPath,
    args: [fileURLToPath(new URL("../../build/src/mcp/index.js", import.meta.url))],
    description: "Agent work ledger for a Git repository. Contracts: bind, amend, arc, deliver, verify, review, abandon, reconcile. Akumas: spawn, fork, tell, ask, kill, wait, history, report. Read and inspect: show, status, ls, region, kanshi, whoami. Debts: debt_add, debt_update. show and ls also read Debts; wait and history also support Contracts.",
    timeout: 600,
  });
  registerAkumaTools(pi);
  let close: (() => void) | undefined;
  let refresh: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    close?.();
    close = undefined;
    refresh = undefined;
    if (ctx.mode !== "tui") return;
    const cwd = ctx.cwd;
    const ui = ctx.ui;
    let live = true;
    let reading = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unknown = "aku ? · kei ? · debt ?";
    const show = (text: string | undefined): void => ui.setStatus("keiyaku", text);
    const value = (section: { kind: "present"; value: number } | { kind: "absent" | "failed" }): string =>
      section.kind === "present" ? String(section.value) : section.kind === "absent" ? "-" : "?";
    const sample = async (): Promise<string> => {
      let repo: Repo | undefined;
      try {
        repo = await readers.repo({ path: cwd });
      } catch (error) {
        if (!(error instanceof NoGitWorldError)) throw error;
      }
      const world = await readers.world(repo === undefined ? { cwd } : { cwd, repositoryRoot: repo.root });
      const report = await readers.counts({ world: world.root, ...(repo === undefined ? {} : { repo }) });
      return `aku ${value(report.akuma)} · kei ${value(report.contracts)} · debt ${value(report.debts)}`;
    };
    const request = (): void => {
      if (!live) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (reading) {
        pending = true;
        return;
      }
      reading = true;
      void sample().catch(() => unknown).then((text) => {
        if (!live) return;
        show(text);
        reading = false;
        if (pending) {
          pending = false;
          request();
        } else {
          timer = setTimeout(request, 5_000);
          timer.unref();
        }
      });
    };
    close = () => {
      if (!live) return;
      live = false;
      if (timer !== undefined) clearTimeout(timer);
      show(undefined);
    };
    refresh = request;
    show(unknown);
    request();
  });
  pi.on("agent_settled", () => { refresh?.(); });
  pi.on("session_shutdown", () => {
    close?.();
    close = undefined;
    refresh = undefined;
  });
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
