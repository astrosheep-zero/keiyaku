import type { ProviderConfigState } from "@getpaseo/plugin/server/provider";

/** A mirror reports the public Akuma configuration; it cannot change it. */
export function modelConfig(status: { provider?: string; model?: string }): ProviderConfigState {
  return {
    ...(status.model === undefined ? {} : { model: status.model }),
    models: status.model === undefined ? [] : [{
      id: status.model,
      label: status.provider ? `${status.provider} / ${status.model}` : status.model,
      isSelectable: false,
    }],
    modes: [], thinkingOptions: [], settings: [],
  };
}
