import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gatesFrom, requireBranchesToBeUpToDateFrom, SettingsError } from "../src/settings.js";
import { ALLOWED_ACTIONS, DEFAULT_ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
import { loadArchetype } from "../src/akuma/archetype.js";
import { decodeProviderOptions } from "../src/akuma/provider-recipe.js";
import { decodeAcpConfig } from "../src/akuma/providers/acp/index.js";
import { cliJson, runCli } from "./support/cli-fixtures.js";
import { renderSettingsText } from "../src/cli/render/settings.js";
import { displayColumns } from "../src/cli/render/terminal.js";
import { projectSettings, settings } from "../src/settings.js";
import { Keiyaku, Repo, type ContractId } from "../src/index.js";
import { KeiyakuError } from "../src/library/outcome.js";
import { accepted, present } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import { makeGitRepository } from "./support/git.js";

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
    assert.throws(() => gatesFrom({ settings: loaded, names: ["reviewed"] }), SettingsError);
    assert.deepEqual(gatesFrom({ settings: loaded, names: [] }), []);
  } finally {
    value.close();
  }
});

test("gatesFrom expands mixed gates and bundles, deduplicates stably, and defaults to reviewed", async () => {
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
    assert.deepEqual(
      gatesFrom({ settings: loaded, names: ["verified", "first", "security-audited", "verified"] }),
      ["verified", "reviewed", "security-audited"],
    );
    assert.deepEqual(gatesFrom({ settings: loaded, names: ["reviewed"] }), ["reviewed"]);
    assert.deepEqual(gatesFrom({ settings: loaded, names: ["default"] }), ["default"]);
    for (const name of ["", " ", "Security", "reviewed,verified"]) {
      assert.throws(() => gatesFrom({ settings: loaded, names: [name] }), /gate or bundle name/u);
    }

    writeFileSync(
      join(value.home, "settings.json"),
      JSON.stringify({
        gates: {
          default: { kind: "bundle", gates: [] },
          reviewed: { kind: "bundle", gates: ["verified"] },
        },
      }),
    );
    loaded = await settings({ home: value.home });
    assert.deepEqual(gatesFrom({ settings: loaded }), []);
    assert.deepEqual(gatesFrom({ settings: loaded, names: ["reviewed"] }), ["verified"]);
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
          custom: { kind: "bundle", gates: ["security-audited"] },
        },
      }),
    );
    const loaded = await settings({ home: value.home });
    assert.deepEqual(gatesFrom({ settings: loaded, names: ["good"] }), ["reviewed"]);
    assert.deepEqual(gatesFrom({ settings: loaded, names: ["missing"] }), ["missing"]);
    assert.throws(() => gatesFrom({ settings: loaded, names: ["future"] }), /unsupported kind/u);
    assert.throws(() => gatesFrom({ settings: loaded, names: ["legacy"] }), /must be an object/u);
    assert.throws(() => gatesFrom({ settings: loaded, names: ["extra"] }), /unknown field/u);
    assert.throws(() => gatesFrom({ settings: loaded, names: ["invalid"] }), /invalid gate word/u);
    assert.deepEqual(gatesFrom({ settings: loaded, names: ["custom"] }), ["security-audited"]);
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

test("Archetype omission uses the delegation baseline while explicit allowed sets remain exact", async () => {
  const value = fixture();
  try {
    assert.deepEqual(DEFAULT_ALLOWED_ACTIONS, [
      "akuma.call",
      "akuma.kill",
      "akuma.tell",
      "contract.audit",
      "contract.deliver",
      "task.add",
      "task.addDocument",
      "task.compose",
      "task.done",
      "task.drop",
      "task.hold",
      "task.resume",
      "task.start",
      "task.stop",
      "task.update",
    ]);
    writeFileSync(join(value.home, "akuma", "worker.md"), "---\nprovider: codex-app-server\n---\n");
    assert.deepEqual((await loadNamed(value, "worker")).allowed, DEFAULT_ALLOWED_ACTIONS);
    assert.equal((await loadNamed(value, "worker")).allowed.includes("contract.review"), false);

    writeFileSync(
      join(value.home, "akuma", "full.md"),
      `---\nprovider: codex-app-server\nallowed:\n${ALLOWED_ACTIONS.map((action) => `  - ${action}\n`).join("")}---\n`,
    );
    assert.deepEqual((await loadNamed(value, "full")).allowed, ALLOWED_ACTIONS);

    writeFileSync(
      join(value.home, "akuma", "reviewer.md"),
      "---\nprovider: codex-app-server\nallowed:\n  - contract.review\n---\n",
    );
    writeFileSync(join(value.home, "akuma", "reviewer-child.md"), "---\nbase: reviewer\n---\n");
    assert.deepEqual((await loadNamed(value, "reviewer-child")).allowed, ["contract.review"]);

    writeFileSync(join(value.home, "akuma", "reviewer-child.md"), "---\nbase: reviewer\nallowed: []\n---\n");
    assert.deepEqual((await loadNamed(value, "reviewer-child")).allowed, []);
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

test("Archetype resolves Kimi ACP model and thinking selectors without a custom provider", async () => {
  const value = fixture();
  try {
    writeFileSync(
      join(value.home, "akuma", "kimi.md"),
      "---\nprovider: kimi\nmodel: kimi-code/kimi-for-coding\neffort: low\n---\n",
    );
    const loaded = await loadNamed(value, "kimi");
    assert.deepEqual(loaded.provider, {
      name: "kimi",
      kind: "acp",
      executable: "kimi",
      config: { argvBefore: ["acp"], argvAfter: [], modelConfigId: "model", effortConfigId: "thinking" },
    });
    assert.deepEqual(loaded.options, { model: "kimi-code/kimi-for-coding", effort: "low" });
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
    const observed = await settings({ root: value.project, home: value.home });
    const text = await runCli(["-C", value.project, "settings"], {
      cwd: value.project,
      environment: { KEIYAKU_HOME: value.home },
    });
    assert.equal(text.exit, 0);
    assert.match(text.stdout, /^settings\n  user  read(?:\n    )?/u);
    assert.match(
      text.stdout,
      /    entry  default · user\n      "value\.kind"  bundle\n      "value\.gates\.0"  reviewed/u,
    );
    const json = await cliJson<{ namespaces: readonly unknown[] }>(["-C", value.project, "settings"], {
      cwd: value.project,
      environment: { KEIYAKU_HOME: value.home },
    });
    assert.deepEqual(json.value.namespaces, [observed.namespace("gates")]);
  } finally {
    value.close();
  }
});

test("settings text preserves long paths and opaque provider values at the terminal width", async () => {
  const value = fixture();
  try {
    const longHome = join(value.root, `${"settings-path-".repeat(8)}home`);
    mkdirSync(longHome, { recursive: true });
    const longPath = join(longHome, "settings.json");
    writeFileSync(
      longPath,
      JSON.stringify({ providers: { local: { kind: "acp", env: { LONG_VALUE: "x".repeat(100) } } } }),
    );
    const observed = await settings({ root: value.project, home: longHome });
    const text = renderSettingsText(observed, 72);
    assert.match(text, new RegExp(realpathSync.native(longPath).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.match(text, /"value\.env\.LONG_VALUE"  x{100}/u);
    assert.ok(
      text
        .split("\n")
        .filter((line) => !line.includes("settings.json") && !line.includes("LONG_VALUE"))
        .every((line) => displayColumns(line) <= 72),
    );
  } finally {
    value.close();
  }
});

// ---------------------------------------------------------------------------
// Captured Settings derivation
// ---------------------------------------------------------------------------

function contractDocument(title = "Settings derivation"): string {
  return contractMarkdown(title, {
    Context: "Exercise captured Settings derivation.",
    Objective: "Derive gates, hooks, and freshness lazily at their consuming operation.",
    Design: "One captured Settings value and one operation-local namespace lookup.",
    Region: "```\nsrc/**\n```",
    Criteria: "### Derivation\nThe selected obligations are retained exactly.\n",
  });
}

function writeProjectSettings(root: string, value: unknown): void {
  mkdirSync(join(root, ".keiyaku"), { recursive: true });
  writeFileSync(join(root, ".keiyaku", "settings.json"), `${JSON.stringify(value)}\n`);
}

function invalidInputFromSettings(error: unknown): boolean {
  return (
    error instanceof KeiyakuError &&
    error.category === "invalid-input" &&
    error.cause instanceof SettingsError
  );
}

test("omitted Settings binds literal gate words, empty hooks, and false freshness", async () => {
  const repository = makeGitRepository();
  try {
    repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
    const repo = await Repo.at({ path: repository.path });
    const selected = accepted(
      await Keiyaku.with().bind({
        repo,
        markdown: contractDocument(),
        gates: ["reviewed", "security-audited", "reviewed"],
      }),
    );
    assert.deepEqual(present(await selected.value.keiyaku.state()).terms.gates, ["reviewed", "security-audited"]);
    const bare = accepted(await Keiyaku.with().bind({ repo, markdown: contractDocument("Bare core") }));
    assert.deepEqual(present(await bare.value.keiyaku.state()).terms.gates, []);
  } finally {
    rmSync(repository.path, { recursive: true, force: true });
  }
});

test("captured Settings selects the configured default while explicit [] skips the lookup", async () => {
  const repository = makeGitRepository();
  try {
    repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
    writeProjectSettings(repository.path, {
      gates: {
        default: { kind: "bundle", gates: ["reviewed"] },
        strict: { kind: "bundle", gates: ["reviewed", "security-audited"] },
      },
    });
    const captured = await projectSettings(repository.path);
    const repo = await Repo.at({ path: repository.path });
    const omitted = accepted(
      await Keiyaku.with({ settings: captured }).bind({ repo, markdown: contractDocument("Omitted") }),
    );
    assert.deepEqual(present(await omitted.value.keiyaku.state()).terms.gates, ["reviewed"]);
    const mixed = accepted(
      await Keiyaku.with({ settings: captured }).bind({
        repo,
        markdown: contractDocument("Mixed"),
        gates: ["security-audited", "strict", "security-audited"],
      }),
    );
    assert.deepEqual(present(await mixed.value.keiyaku.state()).terms.gates, ["security-audited", "reviewed"]);
    const explicit = accepted(
      await Keiyaku.with({ settings: captured }).bind({ repo, markdown: contractDocument("Explicit"), gates: [] }),
    );
    assert.deepEqual(present(await explicit.value.keiyaku.state()).terms.gates, []);

    // Later edits never rewrite an already admitted decision or the captured value.
    writeProjectSettings(repository.path, {
      gates: { default: { kind: "bundle", gates: ["security-audited"] } },
    });
    assert.deepEqual(present(await omitted.value.keiyaku.state()).terms.gates, ["reviewed"]);
    const again = accepted(
      await Keiyaku.with({ settings: captured }).bind({ repo, markdown: contractDocument("Again") }),
    );
    assert.deepEqual(present(await again.value.keiyaku.state()).terms.gates, ["reviewed"]);
  } finally {
    rmSync(repository.path, { recursive: true, force: true });
  }
});

test("a broken gates namespace is scoped to omitted and word-selected bind or amend", async () => {
  const repository = makeGitRepository();
  try {
    repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
    const repo = await Repo.at({ path: repository.path });
    writeProjectSettings(repository.path, { gates: { default: { kind: "bundle", gates: ["reviewed"] } } });
    const good = await projectSettings(repository.path);
    const admitted = accepted(
      await Keiyaku.with({ settings: good }).bind({ repo, markdown: contractDocument("Admitted") }),
    );
    const id = present(await admitted.value.keiyaku.state()).id;

    writeProjectSettings(repository.path, { gates: [] });
    const broken = await projectSettings(repository.path);
    const brokenHandle = Keiyaku.with({ settings: broken }).select({ repo, id });

    // Explicit [] never looks up gates, so it still admits without any bundle read.
    const explicit = accepted(
      await Keiyaku.with({ settings: broken }).bind({
        repo,
        markdown: contractDocument("Explicit under broken gates"),
        gates: [],
      }),
    );
    assert.deepEqual(present(await explicit.value.keiyaku.state()).terms.gates, []);
    // Omitted amend preserves admitted gates without lookup; fork copies the source gates.
    const amended = accepted(await admitted.value.keiyaku.amend({ markdown: contractDocument("Admitted v2") }));
    assert.deepEqual(amended.value.changes.gates, undefined);
    const forked = accepted(await Keiyaku.with({ settings: broken }).bind({ repo, forkOf: id }));
    assert.deepEqual(present(await forked.value.keiyaku.state()).terms.gates, ["reviewed"]);
    // Reads and unrelated verbs never select the namespace.
    assert.ok(Array.isArray((await Keiyaku.with({ settings: broken }).list({ repo })).rows));

    await assert.rejects(
      Keiyaku.with({ settings: broken }).bind({ repo, markdown: contractDocument("Omitted broken") }),
      invalidInputFromSettings,
    );
    await assert.rejects(
      Keiyaku.with({ settings: broken }).bind({
        repo,
        markdown: contractDocument("Word-selected broken"),
        gates: ["reviewed"],
      }),
      invalidInputFromSettings,
    );
    await assert.rejects(brokenHandle.amend({ gates: ["reviewed"] }), invalidInputFromSettings);
  } finally {
    rmSync(repository.path, { recursive: true, force: true });
  }
});

test("hooks and freshness derive only at the operation that consumes them", async () => {
  const repository = makeGitRepository();
  try {
    repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
    const repo = await Repo.at({ path: repository.path });
    const missing = "kei/missing" as ContractId;

    writeProjectSettings(repository.path, { worktree: { create: "not-an-array" } });
    const brokenHooks = await projectSettings(repository.path);
    assert.ok(Array.isArray((await Keiyaku.with({ settings: brokenHooks }).list({ repo })).rows));
    await assert.rejects(
      Keiyaku.with({ settings: brokenHooks }).bind({ repo, markdown: contractDocument("Broken hooks") }),
      invalidInputFromSettings,
    );

    writeProjectSettings(repository.path, { git: { requireBranchesToBeUpToDate: "yes" } });
    const brokenFreshness = await projectSettings(repository.path);
    const selected = Keiyaku.with({ settings: brokenFreshness }).select({ repo, id: missing });
    await assert.rejects(selected.audit(), invalidInputFromSettings);
    await assert.rejects(selected.deliver(), invalidInputFromSettings);
    // Review consumes neither namespace and reaches its own admission instead.
    assert.equal((await selected.review({ verdict: "satisfied" })).kind, "refused");
  } finally {
    rmSync(repository.path, { recursive: true, force: true });
  }
});

test("the CLI keeps a broken selected namespace as invalid input, not a draft refusal", async () => {
  const repository = makeGitRepository();
  const home = mkdtempSync(join(tmpdir(), "keiyaku-settings-cli-home-"));
  try {
    repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
    writeProjectSettings(repository.path, { gates: [] });
    const environment = { KEIYAKU_HOME: home };
    const readStdin = async () => contractDocument("CLI broken gates");
    const refused = await runCli(["-C", repository.path, "bind", "-"], { environment, readStdin });
    assert.equal(refused.exit, 3, refused.stdout + refused.stderr);
    assert.doesNotMatch(refused.stdout, /draft/u);
    const explicit = await runCli(["-C", repository.path, "bind", "--gates", "", "-"], { environment, readStdin });
    assert.equal(explicit.exit, 0, explicit.stdout + explicit.stderr);
  } finally {
    rmSync(repository.path, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
