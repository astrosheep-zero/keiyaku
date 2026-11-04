import type {
  KeiyakuPlugin as RootPlugin,
  PluginContext as RootContext,
  PluginHooks as RootHooks,
  PluginSignal as RootSignal,
  PluginWaitDeferralInput as RootWaitInput,
} from "@astrosheep/keiyaku";
import type { KeiyakuPlugin, PluginContext, PluginHooks, PluginSignal, PluginWaitDeferralInput } from "@astrosheep/keiyaku/plugin";
import squarePlugin from "@astrosheep/keiyaku-plugin-square";
const rootPlugin = null as unknown as RootPlugin;
const plugin: KeiyakuPlugin = rootPlugin;
const rootContext = null as unknown as RootContext;
const context: PluginContext = rootContext;
const rootSignal = null as unknown as RootSignal;
const signal: PluginSignal = rootSignal;
const hooks: PluginHooks = {
  "akuma.outcome-observed": (observed) => {
    observed.akumaId.toUpperCase();
    observed.historyId.toUpperCase();
    observed.observer?.toUpperCase();
    // @ts-expect-error Outcome observation carries no answer body.
    observed.outcome;
  },
  "akuma.turn-outcome": (turn) => {
    turn.turnSequence.toFixed();
    if (turn.outcome.kind === "answered") turn.outcome.text.toUpperCase();
    else if (turn.outcome.kind === "failed") turn.outcome.reason.toUpperCase();
    else {
      const canceled: "canceled" = turn.outcome.kind;
      void canceled;
      // @ts-expect-error Cancellation carries no failure diagnostic.
      turn.outcome.reason;
    }
  },
};
const rootHooks = hooks as RootHooks;
const callWait: RootWaitInput = { akumaIds: ["aku/worker/1234abcd"] };
const waitInput: PluginWaitDeferralInput = callWait;
waitInput.akumaIds.forEach(id => id.toUpperCase());
const observingPlugin: RootPlugin = {
  manifest: { id: "consumer", apiVersion: 1 },
  activate() {
    return {
      signals: hooks,
      waitDeferral(input) {
        input.akumaIds.forEach(id => id.toUpperCase());
        return { close() {} };
      },
    };
  },
};
void observingPlugin;
const installedPlugin: RootPlugin = squarePlugin;
void plugin;
void context;
void signal;
void rootHooks;
void installedPlugin;
