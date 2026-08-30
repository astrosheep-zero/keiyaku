import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProcessInput, ProcessOutcome } from "../../runtime/proc/run.js";
import { CliUsageError, usageLine } from "../usage.js";

export const HARNESS_NAMES = ["codex", "claude", "opencode", "pi"] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];

export type ParsedInstallCommand = Readonly<{
  command: "install";
  harnesses: readonly HarnessName[];
  output: "text" | "json";
}>;

export type HarnessInstallResult = Readonly<{
  harness: HarnessName;
  status: "installed" | "failed";
  diagnostic?: string;
}>;

export type InstallInvocationResult = Readonly<{
  kind: "install";
  results: readonly HarnessInstallResult[];
}>;

export type InstallRunner = (input: ProcessInput) => Promise<ProcessOutcome>;

export const INSTALL_USAGE = "install <codex|claude|opencode|pi> [--json]\ninstall --all [--json]";
export const INSTALL_ROOT_PURPOSE = "Install Keiyaku into coding harnesses";

function isHarness(value: string | undefined): value is HarnessName {
  return value !== undefined && (HARNESS_NAMES as readonly string[]).includes(value);
}

export function parseInstallCommand(argv: readonly string[]): ParsedInstallCommand {
  let all = false;
  let json = false;
  const positionals: string[] = [];
  for (const token of argv) {
    if (token === "--all") {
      if (all) throw new CliUsageError("duplicate option: --all", usageLine(INSTALL_USAGE));
      all = true;
    } else if (token === "--json") {
      if (json) throw new CliUsageError("duplicate option: --json", usageLine(INSTALL_USAGE));
      json = true;
    } else if (token.startsWith("--")) {
      throw new CliUsageError(`option ${token} is not valid for install`, usageLine(INSTALL_USAGE));
    } else {
      positionals.push(token);
    }
  }
  if (positionals.length > 1) throw new CliUsageError("install accepts at most one harness", usageLine(INSTALL_USAGE));
  const harness = positionals[0];
  if (all && harness !== undefined)
    throw new CliUsageError("install accepts either a harness or --all", usageLine(INSTALL_USAGE));
  if (!all && !isHarness(harness))
    throw new CliUsageError("install requires a supported harness or --all", usageLine(INSTALL_USAGE));
  return {
    command: "install",
    harnesses: all ? HARNESS_NAMES : [harness as HarnessName],
    output: json ? "json" : "text",
  };
}

export function renderInstallHelp(): string {
  return `Install Keiyaku into your coding harnesses via each harness's native plugin/package installer. --all continues past failures; any failure exits 1.\n\n${usageLine(INSTALL_USAGE)}`;
}

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const ASSET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../integrations/marketplace");
const PLUGIN_ROOT = resolve(ASSET_ROOT, "plugins/keiyaku");
const PI_PACKAGE_SOURCE = "npm:@astrosheep/keiyaku";

function recipes(harness: HarnessName): readonly (readonly string[])[] {
  switch (harness) {
    case "codex":
      return [
        ["codex", "plugin", "marketplace", "add", ASSET_ROOT, "--json"],
        ["codex", "plugin", "add", "keiyaku", "--marketplace", "keiyaku", "--json"],
      ];
    case "claude":
      return [
        ["claude", "plugin", "marketplace", "add", ASSET_ROOT],
        ["claude", "plugin", "install", "keiyaku@keiyaku", "--scope", "user"],
        ["claude", "plugin", "update", "keiyaku@keiyaku", "--scope", "user"],
      ];
    case "opencode":
      return [["opencode", "plugin", PLUGIN_ROOT, "--global", "--force"]];
    case "pi":
      return [["pi", "install", PI_PACKAGE_SOURCE]];
  }
}

function diagnostic(argv: readonly string[], outcome: ProcessOutcome): string {
  if (outcome.kind === "spawn-error") return `${argv[0]} unavailable: ${outcome.diagnostic}`;
  if (outcome.kind === "timeout") return `${argv[0]} timed out`;
  if (outcome.kind === "unknown-exit") return `${argv[0]} exited without a status`;
  if (outcome.kind === "cancelled") return `${argv[0]} cancelled`;
  if (outcome.code === 0) return "";
  const detail = outcome.stderr.trim() || outcome.stdout.trim();
  return `${argv[0]} exited ${outcome.code}${detail.length === 0 ? "" : `: ${detail}`}`;
}

export function installAssetsRoot(): string {
  return ASSET_ROOT;
}

export async function installHarnesses(
  harnesses: readonly HarnessName[],
  environment: NodeJS.ProcessEnv,
  runner?: InstallRunner,
): Promise<InstallInvocationResult> {
  const run = runner ?? (await import("../../runtime/proc/run.js")).runCrossPlatformProcess;
  const results: HarnessInstallResult[] = [];
  for (const harness of harnesses) {
    let failure: string | undefined;
    for (const argv of recipes(harness)) {
      const detail = diagnostic(argv, await run({ argv, env: environment, timeoutMs: INSTALL_TIMEOUT_MS }));
      if (detail.length > 0) {
        failure = detail;
        break;
      }
    }
    results.push({
      harness,
      status: failure === undefined ? "installed" : "failed",
      ...(failure === undefined ? {} : { diagnostic: failure }),
    });
  }
  return { kind: "install", results };
}

export function renderInstallText(result: InstallInvocationResult): string {
  return result.results
    .map((item) =>
      item.status === "installed" ? `${item.harness} installed` : `${item.harness} failed: ${item.diagnostic}`,
    )
    .join("\n");
}

export function installExitCode(result: InstallInvocationResult): number {
  return result.results.some((item) => item.status === "failed") ? 1 : 0;
}
