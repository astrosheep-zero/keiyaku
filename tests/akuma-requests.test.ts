import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Akuma } from "../src/akuma/akuma.js";
import {
  HeldAkumaLeash,
  admitRequest,
  initializeHeart,
  readRequest,
  readSeal,
  readSoul,
  reserveRequest,
  type Soul,
} from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory, pathsForAkuId } from "../src/akuma/identity.js";
import { publishAkuma } from "../src/akuma/publication.js";
import { AKUMA_REQUESTS_ENV } from "../src/akuma/provider.js";
import {
  AkumaBodyRequestError,
  BodyRequestPump,
  requestBodyCall,
  settleBodyRequests,
} from "../src/akuma/requests.js";
import { World } from "../src/world.js";

async function akumaAt(root: string) { return Akuma.of(await World.at(root)); }

async function fixture() {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-akuma-requests-")));
  const parent = allocateAkumaDirectory({ worldRoot: root, archetype: "parent", draw: () => "1234abcd" });
  initializeHeart(parent.paths);
  const soul: Soul = {
    id: parent.id,
    archetype: "parent",
    provider: { name: "codex-app-server", kind: "codex-app-server" },
    options: { access: "write" },
    cwd: root,
    origin: { kind: "direct" },
    confinement: { kind: "declared", writableRoots: [root] },
    createdAt: "2026-08-09T00:00:00.000Z",
  };
  const leash = HeldAkumaLeash.try(parent.paths)!;
  leash.birth(parent.paths, soul);
  return { root, parent, soul, leash, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("aborted publication keeps an in-flight launch lexically owned", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-akuma-publication-abort-")));
  const controller = new AbortController();
  let started!: () => void;
  const launchStarted = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const launchGate = new Promise<void>((resolve) => { release = resolve; });
  let childPaths: ReturnType<typeof allocateAkumaDirectory>["paths"] | undefined;
  try {
    const publication = publishAkuma({
      worldPath: root,
      archetype: "worker",
      signal: controller.signal,
      async launch(allocated) {
        childPaths = allocated.paths;
        started();
        await launchGate;
      },
    });
    await launchStarted;
    let settled = false;
    void publication.finally(() => { settled = true; }).catch(() => {});
    controller.abort(new Error("cancelled publication"));
    await Promise.resolve();
    assert.equal(settled, false);
    release();
    await assert.rejects(publication, /cancelled publication/u);
    assert.equal(settled, true);
    assert.equal(childPaths === undefined ? null : readSeal(childPaths)?.evidence, "cancelled publication");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a declared drive serves Body Requests through transport while Heart remains authoritative", async () => {
  const value = await fixture();
  const priorHome = process.env.HOME;
  const priorRequests = process.env[AKUMA_REQUESTS_ENV];
  const home = join(value.root, "home");
  mkdirSync(join(home, ".keiyaku", "akuma"), { recursive: true });
  writeFileSync(join(home, ".keiyaku", "akuma", "worker.md"), "---\nprovider: claude\n---\nWork.\n");
  process.env.HOME = home;
  const pump = new BodyRequestPump({
    paths: value.parent.paths,
    parent: value.soul,
    bodySequence: 1,
    now: () => "2026-08-09T00:00:01.000Z",
    signal: new AbortController().signal,
    async spawn(launch) {
      const child = HeldAkumaLeash.try(launch.paths)!;
      child.birth(launch.paths, { ...launch.seed, createdAt: "2026-08-09T00:00:02.000Z" });
      child.release();
    },
  });
  try {
    process.env[AKUMA_REQUESTS_ENV] = pump.directory;
    const childId = (await (await akumaAt(value.root)).call({
      archetype: "worker",
      body: "build",
    })).id;
    const origin = readSoul(pathsForAkuId(value.root, childId))?.origin;
    assert.equal(origin?.kind, "request");
    if (origin?.kind !== "request") return;
    const requestId = origin.requestId;
    assert.equal(readRequest(value.parent.paths, requestId)?.state, "served");
    assert.deepEqual(origin, {
      kind: "request",
      parent: value.parent.id,
      requestId,
    });

    const unassociated = (await (await akumaAt(value.root)).call({ archetype: "worker", body: "separate" })).id;
    delete process.env[AKUMA_REQUESTS_ENV];

    const malformedId = "00000000-0000-4000-8000-000000000001";
    writeFileSync(join(pump.directory, `${malformedId}.request.json`), JSON.stringify({
      id: malformedId,
      world: value.root,
      archetype: "worker",
      body: "legacy association",
      contract: "kei/legacy-association",
      recipe: {
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: { systemPrompt: "Work.\n" },
        confinement: { kind: "unconfined" },
      },
    }));
    await assert.rejects(requestBodyCall({
      directory: pump.directory,
      id: "00000000-0000-4000-8000-000000000002",
      world: join(value.root, "other"),
      archetype: "worker",
      body: "wrong world",
      recipe: {
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: { systemPrompt: "Work.\n" },
        confinement: { kind: "unconfined" },
      },
    }), (error: unknown) => error instanceof AkumaBodyRequestError && error.outcome === "refused");
    assert.equal(readRequest(value.parent.paths, malformedId), null, "legacy association bytes must not enter Heart");
  } finally {
    await pump.close();
    value.leash.release();
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorRequests === undefined) delete process.env[AKUMA_REQUESTS_ENV];
    else process.env[AKUMA_REQUESTS_ENV] = priorRequests;
    assert.equal(existsSync(pump.directory), false);
    value.close();
  }
});

test("a new body settles old requests by observation without replay", async () => {
  const value = await fixture();
  try {
    const admittedId = "00000000-0000-4000-8000-000000000011";
    admitRequest(value.parent.paths, {
      id: admittedId,
      archetype: "worker",
      body: "never spawned",
      world: value.root,
      recipe: { provider: value.soul.provider, options: value.soul.options, confinement: value.soul.confinement },
      admittedAt: "2026-08-09T00:00:01.000Z",
    });

    const bornId = "00000000-0000-4000-8000-000000000012";
    admitRequest(value.parent.paths, {
      id: bornId, archetype: "worker", body: "born", world: value.root,
      recipe: { provider: value.soul.provider, options: value.soul.options, confinement: value.soul.confinement },
      admittedAt: "2026-08-09T00:00:02.000Z",
    });
    const born = allocateAkumaDirectory({ worldRoot: value.root, archetype: "worker", draw: () => "00000012" });
    initializeHeart(born.paths);
    reserveRequest(value.parent.paths, bornId, born.id);
    const bornLeash = HeldAkumaLeash.try(born.paths)!;
    bornLeash.birth(born.paths, {
      ...value.soul,
      id: born.id,
      archetype: "worker",
      origin: { kind: "request", parent: value.parent.id, requestId: bornId },
    });
    bornLeash.release();

    const unbornId = "00000000-0000-4000-8000-000000000013";
    admitRequest(value.parent.paths, {
      id: unbornId, archetype: "worker", body: "unborn", world: value.root,
      recipe: { provider: value.soul.provider, options: value.soul.options, confinement: value.soul.confinement },
      admittedAt: "2026-08-09T00:00:03.000Z",
    });
    const unborn = allocateAkumaDirectory({ worldRoot: value.root, archetype: "worker", draw: () => "00000013" });
    initializeHeart(unborn.paths);
    reserveRequest(value.parent.paths, unbornId, unborn.id);

    const mismatchId = "00000000-0000-4000-8000-000000000014";
    admitRequest(value.parent.paths, {
      id: mismatchId, archetype: "worker", body: "mismatch", world: value.root,
      recipe: { provider: value.soul.provider, options: value.soul.options, confinement: value.soul.confinement },
      admittedAt: "2026-08-09T00:00:04.000Z",
    });
    const mismatch = allocateAkumaDirectory({ worldRoot: value.root, archetype: "worker", draw: () => "00000014" });
    initializeHeart(mismatch.paths);
    reserveRequest(value.parent.paths, mismatchId, mismatch.id);
    const mismatchLeash = HeldAkumaLeash.try(mismatch.paths)!;
    mismatchLeash.birth(mismatch.paths, {
      ...value.soul,
      id: mismatch.id,
      archetype: "worker",
      origin: { kind: "direct" },
    });
    mismatchLeash.release();

    assert.equal(await settleBodyRequests(
      value.parent.paths,
      value.soul,
      () => "2026-08-09T00:00:04.000Z",
    ), "settled");
    assert.equal(readRequest(value.parent.paths, admittedId)?.state, "voided");
    assert.equal(readRequest(value.parent.paths, bornId)?.state, "served");
    assert.equal(readRequest(value.parent.paths, unbornId)?.state, "voided");
    assert.equal(readRequest(value.parent.paths, mismatchId)?.state, "voided");
    assert.equal(readSeal(unborn.paths)?.evidence, "request settlement");
  } finally {
    value.leash.release();
    value.close();
  }
});
