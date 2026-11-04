import { harnessOwner, type Owner } from "@astrosheep/square";

/** Select attribution at the submitting edge; no host or artifact lookup. */
export function deliveryOwner(environment: NodeJS.ProcessEnv): Owner | undefined {
  const explicit = environment.KEIYAKU_INITIATOR?.trim();
  if (explicit) return explicit as Owner;
  if (environment.CLAUDE_CODE_CHILD_SESSION === "1") return undefined;
  const coordinates = [
    ["CLAUDE_CODE_SESSION_ID", "claude-code"],
    ["CODEX_THREAD_ID", "codex"],
    ["OPENCODE_SESSION_ID", "opencode"],
    ["PI_SESSION_ID", "pi"],
  ].flatMap(([variable, channel]) => {
    const session = environment[variable!]?.trim();
    return session ? [{ channel: channel!, session }] : [];
  });
  if (coordinates.length > 1) return undefined;
  const paseo = environment.PASEO_AGENT_ID?.trim();
  const coordinate = coordinates[0] ?? (paseo ? { channel: "paseo", session: paseo } : undefined);
  return coordinate === undefined ? undefined : harnessOwner(coordinate);
}
