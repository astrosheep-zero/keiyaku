import type { Settings, SettingsScopeState } from "../../settings.js";
import { displayColumns, renderTextBlock } from "./terminal.js";

function namespaceNames(value: Settings): readonly string[] {
  return [
    ...new Set(
      [value.scopes.user, value.scopes.project].flatMap((scope) => (scope.kind === "read" ? scope.namespaces : [])),
    ),
  ].sort();
}

function jsonLines(value: unknown, indent: string): readonly string[] {
  return JSON.stringify(value, null, 2)
    .split("\n")
    .map((line) => `${indent}${line}`);
}

function labeledTokens(label: string, tokens: readonly string[], indent: string, columns: number): readonly string[] {
  const inline = [label, ...tokens].filter((part) => part.length > 0).join(" ");
  if (displayColumns(`${indent}${inline}`) <= columns) return [`${indent}${inline}`];
  return [...renderTextBlock(label, indent, columns), ...tokens.map((token) => `${indent}  ${token}`)];
}

export function settingsJsonValue(value: Settings): unknown {
  return {
    scopes: value.scopes,
    namespaces: namespaceNames(value).map((name) => value.namespace(name)),
  };
}

export function renderSettingsText(value: Settings, columns = 80): string {
  const lines = [
    "settings",
    ...scopeLines("user", value.scopes.user, columns),
    ...scopeLines("project", value.scopes.project, columns),
  ];
  for (const name of namespaceNames(value)) {
    const view = value.namespace(name);
    lines.push(...renderTextBlock(`namespace ${name} ${view.kind}`, "  ", columns));
    if (view.kind === "failed") {
      for (const failure of view.failures)
        lines.push(...renderTextBlock(`failure ${failure.scope} ${failure.diagnostic}`, "    ", columns));
    }
    for (const entry of view.entries) {
      lines.push(
        ...renderTextBlock(
          `entry ${entry.name} ${entry.source}${entry.shadows ? " shadows user" : ""}`,
          "    ",
          columns,
        ),
      );
      lines.push(...jsonLines(entry.value, "      "));
    }
  }
  return lines.join("\n");
}

function scopeLines(name: string, value: SettingsScopeState, columns: number): readonly string[] {
  const tokens = value.path === undefined ? [] : [value.path];
  if (value.kind === "failed") tokens.push(value.diagnostic);
  return labeledTokens(`${name} ${value.kind}`, tokens, "  ", columns);
}
