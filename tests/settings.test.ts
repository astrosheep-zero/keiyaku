import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gatesFrom, SettingsError } from "../src/library/keiyaku.js";
import { loadArchetype } from "../src/akuma/archetype.js";
import { invoke, type SettingsInvocationResult } from "../src/cli/invoke.js";
import { parseArgv } from "../src/cli/parse.js";
import { renderSettingsText, settingsJsonValue } from "../src/cli/render/settings.js";
import { settings } from "../src/settings.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-settings-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, "akuma"), { recursive: true });
  mkdirSync(join(project, ".keiyaku"), { recursive: true });
  return { root, home, project, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("Settings resolves opaque entries by whole-record project shadow", () => {
  const value = fixture();
  try {
    writeFileSync(join(value.home, "settings.json"), JSON.stringify({
      gates: { default: ["reviewed"], strict: ["reviewed", "security-audited"] },
      providers: { codex: { kind: "codex-app-server", executable: "user-codex", env: { A: "user" } } },
    }));
    writeFileSync(join(value.project, ".keiyaku", "settings.json"), JSON.stringify({
      providers: { codex: { kind: "codex-app-server", env: { A: "project" } } },
    }));
    const loaded = settings({ root: value.project, home: value.home });
    assert.equal(loaded.scopes.user.kind, "read");
    assert.equal(loaded.scopes.project.kind, "read");
    assert.deepEqual(loaded.namespace("gates"), {
      kind: "read",
      name: "gates",
      entries: [
        { name: "default", value: ["reviewed"], source: "user", shadows: false },
        { name: "strict", value: ["reviewed", "security-audited"], source: "user", shadows: false },
      ],
    });
    assert.deepEqual(loaded.namespace("providers"), {
      kind: "read",
      name: "providers",
      entries: [{
        name: "codex",
        value: { kind: "codex-app-server", env: { A: "project" } },
        source: "project",
        shadows: true,
      }],
    });
  } finally { value.close(); }
});

test("Settings isolates malformed namespaces but never falls through a failed higher scope", () => {
  const value = fixture();
  try {
    writeFileSync(join(value.home, "settings.json"), JSON.stringify({
      gates: { default: ["reviewed"] },
      providers: [],
    }));
    let loaded = settings({ root: value.project, home: value.home });
    assert.deepEqual(gatesFrom({ settings: loaded }), ["reviewed"]);
    assert.equal(loaded.namespace("providers").kind, "failed");

    writeFileSync(join(value.project, ".keiyaku", "settings.json"), "{");
    loaded = settings({ root: value.project, home: value.home });
    assert.equal(loaded.namespace("gates").kind, "failed");
    assert.throws(() => gatesFrom({ settings: loaded }), SettingsError);
  } finally { value.close(); }
});

test("gatesFrom admits custom words, empty sets, and no implicit default", () => {
  const value = fixture();
  try {
    writeFileSync(join(value.home, "settings.json"), JSON.stringify({ gates: {
      empty: [],
      custom: ["reviewed", "security-audited"],
      duplicate: ["reviewed", "reviewed"],
      invalid: ["Security"],
    } }));
    const loaded = settings({ home: value.home });
    assert.deepEqual(gatesFrom({ settings: loaded }), []);
    assert.deepEqual(gatesFrom({ settings: loaded, name: "empty" }), []);
    assert.deepEqual(gatesFrom({ settings: loaded, name: "custom" }), ["reviewed", "security-audited"]);
    assert.throws(() => gatesFrom({ settings: loaded, name: "missing" }), /unknown gate set/u);
    assert.throws(() => gatesFrom({ settings: loaded, name: "duplicate" }), /duplicate gates/u);
    assert.throws(() => gatesFrom({ settings: loaded, name: "invalid" }), /invalid gate word/u);
  } finally { value.close(); }
});

test("Archetype resolves one provider execution without dotenv loading", () => {
  const value = fixture();
  try {
    writeFileSync(join(value.home, ".env"), "INTRUDER=dotenv\n");
    writeFileSync(join(value.home, "settings.json"), JSON.stringify({ providers: {
      "codex-for": {
        kind: "codex-app-server",
        executable: "codex-custom",
        config: { service_tier: "priority" },
        env: { CODEX_HOME: "/configured", LITERAL: "yes" },
      },
    } }));
    writeFileSync(join(value.home, "akuma", "reviewer.md"), "---\nprovider: codex-for\nmodel: gpt-test\n---\nReview.\n");
    const loaded = loadArchetype({ name: "reviewer", settings: settings({ root: value.project, home: value.home }) });
    assert.deepEqual(loaded.provider, {
      name: "codex-for",
      kind: "codex-app-server",
      executable: "codex-custom",
      config: { service_tier: "priority" },
      env: { CODEX_HOME: "/configured", LITERAL: "yes" },
    });
    assert.equal(loaded.provider.env?.INTRUDER, undefined);
    assert.equal(Object.isFrozen(loaded.provider), true);
    assert.equal(Object.isFrozen(loaded.provider.config), true);
    assert.equal(Object.isFrozen(loaded.provider.env), true);
  } finally { value.close(); }
});

test("settings CLI maps KEIYAKU_HOME only at the process edge", async () => {
  const value = fixture();
  try {
    writeFileSync(join(value.home, "settings.json"), JSON.stringify({ gates: { default: ["reviewed"] } }));
    const parsed = parseArgv(["-C", value.project, "settings"]);
    if ("help" in parsed) throw new Error("unexpected help");
    const result = await invoke(parsed, { cwd: value.project, environment: { KEIYAKU_HOME: value.home } });
    const observed = result as SettingsInvocationResult;
    assert.equal(observed.kind, "settings");
    assert.match(renderSettingsText(observed.value), /^user read /u);
    assert.deepEqual((settingsJsonValue(observed.value) as { namespaces: readonly unknown[] }).namespaces, [
      observed.value.namespace("gates"),
    ]);
  } finally { value.close(); }
});
