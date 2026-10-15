import { z } from "zod";
import type { CommandResult } from "./keiyaku.js";

/**
 * One Stop attempt's honest verdict. Only `stopped` proves the Akuma's current
 * execution settled; `not-stopped` carries the public CLI's own refusal or
 * failure diagnostic, and `uncertain` admits that no decided answer exists —
 * a timeout or lost receipt never proves either outcome.
 */
export type StopAttempt =
  | Readonly<{ kind: "stopped" }>
  | Readonly<{ kind: "not-stopped"; message: string }>
  | Readonly<{ kind: "uncertain"; message: string }>;

const settledEvidence = new Set(["killed", "already-killed", "already-stopped"]);
const killReceipt = z.object({ results: z.array(z.object({ id: z.string(), evidence: z.string() })) });

function parseReceipt(stdout: string): z.infer<typeof killReceipt> | undefined {
  try {
    const parsed = killReceipt.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Interpret one `keiyaku kill <aku> --json` result against its public receipt and actual exit status. */
export function decodeStop(result: CommandResult, akuId: string): StopAttempt {
  const receipt = parseReceipt(result.stdout);
  const member = receipt?.results.find((entry) => entry.id === akuId);
  if (receipt !== undefined && member === undefined)
    return { kind: "uncertain", message: `Keiyaku stop receipt did not name ${akuId} (exit ${result.code})` };
  if (member !== undefined) {
    if (!settledEvidence.has(member.evidence))
      return { kind: "not-stopped", message: `Keiyaku reported ${member.evidence} for ${akuId}` };
    return result.code === 0
      ? { kind: "stopped" }
      : { kind: "uncertain", message: `Keiyaku reported ${member.evidence} for ${akuId} with exit ${result.code}` };
  }
  const diagnostic = result.stderr.trim() || result.stdout.trim();
  if (result.code === 0)
    return {
      kind: "uncertain",
      message: diagnostic === "" ? "Keiyaku reported no stop receipt" : `Keiyaku reported no stop receipt: ${diagnostic}`,
    };
  return diagnostic === ""
    ? { kind: "uncertain", message: `Keiyaku kill exited ${result.code}` }
    : { kind: "not-stopped", message: diagnostic };
}
