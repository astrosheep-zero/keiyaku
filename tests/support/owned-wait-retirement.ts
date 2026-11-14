import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { allocatedHeart, claudeBodyLaunch, noBodyLaunch } from "./akuma-fixtures.js";
import { deferred, expectBodySettles, waitForCondition } from "./process.js";
import { readHeart, readLatestTurnForBody } from "../../src/akuma/heart/index.js";
import { createProviderAttempt, type ProviderAdapter } from "../../src/akuma/provider.js";

const [mode, root] = process.argv.slice(2);
assert.ok(root);

if (mode === "gates") register(new URL("./akuma-body-empty-publication-loader.mjs", import.meta.url));
const { driveAkumaBody, CONTROL_RESPONSE_MS } = await import("../../src/akuma/body.js");

if (mode === "gates") {
  // Normal completion must close an observer held at its periodic gate. Launch
  // cancellation must also retire both gates without requiring release files.
  for (const cancel of [false, true]) {
    const barrier = join(root, cancel ? "cancel" : "close");
    mkdirSync(barrier);
    process.env.KEIYAKU_TEST_AKUMA_BODY_IDLE_FINISH_BARRIER = barrier;
    const allocated = await allocatedHeart(root, "claude", cancel ? "c3000002" : "c3000001");
    const { initialBody: _, ...launch } = claudeBodyLaunch(allocated, root, "unused");
    const controller = new AbortController();
    const body = driveAkumaBody(
      launch,
      {
        admitOptions: (options) => ({ kind: "admitted", options }),
        start() {
          throw new Error("empty fixture must not start provider work");
        },
      },
      { spawn: noBodyLaunch, signal: controller.signal },
    );
    void body.catch(() => undefined);
    try {
      await waitForCondition(
        "both owned fixture gates",
        () => existsSync(join(barrier, "idle-ready")) && existsSync(join(barrier, "observation-ready")),
        { budgetMs: 5_000 },
      );
      if (cancel) controller.abort();
      else writeFileSync(join(barrier, "release"), "release\n");
      await expectBodySettles(body, "fixture gate retained its closing owner", 2_000);
      assert.equal((await readHeart(allocated.paths)).latestBody?.end, cancel ? "put-down" : "exited");
    } finally {
      controller.abort();
      writeFileSync(join(barrier, "release"), "release\n");
      writeFileSync(join(barrier, "observation-release"), "release\n");
      await body;
    }
  }
} else {
  assert.equal(mode, "retirement");
  const allocated = await allocatedHeart(root, "claude", "c3000003");
  const started = deferred<void>();
  const closed = deferred<void>();
  const controller = new AbortController();
  let retired = false;
  const adapter: ProviderAdapter = {
    admitOptions: (options) => ({ kind: "admitted", options }),
    start(input) {
      return createProviderAttempt(input.signal, async (custody) => {
        const resource = setInterval(() => {}, 25);
        const retire = async () => {
          clearInterval(resource);
          retired = true;
          closed.resolve();
        };
        custody.own({ closed: closed.promise, abort: retire, forceDispose: retire });
        return {
          admission: { fence: "owned-wait-retirement" },
          events: {
            async *[Symbol.asyncIterator]() {
              started.resolve();
              await new Promise<void>(() => {});
            },
          },
          completion: new Promise<never>(() => {}),
        };
      });
    },
  };
  const body = driveAkumaBody(claudeBodyLaunch(allocated, root, "work"), adapter, {
    spawn: noBodyLaunch,
    signal: controller.signal,
  });
  await started.promise;
  controller.abort();
  await body;
  assert.equal(retired, true);
  await closed.promise;
  const heart = await readHeart(allocated.paths);
  assert.equal(heart.latestBody?.end, "put-down");
  assert.equal(heart.latestBody?.hung, undefined);
  assert.deepEqual((await readLatestTurnForBody(allocated.paths, heart.latestBody!.sequence))?.end?.outcome, {
    kind: "canceled",
  });
  const retiredAt = performance.now();
  process.once("exit", () => {
    console.log(JSON.stringify({ departureMs: performance.now() - retiredAt, deadlineMs: CONTROL_RESPONSE_MS }));
  });
}
