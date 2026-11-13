import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SettingsError } from "../src/settings.js";
import { loadPreparedArchetype } from "../src/akuma/archetype.js";
import { decodeProviderOptions } from "../src/akuma/provider-recipe.js";
import { decodeAcpConfig } from "../src/akuma/providers/acp/index.js";
import { resolveProviderExecution } from "../src/akuma/providers/index.js";
import { cliJson, runCli } from "./support/cli-fixtures.js";
import { renderSettingsText } from "../src/cli/render/settings.js";
import { projectSettings, Settings, settingsSchema } from "../src/settings.js";
import { z } from "zod";
import { Keis, Repo, type ContractId } from "../src/index.js";
import { KeiyakuError } from "../src/library/outcome.js";
import { accepted, present } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import { makeGitRepository } from "./support/git.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-settings-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, "akumas"), { recursive: true });
  mkdirSync(join(project, ".keiyaku"), { recursive: true });
  return { root, home, project, close: () => rmSync(root, { recursive: true, force: true }) };
}

type SettingsFixture = ReturnType<typeof fixture>;

/** Load one akumaName through the same preparation and provider-admission composition publication uses. */
async function loadNamed(value: SettingsFixture, name: string) {
  const akumaName = await loadPreparedArchetype({
    name,
    home: value.home,
    settings: await Settings.load({ cwd: value.project, home: value.home }),
  });
  const { adapter } = await resolveProviderExecution(akumaName.provider);
  const admission = adapter.admitOptions(akumaName.options);
  if (admission.kind === "refused") throw new TypeError(admission.diagnostic);
  return { ...akumaName, options: admission.options };
}

function contractGates(context: TestContext) {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  context.after(() => rmSync(repository.path, { recursive: true, force: true }));
  const repo = Repo.at({ path: repository.path });
  return async (loaded: Settings, names?: readonly string[]) => {
    const result = accepted(
      await Keis.of(await repo, { settings: loaded }).bind({
        markdown: contractDocument("Settings derivation", "true"),
        ...(names === undefined ? {} : { gates: names }),
      }),
    );
    return present(await result.kei.state()).terms.gates;
  };
}

test("Settings.load keeps omitted cwd user-only and canonical equal coordinates in user scope", async () => {
  const value = fixture();
  const previous = process.cwd();
  try {
    writeFileSync(join(value.home, "settings.json"), JSON.stringify({ sample: { shared: "user" } }));
    writeFileSync(join(value.project, ".keiyaku", "settings.json"), JSON.stringify({ sample: { shared: "project" } }));
    const child = join(value.project, "nested");
    mkdirSync(child);
    process.chdir(child);
    const user = await Settings.load({ home: value.home });
    assert.deepEqual(user.scopes.project, { kind: "absent" });
    assert.deepEqual(user.namespace("sample"), { kind: "read", entries: { shared: { value: "user", source: "user" } } });
    const project = await Settings.load({ cwd: value.project, home: value.home });
    assert.deepEqual(project.namespace("sample"), { kind: "read", entries: { shared: { value: "project", source: "project", shadows: true } } });
    assert.deepEqual((await Settings.load({ cwd: child, home: value.home })).namespace("sample"), user.namespace("sample"));
    const alias = join(value.root, "home-alias");
    symlinkSync(join(value.project, ".keiyaku"), alias, process.platform === "win32" ? "junction" : "dir");
    const equal = await Settings.load({ cwd: value.project, home: alias });
    assert.deepEqual(equal.scopes.project, { kind: "absent" });
    assert.deepEqual(equal.namespace("sample"), { kind: "read", entries: { shared: { value: "project", source: "user" } } });
    assert.ok(Object.isFrozen(user));
    writeFileSync(join(value.home, "settings.json"), JSON.stringify({ sample: { shared: "changed" } }));
    assert.equal(user.namespace("sample").entries?.shared?.value, "user");
    assert.equal((await Settings.load({ home: value.home })).namespace("sample").entries?.shared?.value, "changed");
    await assert.rejects(
      Settings.load({ cwd: 7 } as never),
      (error: unknown) => error instanceof KeiyakuError && error.category === "invalid-input",
    );
  } finally {
    process.chdir(previous);
    value.close();
  }
});

test("Settings namespaces match individual resolution, including provenance and failures", async () => {
  const value = fixture();
  try {
    writeFileSync(
      join(value.home, "settings.json"),
      JSON.stringify({
        providers: { shared: { user: true }, userOnly: 1 },
        broken: [],
      }),
    );
    writeFileSync(
      join(value.project, ".keiyaku", "settings.json"),
      JSON.stringify({
        providers: { shared: { project: true }, projectOnly: 2 },
      }),
    );
    let loaded = await Settings.load({ cwd: value.project, home: value.home });
    assert.deepEqual(Object.keys(loaded.namespaces ?? {}), ["broken", "providers"]);
    assert.deepEqual(
      loaded.namespaces,
      Object.fromEntries(Object.keys(loaded.namespaces ?? {}).map((name) => [name, loaded.namespace(name)])),
    );
    assert.deepEqual(loaded.namespace("providers"), {
      kind: "read",
      entries: {
        projectOnly: { value: 2, source: "project" },
        shared: { value: { project: true }, source: "project", shadows: true },
        userOnly: { value: 1, source: "user" },
      },
    });
    assert.equal(loaded.namespace("broken").kind, "failed");

    writeFileSync(join(value.project, ".keiyaku", "settings.json"), "{");
    loaded = await Settings.load({ cwd: value.project, home: value.home });
    assert.deepEqual(
      loaded.namespaces,
      Object.fromEntries(Object.keys(loaded.namespaces ?? {}).map((name) => [name, loaded.namespace(name)])),
    );
    const providers = loaded.namespaces?.providers;
    assert.equal(providers?.kind, "failed");
    if (providers?.kind === "failed") assert.equal(providers.failures[0]?.scope, "project");
  } finally {
    value.close();
  }
});

test("opaque blank namespace names do not poison Settings construction or unrelated lookups", async () => {
  const value = fixture();
  try {
    writeFileSync(
      join(value.home, "settings.json"),
      JSON.stringify({
        "": { shared: "user", userOnly: 1 },
        " ": { userOnly: true },
        providers: { local: "available" },
      }),
    );
    writeFileSync(
      join(value.project, ".keiyaku", "settings.json"),
      JSON.stringify({
        "": { shared: "project" },
        " ": { projectOnly: true },
      }),
    );
    const loaded = await Settings.load({ cwd: value.project, home: value.home });
    assert.deepEqual(loaded.namespaces, {
      "": {
        kind: "read",
        entries: {
          shared: { value: "project", source: "project", shadows: true },
          userOnly: { value: 1, source: "user" },
        },
      },
      " ": {
        kind: "read",
        entries: {
          projectOnly: { value: true, source: "project" },
          userOnly: { value: true, source: "user" },
        },
      },
      providers: {
        kind: "read",
        entries: {
          local: { value: "available", source: "user" },
        },
      },
    });
    assert.deepEqual(loaded.namespace("providers"), loaded.namespaces?.providers);
    assert.throws(() => loaded.namespace(""), /namespace must be nonblank/u);
    assert.throws(() => loaded.namespace(" "), /namespace must be nonblank/u);
    const project = await projectSettings(value.project);
    assert.deepEqual(Object.keys(project.namespaces ?? {}), ["", " "]);
  } finally {
    value.close();
  }
});

test("user Settings entries named like object properties retain their values and provenance", async () => {
  const value = fixture();
  try {
    const entries = Object.fromEntries([
      ["constructor", 7],
      ["toString", false],
      ["__proto__", { local: true }],
    ]);
    writeFileSync(join(value.home, "settings.json"), JSON.stringify(Object.fromEntries([
      ["future", entries],
      ["__proto__", { nested: JSON.parse('{"__proto__":null,"constructor":false,"toString":[]}') }],
    ])));
    writeFileSync(join(value.project, ".keiyaku", "settings.json"), JSON.stringify({ future: { projectOnly: null } }));
    const loaded = await Settings.load({ cwd: value.project, home: value.home });
    assert.deepEqual(loaded.namespace("future"), {
      kind: "read",
      entries: Object.fromEntries([
        ["__proto__", { value: { local: true }, source: "user" }],
        ["constructor", { value: 7, source: "user" }],
        ["projectOnly", { value: null, source: "project" }],
        ["toString", { value: false, source: "user" }],
      ]),
    });
    assert.match(renderSettingsText(loaded), /entry  constructor · user/u);
    const wire = JSON.parse(JSON.stringify(loaded));
    assert.deepEqual(settingsSchema.parse(wire), wire, "namespace, entry, and nested JSON names survive native schema parsing");
    const invalid = {
      ...wire,
      namespaces: Object.fromEntries([["__proto__", { kind: "read", entries: Object.fromEntries([
        ["__proto__", { value: undefined, source: "user" }],
      ]) }]]),
    };
    assert.equal(settingsSchema.safeParse(invalid).success, false, "prototype-named entries still validate their value");
    for (const reused of ["ref", "inline"] as const) {
      const schema = z.toJSONSchema(settingsSchema, { reused });
      function checkReferences(value: unknown): void {
        if (value === null || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
          if (key === "$ref" && typeof child === "string") {
            assert.ok(child.startsWith("#/"));
            let target: unknown = schema;
            for (const segment of child.slice(2).split("/")) {
              assert.ok(target !== null && typeof target === "object", child);
              target = Reflect.get(target, segment.replaceAll("~1", "/").replaceAll("~0", "~"));
            }
            assert.notEqual(target, undefined, child);
          } else checkReferences(child);
        }
      }
      checkReferences(schema);
    }
  } finally {
    value.close();
  }
});

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
    let loaded = await Settings.load({ cwd: value.project, home: value.home });
    assert.deepEqual(await gates(loaded), ["reviewed"]);
    assert.equal(loaded.namespace("providers").kind, "failed");

    writeFileSync(join(value.project, ".keiyaku", "settings.json"), "{");
    loaded = await Settings.load({ cwd: value.project, home: value.home });
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
          custom: { kind: "bundle", gates: ["security-audited"] },
          future: { kind: "external", gate: "security-audited" },
        },
      }),
    );
    let loaded = await Settings.load({ home: value.home });
    assert.deepEqual(await gates(loaded), ["reviewed"]);
    assert.deepEqual(await gates(loaded, []), []);
    assert.deepEqual(await gates(loaded, ["empty"]), []);
    assert.deepEqual(await gates(loaded, ["first", "second", "first"]), ["reviewed", "verified"]);
    assert.deepEqual(await gates(loaded, ["verified", "first", "custom", "verified"]), [
      "verified",
      "reviewed",
      "security-audited",
    ]);
    assert.deepEqual(await gates(loaded, ["reviewed"]), ["reviewed"]);
    await assert.rejects(
      () => gates(loaded, ["default"]),
      /Unknown gate 'default'\. Known gate names: reviewed, verified, custom, empty, first, future, second/u,
    );
    for (const name of ["", " ", "Security", "reviewed,verified"]) {
      await assert.rejects(
        () => gates(loaded, [name]),
        (error: unknown) =>
          invalidInputFromSettings(error) && error instanceof Error && /gate name/u.test(error.message),
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
    loaded = await Settings.load({ home: value.home });
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
    const loaded = await Settings.load({ home: value.home });
    assert.deepEqual(await gates(loaded, ["good"]), ["reviewed"]);
    await assert.rejects(() => gates(loaded, ["missing"]), /Unknown gate 'missing'/u);
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
    const strict = Keis.of(repo, { settings: await projectSettings(repository.path) });
    const bound = accepted(
      await strict.bind({
        markdown: contractDocument(),
        target: "main",
        gates: ["reviewed"],
      }),
    );
    const id = present(await bound.kei.state()).id;
    assert.ok(bound.worktreePath);
    const path = bound.worktreePath;
    writeFileSync(join(path, "candidate.txt"), "candidate\n");
    repository.run(["-C", path, "add", "candidate.txt"]);
    repository.run(["-C", path, "commit", "--quiet", "-m", "candidate"]);
    writeFileSync(join(repository.path, "target.txt"), "target\n");
    repository.run(["add", "target.txt"]);
    repository.run(["commit", "--quiet", "-m", "advance target"]);

    // A later edit cannot relax the composition's already captured freshness policy.
    writeProjectSettings(repository.path, {});
    const refusal = {
      kind: "not-based-on-target",
      targetHead: repository.run(["rev-parse", "main"]).trim(),
    };
    const audited = await bound.kei.previewDelivery();
    assert.ok(audited.kind === "blocked");
    assert.deepEqual(audited.reason, refusal);
    const rejected = await bound.kei.deliver();
    assert.equal(rejected.kind, "refused");
    if (rejected.kind !== "refused") throw new Error("expected strict delivery refusal");
    assert.deepEqual(rejected.reason, refusal);
    assert.equal(present(await bound.kei.state()).delivery, null);

    const permissive = Keis.of(repo, { settings: await projectSettings(repository.path) }).kei({ id });
    const ready = await permissive.previewDelivery();
    assert.equal(ready.kind, "ready");
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
    writeFileSync(join(value.home, "akumas", "builder.md"), "---\nprovider: local\nmodel: openai/test\n---\n");
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
      join(value.home, "akumas", "pi-worker.md"),
      "---\nprovider: pi\nmodel: openai/gpt\neffort: high\n---\nWork.\n",
    );
    let loaded = await loadNamed(value, "pi-worker");
    assert.deepEqual(loaded.provider, { name: "pi", kind: "pi" });
    writeFileSync(join(value.home, "settings.json"), JSON.stringify({ providers: { local: { kind: "pi", env: {} } } }));
    writeFileSync(join(value.home, "akumas", "pi-worker.md"), "---\nprovider: local\nmodel: openai/gpt\n---\nWork.\n");
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

test("Archetype inherits the provider recipe and body while child fields replace their settings", async () => {
  const value = fixture();
  try {
    writeFileSync(
      join(value.home, "akumas", "base.md"),
      "---\nprovider: codex-app-server\nmodel: base-model\neffort: high\nnetwork: disabled\ndescription: Base\n---\nBase personality.\n",
    );
    writeFileSync(join(value.home, "akumas", "child.md"), "---\nbase: base\nmodel: child-model\n---\n");
    const inherited = await loadNamed(value, "child");
    assert.deepEqual(inherited.provider, { name: "codex-app-server", kind: "codex-app-server" });
    assert.equal(inherited.description, "Base");
    assert.deepEqual(inherited.options, {
      model: "child-model",
      effort: "high",
      network: "disabled",
      systemPrompt: "Base personality.\n",
      systemPromptMode: "append",
    });
    writeFileSync(
      join(value.home, "settings.json"),
      JSON.stringify({ providers: { local: { kind: "codex-app-server" } } }),
    );
    writeFileSync(
      join(value.home, "akumas", "child.md"),
      "---\nbase: base\nprovider: local\neffort: low\ndescription: Child\n---\nChild personality.\n",
    );
    const replaced = await loadNamed(value, "child");
    assert.deepEqual(replaced.provider, { name: "local", kind: "codex-app-server" });
    assert.equal(replaced.description, "Child");
    assert.deepEqual(replaced.options, {
      model: "base-model",
      effort: "low",
      network: "disabled",
      systemPrompt: "Child personality.\n",
      systemPromptMode: "append",
    });
  } finally {
    value.close();
  }
});

test("Archetype refuses unsupported frontmatter on definitions and inherited bases", async () => {
  const value = fixture();
  try {
    for (const field of ["allowed", "unsupported"]) {
      writeFileSync(join(value.home, "akumas", "worker.md"), `---\nprovider: codex-app-server\n${field}: []\n---\n`);
      writeFileSync(join(value.home, "akumas", "child.md"), "---\nbase: worker\n---\n");
      await assert.rejects(loadNamed(value, "worker"), new RegExp(`unknown field: ${field}`, "u"));
      await assert.rejects(loadNamed(value, "child"), new RegExp(`unknown field: ${field}`, "u"));
    }
  } finally {
    value.close();
  }
});

test("Archetype resolves grok-build as its own builtin protocol execution", async () => {
  const value = fixture();
  try {
    writeFileSync(
      join(value.home, "akumas", "grok.md"),
      "---\nprovider: grok-build\nmodel: grok-4\neffort: high\n---\n",
    );
    const loaded = await loadNamed(value, "grok");
    assert.deepEqual(loaded.provider, {
      name: "grok-build",
      kind: "grok-build",
      executable: "grok",
    });
    assert.deepEqual(loaded.options, { model: "grok-4", effort: "high" });
    writeFileSync(join(value.home, "akumas", "grok.md"), "---\nprovider: grok-build\n---\nBuild.\n");
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
    writeFileSync(join(value.home, "akumas", "grok.md"), "---\nprovider: private\neffort: high\n---\n");
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
      join(value.home, "akumas", "kimi.md"),
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
    writeFileSync(join(value.home, "akumas", "local.md"), "---\nprovider: local\nmodel: test-model\n---\nBuild.\n");
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
    writeFileSync(join(value.home, "akumas", "worker.md"), "---\nprovider: claude\n---\nWork.\n");
    assert.deepEqual((await loadNamed(value, "worker")).options, {
      systemPrompt: "Work.\n",
      systemPromptMode: "append",
    });
    writeFileSync(
      join(value.home, "akumas", "worker.md"),
      "---\nprovider: claude\nsystemPromptMode: append\n---\nWork.\n",
    );
    assert.deepEqual((await loadNamed(value, "worker")).options, {
      systemPrompt: "Work.\n",
      systemPromptMode: "append",
    });
    writeFileSync(
      join(value.home, "akumas", "worker.md"),
      "---\nprovider: claude\nsystemPromptMode: replace\n---\nWork.\n",
    );
    assert.deepEqual((await loadNamed(value, "worker")).options, {
      systemPrompt: "Work.\n",
      systemPromptMode: "replace",
    });
    writeFileSync(join(value.home, "akumas", "worker.md"), "---\nprovider: claude\n---\n");
    assert.deepEqual((await loadNamed(value, "worker")).options, {});
    writeFileSync(join(value.home, "akumas", "worker.md"), "---\nprovider: claude\nsystemPromptMode: replace\n---\n");
    await assert.rejects(loadNamed(value, "worker"), /systemPromptMode requires a nonempty Markdown body/u);
    writeFileSync(
      join(value.home, "akumas", "worker.md"),
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
    writeFileSync(join(value.home, "akumas", "local.md"), "---\nprovider: local\n---\nBuild.\n");
    await assert.rejects(loadNamed(value, "local"), /does not match the configured argument mode/u);
    writeFileSync(
      join(value.home, "akumas", "local.md"),
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
    writeFileSync(join(value.home, "akumas", "local.md"), "---\nprovider: local\n---\nBuild.\n");
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
    const observed = await Settings.load({ cwd: value.project, home: value.home });
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
    const json = await cliJson<Pick<Settings, "namespaces">>(["-C", value.project, "settings"], {
      cwd: value.project,
      environment: { KEIYAKU_HOME: value.home },
    });
    assert.deepEqual(json.value.namespaces, { gates: observed.namespace("gates") });
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
    const json = await cliJson<Pick<Settings, "scopes" | "namespaces">>(["-C", value.project, "settings"], runtime);
    assert.equal(json.exit, 0, json.stderr);
    const observed = await Settings.load({ cwd: value.project, home: value.home });
    assert.deepEqual(json.value.scopes, observed.scopes);
    assert.deepEqual(json.value.namespaces, {
      future: {
        kind: "read",
        entries: { local: { source: "project", shadows: true, value: opaque } },
      },
    });
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
    const json = await cliJson<Pick<Settings, "scopes" | "namespaces">>(["-C", value.project, "settings"], runtime);
    assert.equal(json.exit, 0, json.stderr);
    const observed = await Settings.load({ cwd: value.project, home: value.home });
    assert.deepEqual(json.value.scopes, observed.scopes);
    assert.deepEqual(json.value.namespaces, {
      future: {
        kind: "failed",
        entries: { local: { source: "user", value: { token: "synthetic" } } },
        failures: [{ scope: "project" }],
      },
    });
  } finally {
    value.close();
  }
});

test("settings text preserves long paths and opaque provider values", async () => {
  const value = fixture();
  try {
    const longHome = join(value.root, `${"settings-path-".repeat(8)}home`);
    mkdirSync(longHome, { recursive: true });
    const longPath = join(longHome, "settings.json");
    writeFileSync(
      longPath,
      JSON.stringify({ providers: { local: { kind: "acp", env: { LONG_VALUE: "x".repeat(100) } } } }),
    );
    const observed = await Settings.load({ cwd: value.project, home: longHome });
    const text = renderSettingsText(observed, 72);
    assert.match(text, new RegExp(realpathSync.native(longPath).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.match(text, /LONG_VALUE  "x{100}"/u);
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

test("omitted Settings accepts built-in gates only, empty hooks, and false freshness", async () => {
  const repository = makeGitRepository();
  try {
    repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
    const repo = await Repo.at({ path: repository.path });
    const selected = accepted(
      await Keis.of(repo).bind({
        markdown: contractDocument(),
        gates: ["reviewed", "reviewed"],
      }),
    );
    assert.deepEqual(present(await selected.kei.state()).terms.gates, ["reviewed"]);
    await assert.rejects(
      Keis.of(repo).bind({ markdown: contractDocument(), gates: ["security-audited"] }),
      (error: unknown) =>
        error instanceof KeiyakuError &&
        error.category === "invalid-input" &&
        /Unknown gate 'security-audited'\. Known gate names: reviewed, verified/u.test(error.message),
    );
    const bare = accepted(await Keis.of(repo).bind({ markdown: contractDocument("Bare core") }));
    assert.deepEqual(present(await bare.kei.state()).terms.gates, []);
    const empty = accepted(
      await Keis.of(repo, { settings: await projectSettings(repository.path) }).bind({
        markdown: contractDocument("Provided empty Settings"),
      }),
    );
    assert.deepEqual(present(await empty.kei.state()).terms.gates, ["reviewed"]);
    await assert.rejects(
      Keis.of(repo).bind({ markdown: contractDocument(), gates: ["Security"] }),
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
      await Keis.of(repo, { settings: captured }).bind({ markdown: contractDocument("Omitted") }),
    );
    assert.deepEqual(present(await omitted.kei.state()).terms.gates, ["reviewed"]);
    const mixed = accepted(
      await Keis.of(repo, { settings: captured }).bind({
        markdown: contractDocument("Mixed"),
        gates: ["reviewed", "strict", "reviewed"],
      }),
    );
    assert.deepEqual(present(await mixed.kei.state()).terms.gates, ["reviewed", "security-audited"]);
    const explicit = accepted(
      await Keis.of(repo, { settings: captured }).bind({ markdown: contractDocument("Explicit"), gates: [] }),
    );
    assert.deepEqual(present(await explicit.kei.state()).terms.gates, []);

    // Later edits never rewrite an already admitted decision or the captured value.
    writeProjectSettings(repository.path, {
      gates: { default: { kind: "bundle", gates: ["security-audited"] } },
    });
    assert.deepEqual(present(await omitted.kei.state()).terms.gates, ["reviewed"]);
    const again = accepted(await Keis.of(repo, { settings: captured }).bind({ markdown: contractDocument("Again") }));
    assert.deepEqual(present(await again.kei.state()).terms.gates, ["reviewed"]);
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
    const admitted = accepted(await Keis.of(repo, { settings: good }).bind({ markdown: contractDocument("Admitted") }));
    const id = present(await admitted.kei.state()).id;

    writeProjectSettings(repository.path, { gates: [] });
    const broken = await projectSettings(repository.path);
    const brokenHandle = Keis.of(repo, { settings: broken }).kei({ id });

    // Explicit [] never looks up gates, so it still admits without any bundle read.
    const explicit = accepted(
      await Keis.of(repo, { settings: broken }).bind({
        markdown: contractDocument("Explicit under broken gates"),
        gates: [],
      }),
    );
    assert.deepEqual(present(await explicit.kei.state()).terms.gates, []);
    // Omitted amend preserves admitted gates without lookup; fork copies the source gates.
    accepted(await brokenHandle.amend({ markdown: contractDocument("Admitted v2") }));
    assert.deepEqual(present(await brokenHandle.state()).terms.gates, ["reviewed"]);
    const forked = accepted(await Keis.of(repo, { settings: broken }).bind({ forkOf: id }));
    assert.deepEqual(present(await forked.kei.state()).terms.gates, ["reviewed"]);
    // Reads and unrelated verbs never select the namespace.
    assert.ok(Array.isArray((await Keis.of(repo, { settings: broken }).list({})).rows!));

    const before = await brokenHandle.history();
    const rowsBefore = (await Keis.of(repo, { settings: broken }).list({})).rows!.length;
    await assert.rejects(
      Keis.of(repo, { settings: broken }).bind({ markdown: contractDocument("Omitted broken") }),
      invalidInputFromSettings,
    );
    await assert.rejects(
      Keis.of(repo, { settings: broken }).bind({
        markdown: contractDocument("Word-selected broken"),
        gates: ["reviewed"],
      }),
      invalidInputFromSettings,
    );
    await assert.rejects(brokenHandle.amend({ gates: ["reviewed"] }), invalidInputFromSettings);
    assert.deepEqual(await brokenHandle.history(), before);
    assert.equal((await Keis.of(repo, { settings: broken }).list({})).rows!.length, rowsBefore);
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
    assert.equal((await Keis.of(repo, { settings: brokenHooks }).list({})).rows, undefined);
    await assert.rejects(
      Keis.of(repo, { settings: brokenHooks }).bind({ markdown: contractDocument("Broken hooks") }),
      invalidInputFromSettings,
    );

    writeProjectSettings(repository.path, { git: { requireBranchesToBeUpToDate: "yes" } });
    const brokenFreshness = await projectSettings(repository.path);
    const selected = Keis.of(repo, { settings: brokenFreshness }).kei({ id: missing });
    await assert.rejects(selected.previewDelivery(), invalidInputFromSettings);
    await assert.rejects(selected.deliver(), invalidInputFromSettings);
    await assert.rejects(selected.verify(), invalidInputFromSettings);
    // Review consumes neither namespace and reaches its own admission instead.
    assert.equal((await selected.review({ verdict: "satisfied", summary: "Settings review passed" })).kind, "refused");

    const cause = new SettingsError("unavailable git observation");
    const unavailable: Settings = {
      ...brokenFreshness,
      namespace(name) {
        if (name === "git") throw cause;
        return brokenFreshness.namespace(name);
      },
    };
    await assert.rejects(
      Keis.of(repo, { settings: unavailable }).kei({ id: missing }).previewDelivery(),
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
    assert.equal(refused.exit, 64, refused.stdout + refused.stderr);
    assert.doesNotMatch(refused.stdout, /draft/u);
    const explicit = await runCli(["-C", repository.path, "bind", "--gates", "", "-"], { environment, readStdin });
    assert.equal(explicit.exit, 0, explicit.stdout + explicit.stderr);
  } finally {
    rmSync(repository.path, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
