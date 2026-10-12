import { deferred as promiseBarrier } from "./support/process.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as sdk from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createPiProvider, type PiSdk } from "../src/akuma/providers/pi/index.js";
import { temporaryDirectory } from "./support/process.js";

type PackageJson = {
  keywords?: unknown;
  pi?: { extensions?: unknown; skills?: unknown };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const rootUrl = new URL(import.meta.url.endsWith(".js") ? "../../" : "../", import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL("package.json", rootUrl), "utf8")) as PackageJson;
const piExtension = packageJson.pi?.extensions;
if (!Array.isArray(piExtension) || typeof piExtension[0] !== "string") {
  throw new Error("Pi package extension is missing");
}
const builtExtension = fileURLToPath(new URL("build/integrations/pi/keiyaku.ts", rootUrl));
if (!existsSync(builtExtension)) {
  execFileSync("npm", ["run", "build"], { cwd: fileURLToPath(rootUrl), stdio: "inherit" });
}
const { default: keiyakuExtension } = (await import(new URL(piExtension[0], rootUrl).href)) as {
  default: (pi: ExtensionAPI) => void;
};

async function extensionSdk(root: string, fixture: ExtensionFactory, eventBus: sdk.EventBus): Promise<PiSdk> {
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async () => {
        throw new Error("fixture must not modify credentials");
      },
      delete: async () => {
        throw new Error("fixture must not delete credentials");
      },
    },
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  return {
    ...sdk,
    getAgentDir: () => root,
    SessionManager: {
      create: (cwd: string) => sdk.SessionManager.create(cwd, join(root, "sessions")),
      open: sdk.SessionManager.open,
    } as typeof sdk.SessionManager,
    createAgentSessionServices: async (options) =>
      await sdk.createAgentSessionServices({
        ...options,
        modelRuntime,
        settingsManager: sdk.SettingsManager.inMemory({}),
        resourceLoaderOptions: {
          ...options.resourceLoaderOptions,
          eventBus,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          extensionFactories: [keiyakuExtension, fixture],
        },
      }),
  };
}

test("Pi native extensions finish session start and discover resources before fresh and resumed prompts", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-pi-extension-order-");
  const skill = join(root, "skill");
  mkdirSync(skill);
  writeFileSync(join(skill, "SKILL.md"), "---\nname: bind-fixture\ndescription: Binding fixture\n---\nFixture\n");
  let sessionFile: string | undefined;
  for (const resumed of [false, true]) {
    const calls: string[] = [];
    const started = promiseBarrier<void>();
    const binding = promiseBarrier<void>();
    const shuttingDown = promiseBarrier<void>();
    const cleanup = promiseBarrier<void>();
    let timer: ReturnType<typeof setInterval> | undefined;
    let context: ExtensionContext | undefined;
    let probe = 0;
    const eventBus = sdk.createEventBus();
    const nativeSdk = await extensionSdk(
      root,
      (pi) => {
        pi.events.on("binding-probe", () => {
          probe += 1;
        });
        pi.on("session_start", async (_event, ctx) => {
          context = ctx;
          sessionFile = ctx.sessionManager.getSessionFile();
          calls.push("session_start");
          started.resolve();
          await binding.promise;
          calls.push("session_start_done");
          timer = setInterval(() => {}, 1_000);
        });
        pi.on("session_shutdown", async () => {
          calls.push("session_shutdown");
          shuttingDown.resolve();
          await cleanup.promise;
          clearInterval(timer);
          timer = undefined;
        });
        pi.on("resources_discover", () => {
          calls.push("resources_discover");
          return { skillPaths: [skill] };
        });
        pi.on("input", (event) => {
          calls.push(event.text);
          return { action: "handled" };
        });
      },
      eventBus,
    );
    const createSession = nativeSdk.createAgentSessionFromServices;
    let native: sdk.AgentSession | undefined;
    const provider = createPiProvider(undefined, async () => ({
      ...nativeSdk,
      createAgentSessionFromServices: async (options) => {
        const created = await createSession(options);
        native = created.session;
        return created;
      },
    }));
    const input = {
      body: "work",
      launchTells: [{ id: "tell-1", text: "also check" }],
      cwd: root,
      options: {},
      requests: { dir: join(root, "requests") },
      signal: new AbortController().signal,
    };
    assert.ok(!resumed || sessionFile);
    const attempt = resumed
      ? provider.resume!({ ...input, session: { kind: "resume", coordinate: { sessionFile: sessionFile! } } })
      : provider.start({ ...input, session: { kind: "fresh" } });
    try {
      await started.promise;
      assert.deepEqual(calls, ["session_start"]);
      assert.equal(context?.cwd, root);
      assert.equal(context?.hasUI, false);
      assert.ok(native);
      assert.ok(native.extensionRunner?.getRegisteredCommands().some((command) => command.name === "keiyaku"));
      eventBus.emit("binding-probe", undefined);
      assert.equal(probe, 1);
      binding.resolve();
      const drive = await attempt.result;
      // Input is handled locally by the fixture: this checks the real native
      // prompt/extension path without a network model or a fabricated answer.
      assert.deepEqual(await drive.completion, {
        kind: "failed",
        diagnostic: "Pi completed without a native assistant answer",
      });
      await shuttingDown.promise;
      let closed = false;
      void attempt.closed.then(() => { closed = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(closed, false);
      assert.ok(timer);
      cleanup.resolve();
      await attempt.closed;
      assert.equal(timer, undefined);
      assert.deepEqual(calls, ["session_start", "session_start_done", "resources_discover", "work\n\nalso check", "session_shutdown"]);
      assert.ok(native.systemPrompt.includes("bind-fixture"));
      assert.throws(() => context!.cwd, /stale/u);
      assert.throws(() => native!.resourceLoader.getExtensions().runtime.assertActive(), /stale/u);
      eventBus.emit("binding-probe", undefined);
      assert.equal(probe, 1);
    } finally {
      binding.resolve();
      cleanup.resolve();
      clearInterval(timer);
      await attempt.forceDispose();
      await attempt.closed;
    }
  }
});

test("Pi retires native extension contexts and subscriptions when cancellation interrupts binding", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-pi-extension-abort-");
  for (const phase of ["session_start", "resources_discover"] as const) {
    const controller = new AbortController();
    const binding = promiseBarrier<void>();
    const started = promiseBarrier<void>();
    const eventBus = sdk.createEventBus();
    let context: ExtensionContext | undefined;
    let native: sdk.AgentSession | undefined;
    let bindingOperation: Promise<void> | undefined;
    let retired = 0;
    let lateResource = false;
    let inputs = 0;
    let probe = 0;
    const nativeSdk = await extensionSdk(
      root,
      (pi) => {
        pi.events.on("binding-probe", () => {
          probe += 1;
        });
        pi.on("session_start", (_event, ctx) => {
          context = ctx;
          if (phase === "session_start") controller.abort(new Error("cancel during session start"));
        });
        pi.on("resources_discover", async () => {
          started.resolve();
          if (phase === "resources_discover") await binding.promise;
          lateResource = true;
          return {};
        });
        pi.on("session_shutdown", () => {
          assert.equal(lateResource, true);
          lateResource = false;
          retired++;
        });
        pi.on("input", () => {
          inputs += 1;
          return { action: "handled" };
        });
      },
      eventBus,
    );
    const createSession = nativeSdk.createAgentSessionFromServices;
    const provider = createPiProvider(undefined, async () => ({
      ...nativeSdk,
      createAgentSessionFromServices: async (options) => {
        const created = await createSession(options);
        native = created.session;
        const bind = native.bindExtensions.bind(native);
        native.bindExtensions = (bindings) => {
          bindingOperation = bind(bindings);
          return bindingOperation;
        };
        return created;
      },
    }));
    const attempt = provider.start({
      body: "work",
      launchTells: [],
      cwd: root,
      options: {},
      requests: { dir: join(root, "requests") },
      signal: controller.signal,
      session: { kind: "fresh" },
    });
    const rejected = assert.rejects(attempt.result, /cancel during session start|provider attempt retired/u);
    try {
      if (phase === "resources_discover") {
        await started.promise;
        void attempt.abort().catch(() => undefined);
      }
      await rejected;
      if (phase === "resources_discover") {
        let closed = false;
        void attempt.closed.then(() => { closed = true; });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(closed, false);
      }
      binding.resolve();
      await attempt.closed;
      assert.equal(retired, 1);
      assert.equal(lateResource, false);
      assert.equal(inputs, 0);
      assert.ok(native);
      assert.throws(() => context!.cwd, /stale/u);
      assert.throws(() => native!.resourceLoader.getExtensions().runtime.assertActive(), /stale/u);
      eventBus.emit("binding-probe", undefined);
      assert.equal(probe, 0);
      await bindingOperation;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(inputs, 0);
    } finally {
      binding.resolve();
      await attempt.forceDispose();
      await attempt.closed;
    }
  }
});

test("Pi closure reports extension shutdown failure but still disposes native state", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-pi-shutdown-failure-");
  let shutdowns = 0;
  let native: sdk.AgentSession | undefined;
  const nativeSdk = await extensionSdk(root, (pi) => {
    pi.on("input", () => ({ action: "handled" }));
    pi.on("session_shutdown", () => {
      shutdowns++;
      throw new Error("shutdown fixture failure");
    });
  }, sdk.createEventBus());
  const createSession = nativeSdk.createAgentSessionFromServices;
  const provider = createPiProvider(undefined, async () => ({
    ...nativeSdk,
    createAgentSessionFromServices: async (options) => {
      const created = await createSession(options);
      native = created.session;
      return created;
    },
  }));
  const attempt = provider.start({
    body: "work", launchTells: [], cwd: root, options: {},
    requests: { dir: join(root, "requests") },
    signal: new AbortController().signal, session: { kind: "fresh" },
  });
  const drive = await attempt.result;
  await drive.completion;
  await assert.rejects(attempt.closed, /shutdown fixture failure/u);
  assert.throws(() => native!.resourceLoader.getExtensions().runtime.assertActive(), /stale/u);
  await assert.rejects(attempt.forceDispose(), /shutdown fixture failure/u);
  assert.equal(shutdowns, 1);
});

test("npm root package declares its Pi resources", () => {
  assert.equal(Array.isArray(packageJson.keywords) && packageJson.keywords.includes("pi-package"), true);
  assert.deepEqual(packageJson.pi, {
    extensions: ["./build/integrations/pi/keiyaku.ts"],
    skills: ["./build/integrations/marketplace/plugins/keiyaku/skills"],
  });
});

test("Pi loads the root package without host-provided dependency warnings", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-pi-peer-");
  const loader = new sdk.DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager: sdk.SettingsManager.inMemory({ packages: [fileURLToPath(rootUrl)] }),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const result = loader.getExtensions();
  t.after(() => result.runtime.invalidate());
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  assert.equal(result.extensions[0]?.resolvedPath, builtExtension);
  assert.ok(result.extensions[0]?.commands.has("keiyaku"));
  assert.deepEqual(result.warnings, []);
  assert.equal(packageJson.dependencies?.["@earendil-works/pi-coding-agent"], undefined);
  assert.equal(packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"], "*");
  assert.equal(packageJson.devDependencies?.["@earendil-works/pi-coding-agent"], "^1.0.0");
});

type Handler = (event: unknown, context: ExtensionContext) => unknown;

type CommandHandler = (args: string, context: ExtensionContext) => Promise<void>;
type Overlay = Readonly<{ handleInput(data: string): void; render(width: number): string[] }>;
type ExecResult = Readonly<{ stdout: string; stderr: string; code: number; killed: boolean }>;

function install(execute: (command: string, args: string[]) => Promise<ExecResult>) {
  const handlers = new Map<string, Handler>();
  let command: CommandHandler | undefined;
  const pi = {
    on(event: string, handler: Handler): void {
      handlers.set(event, handler);
    },
    registerCommand(name: string, options: { handler: CommandHandler }): void {
      assert.equal(name, "keiyaku");
      command = options.handler;
    },
    exec(commandName: string, args: string[]): Promise<ExecResult> {
      return execute(commandName, args);
    },
  } as unknown as ExtensionAPI;

  keiyakuExtension(pi);
  assert.ok(command);
  return { command, handlers };
}

test("Pi registers only the explicit Keiyaku command", () => {
  const { handlers } = install(async () => {
    throw new Error("status must not run while loading");
  });

  assert.deepEqual([...handlers.keys()], []);
});

test("Pi command runs one text status and does not refresh when dismissed", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const { command } = install(async (commandName, args) => {
    calls.push({ command: commandName, args });
    return { stdout: "Contract status\nAkuma status\n", stderr: "", code: 0, killed: false };
  });
  let overlay: Overlay | undefined;
  const { promise: closed, resolve: closeOverlay } = promiseBarrier<void>();
  const context = {
    hasUI: true,
    ui: {
      custom(factory: unknown): Promise<void> {
        overlay = (
          factory as (
            tui: unknown,
            theme: { fg(role: string, value: string): string },
            keybindings: unknown,
            done: () => void,
          ) => Overlay
        )(undefined, { fg: (_role, value) => value }, undefined, closeOverlay);
        return closed;
      },
    },
  } as unknown as ExtensionContext;

  const invocation = command("", context);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, process.execPath);
  assert.equal(calls[0]?.args[0], fileURLToPath(new URL("build/src/cli/index.js", rootUrl)));
  assert.equal(calls[0]?.args.at(-1), "status");
  assert.equal(calls[0]?.args.includes("--json"), false);
  assert.ok(overlay);
  assert.equal(
    overlay.render(80).some((line) => line.includes("Contract status")),
    true,
  );
  overlay.handleInput("\r");
  await invocation;
  assert.equal(calls.length, 1);
});

test("Pi command skips no-UI calls and preserves status diagnostics", async () => {
  let calls = 0;
  const noUi = install(async () => {
    calls++;
    return { stdout: "", stderr: "", code: 0, killed: false };
  });
  await noUi.command("", { hasUI: false } as ExtensionContext);
  assert.equal(calls, 0);

  for (const [stderr, expected] of [
    ["database unreachable", "database unreachable"],
    ["", "status unavailable"],
  ] as const) {
    let displayed: string[] = [];
    const { command } = install(async () => ({ stdout: "", stderr, code: 1, killed: false }));
    await command("", {
      hasUI: true,
      ui: {
        custom(factory: unknown): Promise<void> {
          const component = (
            factory as (
              tui: unknown,
              theme: { fg(role: string, value: string): string },
              keybindings: unknown,
              done: () => void,
            ) => Overlay
          )(undefined, { fg: (_role, value) => value }, undefined, () => undefined);
          displayed = component.render(100);
          return Promise.resolve();
        },
      },
    } as ExtensionContext);
    assert.equal(
      displayed.some((line) => line.includes(expected)),
      true,
    );
  }
});
