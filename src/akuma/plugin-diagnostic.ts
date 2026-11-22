import { appendFile } from "node:fs/promises";
import { boundedDiagnostic } from "../settings.js";
import type { AkumaPaths } from "./identity.js";

export async function recordPluginDiagnostic(paths: AkumaPaths, occurrence: string, error: unknown): Promise<void> {
  try {
    await appendFile(paths.log, `plugin ${occurrence} failed: ${boundedDiagnostic(error)}\n`);
  } catch {
    /* plugin diagnostic loss never changes product truth */
  }
}
