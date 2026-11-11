const marker = "pendingTellDisposition = await runBodyTurns({";
const idleMarker = "const finished = await finishBodyIfIdle(launch.paths, { sequence: bodySequence, at: runtime.now() });";
const observationMarker = "await this.refresh();";
const injected = `
import { existsSync as __keiyakuBarrierExists, renameSync as __keiyakuBarrierRename, writeFileSync as __keiyakuBarrierWrite } from "node:fs";
import { setInterval as __keiyakuBarrierPoll } from "node:timers/promises";
import { join as __keiyakuBarrierJoin } from "node:path";

// Announce readiness after the first poll reads the durable release predicate.
async function __keiyakuAwaitEmptyPublicationBarrier(launch) {
  const barrier = process.env.KEIYAKU_TEST_AKUMA_BODY_EMPTY_PUBLICATION_BARRIER;
  if (launch.seed === undefined || launch.initialBody !== undefined || typeof barrier !== "string") return;
  const release = __keiyakuBarrierJoin(barrier, "release");
  if (__keiyakuBarrierExists(release)) return;
  let announced = false;
  for await (const _ of __keiyakuBarrierPoll(25)) {
    if (__keiyakuBarrierExists(release)) return;
    if (!announced) {
      const ready = __keiyakuBarrierJoin(barrier, "ready");
      __keiyakuBarrierWrite(ready + ".tmp", JSON.stringify({ id: launch.seed.id, pid: process.pid }) + "\\n");
      __keiyakuBarrierRename(ready + ".tmp", ready);
      announced = true;
    }
  }
}

async function __keiyakuAwaitIdleFinishBarrier() {
  const barrier = process.env.KEIYAKU_TEST_AKUMA_BODY_IDLE_FINISH_BARRIER;
  if (typeof barrier !== "string") return;
  const release = __keiyakuBarrierJoin(barrier, "release");
  if (__keiyakuBarrierExists(release)) return;
  let announced = false;
  for await (const _ of __keiyakuBarrierPoll(25)) {
    if (__keiyakuBarrierExists(release)) return;
    if (!announced) {
      __keiyakuBarrierWrite(__keiyakuBarrierJoin(barrier, "idle-ready"), "ready\\n");
      announced = true;
    }
  }
}

async function __keiyakuAwaitPeriodicObservationBarrier() {
  const barrier = process.env.KEIYAKU_TEST_AKUMA_BODY_IDLE_FINISH_BARRIER;
  if (typeof barrier !== "string") return;
  const release = __keiyakuBarrierJoin(barrier, "observation-release");
  if (__keiyakuBarrierExists(release)) return;
  let announced = false;
  for await (const _ of __keiyakuBarrierPoll(25)) {
    if (__keiyakuBarrierExists(release)) return;
    if (!announced) {
      __keiyakuBarrierWrite(__keiyakuBarrierJoin(barrier, "observation-ready"), "ready\\n");
      announced = true;
    }
  }
}
`;

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  const bodyModule = /\/src\/akuma\/body\.(?:js|ts)$/u.test(url);
  const supervisorModule = /\/src\/akuma\/body-supervisor\.(?:js|ts)$/u.test(url);
  if (!bodyModule && !supervisorModule) return loaded;
  const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
  if (bodyModule) {
    if (!source.includes(marker) || !source.includes(idleMarker))
      throw new Error("Akuma Body test barrier could not find its lifecycle boundaries");
    return {
      ...loaded,
      source: `${injected}\n${source
        .replace(marker, `await __keiyakuAwaitEmptyPublicationBarrier(launch);\n    ${marker}`)
        .replace(idleMarker, `await __keiyakuAwaitIdleFinishBarrier();\n      ${idleMarker}`)}`,
    };
  }
  if (!source.includes(observationMarker)) throw new Error("Akuma Body test barrier could not find periodic observation");
  return {
    ...loaded,
    source: `${injected}\n${source.replace(
      observationMarker,
      `await __keiyakuAwaitPeriodicObservationBarrier();\n      ${observationMarker}`,
    )}`,
  };
}
