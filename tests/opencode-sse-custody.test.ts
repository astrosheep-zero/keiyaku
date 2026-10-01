import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
import { driveAkumaBody as runAkumaBody, type BodyLaunch } from "../src/akuma/body.js";
import { CONTROL_RESPONSE_MS } from "../src/akuma/body-supervisor.js";
import { readHeart, requestPause } from "../src/akuma/heart/index.js";
import { createOpencodeProvider } from "../src/akuma/providers/opencode-sdk/index.js";
import {
  opencodeEventPort,
  type OpencodeEventSubscriptionRequest,
  type OpencodeSdkLoader,
  type OpencodeSdkSession,
} from "../src/akuma/providers/opencode-sdk/session.js";
import { allocatedHeart } from "./support/akuma-fixtures.js";
import { waitForCondition, waitForProcessExit } from "./support/process.js";

const SESSION_ID = "session-1";
const RETRY_DELAY_MS = 3_000;

/** Minimal native session whose only assistant answer follows the admitted launch message. */
function fixtureSession(): Readonly<{ session: OpencodeSdkSession; prompts: string[] }> {
  const prompts: string[] = [];
  const session = {
    async create() {
      return { data: { id: SESSION_ID } };
    },
    async get() {
      return { data: { id: SESSION_ID } };
    },
    async promptAsync(value: { body: { messageID: string } }) {
      prompts.push(value.body.messageID);
      return { data: undefined };
    },
    async messages() {
      const user = prompts[0] ?? "msg_unknown";
      return {
        data: [
          { info: { id: user, sessionID: SESSION_ID, role: "user", time: { created: 1 } }, parts: [] },
          {
            info: { id: "assistant-1", sessionID: SESSION_ID, parentID: user, role: "assistant", time: { created: 2 } },
            parts: [{ type: "text", text: "answer" }],
          },
        ],
      };
    },
    async abort() {
      return { data: true };
    },
  } as unknown as OpencodeSdkSession;
  return { session, prompts };
}

function driveInput() {
  return {
    body: "work",
    launchTells: [],
    cwd: "/tmp",
    options: {},
    signal: new AbortController().signal,
    requests: { dir: "/tmp/requests" },
    session: { kind: "fresh" as const },
  };
}

/** The real installed SDK client, adapted through the adapter's own one SDK seam. */
function realSdkLoader(
  input: Readonly<{
    session: OpencodeSdkSession;
    observeSubscribe?(request: OpencodeEventSubscriptionRequest): OpencodeEventSubscriptionRequest;
    onClose?(): void;
  }>,
): OpencodeSdkLoader {
  return async () => {
    const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:9", directory: "/tmp" });
    const port = opencodeEventPort(client.event);
    return {
      client: {
        session: input.session,
        event: {
          subscribe: (request) =>
            port.subscribe(input.observeSubscribe === undefined ? request : input.observeSubscribe(request)),
        },
      },
      close: () => input.onClose?.(),
    };
  };
}

/** A controlled SSE body the test feeds; cancellation is observable. */
function controlledBody() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    send: (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
    cancelled: () => cancelled,
  };
}

/** Observe whether a settlement occurred within a short bound, without forcing it. */
function settledOutcome(settlement: Promise<unknown>): () => Promise<"settled" | "pending"> {
  let state: "settled" | "pending" = "pending";
  void settlement.then(
    () => {
      state = "settled";
    },
    () => {
      state = "settled";
    },
  );
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return state;
  };
}

/** Count referenced timers, so a leaked retry backoff is visible in-process. */
function activeTimers(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
}

async function withInjectedFetch(fetchImpl: typeof fetch, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("OpenCode retires real-SDK fetch, reader, and retry waiting before attempt closure", async () => {
  let fetches = 0;
  const sleeps: number[] = [];
  let closeCalls = 0;
  await withInjectedFetch(
    async () => {
      fetches += 1;
      throw new Error("connect ECONNREFUSED 127.0.0.1:9");
    },
    async () => {
      const { session } = fixtureSession();
      const provider = createOpencodeProvider({
        loader: realSdkLoader({
          session,
          observeSubscribe: (request) => ({
            ...request,
            sleep: async (milliseconds) => {
              sleeps.push(milliseconds);
              await request.sleep(milliseconds);
            },
          }),
          onClose: () => {
            closeCalls += 1;
          },
        }),
      });
      const attempt = provider.start(driveInput());
      await attempt.result;
      await waitForCondition("the first SSE fetch", () => fetches === 1, { budgetMs: 5_000 });
      const timersBefore = activeTimers();
      const retiring = performance.now();
      await attempt.abort();
      await attempt.closed;
      const elapsed = performance.now() - retiring;
      assert.deepEqual(sleeps, [RETRY_DELAY_MS], "the real SDK waited inside the adapter's cancellable sleep");
      assert.ok(elapsed < CONTROL_RESPONSE_MS, `retirement took ${Math.round(elapsed)}ms`);
      assert.ok(
        activeTimers() <= timersBefore,
        `a referenced retry timer outlived closure (${activeTimers()} > ${timersBefore})`,
      );
      const settled = fetches;
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(fetches, settled, "no further fetch runs after closure");
      assert.equal(closeCalls, 1, "the owned server retired once");
    },
  );
});

test("OpenCode answered Turn cancels the real SSE reader before whole closure", async () => {
  const body = controlledBody();
  let closeCalls = 0;
  await withInjectedFetch(
    async () => body.response(),
    async () => {
      const { session, prompts } = fixtureSession();
      const provider = createOpencodeProvider({ loader: realSdkLoader({ session, onClose: () => (closeCalls += 1) }) });
      const attempt = provider.start(driveInput());
      const drive = await attempt.result;
      const messageId = prompts[0]!;
      body.send({
        type: "message.updated",
        properties: { info: { id: messageId, sessionID: SESSION_ID, role: "user" } },
      });
      body.send({ type: "session.status", properties: { sessionID: SESSION_ID, status: { type: "busy" } } });
      body.send({ type: "session.status", properties: { sessionID: SESSION_ID, status: { type: "idle" } } });
      assert.deepEqual(await drive.completion, { kind: "answered", answer: "answer", historyId: "assistant-1" });
      await attempt.closed;
      assert.equal(body.cancelled(), true, "a normal answer cancelled its SSE reader");
      assert.equal(closeCalls, 1);
    },
  );
});

test("OpenCode forced disposal during production backoff retires once inside control policy", async () => {
  let fetches = 0;
  let closeCalls = 0;
  await withInjectedFetch(
    async () => {
      fetches += 1;
      throw new Error("connect ECONNREFUSED 127.0.0.1:9");
    },
    async () => {
      const { session } = fixtureSession();
      const provider = createOpencodeProvider({ loader: realSdkLoader({ session, onClose: () => (closeCalls += 1) }) });
      const attempt = provider.start(driveInput());
      await attempt.result;
      await waitForCondition("the first SSE fetch", () => fetches === 1, { budgetMs: 5_000 });
      const retiring = performance.now();
      await Promise.all([attempt.forceDispose(), attempt.forceDispose()]);
      await attempt.closed;
      assert.ok(performance.now() - retiring < CONTROL_RESPONSE_MS);
      const settled = fetches;
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(fetches, settled, "forced disposal leaves no retry behind");
      assert.equal(closeCalls, 1, "idempotent whole-close retires the server once");
    },
  );
});

test("OpenCode owns a late-arriving subscription before setup can await", async () => {
  let fetches = 0;
  let subscribeCalls = 0;
  let closeCalls = 0;
  let releaseSubscribe!: (value: Readonly<{ stream: AsyncIterable<unknown> }>) => void;
  const arriving = new Promise<Readonly<{ stream: AsyncIterable<unknown> }>>((resolve) => (releaseSubscribe = resolve));
  await withInjectedFetch(
    async () => {
      fetches += 1;
      throw new Error("no fetch may start after cancellation");
    },
    async () => {
      const { session } = fixtureSession();
      const provider = createOpencodeProvider({
        loader: async () => ({
          client: {
            session,
            event: {
              subscribe: async () => {
                subscribeCalls += 1;
                return await arriving;
              },
            },
          },
          close: () => {
            closeCalls += 1;
          },
        }),
      });
      const attempt = provider.start(driveInput());
      await waitForCondition("subscription setup", () => subscribeCalls === 1, { budgetMs: 5_000 });
      const retiring = performance.now();
      const disposal = attempt.forceDispose();
      releaseSubscribe({ stream: (async function* () {})() });
      await disposal;
      await attempt.closed;
      assert.ok(performance.now() - retiring < CONTROL_RESPONSE_MS);
      assert.equal(fetches, 0, "a subscription arriving after cancellation never fetches");
      assert.equal(closeCalls, 1);
    },
  );
});

test("OpenCode preserves subscription setup failure while resources retire", async () => {
  let closeCalls = 0;
  const { session } = fixtureSession();
  const provider = createOpencodeProvider({
    loader: async () => ({
      client: {
        session,
        event: {
          subscribe: async () => {
            throw new Error("native subscription refused");
          },
        },
      },
      close: () => {
        closeCalls += 1;
      },
    }),
  });
  const attempt = provider.start(driveInput());
  await assert.rejects(attempt.result, /native subscription refused/u);
  await attempt.closed;
  assert.equal(closeCalls, 1, "setup failure still closed the owned server");
});

test("OpenCode surfaces reader teardown rejection through attempt custody", async () => {
  let closeCalls = 0;
  const { session } = fixtureSession();
  const provider = createOpencodeProvider({
    loader: async () => ({
      client: {
        session,
        event: {
          subscribe: async (request: OpencodeEventSubscriptionRequest) => ({
            stream: {
              [Symbol.asyncIterator]: () => ({
                next: () =>
                  new Promise<IteratorResult<unknown>>((resolve) => {
                    if (request.signal.aborted) resolve({ done: true, value: undefined });
                    else
                      request.signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), {
                        once: true,
                      });
                  }),
                return: async () => {
                  throw new Error("event reader teardown refused");
                },
              }),
            },
          }),
        },
      },
      close: () => {
        closeCalls += 1;
      },
    }),
  });
  const attempt = provider.start(driveInput());
  const drive = await attempt.result;
  const completion = settledOutcome(drive.completion);
  await assert.rejects(attempt.abort(), /event reader teardown refused/u);
  await assert.rejects(attempt.closed, /event reader teardown refused/u);
  assert.equal(await completion(), "pending", "a refused whole closure never publishes the Turn");
  assert.equal(closeCalls, 1, "the server retired even though the reader teardown failed");
});

test("OpenCode never marks closure when the reader cannot prove retirement", async () => {
  let closeCalls = 0;
  const { session } = fixtureSession();
  const provider = createOpencodeProvider({
    loader: async () => ({
      client: {
        session,
        event: {
          subscribe: async (request: OpencodeEventSubscriptionRequest) => ({
            stream: {
              [Symbol.asyncIterator]: () => ({
                next: () =>
                  new Promise<IteratorResult<unknown>>((resolve) => {
                    if (request.signal.aborted) resolve({ done: true, value: undefined });
                    else
                      request.signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), {
                        once: true,
                      });
                  }),
                return: () => new Promise<IteratorResult<unknown>>(() => undefined),
              }),
            },
          }),
        },
      },
      close: () => {
        closeCalls += 1;
      },
    }),
  });
  const attempt = provider.start(driveInput());
  const drive = await attempt.result;
  const disposal = attempt.forceDispose().then(
    () => "settled" as const,
    () => "rejected" as const,
  );
  const outcome = await Promise.race([
    disposal,
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), CONTROL_RESPONSE_MS + 100)),
  ]);
  assert.equal(outcome, "pending", "an unprovable retirement leaves closure pending, never marked closed");
  assert.equal(closeCalls, 1, "the owned server still retired");
  assert.equal(await settledOutcome(drive.completion)(), "pending", "an unproven closure never publishes the Turn");
});

test("OpenCode whole closure is idempotent after a normal answer", async () => {
  const body = controlledBody();
  let closeCalls = 0;
  await withInjectedFetch(
    async () => body.response(),
    async () => {
      const { session, prompts } = fixtureSession();
      const provider = createOpencodeProvider({ loader: realSdkLoader({ session, onClose: () => (closeCalls += 1) }) });
      const attempt = provider.start(driveInput());
      const drive = await attempt.result;
      const messageId = prompts[0]!;
      body.send({
        type: "message.updated",
        properties: { info: { id: messageId, sessionID: SESSION_ID, role: "user" } },
      });
      body.send({ type: "session.status", properties: { sessionID: SESSION_ID, status: { type: "busy" } } });
      body.send({ type: "session.status", properties: { sessionID: SESSION_ID, status: { type: "idle" } } });
      assert.equal((await drive.completion).kind, "answered");
      await Promise.all([drive.forceDispose(), drive.forceDispose()]);
      await attempt.closed;
      assert.equal(closeCalls, 1, "a settled whole-close never retires twice");
      assert.equal(body.cancelled(), true);
    },
  );
});

/** A Body launch whose seed names this adapter; cwd and Heart come from the fixture. */
function opencodeBodyLaunch(allocated: Awaited<ReturnType<typeof allocatedHeart>>, cwd: string): BodyLaunch {
  return {
    paths: allocated.paths,
    seed: {
      id: allocated.id,
      archetype: "claude",
      provider: { name: "opencode-sdk", kind: "opencode-sdk" },
      options: {},
      origin: { kind: "direct" },
      allowed: ALLOWED_ACTIONS,
      cwd,
    },
    initialBody: "work",
  };
}

/**
 * A native event stream that answers once and then cannot prove retirement:
 * `next` settles only on abort, while `return` never settles. Whole closure
 * therefore stays pending, which is exactly the unproven case the Body must
 * survive without parking.
 */
function terminalThenUnclosable(
  session: Readonly<{ prompts: string[] }>,
  request: OpencodeEventSubscriptionRequest,
): AsyncIterable<unknown> {
  const queued: unknown[] = [];
  let index = 0;
  let seeded = false;
  return {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<unknown>> => {
        while (queued.length === index) {
          if (request.signal.aborted) return { done: true, value: undefined };
          if (!seeded && session.prompts.length > 0) {
            const messageId = session.prompts[0]!;
            queued.push(
              {
                type: "message.updated",
                properties: { info: { id: messageId, sessionID: SESSION_ID, role: "user" } },
              },
              { type: "session.status", properties: { sessionID: SESSION_ID, status: { type: "busy" } } },
              { type: "session.status", properties: { sessionID: SESSION_ID, status: { type: "idle" } } },
            );
            seeded = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        return { done: false, value: queued[index++] };
      },
      return: () => new Promise<IteratorResult<unknown>>(() => undefined),
    }),
  };
}

async function waitUntilLatestBody(paths: Parameters<typeof readHeart>[0]): Promise<void> {
  await waitForCondition("the first Body recorded in Heart", async () => (await readHeart(paths)).latestBody !== null);
}

/** Distinguishes a bounded Body settlement from a park, without forcing either. */
async function boundedOutcome(body: Promise<unknown>, timeoutMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      body.then(
        () => "settled",
        (error: unknown) => `rejected:${error instanceof Error ? error.name : String(error)}`,
      ),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("parked"), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A failed bounded supervision wait must not be mistaken for a hung Body. */
async function expectBodySettles(body: Promise<unknown>, message: string, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      body,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("OpenCode Body supervises control stop while stream closure is unproven", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-opencode-body-stop-"));
  try {
    const allocated = await allocatedHeart(root, "claude", "feed0001");
    const { session, prompts } = fixtureSession();
    const provider = createOpencodeProvider({
      loader: async () => ({
        client: {
          session,
          event: {
            subscribe: async (request: OpencodeEventSubscriptionRequest) => ({
              stream: terminalThenUnclosable({ prompts }, request),
            }),
          },
        },
        close: () => undefined,
      }),
    });
    const body = runAkumaBody(opencodeBodyLaunch(allocated, root), provider, {
      now: () => "2026-08-08T00:00:00.000Z",
    });
    await waitUntilLatestBody(allocated.paths);
    const requested = await requestPause(allocated.paths, "2026-08-08T00:00:01.000Z");
    assert.equal(requested.kind, "requested");
    await expectBodySettles(body, "the Body did not reach bounded hung handling", 6_000);
    const heart = await readHeart(allocated.paths);
    assert.match(
      heart.latestBody?.hung?.diagnostic ?? "",
      /provider custody remained live after 1000ms/u,
      "the unproven stream closure is recorded as hung, not parked",
    );
    assert.equal(heart.latestBody?.end, "broke-off");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode Body supervises Heart loss while stream closure is unproven", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-opencode-body-heart-gone-"));
  try {
    const allocated = await allocatedHeart(root, "claude", "feed0002");
    const { session, prompts } = fixtureSession();
    const provider = createOpencodeProvider({
      loader: async () => ({
        client: {
          session,
          event: {
            subscribe: async (request: OpencodeEventSubscriptionRequest) => ({
              stream: terminalThenUnclosable({ prompts }, request),
            }),
          },
        },
        close: () => undefined,
      }),
    });
    const body = runAkumaBody(opencodeBodyLaunch(allocated, root), provider, {
      now: () => "2026-08-08T00:00:00.000Z",
    });
    await waitUntilLatestBody(allocated.paths);
    // Heart loss must land mid-turn, while closure is still unproven.
    await waitForCondition("the launched native prompt", () => prompts.length > 0, { budgetMs: 5_000 });
    rmSync(allocated.paths.heart, { force: true });
    // Before the whole-close ordering fix the driver was parked at a pending
    // completion here and never woke. It must now leave the Heart/control race
    // and retire bounded; the absent-Heart `breakBody` edge it then meets is
    // pre-existing Body behaviour outside this adapter, not a park.
    const started = performance.now();
    const outcome = await boundedOutcome(body, 8_000);
    const elapsed = performance.now() - started;
    assert.notEqual(outcome, "parked", "Heart loss must not park the Body on unproven closure");
    assert.match(outcome, /^(?:settled|rejected:HeartAbsentError)$/u, `unexpected Heart-loss outcome ${outcome}`);
    assert.ok(elapsed < 8_000, `Heart loss settled in ${Math.round(elapsed)}ms`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function childScript(sdkEntry: string, adapterEntry: string, seamEntry: string): string {
  return `
import { createOpencodeClient } from ${JSON.stringify(sdkEntry)};
import { createOpencodeProvider } from ${JSON.stringify(adapterEntry)};
import { opencodeEventPort } from ${JSON.stringify(seamEntry)};

const watchdog = setTimeout(() => {
  console.error("unproven closure: the attempt did not retire every owned resource");
  process.exit(3);
}, 1500);
watchdog.unref();

let fetches = 0;
globalThis.fetch = async () => {
  fetches += 1;
  throw new Error("connect ECONNREFUSED 127.0.0.1:9");
};

const session = {
  create: async () => ({ data: { id: "session-1" } }),
  promptAsync: async () => ({ data: undefined }),
  messages: async () => ({ data: [] }),
  abort: async () => ({ data: true }),
};
let closeCalls = 0;
const provider = createOpencodeProvider({
  loader: async () => {
    const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:9", directory: process.cwd() });
    return {
      client: { session, event: opencodeEventPort(client.event) },
      close: () => {
        closeCalls += 1;
      },
    };
  },
});

const attempt = provider.start({
  body: "work",
  launchTells: [],
  cwd: process.cwd(),
  options: {},
  signal: new AbortController().signal,
  requests: { dir: process.cwd() },
  session: { kind: "fresh" },
});
await attempt.result;
for (let index = 0; index < 4000 && fetches === 0; index += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1));
}
if (fetches !== 1) {
  console.error(\`expected one SSE fetch, saw \${fetches}\`);
  process.exit(4);
}
await attempt.abort();
await attempt.closed;
if (closeCalls !== 1) {
  console.error(\`expected one server close, saw \${closeCalls}\`);
  process.exit(5);
}
console.log("closed");
`;
}

async function superviseChild(
  child: ChildProcess,
  timeoutMs: number,
): Promise<Readonly<{ code: number | null; stdout: string; stderr: string }>> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => (stdout += chunk));
  child.stderr?.on("data", (chunk: string) => (stderr += chunk));
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`diagnostic child did not exit naturally: stdout=${stdout} stderr=${stderr}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test("OpenCode diagnostic child exits naturally after real-SDK retry closure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-sse-child-"));
  const script = join(directory, "child.mjs");
  writeFileSync(
    script,
    childScript(
      import.meta.resolve("@opencode-ai/sdk"),
      new URL("../src/akuma/providers/opencode-sdk/index.js", import.meta.url).href,
      new URL("../src/akuma/providers/opencode-sdk/session.js", import.meta.url).href,
    ),
  );
  const loader = import.meta.url.endsWith(".js") ? [] : ["--import", "tsx"];
  const child = spawn(process.execPath, [...loader, script], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const outcome = await superviseChild(child, 20_000);
    assert.equal(outcome.stderr, "");
    assert.equal(outcome.stdout.trim(), "closed");
    assert.equal(outcome.code, 0, "the child exited naturally, without a forced or timed exit");
  } finally {
    if (child.pid !== undefined) {
      child.kill("SIGKILL");
      await waitForProcessExit(child.pid).catch(() => undefined);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
