import type { Settings, SettingsScopeState } from "../../settings.js";
import { DEFAULT_CLI_COLUMNS, displayColumns, renderTextBlock } from "./terminal.js";
import { fieldName } from "./value.js";

function settingValueLines(name: string, value: unknown, indent: string): readonly string[] {
  const secret = /(?:key|token|secret|password|credential)/iu.test(name);
  if (secret && value !== undefined && value !== null && String(value).length > 0)
    return [`${indent}${fieldName(name)}  [redacted]`];
  if (value === null || typeof value !== "object") return [`${indent}${fieldName(name)}  ${String(value)}`];
  if (Array.isArray(value)) return value.flatMap((item, index) => settingValueLines(`${name}.${index}`, item, indent));
  return Object.entries(value).flatMap(([key, item]) => settingValueLines(`${name}.${key}`, item, indent));
}

function namespaceNames(value: Settings): readonly string[] {
  return [
    ...new Set(
      [value.scopes.user, value.scopes.project].flatMap((scope) => (scope.kind === "read" ? scope.namespaces : [])),
    ),
  ].sort();
}

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

export function settingsJsonValue(value: Settings): unknown {
  return {
    scopes: value.scopes,
    namespaces: namespaceNames(value).map((name) => value.namespace(name)),
  };
}

export function renderSettingsText(value: Settings, columns = DEFAULT_CLI_COLUMNS): string {
  const lines = [
    "settings",
    ...scopeLines("user", value.scopes.user, columns),
    ...scopeLines("project", value.scopes.project, columns),
  ];
  for (const name of namespaceNames(value)) {
    const view = value.namespace(name);
    lines.push(`  namespace  ${fieldName(name)}  ${view.kind}`);
    if (view.kind === "failed") {
      for (const failure of view.failures) lines.push(`    failure  ${failure.scope}  ${failure.diagnostic}`);
    }
    for (const entry of view.entries) {
      lines.push(`    entry  ${fieldName(entry.name)} · ${entry.source}${entry.shadows ? " · shadows user" : ""}`);
      lines.push(...settingValueLines("value", entry.value, "      "));
    }
  }
  return lines.join("\n");
}

function scopeLines(name: string, value: SettingsScopeState, columns: number): readonly string[] {
  const tokens = value.path === undefined ? [] : [value.path];
  if (value.kind === "failed") tokens.push(value.diagnostic);
  return labeledTokens(name, [value.kind, ...tokens], "  ", columns);
}
