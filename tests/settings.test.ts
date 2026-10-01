import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SettingsError, type Settings } from "../src/settings.js";
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

function contractGates(context: TestContext) {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  context.after(() => rmSync(repository.path, { recursive: true, force: true }));
  const repo = Repo.at({ path: repository.path });
  return async (loaded: Settings, names?: readonly string[]) => {
    const result = accepted(
      await Keiyaku.with({ settings: loaded }).bind({
        repo: await repo,
        markdown: contractDocument("Settings derivation", "true"),
        ...(names === undefined ? {} : { gates: names }),
      }),
    );
    return present(await result.value.keiyaku.state()).terms.gates;
  };
}

test("Settings isolates malformed namespaces but never falls through a failed higher scope", async (context) => {
  const gates = contractGates(context);
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
    assert.deepEqual(await gates(loaded), ["reviewed"]);
    assert.equal(loaded.namespace("providers").kind, "failed");

    writeFileSync(join(value.project, ".keiyaku", "settings.json"), "{");
    loaded = await settings({ root: value.project, home: value.home });
    assert.equal(loaded.namespace("gates").kind, "failed");
    await assert.rejects(() => gates(loaded), invalidInputFromSettings);
    await assert.rejects(() => gates(loaded, ["reviewed"]), invalidInputFromSettings);
    // Empty gate selection skips only gates; unavailable resource scopes still fail the hook consumer.
    await assert.rejects(() => gates(loaded, []), invalidInputFromSettings);
  } finally {
    value.close();
  }
});

test("Contract bind expands mixed gates and bundles, deduplicates stably, and defaults to reviewed", async (context) => {
  const gates = contractGates(context);
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
    assert.deepEqual(await gates(loaded), ["reviewed"]);
    assert.deepEqual(await gates(loaded, []), []);
    assert.deepEqual(await gates(loaded, ["empty"]), []);
    assert.deepEqual(await gates(loaded, ["first", "second", "first"]), ["reviewed", "verified"]);
    assert.deepEqual(await gates(loaded, ["verified", "first", "security-audited", "verified"]), [
      "verified",
      "reviewed",
      "security-audited",
    ]);
    assert.deepEqual(await gates(loaded, ["reviewed"]), ["reviewed"]);
    assert.deepEqual(await gates(loaded, ["default"]), ["default"]);
    for (const name of ["", " ", "Security", "reviewed,verified"]) {
      await assert.rejects(
        () => gates(loaded, [name]),
        (error: unknown) =>
          invalidInputFromSettings(error) && error instanceof Error && /gate or bundle name/u.test(error.message),
      );
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
    assert.deepEqual(await gates(loaded), []);
    assert.deepEqual(await gates(loaded, ["reviewed"]), ["verified"]);
  } finally {
    value.close();
  }
});

test("Contract bind validates only selected bundle records and hard-rejects the old grammar", async (context) => {
  const gates = contractGates(context);
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
    assert.deepEqual(await gates(loaded, ["good"]), ["reviewed"]);
    assert.deepEqual(await gates(loaded, ["missing"]), ["missing"]);
    await assert.rejects(() => gates(loaded, ["future"]), /unsupported kind/u);
    await assert.rejects(() => gates(loaded, ["legacy"]), /must be an object/u);
    await assert.rejects(() => gates(loaded, ["extra"]), /unknown field/u);
    await assert.rejects(
      () => gates(loaded, ["invalid"]),
      (error: unknown) =>
        invalidInputFromSettings(error) && error instanceof Error && /invalid gate word/u.test(error.message),
    );
    assert.deepEqual(await gates(loaded, ["custom"]), ["security-audited"]);
  } finally {
    value.close();
  }
});

test("Contract audit and delivery consume captured freshness while empty Settings stays permissive", async () => {
  const repository = makeGitRepository();
  try {
    repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
    const repo = await Repo.at({ path: repository.path });
    writeProjectSettings(repository.path, { git: { requireBranchesToBeUpToDate: true } });
    const strict = Keiyaku.with({ settings: await projectSettings(repository.path) });
    const bound = accepted(
      await strict.bind({
        repo,
        markdown: contractDocument(),
        target: "main",
        gates: ["reviewed"],
      }),
    );
    const id = present(await bound.value.keiyaku.state()).id;
    assert.ok(bound.value.workspace);
    const path = bound.value.workspace.path;
    writeFileSync(join(path, "candidate.txt"), "candidate\n");
    repository.run(["-C", path, "add", "candidate.txt"]);
    repository.run(["-C", path, "commit", "--quiet", "-m", "candidate"]);
    writeFileSync(join(repository.path, "target.txt"), "target\n");
    repository.run(["add", "target.txt"]);
    repository.run(["commit", "--quiet", "-m", "advance target"]);

    // A later edit cannot relax the composition's already captured freshness policy.
    writeProjectSettings(repository.path, {});
    const refusal = {
      kind: "integration-failed",
      contractId: id,
      reason: "not-based-on-target",
      targetHead: repository.run(["rev-parse", "main"]).trim(),
    };
    const audited = accepted(await bound.value.keiyaku.audit());
    assert.deepEqual(audited.value.candidate, { kind: "blocked", refusal });
    const rejected = await bound.value.keiyaku.deliver();
    assert.equal(rejected.kind, "refused");
    if (rejected.kind !== "refused") throw new Error("expected strict delivery refusal");
    assert.deepEqual(rejected.refusal, refusal);
    assert.equal(present(await bound.value.keiyaku.state()).delivery, null);

    const permissive = Keiyaku.with({ settings: await projectSettings(repository.path) }).select({ repo, id });
    const ready = accepted(await permissive.audit());
    assert.equal(ready.value.candidate.kind, "ready");
    accepted(await permissive.deliver());
    assert.deepEqual(present(await permissive.state()).delivery?.data.policy, { requireBranchesToBeUpToDate: false });
  } finally {
    rmSync(repository.path, { recursive: true, force: true });
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
      /    entry  default · user\n      value  object \(2\)\n        kind  "bundle"\n        gates  list \(1\)\n          "0"  "reviewed"/u,
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

test("settings CLI preserves opaque names, types, empty collections and provenance", async () => {
  const value = fixture();
  try {
    const opaque = {
      emptyArray: [],
      emptyObject: {},
      number: 1,
      string: "1",
      monkey: "banana",
      token: "synthetic",
      password: "fixture",
      "dotted.key": "line\n\u001b",
      dotted: { key: "nested" },
      rows: [{ x: 1 }, { x: "1" }, null, false, ""],
      "escaped\nkey": 'tab\tquote"slash\\\u200d',
    };
    writeFileSync(join(value.home, "settings.json"), JSON.stringify({ future: { local: { lower: true } } }));
    writeFileSync(join(value.project, ".keiyaku", "settings.json"), JSON.stringify({ future: { local: opaque } }));
    const runtime = { cwd: value.project, environment: { KEIYAKU_HOME: value.home } };
    const text = await runCli(["-C", value.project, "settings"], runtime);
    assert.equal(text.exit, 0, text.stderr);
    assert.equal(text.stderr, "");
    assert.equal(
      text.stdout.slice(text.stdout.indexOf("    entry")),
      [
        "    entry  local · project · shadows user",
        "      value  object (11)",
        "        emptyArray  list (0)",
        "        emptyObject  object (0)",
        "        number  1",
        '        string  "1"',
        '        monkey  "banana"',
        '        token  "synthetic"',
        '        password  "fixture"',
        '        "dotted.key"  "line\\n\\u001b"',
        "        dotted  object (1)",
        '          key  "nested"',
        "        rows  list (5)",
        '          "0"  object (1)',
        "            x  1",
        '          "1"  object (1)',
        '            x  "1"',
        '          "2"  null',
        '          "3"  false',
        '          "4"  ""',
        '        "escaped\\nkey"  "tab\\tquote\\\"slash\\\\\\u200d"',
        "",
      ].join("\n"),
    );
    assert.doesNotMatch(text.stdout, /redacted|lower|\u001b|\u200d/u);
    const json = await cliJson<{ scopes: unknown; namespaces: readonly unknown[] }>(
      ["-C", value.project, "settings"],
      runtime,
    );
    assert.equal(json.exit, 0, json.stderr);
    const observed = await settings({ root: value.project, home: value.home });
    assert.deepEqual(json.value.scopes, observed.scopes);
    assert.deepEqual(json.value.namespaces, [
      {
        kind: "read",
        name: "future",
        entries: [{ name: "local", source: "project", shadows: true, value: opaque }],
      },
    ]);
  } finally {
    value.close();
  }
});

test("settings CLI retains scoped failures and available opaque observations", async () => {
  const value = fixture();
  try {
    writeFileSync(join(value.home, "settings.json"), JSON.stringify({ future: { local: { token: "synthetic" } } }));
    writeFileSync(join(value.project, ".keiyaku", "settings.json"), "null");
    const runtime = { cwd: value.project, environment: { KEIYAKU_HOME: value.home } };
    const text = await runCli(["-C", value.project, "settings"], runtime);
    assert.equal(text.exit, 0, text.stderr);
    assert.equal(text.stderr, "");
    assert.match(text.stdout, /  user  read/u);
    assert.match(text.stdout, /  project  failed[\s\S]*settings root must be an object\n  namespace/u);
    assert.match(text.stdout, /  namespace  future  failed\n    failure  project  settings root must be an object/u);
    assert.match(text.stdout, /    entry  local · user\n      value  object \(1\)\n        token  "synthetic"/u);
    assert.doesNotMatch(text.stdout, /shadows user|redacted/u);
    const json = await cliJson<{ scopes: unknown; namespaces: readonly unknown[] }>(
      ["-C", value.project, "settings"],
      runtime,
    );
    assert.equal(json.exit, 0, json.stderr);
    const observed = await settings({ root: value.project, home: value.home });
    assert.deepEqual(json.value.scopes, observed.scopes);
    assert.deepEqual(json.value.namespaces, [
      {
        kind: "failed",
        name: "future",
        entries: [{ name: "local", source: "user", shadows: false, value: { token: "synthetic" } }],
        failures: [{ scope: "project", diagnostic: "settings root must be an object" }],
      },
    ]);
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
    assert.match(text, /LONG_VALUE  "x{100}"/u);
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

function contractDocument(title = "Settings derivation", verification?: string): string {
  return contractMarkdown(title, {
    Context: "Exercise captured Settings derivation.",
    Objective: "Derive gates, hooks, and freshness lazily at their consuming operation.",
    Design: "One captured Settings value and one operation-local namespace lookup.",
    Region: "```\nsrc/**\n```",
    Criteria: "### Derivation\nThe selected obligations are retained exactly.\n",
    ...(verification === undefined ? {} : { Verification: `~~~bash timeout=1m\n${verification}\n~~~` }),
  });
}

function writeProjectSettings(root: string, value: unknown): void {
  mkdirSync(join(root, ".keiyaku"), { recursive: true });
  writeFileSync(join(root, ".keiyaku", "settings.json"), `${JSON.stringify(value)}\n`);
}

function invalidInputFromSettings(error: unknown): boolean {
  return error instanceof KeiyakuError && error.category === "invalid-input" && error.cause instanceof SettingsError;
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
    const empty = accepted(
      await Keiyaku.with({ settings: await projectSettings(repository.path) }).bind({
        repo,
        markdown: contractDocument("Provided empty Settings"),
      }),
    );
    assert.deepEqual(present(await empty.value.keiyaku.state()).terms.gates, ["reviewed"]);
    await assert.rejects(
      Keiyaku.with().bind({ repo, markdown: contractDocument(), gates: ["Security"] }),
      (error: unknown) =>
        error instanceof KeiyakuError && error.category === "invalid-input" && error.cause instanceof TypeError,
    );
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
    const amended = accepted(await brokenHandle.amend({ markdown: contractDocument("Admitted v2") }));
    assert.deepEqual(amended.value.changes.gates, undefined);
    assert.deepEqual(present(await brokenHandle.state()).terms.gates, ["reviewed"]);
    const forked = accepted(await Keiyaku.with({ settings: broken }).bind({ repo, forkOf: id }));
    assert.deepEqual(present(await forked.value.keiyaku.state()).terms.gates, ["reviewed"]);
    // Reads and unrelated verbs never select the namespace.
    assert.ok(Array.isArray((await Keiyaku.with({ settings: broken }).list({ repo })).rows));

    const before = await brokenHandle.history();
    const rowsBefore = (await Keiyaku.with({ settings: broken }).list({ repo })).rows.length;
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
    assert.deepEqual(await brokenHandle.history(), before);
    assert.equal((await Keiyaku.with({ settings: broken }).list({ repo })).rows.length, rowsBefore);
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

    const cause = new SettingsError("unavailable git observation");
    const unavailable: Settings = {
      ...brokenFreshness,
      namespace(name) {
        if (name === "git") throw cause;
        return brokenFreshness.namespace(name);
      },
    };
    await assert.rejects(
      Keiyaku.with({ settings: unavailable }).select({ repo, id: missing }).audit(),
      (error: unknown) => error instanceof KeiyakuError && error.category === "invalid-input" && error.cause === cause,
    );
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
