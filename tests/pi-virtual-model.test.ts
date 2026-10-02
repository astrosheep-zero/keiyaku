import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiProvider, type PiSdk } from "../src/akuma/providers/pi/index.js";
import { temporaryDirectory } from "./support/process.js";

test("Pi's native service bootstrap registers virtual models before selection and preserves retry success", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-pi-virtual-");
  const calls: string[] = [];
  let registrations = 0;
  let servicesCreated = 0;
  let sessionsCreated = 0;
  const credentials = {
    read: async () => undefined,
    list: async () => [],
    modify: async () => {
      throw new Error("fixture must not modify credentials");
    },
    delete: async () => {
      throw new Error("fixture must not delete credentials");
    },
  };
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
  });
  const fixture = (pi: ExtensionAPI) => {
    registrations += 1;
    pi.registerProvider("fixture", {
      baseUrl: "https://unused.invalid",
      api: "fixture-api",
      apiKey: "fixture-not-a-real-key",
      models: ["primary", "fallback"].map((id) => ({
        id,
        name: id,
        reasoning: false,
        input: ["text"],
        contextWindow: 100_000,
        maxTokens: 128,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      })),
      streamSimple(model) {
        calls.push(model.id);
        const error = model.id === "primary";
        const message = {
          role: "assistant" as const,
          api: "fixture-api",
          provider: "fixture",
          model: model.id,
          content: error ? [] : [{ type: "text" as const, text: "fallback answer" }],
          stopReason: error ? ("error" as const) : ("stop" as const),
          ...(error ? { errorMessage: "503 Service unavailable" } : {}),
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "start", partial: message };
            yield error
              ? { type: "error", reason: "error", error: message }
              : { type: "done", reason: "stop", message };
          },
          result: async () => message,
        } as never;
      },
    });
    pi.registerVirtualModel({
      provider: "dot-router",
      id: "dots-dot",
      name: "dots-dot",
      route(request, ctx) {
        const id = request.failed ? "fallback" : "primary";
        const model = ctx.modelRegistry.find("fixture", id);
        assert.ok(model);
        return { model, thinkingLevel: "off" };
      },
    });
  };
  const nativeSdk: PiSdk = {
    ...sdk,
    getAgentDir: () => root,
    SessionManager: { create: (cwd: string) => sdk.SessionManager.create(cwd, root) } as never,
    createAgentSessionServices: async (options) => {
      servicesCreated += 1;
      const services = await sdk.createAgentSessionServices({
        ...options,
        modelRuntime,
        settingsManager,
        resourceLoaderOptions: {
          ...options.resourceLoaderOptions,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          extensionFactories: [fixture],
        },
      });
      assert.equal(services.modelRuntime.getModel("dot-router", "dots-dot")?.api, "pi-virtual");
      return services;
    },
    createAgentSessionFromServices: async (options) => {
      sessionsCreated += 1;
      assert.equal(options.model?.id, "dots-dot");
      return sdk.createAgentSessionFromServices({ ...options, noTools: "all", tools: [] });
    },
  };
  const provider = createPiProvider(undefined, async () => nativeSdk);
  const attempt = provider.start({
    body: "Fixture only",
    launchTells: [],
    cwd: root,
    options: { model: "dot-router/dots-dot" },
    requests: { dir: join(root, "requests") },
    session: { kind: "fresh" },
    signal: new AbortController().signal,
  });
  try {
    const native = await attempt.result;
    const result = await native.completion;
    assert.equal(result.kind, "answered");
    if (result.kind === "answered") assert.equal(result.answer, "fallback answer");
    assert.deepEqual(calls, ["primary", "fallback"]);
    assert.equal(servicesCreated, 1);
    assert.equal(sessionsCreated, 1);
    assert.equal(registrations, 1);
    assert.equal(settingsManager.getDefaultProvider(), undefined);
    assert.equal(settingsManager.getDefaultModel(), undefined);
  } finally {
    await attempt.forceDispose();
    await attempt.closed;
  }
});
