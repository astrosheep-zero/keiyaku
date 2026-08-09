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
import { AKUMA_REQUESTS_ENV } from "../src/akuma/provider.js";
import {
  AkumaBodyRequestError,
  BodyRequestPump,
  requestBodyCall,
  settleBodyRequests,
} from "../src/akuma/requests.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-requests-"));
  const parent = allocateAkumaDirectory({ worldRoot: root, persona: "parent", draw: () => "1234abcd" });
  initializeHeart(parent.paths);
  const soul: Soul = {
    id: parent.id,
    persona: "parent",
    provider: "codex-app-server",
    options: { access: "write" },
    cwd: root,
    origin: { kind: "direct" },
    confinement: { kind: "declared", writableRoots: [root] },
    contract: "kei/parent-purpose",
    createdAt: "2026-08-09T00:00:00.000Z",
  };
  const leash = HeldAkumaLeash.try(parent.paths)!;
  leash.birth(parent.paths, soul);
  return { root, parent, soul, leash, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("a declared drive serves Body Requests through transport while Heart remains authoritative", async () => {
  const value = fixture();
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
    async spawn(launch) {
      const child = HeldAkumaLeash.try(launch.paths)!;
      child.birth(launch.paths, { ...launch.seed, createdAt: "2026-08-09T00:00:02.000Z" });
      child.release();
      return { pid: 999_991, processGroup: 999_991, spawnedAt: "request-child" };
    },
  });
  try {
    process.env[AKUMA_REQUESTS_ENV] = pump.directory;
    const childId = (await Akuma.at({ path: value.root }).call({
      persona: "worker",
      body: "build",
      contract: "kei/explicit-purpose",
    })).id;
    const origin = readSoul(pathsForAkuId(value.root, childId))?.origin;
    assert.equal(origin?.kind, "request");
    if (origin?.kind !== "request") return;
    const requestId = origin.requestId;
    assert.equal(readRequest(value.parent.paths, requestId)?.state, "served");
    assert.deepEqual(origin, {
      kind: "request",
      parentId: value.parent.id,
      requestId,
    });
    assert.equal(readSoul(pathsForAkuId(value.root, childId))?.contract, "kei/explicit-purpose");

    const unassociated = (await Akuma.at({ path: value.root }).call({ persona: "worker", body: "separate" })).id;
    assert.equal(readSoul(pathsForAkuId(value.root, unassociated))?.contract, undefined);
    delete process.env[AKUMA_REQUESTS_ENV];

    await assert.rejects(requestBodyCall({
      directory: pump.directory,
      id: "00000000-0000-4000-8000-000000000002",
      world: join(value.root, "other"),
      persona: "worker",
      body: "wrong world",
    }), (error: unknown) => error instanceof AkumaBodyRequestError && error.outcome === "refused");
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
  const value = fixture();
  try {
    const admittedId = "00000000-0000-4000-8000-000000000011";
    admitRequest(value.parent.paths, {
      id: admittedId,
      persona: "worker",
      body: "never spawned",
      world: value.root,
      admittedAt: "2026-08-09T00:00:01.000Z",
    });

    const bornId = "00000000-0000-4000-8000-000000000012";
    admitRequest(value.parent.paths, {
      id: bornId, persona: "worker", body: "born", world: value.root,
      admittedAt: "2026-08-09T00:00:02.000Z",
    });
    const born = allocateAkumaDirectory({ worldRoot: value.root, persona: "worker", draw: () => "00000012" });
    initializeHeart(born.paths);
    reserveRequest(value.parent.paths, bornId, born.id);
    const bornLeash = HeldAkumaLeash.try(born.paths)!;
    bornLeash.birth(born.paths, {
      ...value.soul,
      id: born.id,
      persona: "worker",
      origin: { kind: "request", parentId: value.parent.id, requestId: bornId },
    });
    bornLeash.release();

    const unbornId = "00000000-0000-4000-8000-000000000013";
    admitRequest(value.parent.paths, {
      id: unbornId, persona: "worker", body: "unborn", world: value.root,
      admittedAt: "2026-08-09T00:00:03.000Z",
    });
    const unborn = allocateAkumaDirectory({ worldRoot: value.root, persona: "worker", draw: () => "00000013" });
    initializeHeart(unborn.paths);
    reserveRequest(value.parent.paths, unbornId, unborn.id);

    const mismatchId = "00000000-0000-4000-8000-000000000014";
    admitRequest(value.parent.paths, {
      id: mismatchId, persona: "worker", body: "mismatch", world: value.root,
      admittedAt: "2026-08-09T00:00:04.000Z",
    });
    const mismatch = allocateAkumaDirectory({ worldRoot: value.root, persona: "worker", draw: () => "00000014" });
    initializeHeart(mismatch.paths);
    reserveRequest(value.parent.paths, mismatchId, mismatch.id);
    const mismatchLeash = HeldAkumaLeash.try(mismatch.paths)!;
    mismatchLeash.birth(mismatch.paths, {
      ...value.soul,
      id: mismatch.id,
      persona: "worker",
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
