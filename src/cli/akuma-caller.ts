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
  const hosts = [
    { integration: "codex", id: environment.CODEX_THREAD_ID },
    { integration: "pi", id: environment.PI_SESSION_ID },
    { integration: "claude", id: environment.CLAUDE_CODE_SESSION_ID },
  ].filter(({ id }) => id !== undefined && id !== "");
  if (hosts.length > 1) {
    throw new TypeError(`Ambiguous native host caller: ${hosts.map(({ integration }) => integration).join(", ")}`);
  }
  if (hosts[0]) return decodeAkumaCaller({ kind: "external", ...hosts[0] });
  const external = environment.KEIYAKU_EXTERNAL_CALLER;
  if (external === undefined) return undefined;
  const colon = external.indexOf(":");
  if (colon < 0) throw new TypeError("KEIYAKU_EXTERNAL_CALLER must be <integration>:<id>");
  return decodeAkumaCaller({ kind: "external", integration: external.slice(0, colon), id: external.slice(colon + 1) });
}
