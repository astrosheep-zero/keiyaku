import { pluginRuntime, reportPluginDiagnostic } from "./runtime.js";
import type { Settings } from "../settings.js";
import type { WorldRoot } from "../world.js";
import type { PluginSignal } from "./public.js";

type PluginSignalEmission = Readonly<{
  world: WorldRoot;
  settings?: Settings;
  reportDiagnostic: (message: string) => void;
}>;

/**
 * The one producer entry for plugin signals. It owns runtime acquisition, the
 * World Settings fallback, bounded delivery, and failure isolation: a delivery
 * problem reaches the producer only as a diagnostic, never as a thrown error.
 */
export async function emitPluginSignal(emission: PluginSignalEmission, signal: PluginSignal): Promise<void> {
  try {
    const runtime = await pluginRuntime({
      world: emission.world,
      ...(emission.settings === undefined ? {} : { settings: emission.settings }),
      reportDiagnostic: emission.reportDiagnostic,
    });
    await runtime.emit(signal, emission.reportDiagnostic);
  } catch (error) {
    reportPluginDiagnostic(emission.reportDiagnostic, "runtime", "signal", error);
  }
}
