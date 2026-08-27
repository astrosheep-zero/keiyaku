import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gatesFrom, requireBranchesToBeUpToDateFrom, SettingsError } from "../src/library/keiyaku.js";
import { loadArchetype } from "../src/akuma/archetype.js";
import { decodeProviderOptions } from "../src/akuma/provider-recipe.js";
import { decodeAcpConfig } from "../src/akuma/providers/acp/index.js";
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

type SettingsFixture = ReturnType<typeof fixture>;

async function loadNamed(value: SettingsFixture, name: string) {
  return loadArchetype({
    name,
    home: value.home,
    settings: await settings({ root: value.project, home: value.home }),
  });
}

test("Settings resolves opaque entries by whole-record project shadow", async () => {
  const value = fixture();
  try {
    writeFileSync(
      join(value.home, "settings.json"),
      JSON.stringify({
        gates: {
          default: { kind: "bundle", gates: ["reviewed"] },
          strict: { kind: "bundle", gates: ["reviewed", "verified"] },
        },
        providers: { codex: { kind: "codex-app-server", executable: "user-codex", env: { A: "user" } } },
      }),
    );
    writeFileSync(
      join(value.project, ".keiyaku", "settings.json"),
      JSON.stringify({
        providers: { codex: { kind: "codex-app-server", env: { A: "project" } } },
      }),
    );
    const loaded = await settings({ root: value.project, home: value.home });
    assert.equal(loaded.scopes.user.kind, "read");
    assert.equal(loaded.scopes.project.kind, "read");
    assert.deepEqual(loaded.namespace("gates"), {
      kind: "read",
      name: "gates",
      entries: [
        { name: "default", value: { kind: "bundle", gates: ["reviewed"] }, source: "user", shadows: false },
        { name: "strict", value: { kind: "bundle", gates: ["reviewed", "verified"] }, source: "user", shadows: false },
      ],
    });
    assert.deepEqual(loaded.namespace("providers"), {
      kind: "read",
      name: "providers",
      entries: [
        {
          name: "codex",
          value: { kind: "codex-app-server", env: { A: "project" } },
          source: "project",
          shadows: true,
        },
      ],
    });
  } finally {
    value.close();
  }
});

test("Settings isolates malformed namespaces but never falls through a failed higher scope", async () => {
  const value = fixture();
  try {
    writeFileSync(
      join(value.home, "settings.json"),
      JSON.stringify({
        gates: { default: { kind: "bundle", gates: ["reviewed"] } },
        providers: [],
      }),
    );
    let loaded = await settings({ root: value.project, home: value.home });
    assert.deepEqual(gatesFrom({ settings: loaded }), ["reviewed"]);
    assert.equal(loaded.namespace("providers").kind, "failed");

    writeFileSync(join(value.project, ".keiyaku", "settings.json"), "{");
    loaded = await settings({ root: value.project, home: value.home });
    assert.equal(loaded.namespace("gates").kind, "failed");
    assert.throws(() => gatesFrom({ settings: loaded }), SettingsError);
  } finally {
    value.close();
  }
});

test("gatesFrom expands selected bundles, deduplicates stably, and defaults to reviewed", async () => {
  const value = fixture();
  try {
    writeFileSync(
      join(value.home, "settings.json"),
      JSON.stringify({
        gates: {
          empty: { kind: "bundle", gates: [] },
          first: { kind: "bundle", gates: ["reviewed", "verified", "reviewed"] },
          second: { kind: "bundle", gates: ["verified"] },
          future: { kind: "external", gate: "security-audited" },
        },
      }),
    );
    let loaded = await settings({ home: value.home });
    assert.deepEqual(gatesFrom({ settings: loaded }), ["reviewed"]);
    assert.deepEqual(gatesFrom({ settings: loaded, names: [] }), []);
    assert.deepEqual(gatesFrom({ settings: loaded, names: ["empty"] }), []);
    assert.deepEqual(gatesFrom({ settings: loaded, names: ["first", "second", "first"] }), ["reviewed", "verified"]);

    writeFileSync(
      join(value.home, "settings.json"),
      JSON.stringify({
        gates: {
          default: { kind: "bundle", gates: [] },
        },
      }),
    );
    loaded = await settings({ home: value.home });
    assert.deepEqual(gatesFrom({ settings: loaded }), []);
  } finally {
    value.close();
  }
});

test("gatesFrom validates only selected bundle records and hard-rejects the old grammar", async () => {
  const value = fixture();
  try {
    writeFileSync(
      join(value.home, "settings.json"),
      JSON.stringify({
        gates: {
          good: { kind: "bundle", gates: ["reviewed"] },
          future: { kind: "external", gate: "security-audited" },
          legacy: ["reviewed"],
          extra: { kind: "bundle", gates: ["reviewed"], note: true },
          invalid: { kind: "bundle", gates: ["Security"] },
          unavailable: { kind: "bundle", gates: ["security-audited"] },
        },
      }),
    );
    const loaded = await settings({ home: value.home });
    assert.deepEqual(gatesFrom({ settings: loaded, names: ["good"] }), ["reviewed"]);
    assert.throws(() => gatesFrom({ settings: loaded, names: ["missing"] }), /unknown gate bundle/u);
    assert.throws(() => gatesFrom({ settings: loaded, names: ["future"] }), /unsupported kind/u);
    assert.throws(() => gatesFrom({ settings: loaded, names: ["legacy"] }), /must be an object/u);
    assert.throws(() => gatesFrom({ settings: loaded, names: ["extra"] }), /unknown field/u);
    assert.throws(() => gatesFrom({ settings: loaded, names: ["invalid"] }), /invalid gate word/u);
    assert.throws(() => gatesFrom({ settings: loaded, names: ["unavailable"] }), /without a producer/u);
  } finally {
    value.close();
  }
});

test("git policy defaults false and accepts only the ruled boolean", async () => {
  const value = fixture();
  try {
    let loaded = await settings({ root: value.project, home: value.home });
    assert.equal(requireBranchesToBeUpToDateFrom({ settings: loaded }), false);
    writeFileSync(join(value.home, "settings.json"), JSON.stringify({ git: { requireBranchesToBeUpToDate: true } }));
    loaded = await settings({ root: value.project, home: value.home });
    assert.equal(requireBranchesToBeUpToDateFrom({ settings: loaded }), true);
    writeFileSync(join(value.home, "settings.json"), JSON.stringify({ git: { requireBranchesToBeUpToDate: "yes" } }));
    loaded = await settings({ root: value.project, home: value.home });
    assert.throws(() => requireBranchesToBeUpToDateFrom({ settings: loaded }), SettingsError);
  } finally {
    value.close();
  }
});

test("Archetype resolves one provider execution without dotenv loading", async () => {
  const value = fixture();
  try {
    writeFileSync(join(value.home, ".env"), "INTRUDER=dotenv\n");
    writeFileSync(
      join(value.home, "settings.json"),
      JSON.stringify({
        providers: {
          "codex-for": {
            kind: "codex-app-server",
            executable: "codex-custom",
            config: { service_tier: "priority" },
            env: { CODEX_HOME: "/configured", LITERAL: "yes" },
          },
        },
      }),
    );
    writeFileSync(
      join(value.home, "akuma", "reviewer.md"),
      "---\nprovider: codex-for\nmodel: gpt-test\n---\nReview.\n",
    );
    const loaded = await loadNamed(value, "reviewer");
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
  } finally {
    value.close();
  }
});

test("Archetype resolves the OpenCode V1 provider execution as one frozen recipe", async () => {
  const value = fixture();
  try {
    writeFileSync(
      join(value.home, "settings.json"),
      JSON.stringify({
        providers: {
          local: { kind: "opencode-sdk", executable: "opencode-custom", env: { LITERAL: "yes" } },
        },
      }),
    );
    writeFileSync(join(value.home, "akuma", "builder.md"), "---\nprovider: local\nmodel: openai/test\n---\n");
    const loaded = await loadNamed(value, "builder");
    assert.deepEqual(loaded.provider, {
      name: "local",
      kind: "opencode-sdk",
      executable: "opencode-custom",
      env: { LITERAL: "yes" },
    });
    assert.deepEqual(loaded.options, { model: "openai/test" });
    assert.equal(Object.isFrozen(loaded.provider), true);
    assert.equal(Object.isFrozen(loaded.provider.env), true);
  } finally {
    value.close();
  }
});

test("Archetype resolves builtin and configured Pi executions", async () => {
  const value = fixture();
  try {
    writeFileSync(
      join(value.home, "akuma", "pi-worker.md"),
      "---\nprovider: pi\nmodel: openai/gpt\neffort: high\n---\nWork.\n",
    );
    let loaded = await loadNamed(value, "pi-worker");
    assert.deepEqual(loaded.provider, { name: "pi", kind: "pi" });
    writeFileSync(join(value.home, "settings.json"), JSON.stringify({ providers: { local: { kind: "pi", env: {} } } }));
    writeFileSync(join(value.home, "akuma", "pi-worker.md"), "---\nprovider: local\nmodel: openai/gpt\n---\nWork.\n");
    loaded = await loadNamed(value, "pi-worker");
    assert.deepEqual(loaded.provider, { name: "local", kind: "pi", env: {} });
    writeFileSync(
      join(value.home, "settings.json"),
      JSON.stringify({ providers: { local: { kind: "pi", env: { A: "x" } } } }),
    );
    await assert.rejects(loadNamed(value, "pi-worker"), /env injection not supported for provider pi/u);
  } finally {
    value.close();
  }
});

test("Archetype resolves grok-build as its own builtin protocol execution", async () => {
  const value = fixture();
  try {
    writeFileSync(
      join(value.home, "akuma", "grok.md"),
      "---\nprovider: grok-build\nmodel: grok-4\neffort: high\n---\n",
    );
    const loaded = await loadNamed(value, "grok");
    assert.deepEqual(loaded.provider, {
      name: "grok-build",
      kind: "grok-build",
      executable: "grok",
    });
    assert.deepEqual(loaded.options, { model: "grok-4", effort: "high" });
    writeFileSync(join(value.home, "akuma", "grok.md"), "---\nprovider: grok-build\n---\nBuild.\n");
    const prompted = await loadNamed(value, "grok");
    assert.deepEqual(prompted.options, { systemPrompt: "Build.\n", systemPromptMode: "append" });
    writeFileSync(
      join(value.home, "settings.json"),
      JSON.stringify({
        providers: {
          private: { kind: "grok-build", executable: "private-grok", env: { XAI_API_KEY: "test" } },
        },
      }),
    );
    writeFileSync(join(value.home, "akuma", "grok.md"), "---\nprovider: private\neffort: high\n---\n");
    const custom = await loadNamed(value, "grok");
    assert.deepEqual(custom.provider, {
      name: "private",
      kind: "grok-build",
      executable: "private-grok",
      env: { XAI_API_KEY: "test" },
    });
    assert.deepEqual(custom.options, { effort: "high" });
  } finally {
    value.close();
  }
});

test("Archetype resolves a second configured ACP execution without registry changes", async () => {
  const value = fixture();
  try {
    writeFileSync(
      join(value.home, "settings.json"),
      JSON.stringify({
        providers: {
          local: {
            kind: "acp",
            executable: "other-agent",
            config: {
              argvBefore: ["serve"],
              argvAfter: ["stdio"],
              modelArg: "--model-id",
              systemPromptArg: "--prompt",
              systemPromptMode: "append",
            },
            env: { AGENT_PROFILE: "local" },
          },
        },
      }),
    );
    writeFileSync(join(value.home, "akuma", "local.md"), "---\nprovider: local\nmodel: test-model\n---\nBuild.\n");
    const loaded = await loadNamed(value, "local");
    assert.deepEqual(loaded.provider, {
      name: "local",
      kind: "acp",
      executable: "other-agent",
      config: {
        argvBefore: ["serve"],
        argvAfter: ["stdio"],
        modelArg: "--model-id",
        systemPromptArg: "--prompt",
        systemPromptMode: "append",
      },
      env: { AGENT_PROFILE: "local" },
    });
    assert.deepEqual(loaded.options, { model: "test-model", systemPrompt: "Build.\n", systemPromptMode: "append" });
  } finally {
    value.close();
  }
});

test("Archetype systemPromptMode defaults to append and rejects invalid definitions", async () => {
  const value = fixture();
  try {
    writeFileSync(join(value.home, "akuma", "worker.md"), "---\nprovider: claude\n---\nWork.\n");
    assert.deepEqual((await loadNamed(value, "worker")).options, {
      systemPrompt: "Work.\n",
      systemPromptMode: "append",
    });
    writeFileSync(
      join(value.home, "akuma", "worker.md"),
      "---\nprovider: claude\nsystemPromptMode: append\n---\nWork.\n",
    );
    assert.deepEqual((await loadNamed(value, "worker")).options, {
      systemPrompt: "Work.\n",
      systemPromptMode: "append",
    });
    writeFileSync(
      join(value.home, "akuma", "worker.md"),
      "---\nprovider: claude\nsystemPromptMode: replace\n---\nWork.\n",
    );
    assert.deepEqual((await loadNamed(value, "worker")).options, {
      systemPrompt: "Work.\n",
      systemPromptMode: "replace",
    });
    writeFileSync(join(value.home, "akuma", "worker.md"), "---\nprovider: claude\n---\n");
    assert.deepEqual((await loadNamed(value, "worker")).options, {});
    writeFileSync(join(value.home, "akuma", "worker.md"), "---\nprovider: claude\nsystemPromptMode: replace\n---\n");
    await assert.rejects(loadNamed(value, "worker"), /systemPromptMode requires a nonempty Markdown body/u);
    writeFileSync(
      join(value.home, "akuma", "worker.md"),
      "---\nprovider: claude\nsystemPromptMode: merge\n---\nWork.\n",
    );
    await assert.rejects(loadNamed(value, "worker"), /systemPromptMode must be one of append, replace/u);
  } finally {
    value.close();
  }
});

test("provider option decoding preserves historical prompts and rejects invalid modes", () => {
  assert.deepEqual(decodeProviderOptions({ systemPrompt: "Work.\n" }), { systemPrompt: "Work.\n" });
  assert.deepEqual(decodeProviderOptions({ systemPrompt: "Work.\n", systemPromptMode: "replace" }), {
    systemPrompt: "Work.\n",
    systemPromptMode: "replace",
  });
  assert.throws(() => decodeProviderOptions({ systemPromptMode: "append" }), /requires systemPrompt/u);
  assert.throws(
    () => decodeProviderOptions({ systemPrompt: "Work.\n", systemPromptMode: "merge" }),
    /systemPromptMode must be append, replace/u,
  );
});

test("generic ACP prompt argument mode matches only the configured mapping", async () => {
  const value = fixture();
  const historical = {
    kind: "acp",
    executable: "other-agent",
    config: { argvBefore: ["serve"], argvAfter: ["stdio"], systemPromptArg: "--prompt" },
  };
  try {
    assert.deepEqual(decodeAcpConfig(historical.config), {
      argvBefore: ["serve"],
      argvAfter: ["stdio"],
      systemPromptArg: "--prompt",
    });
    writeFileSync(join(value.home, "settings.json"), JSON.stringify({ providers: { local: historical } }));
    writeFileSync(join(value.home, "akuma", "local.md"), "---\nprovider: local\n---\nBuild.\n");
    await assert.rejects(loadNamed(value, "local"), /does not match the configured argument mode/u);
    writeFileSync(
      join(value.home, "akuma", "local.md"),
      "---\nprovider: local\nsystemPromptMode: replace\n---\nBuild.\n",
    );
    assert.deepEqual((await loadNamed(value, "local")).options, {
      systemPrompt: "Build.\n",
      systemPromptMode: "replace",
    });
    writeFileSync(
      join(value.home, "settings.json"),
      JSON.stringify({
        providers: {
          local: {
            ...historical,
            config: { ...historical.config, systemPromptMode: "append" },
          },
        },
      }),
    );
    writeFileSync(join(value.home, "akuma", "local.md"), "---\nprovider: local\n---\nBuild.\n");
    assert.deepEqual((await loadNamed(value, "local")).options, {
      systemPrompt: "Build.\n",
      systemPromptMode: "append",
    });
    writeFileSync(
      join(value.home, "settings.json"),
      JSON.stringify({
        providers: {
          local: {
            kind: "acp",
            executable: "other-agent",
            config: { argvBefore: ["serve"], argvAfter: ["stdio"], systemPromptMode: "append" },
          },
        },
      }),
    );
    await assert.rejects(loadNamed(value, "local"), /systemPromptMode requires systemPromptArg/u);
  } finally {
    value.close();
  }
});

test("settings CLI maps KEIYAKU_HOME only at the process edge", async () => {
  const value = fixture();
  try {
    writeFileSync(
      join(value.home, "settings.json"),
      JSON.stringify({
        gates: {
          default: { kind: "bundle", gates: ["reviewed"] },
        },
      }),
    );
    const parsed = parseArgv(["-C", value.project, "settings"]);
    if ("help" in parsed) throw new Error("unexpected help");
    const result = await invoke(parsed, { cwd: value.project, environment: { KEIYAKU_HOME: value.home } });
    const observed = result as SettingsInvocationResult;
    assert.equal(observed.kind, "settings");
    assert.match(renderSettingsText(observed.value), /^user read /u);
    assert.deepEqual((settingsJsonValue(observed.value) as { namespaces: readonly unknown[] }).namespaces, [
      observed.value.namespace("gates"),
    ]);
  } finally {
    value.close();
  }
});
