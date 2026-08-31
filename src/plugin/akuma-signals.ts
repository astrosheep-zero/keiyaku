import { pluginRuntime } from "./runtime.js";
import type { Settings } from "../settings.js";
import type { WorldRoot } from "../world.js";

type CalledPluginSignalInput = Readonly<{
  world: WorldRoot;
  settings?: Settings;
  reportDiagnostic: (message: string) => void;
  akumaId: string;
  callerAkumaId?: string;
  contractId?: string;
}>;

export async function emitCalledPluginSignal(input: CalledPluginSignalInput): Promise<void> {
  const runtime = await pluginRuntime({
    world: input.world,
    ...(input.settings === undefined ? {} : { settings: input.settings }),
    reportDiagnostic: input.reportDiagnostic,
  });
  runtime.emit(
    {
      kind: "akuma.called",
      akumaId: input.akumaId,
      ...(input.callerAkumaId === undefined ? {} : { callerAkumaId: input.callerAkumaId }),
      ...(input.contractId === undefined ? {} : { contractId: input.contractId }),
    },
    input.reportDiagnostic,
  );
}
