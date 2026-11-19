const marker = "await runBodyTurns({";
const idleMarker = "const finished = await finishBodyIfIdle(launch.paths, { sequence: bodySequence, at: runtime.now() });";
const observationMarker = "await this.refresh();";
const injected = `
import { existsSync as __keiyakuBarrierExists, renameSync as __keiyakuBarrierRename, writeFileSync as __keiyakuBarrierWrite } from "node:fs";
import { setInterval as __keiyakuBarrierPoll } from "node:timers/promises";
import { join as __keiyakuBarrierJoin } from "node:path";

// The fixture owns this wait, including cancellation and disappearance of its directory.
async function __keiyakuAwaitBarrier(barrier, releaseName, announce, ownerSignal) {
  if (typeof barrier !== "string") return;
  const release = __keiyakuBarrierJoin(barrier, releaseName);
  const waiting = () => __keiyakuBarrierExists(barrier) && !__keiyakuBarrierExists(release);
  if (!waiting() || ownerSignal?.aborted) return;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("Akuma fixture barrier expired: " + barrier)), 60_000);
  const signal = ownerSignal === undefined ? deadline.signal : AbortSignal.any([ownerSignal, deadline.signal]);
  const poll = __keiyakuBarrierPoll(25, undefined, { signal });
  let announced = false;
  try {
    for await (const _ of poll) {
      if (!waiting()) return;
      if (!announced) {
        announce();
        announced = true;
      }
    }
  } catch (error) {
    if (!ownerSignal?.aborted) throw deadline.signal.aborted ? deadline.signal.reason : error;
  } finally {
    clearTimeout(timer);
    await poll.return();
  }
}

async function __keiyakuAwaitEmptyPublicationBarrier(launch, signal) {
  const barrier = process.env.KEIYAKU_TEST_AKUMA_BODY_EMPTY_PUBLICATION_BARRIER;
  if (launch.seed === undefined) return;
  await __keiyakuAwaitBarrier(barrier, "release", () => {
    const ready = __keiyakuBarrierJoin(barrier, "ready");
    __keiyakuBarrierWrite(ready + ".tmp", JSON.stringify({ id: launch.seed.id, pid: process.pid }) + "\\n");
    __keiyakuBarrierRename(ready + ".tmp", ready);
  }, signal);
}

async function __keiyakuAwaitIdleFinishBarrier(signal) {
  const barrier = process.env.KEIYAKU_TEST_AKUMA_BODY_IDLE_FINISH_BARRIER;
  await __keiyakuAwaitBarrier(barrier, "release", () => {
    __keiyakuBarrierWrite(__keiyakuBarrierJoin(barrier, "idle-ready"), "ready\\n");
  }, signal);
}

async function __keiyakuAwaitPeriodicObservationBarrier(signal) {
  const barrier = process.env.KEIYAKU_TEST_AKUMA_BODY_IDLE_FINISH_BARRIER;
  await __keiyakuAwaitBarrier(barrier, "observation-release", () => {
    __keiyakuBarrierWrite(__keiyakuBarrierJoin(barrier, "observation-ready"), "ready\\n");
  }, signal);
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
        .replace(marker, `await __keiyakuAwaitEmptyPublicationBarrier(launch, supervisor.signal);\n    ${marker}`)
        .replace(idleMarker, `await __keiyakuAwaitIdleFinishBarrier(supervisor.signal);\n      if (supervisor.signal.aborted) continue;\n      ${idleMarker}`)}`,
    };
  }
  if (!source.includes(observationMarker)) throw new Error("Akuma Body test barrier could not find periodic observation");
  return {
    ...loaded,
    source: `${injected}\n${source.replace(
      observationMarker,
      `await __keiyakuAwaitPeriodicObservationBarrier(AbortSignal.any([this.signal, this.finished.signal]));\n      if (this.signal.aborted || this.finished.signal.aborted) return;\n      ${observationMarker}`,
    )}`,
  };
}
