import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import test from "node:test";
import { driveAkumaBody } from "../src/akuma/body.js";
import type { BodyLaunch } from "../src/akuma/body-launch.js";
import { readHeart } from "../src/akuma/heart/index.js";
import { createProviderAttempt } from "../src/akuma/provider.js";
import { createOpencodeProvider } from "../src/akuma/providers/opencode-sdk/index.js";
import { NativeOpencodeRuntime, type RuntimeOpener } from "../src/akuma/providers/opencode-sdk/session.js";
import { allocatedHeart, insertLegacyPauseControl } from "./support/akuma-fixtures.js";
import {
  failDispatcherRetirement,
  json,
  nativeEndpoint,
  nativeInfo,
  opencodeFixture,
  ownedOpenCode,
  sse,
} from "./support/opencode-v2.js";
import {
  deferred,
  expectBodySettles,
  processExists,
  temporaryDirectory,
  waitForProcessExit,
} from "./support/process.js";
import { isolateUserHome } from "./support/user-home.js";

isolateUserHome();

const recipe = { name: "opencode-sdk", kind: "opencode-sdk" } as const;
function openRuntime(open: RuntimeOpener, cwd = "/tmp", execution: Parameters<RuntimeOpener>[0]["execution"] = recipe) {
  return createProviderAttempt(undefined, (custody) => open({ execution, cwd, signal: custody.signal, custody }));
}

test("OpenCode v2 HTML and foreign JSON cannot satisfy native readiness", async (t) => {
  const requests: string[] = [];
  const native = nativeEndpoint(t, (request, response) => {
    requests.push(request.url!);
    if (requests.length === 1) {
      response.writeHead(200, { "content-type": "text/html" });
      return void response.end("<html>app</html>");
    }
    if (requests.length === 2) return json(response, { data: [] });
    if (request.url === "/api/info") return json(response, nativeInfo);
    response.writeHead(200, { "content-type": "text/event-stream" });
    sse(response, { type: "server.connected", data: {} });
  });
  const attempt = openRuntime(native.open);
  await attempt.result;
  assert.deepEqual(requests, ["/api/info", "/api/info", "/api/info", "/api/event"]);
  await attempt.forceDispose();
  await attempt.closed;
  await native.retired();
});

test("OpenCode v2 refuses a bound port without a usable address", async (t) => {
  const fake = {
    once: () => fake,
    listen: (_port: number, _host: string, ready: () => void) => (ready(), fake),
    address: () => null,
    close: (callback?: (error?: Error) => void) => (callback?.(), fake),
  };
  t.mock.method(net, "createServer", () => fake as unknown as net.Server);
  const signal = new AbortController().signal;
  await assert.rejects(
    NativeOpencodeRuntime.open({ execution: recipe, cwd: "/tmp", signal, custody: { signal, own() {} } }),
    /OpenCode port unavailable/,
  );
});

test("OpenCode v2 readiness and events run on the package Undici fetch, not the host global", async (t) => {
  const requests: string[] = [];
  const native = nativeEndpoint(t, (request, response) => {
    requests.push(request.url!);
    if (request.url === "/api/info") return json(response, nativeInfo);
    response.writeHead(200, { "content-type": "text/event-stream" });
    sse(response, { type: "server.connected", data: {} });
    sse(response, { type: "server.heartbeat", data: {} });
  });
  t.mock.method(globalThis, "fetch", () => Promise.reject(new Error("host global fetch was used")));
  const attempt = openRuntime(native.open);
  const runtime = await attempt.result;
  try {
    assert.deepEqual(await runtime.next(), { done: false, value: { type: "server.heartbeat", data: {} } });
    assert.deepEqual(requests, ["/api/info", "/api/event"]);
  } finally {
    await attempt.forceDispose();
    await attempt.closed;
    await native.retired();
  }
});

test("OpenCode v2 retires an outstanding read and its physical socket once without retries", async (t) => {
  let opens = 0;
  const native = nativeEndpoint(t, (request, response) => {
    if (request.url === "/api/info") return json(response, nativeInfo);
    opens += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    sse(response, { type: "server.connected", data: {} });
  });
  const attempt = openRuntime(native.open);
  const runtime = await attempt.result;
  const reading = runtime.next();
  const retiring = runtime.retire();
  assert.equal(runtime.retire(), retiring);
  assert.equal((await reading).done, true);
  await retiring;
  await attempt.closed;
  await native.retired();
  assert.equal(opens, 1);
});

test("OpenCode v2 surfaces the native Effect stream failure frame", async (t) => {
  let opens = 0;
  const native = nativeEndpoint(t, (request, response) => {
    if (request.url === "/api/info") return json(response, nativeInfo);
    opens += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    sse(response, { type: "server.connected", data: {} });
    response.end("event: effect/httpapi/stream/failure\ndata: []\n\n");
  });
  const attempt = openRuntime(native.open);
  try {
    const runtime = await attempt.result;
    await assert.rejects(runtime.next(), /native event feed failed/u);
  } finally {
    await attempt.forceDispose();
    await attempt.closed;
    await native.retired();
  }
  assert.equal(opens, 1);
});

test("OpenCode v2 cancels subscription setup before the connected barrier or any prompt", async (t) => {
  const subscribed = deferred();
  const requests: string[] = [];
  const native = nativeEndpoint(t, (request, response) => {
    requests.push(request.url!);
    if (request.url === "/api/info") return json(response, nativeInfo);
    response.writeHead(200, { "content-type": "text/event-stream" }).flushHeaders();
    subscribed.resolve();
  });
  const attempt = createOpencodeProvider(undefined, native.open).start(opencodeFixture(t).input);
  const refused = assert.rejects(attempt.result, /provider attempt retired/u);
  await subscribed.promise;
  await attempt.abort();
  await refused;
  await attempt.closed;
  await native.retired();
  assert.deepEqual(requests, ["/api/info", "/api/event"]);
});

test("OpenCode v2 Body remains supervised while whole closure is unproven", async (t) => {
  for (const control of ["stop", "heart-loss"] as const) {
    await t.test(control, async (context) => {
      const root = temporaryDirectory(context, `keiyaku-opencode-${control}-`);
      mkdirSync(join(root, ".keiyaku"), { recursive: true });
      writeFileSync(
        join(root, ".keiyaku", "settings.json"),
        JSON.stringify({
          plugins: {
            square: { package: "@astrosheep/keiyaku-plugin-square", enabled: false },
            paseo: { package: "@astrosheep/keiyaku-plugin-paseo", enabled: false },
          },
        }),
      );
      const allocated = await allocatedHeart(root, "claude", control === "stop" ? "feed0001" : "feed0002");
      const native = opencodeFixture(context);
      native.controls.onPrompt = (id) => {
        native.admitted(id);
        native.delivered(id);
        native.step();
        native.complete();
      };
      const entered = deferred();
      const release = deferred();
      const originalCancel = ReadableStreamDefaultReader.prototype.cancel;
      context.mock.method(
        ReadableStreamDefaultReader.prototype,
        "cancel",
        async function (this: ReadableStreamDefaultReader, reason?: unknown) {
          entered.resolve();
          await release.promise;
          return await originalCancel.call(this, reason);
        },
      );
      const launch: BodyLaunch = {
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          akumaName: "claude",
          provider: recipe,
          options: {},
          origin: { kind: "direct" },
          cwd: root,
        },
        initialBody: "work",
      };
      const body = driveAkumaBody(launch, createOpencodeProvider(undefined, native.open), {
        now: () => "2026-08-08T00:00:00.000Z",
      });
      try {
        await expectBodySettles(entered.promise, "native reader did not enter retirement");
        await native.retired(); // Socket destruction proceeds even while the reader cannot retire.
        if (control === "stop") {
          const current = (await readHeart(allocated.paths)).latestBody!;
          await insertLegacyPauseControl(allocated.paths, current.sequence, "2026-08-08T00:00:01.000Z");
          await expectBodySettles(body, "Body parked outside custody supervision", 6_000);
          const heart = await readHeart(allocated.paths);
          assert.match(heart.latestBody?.hung?.diagnostic ?? "", /provider custody remained live/u);
          assert.equal(heart.latestBody?.end, "broke-off");
        } else {
          rmSync(allocated.paths.heart);
          await expectBodySettles(
            body.catch((error: unknown) => {
              assert.equal((error as Error).name, "HeartAbsentError");
            }),
            "Heart loss parked outside custody supervision",
            8_000,
          );
        }
      } finally {
        release.resolve();
      }
    });
  }
});

test("OpenCode v2 preserves hidden reader teardown failure independently of the Turn", async (t) => {
  const native = opencodeFixture(t);
  const originalCancel = ReadableStreamDefaultReader.prototype.cancel;
  t.mock.method(
    ReadableStreamDefaultReader.prototype,
    "cancel",
    async function (this: ReadableStreamDefaultReader, reason?: unknown) {
      await originalCancel.call(this, reason).catch(() => undefined);
      throw new Error("reader teardown refused");
    },
  );
  const attempt = createOpencodeProvider(undefined, native.open).start(native.input);
  const session = await attempt.result;
  await assert.rejects(attempt.forceDispose(), /reader teardown refused/u);
  await assert.rejects(attempt.closed, /reader teardown refused/u);
  assert.deepEqual(await session.completion, {
    kind: "failed",
    diagnostic: "OpenCode session force-disposed",
  });
  await native.retired();
});

test(
  "OpenCode v2 attempts reader, dispatcher and child cleanup independently",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = temporaryDirectory(t, "keiyaku-opencode-child-failure-");
    const owned = ownedOpenCode(t, root);
    const cancel = ReadableStreamDefaultReader.prototype.cancel;
    t.mock.method(
      ReadableStreamDefaultReader.prototype,
      "cancel",
      async function (this: ReadableStreamDefaultReader, reason?: unknown) {
        await cancel.call(this, reason).catch(() => undefined);
        throw new Error("reader cleanup refused");
      },
    );
    failDispatcherRetirement(t, "dispatcher cleanup refused");
    const attempt = openRuntime(NativeOpencodeRuntime.open, root, { ...recipe, executable: owned.executable });
    await attempt.result;
    const { pid } = await owned.child();
    const kill = process.kill;
    t.mock.method(process, "kill", (target: number, signal?: NodeJS.Signals | number) => {
      if (target === -pid && signal === "SIGTERM") throw new Error("child cleanup refused");
      return kill(target, signal);
    });
    const failures = (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors.map((reason: Error) => reason.message).sort(), [
        "child cleanup refused",
        "dispatcher cleanup refused",
        "reader cleanup refused",
      ]);
      return true;
    };
    try {
      await assert.rejects(attempt.forceDispose(), failures);
      await assert.rejects(attempt.closed, failures);
      assert.ok(processExists(pid), "logical retirement did not prove physical child exit");
    } finally {
      kill(pid, "SIGKILL");
      await waitForProcessExit(pid);
    }
  },
);
