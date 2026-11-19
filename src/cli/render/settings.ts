import type { Settings, SettingsScopeState } from "../../settings.js";
import { opaqueCoordinate, previewLines } from "./terminal.js";
import { fieldName, namedValueLines } from "./value.js";

export function renderSettingsText(value: Omit<Settings, "namespace">): string {
  const lines = ["settings", ...scopeLines("user", value.scopes.user), ...scopeLines("project", value.scopes.project)];
  for (const [name, view] of Object.entries(value.namespaces ?? {})) {
    lines.push(`  namespace  ${fieldName(name)}  ${view.kind}`);
    if (view.kind === "failed") {
      for (const failure of view.failures) {
        const scope = value.scopes[failure.scope];
        const diagnostic = failure.diagnostic ?? (scope.kind === "failed" ? scope.diagnostic : undefined);
        lines.push(
          `    failure  ${failure.scope}`,
          ...(diagnostic === undefined ? [] : previewLines(diagnostic, "      ")),
        );
      }
    }
    for (const [entryName, entry] of Object.entries(view.entries ?? {})) {
      lines.push(`    entry  ${fieldName(entryName)} · ${entry.source}${entry.shadows ? " · shadows user" : ""}`);
      lines.push(...namedValueLines("value", entry.value, "      "));
    }
  }
  return lines.join("\n");
}

function scopeLines(name: string, value: SettingsScopeState): readonly string[] {
  return [
    `  ${name}  ${value.kind}${value.path === undefined ? "" : `  ${opaqueCoordinate(value.path)}`}`,
    ...(value.kind === "failed" ? previewLines(value.diagnostic, "    ") : []),
  ];
}
