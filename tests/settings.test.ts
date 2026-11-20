import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsError } from "../src/settings.js";
import { loadPreparedArchetype } from "../src/akuma/archetype.js";
import { decodeAcpConfig } from "../src/akuma/providers/acp/index.js";
import { resolveProviderExecution } from "../src/akuma/providers/index.js";
import { cliJson, runCli } from "./support/cli-fixtures.js";
import { renderSettingsText } from "../src/cli/render/settings.js";
import { projectSettings, Settings, settingsSchema } from "../src/settings.js";
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

  } finally {
    value.close();
  }
});

test("Contract delivery consumes captured freshness after a Settings edit", async () => {
  const repository = makeGitRepository();
  try {
    repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
    const repo = await Repo.at({ path: repository.path });
    writeProjectSettings(repository.path, { git: { requireBranchesToBeUpToDate: true } });
    const strict = Keis.of(repo, { settings: await projectSettings(repository.path) });
    const bound = accepted(
      await strict.bind({
        terms: contractDocument(),
        target: "main",
        gates: ["reviewed"],
      }),
    );
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
    const rejected = await bound.kei.deliver();
    assert.equal(rejected.kind, "refused");
    if (rejected.kind !== "refused") throw new Error("expected strict delivery refusal");
    assert.deepEqual(rejected.reason, refusal);
    assert.equal(present(await bound.kei.state()).delivery, null);
  } finally {
    rmSync(repository.path, { recursive: true, force: true });
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
    assert.match(text.stdout, /  namespace  future  failed\n    failure  project\n      settings root must be an object/u);
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

test("a broken gates namespace refuses selected gates but not an explicit empty selection", async () => {
  const repository = makeGitRepository();
  try {
    repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
    const repo = await Repo.at({ path: repository.path });
    writeProjectSettings(repository.path, { gates: { default: { kind: "bundle", gates: ["reviewed"] } } });
    const good = await projectSettings(repository.path);
    const admitted = accepted(await Keis.of(repo, { settings: good }).bind({ terms: contractDocument("Admitted") }));
    const id = present(await admitted.kei.state()).id;

    writeProjectSettings(repository.path, { gates: [] });
    const broken = await projectSettings(repository.path);
    const brokenHandle = Keis.of(repo, { settings: broken }).kei({ id });

    // Explicit [] never looks up gates, so it still admits without any bundle read.
    const explicit = accepted(
      await Keis.of(repo, { settings: broken }).bind({
        terms: contractDocument("Explicit under broken gates"),
        gates: [],
      }),
    );
    assert.deepEqual(present(await explicit.kei.state()).terms.gates, []);
    const before = await brokenHandle.history();
    await assert.rejects(
      Keis.of(repo, { settings: broken }).bind({ terms: contractDocument("Omitted broken") }),
      invalidInputFromSettings,
    );
    await assert.rejects(brokenHandle.amend({ gates: ["reviewed"] }), invalidInputFromSettings);
    assert.deepEqual(await brokenHandle.history(), before);
  } finally {
    rmSync(repository.path, { recursive: true, force: true });
  }
});

test("invalid Verification settings fail verify before admission without contaminating other verbs", async () => {
  const repository = makeGitRepository();
  try {
    repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
    const repo = await Repo.at({ path: repository.path });
    writeProjectSettings(repository.path, { verification: [] });
    const settings = await Settings.load({ cwd: repository.path, home: join(repository.path, ".git", "home") });
    const contracts = Keis.of(repo, { settings });
    const { kei } = accepted(await contracts.bind({ terms: contractDocument("Verification isolation", "true"), gates: ["reviewed", "verified"] }));
    const before = await kei.history();
    const id = present(await kei.state()).id;
    for (const verification of [[], { mode: "loose" }]) {
      writeProjectSettings(repository.path, { verification });
      const selected = Keis.of(repo, { settings: await Settings.load({ cwd: repository.path, home: join(repository.path, ".git", "home") }) }).kei({ id });
      await assert.rejects(selected.verify(), (error: unknown) => {
        assert.ok(invalidInputFromSettings(error));
        if (verification !== null && typeof verification === "object" && "mode" in verification)
          assert.equal((error as Error).message, 'verification.mode must be "optimistic" or "strict"');
        return true;
      });
      assert.deepEqual(await selected.history(), before);
    }
    assert.equal(accepted(await kei.deliver()).placement?.kind, "gates-unsatisfied");
  } finally { rmSync(repository.path, { recursive: true, force: true }); }
});

test("hooks and freshness derive only at the operation that consumes them", async () => {
  const repository = makeGitRepository();
  try {
    repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
    const repo = await Repo.at({ path: repository.path });
    const missing = "kei/missing" as ContractId;

    writeProjectSettings(repository.path, { worktree: { create: "not-an-array" } });
    const brokenHooks = await projectSettings(repository.path);
    await assert.rejects(
      Keis.of(repo, { settings: brokenHooks }).bind({ terms: contractDocument("Broken hooks") }),
      invalidInputFromSettings,
    );

    writeProjectSettings(repository.path, { git: { requireBranchesToBeUpToDate: "yes" } });
    const brokenFreshness = await projectSettings(repository.path);
    const selected = Keis.of(repo, { settings: brokenFreshness }).kei({ id: missing });
    await assert.rejects(selected.previewDelivery(), invalidInputFromSettings);
    // Review consumes neither namespace and reaches its own admission instead.
    assert.equal((await selected.review({ verdict: "satisfied", summary: "Settings review passed" })).kind, "refused");
  } finally {
    rmSync(repository.path, { recursive: true, force: true });
  }
});
