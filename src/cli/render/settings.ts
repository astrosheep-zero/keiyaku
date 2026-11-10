import type { Settings, SettingsScopeState } from "../../settings.js";
import { DEFAULT_CLI_COLUMNS, displayColumns, renderTextBlock } from "./terminal.js";
import { fieldName, namedValueLines } from "./value.js";

function labeledTokens(label: string, tokens: readonly string[], indent: string, columns: number): readonly string[] {
  const inline = [label, ...tokens].filter((part) => part.length > 0).join("  ");
  if (displayColumns(`${indent}${inline}`) <= columns) return [`${indent}${inline}`];
  if (tokens.length > 0) {
    const head = `${label}  ${tokens[0]}`;
    if (displayColumns(`${indent}${head}`) <= columns) {
      return [`${indent}${head}`, ...tokens.slice(1).map((token) => `${indent}  ${token}`)];
    }
  }
  return [...renderTextBlock(label, indent, columns), ...tokens.map((token) => `${indent}  ${token}`)];
}

export function renderSettingsText(value: Omit<Settings, "namespace">, columns = DEFAULT_CLI_COLUMNS): string {
  const lines = [
    "settings",
    ...scopeLines("user", value.scopes.user, columns),
    ...scopeLines("project", value.scopes.project, columns),
  ];
  for (const [name, view] of Object.entries(value.namespaces ?? {})) {
    lines.push(`  namespace  ${fieldName(name)}  ${view.kind}`);
    if (view.kind === "failed") {
      for (const failure of view.failures) {
        const scope = value.scopes[failure.scope];
        const diagnostic = failure.diagnostic ?? (scope.kind === "failed" ? scope.diagnostic : undefined);
        lines.push(`    failure  ${failure.scope}${diagnostic === undefined ? "" : `  ${diagnostic}`}`);
      }
    }
    for (const [entryName, entry] of Object.entries(view.entries ?? {})) {
      lines.push(`    entry  ${fieldName(entryName)} · ${entry.source}${entry.shadows ? " · shadows user" : ""}`);
      lines.push(...namedValueLines("value", entry.value, "      "));
    }
  }
  return lines.join("\n");
}

function scopeLines(name: string, value: SettingsScopeState, columns: number): readonly string[] {
  const tokens = value.path === undefined ? [] : [value.path];
  if (value.kind === "failed") tokens.push(value.diagnostic);
  return labeledTokens(name, [value.kind, ...tokens], "  ", columns);
}
