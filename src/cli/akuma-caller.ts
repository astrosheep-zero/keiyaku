import { decodeAkumaCaller, type AkumaCaller } from "../akuma/caller.js";
import { World } from "../world.js";

/** Environment attribution belongs to the process edge, never SDK admission. */
export async function akumaCallerFromEnvironment(environment: NodeJS.ProcessEnv): Promise<AkumaCaller | undefined> {
  const id = environment.KEIYAKU_ACTOR_ID;
  const world = environment.KEIYAKU_ACTOR_WORLD;
  if ((id === undefined) !== (world === undefined)) {
    throw new TypeError("Akuma caller requires both KEIYAKU_ACTOR_ID and KEIYAKU_ACTOR_WORLD");
  }
  if (id !== undefined && world !== undefined) {
    const resolved = await World.resolve({ cwd: world, repositoryRoot: world });
    return decodeAkumaCaller({ kind: "akuma", akuId: id, world: resolved.candidate });
  }
  const external = environment.KEIYAKU_EXTERNAL_CALLER;
  if (external === undefined) return undefined;
  const colon = external.indexOf(":");
  if (colon < 0) throw new TypeError("KEIYAKU_EXTERNAL_CALLER must be <integration>:<id>");
  return decodeAkumaCaller({ kind: "external", integration: external.slice(0, colon), id: external.slice(colon + 1) });
}
