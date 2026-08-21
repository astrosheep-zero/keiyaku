import type { Settings, SettingsScopeState } from "../../settings.js";

function namespaceNames(value: Settings): readonly string[] {
  return [
    ...new Set(
      [value.scopes.user, value.scopes.project].flatMap((scope) => (scope.kind === "read" ? scope.namespaces : [])),
    ),
  ].sort();
}

function scope(name: string, value: SettingsScopeState): string {
  const path = value.path === undefined ? "" : ` ${value.path}`;
  return value.kind === "failed" ? `${name} failed${path} ${value.diagnostic}` : `${name} ${value.kind}${path}`;
}

export function settingsJsonValue(value: Settings): unknown {
  return {
    scopes: value.scopes,
    namespaces: namespaceNames(value).map((name) => value.namespace(name)),
  };
}

export function renderSettingsText(value: Settings): string {
  const lines = [scope("user", value.scopes.user), scope("project", value.scopes.project)];
  for (const name of namespaceNames(value)) {
    const view = value.namespace(name);
    lines.push(`namespace ${name} ${view.kind}`);
    if (view.kind === "failed") {
      for (const failure of view.failures) lines.push(`failure ${failure.scope} ${failure.diagnostic}`);
    }
    for (const entry of view.entries) {
      lines.push(
        `entry ${entry.name} ${entry.source}${entry.shadows ? " shadows user" : ""} ${JSON.stringify(entry.value)}`,
      );
    }
  }
  return lines.join("\n");
}
