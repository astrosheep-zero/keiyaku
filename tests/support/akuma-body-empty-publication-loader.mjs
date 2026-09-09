const marker = "const supervisor = await BodySupervisor.open(launch.paths, body.sequence, leash);";
const injected = `
import { existsSync as __keiyakuBarrierExists, watch as __keiyakuBarrierWatch, writeFileSync as __keiyakuBarrierWrite } from "node:fs";
import { join as __keiyakuBarrierJoin } from "node:path";

async function __keiyakuAwaitEmptyPublicationBarrier(launch) {
  const barrier = process.env.KEIYAKU_TEST_AKUMA_BODY_EMPTY_PUBLICATION_BARRIER;
  if (launch.seed === undefined || launch.initialBody !== undefined || typeof barrier !== "string") return;
  const release = __keiyakuBarrierJoin(barrier, "release");
  if (__keiyakuBarrierExists(release)) return;
  await new Promise((resolve, reject) => {
    const watcher = __keiyakuBarrierWatch(barrier, (_event, filename) => {
      if (filename === "release") {
        watcher.close();
        resolve();
      }
    });
    watcher.once("error", reject);
    __keiyakuBarrierWrite(__keiyakuBarrierJoin(barrier, "ready"), JSON.stringify({ id: launch.seed.id, pid: process.pid }) + "\\n");
    if (__keiyakuBarrierExists(release)) {
      watcher.close();
      resolve();
    }
  });
}
`;

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith("/src/akuma/body.ts")) return loaded;
  const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
  if (!source.includes(marker)) throw new Error("Akuma Body test barrier could not find the empty publication boundary");
  return {
    ...loaded,
    source: `${injected}\n${source.replace(marker, `await __keiyakuAwaitEmptyPublicationBarrier(launch);\n    ${marker}`)}`,
  };
}
