import { pluginRuntime, reportPluginDiagnostic } from "./runtime.js";
import type { Settings } from "../settings.js";
import type { WorldRoot } from "../world.js";
import type { PluginSignal } from "./public.js";

/** The local library observation default; CLI and Body supply their own sinks. */
export function stderrPluginDiagnostic(message: string): void {
  console.error(message);
}

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

export async function withAkumaWaitDeferrals<T>(
  emission: PluginSignalEmission,
  akumaIds: readonly string[],
  signal: AbortSignal | undefined,
  action: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  let runtime;
  try {
    runtime = await pluginRuntime({
      world: emission.world,
      ...(emission.settings === undefined ? {} : { settings: emission.settings }),
      reportDiagnostic: emission.reportDiagnostic,
    });
  } catch (error) {
    signal?.throwIfAborted();
    reportPluginDiagnostic(emission.reportDiagnostic, "runtime", "wait deferral", error);
    return await action();
  }
  return await runtime.withWaitDeferrals(akumaIds, signal, action, emission.reportDiagnostic);
}

/** One public observer operation, never shared with incidental owner reads. */
export function outcomePluginObserver(emission: PluginSignalEmission, observer?: string) {
  const seen = new Set<string>();
  return async (akumaId: string, historyIds: readonly string[]): Promise<void> => {
    const fresh = historyIds.filter((historyId) => {
      const key = `${akumaId}:${historyId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    await Promise.all(
      fresh.map(
        async (historyId) =>
          await emitPluginSignal(emission, {
            kind: "akuma.outcome-observed",
            akumaId,
            historyId,
            ...(observer === undefined ? {} : { observer }),
          }),
      ),
    );
  };
}
