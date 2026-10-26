import assert from "node:assert/strict";
import http from "node:http";
import type { Socket } from "node:net";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
import { driveAkumaBody, type BodyLaunch } from "../src/akuma/body.js";
import { readHeart } from "../src/akuma/heart/index.js";
import { allocatedHeart, insertLegacyPauseControl } from "./support/akuma-fixtures.js";
import { temporaryDirectory, expectBodySettles, waitForCondition } from "./support/process.js";
import test from "node:test";
import { createNativeClient } from "../src/akuma/providers/opencode-sdk/native-http.js";
import { waitReady } from "../src/akuma/providers/opencode-sdk/session.js";
import { createOpencodeProvider } from "../src/akuma/providers/opencode-sdk/index.js";
import { opencodeFixture, until } from "./support/opencode-v2.js";

async function server(handler: http.RequestListener) {
  const sockets = new Set<Socket>();
  const native = http.createServer(handler);
  native.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => native.listen(0, "127.0.0.1", resolve));
  const address = native.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    base: `http://127.0.0.1:${address.port}`,
    sockets,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        native.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}

test("OpenCode v2 HTML and foreign JSON cannot satisfy native readiness", async () => {
  const native = await server((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html>app</html>");
  });
  const client = createNativeClient(native.base, "test-password");
  try {
    await assert.rejects(client.sdk.server.info(), /UnsupportedContentType/u);
    const controller = new AbortController();
    let reads = 0;
    const ready = waitReady(async () => {
      reads += 1;
      if (reads === 2) controller.abort(new Error("not ready"));
      return { data: [] };
    }, controller.signal);
    await assert.rejects(ready, /not ready/u);
    assert.equal(reads, 2);
    await waitReady(
      async () => ({ version: "2.0.20", pid: 1, urls: [], paths: { tmp: "/tmp" } }),
      new AbortController().signal,
    );
  } finally {
    await client.close();
    await native.close();
  }
});

test("OpenCode v2 readiness and events run on the package Undici fetch, not the host global", async () => {
  const requests: string[] = [];
  const native = await server((request, response) => {
    requests.push(request.url ?? "");
    if (request.url === "/api/info") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: "2.0.20", pid: 1, urls: [], paths: { tmp: "/tmp" } }));
      return;
    }
    assert.equal(request.url, "/api/event");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"type":"server.connected","data":{}}\n\n');
    response.write('data: {"type":"server.heartbeat","data":{}}\n\n');
  });
  const hostFetch = globalThis.fetch;
  // The host global is a different Undici; a request through it cannot carry
  // this owned dispatcher. Readiness and the event feed must never reach it.
  globalThis.fetch = () => Promise.reject(new Error("host global fetch was used"));
  try {
    const client = createNativeClient(native.base, "test-password");
    try {
      const info = { version: "2.0.20", pid: 1, urls: [], paths: { tmp: "/tmp" } };
      assert.deepEqual(await client.sdk.server.info(), info);
      const subscription = await client.subscribe(new AbortController().signal);
      const event = await subscription.stream[Symbol.asyncIterator]().next();
      assert.deepEqual(event, { done: false, value: { type: "server.heartbeat", data: {} } });
      assert.deepEqual(requests, ["/api/info", "/api/event"]);
      await client.close();
      await until(() => native.sockets.size === 0);
    } finally {
      await client.close();
    }
  } finally {
    globalThis.fetch = hostFetch;
    await native.close();
  }
});

test("OpenCode v2 SSE cancellation proves physical socket closure without retries", async () => {
  let requests = 0;
  const native = await server((request, response) => {
    requests += 1;
    assert.equal(request.url, "/api/event");
    assert.equal(request.headers.authorization, `Basic ${Buffer.from("opencode:test-password").toString("base64")}`);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"type":"server.connected","data":{}}\r\n\r\n');
  });
  const client = createNativeClient(native.base, "test-password");
  const controller = new AbortController();
  try {
    const subscribed = await client.subscribe(controller.signal);
    const iterator = subscribed.stream[Symbol.asyncIterator]();
    const reading = iterator.next();
    controller.abort();
    await reading.catch(() => undefined);
    await iterator.return?.();
    await Promise.all([client.close(), client.close()]);
    await until(() => native.sockets.size === 0);
    assert.equal(requests, 1);
  } finally {
    await client.close();
    await native.close();
  }
});

test("OpenCode v2 native feed loss is not replayed and effect stream failure is visible", async () => {
  for (const terminal of ["eof", "failure"] as const) {
    let requests = 0;
    const native = await server((_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"type":"server.connected","data":{}}\n\n');
      if (terminal === "failure") response.write("event: effect/httpapi/stream/failure\ndata: []\n\n");
      response.end();
    });
    const client = createNativeClient(native.base, "test-password");
    try {
      const subscription = await client.subscribe(new AbortController().signal);
      const next = subscription.stream[Symbol.asyncIterator]().next();
      if (terminal === "failure") await assert.rejects(next, /native event feed failed/u);
      else assert.equal((await next).done, true);
      assert.equal(requests, 1);
    } finally {
      await client.close();
      await native.close();
    }
  }
});

test("OpenCode v2 cancellation during subscription setup retires the connection", async () => {
  let connected = false;
  const native = await server(() => {
    connected = true;
  });
  const client = createNativeClient(native.base, "test-password");
  try {
    const subscription = client.subscribe(new AbortController().signal);
    const refused = assert.rejects(subscription, /abort/u);
    await until(() => connected);
    await client.close();
    await refused;
    await until(() => native.sockets.size === 0);
  } finally {
    await client.close();
    await native.close();
  }
});

test("OpenCode v2 Body remains supervised while whole closure is unproven", async (context) => {
  for (const control of ["stop", "heart-loss"] as const) {
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
    const fixture = opencodeFixture();
    let returning = false;
    const provider = createOpencodeProvider({
      loader: async (...args) => {
        const loaded = await fixture.loader(...args);
        return {
          ...loaded,
          client: {
            session: {
              ...loaded.client.session,
              async prompt(input) {
                const result = await fixture.session.prompt(input);
                fixture.admitted(input.body.id);
                fixture.delivered(input.body.id);
                fixture.step();
                fixture.complete();
                return result;
              },
            },
            event: {
              async subscribe(request) {
                const subscription = await loaded.client.event.subscribe(request);
                const iterator = subscription.stream[Symbol.asyncIterator]();
                return {
                  stream: {
                    [Symbol.asyncIterator]: () => ({
                      next: () => iterator.next(),
                      return: () => {
                        returning = true;
                        return new Promise<IteratorResult<unknown>>(() => undefined);
                      },
                    }),
                  },
                };
              },
            },
          },
        };
      },
    });
    const launch: BodyLaunch = {
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        provider: { name: "opencode-sdk", kind: "opencode-sdk" },
        options: {},
        origin: { kind: "direct" },
        allowed: ALLOWED_ACTIONS,
        cwd: root,
      },
      initialBody: "work",
    };
    const body = driveAkumaBody(launch, provider, { now: () => "2026-08-08T00:00:00.000Z" });
    // Iterator return, not elapsed time or prompt submission, proves this exact phase.
    await waitForCondition("whole closure entered unproven iterator return", () => returning, { budgetMs: 5_000 });
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
    assert.equal(fixture.closed(), 1);
  }
});

test("OpenCode v2 preserves reader teardown failure independently of the Turn", async () => {
  const native = opencodeFixture();
  const provider = createOpencodeProvider({
    loader: async (...args) => {
      const loaded = await native.loader(...args);
      return {
        ...loaded,
        client: {
          ...loaded.client,
          event: {
            async subscribe({ signal }) {
              return {
                stream: {
                  [Symbol.asyncIterator]: () => ({
                    next: () =>
                      new Promise<IteratorResult<unknown>>((resolve) => {
                        const done = () => resolve({ done: true, value: undefined });
                        if (signal.aborted) done();
                        else signal.addEventListener("abort", done, { once: true });
                      }),
                    return: async () => {
                      throw new Error("reader teardown refused");
                    },
                  }),
                },
              };
            },
          },
        },
      };
    },
  });
  const attempt = provider.start(native.input);
  await attempt.result;
  await assert.rejects(attempt.forceDispose(), /reader teardown refused/u);
  await assert.rejects(attempt.closed, /reader teardown refused/u);
  assert.equal(native.closed(), 1);
});
