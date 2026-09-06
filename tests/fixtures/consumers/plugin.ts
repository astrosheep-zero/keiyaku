import type {
  KeiyakuPlugin as RootPlugin,
  PluginContext as RootContext,
  PluginHooks as RootHooks,
  PluginSignal as RootSignal,
} from "@astrosheep/keiyaku";
import type { KeiyakuPlugin, PluginContext, PluginHooks, PluginSignal } from "@astrosheep/keiyaku/plugin";
import squarePlugin from "@astrosheep/keiyaku-plugin-square";
const rootPlugin = null as unknown as RootPlugin;
const plugin: KeiyakuPlugin = rootPlugin;
const rootContext = null as unknown as RootContext;
const context: PluginContext = rootContext;
const rootSignal = null as unknown as RootSignal;
const signal: PluginSignal = rootSignal;
const hooks: PluginHooks = {
  "akuma.turn-outcome": (turn) => {
    turn.turnSequence.toFixed();
    if (turn.outcome.kind === "answered") turn.outcome.text.toUpperCase();
    else turn.outcome.reason.toUpperCase();
  },
};
const rootHooks = hooks as RootHooks;
const installedPlugin: RootPlugin = squarePlugin;
void plugin;
void context;
void signal;
void rootHooks;
void installedPlugin;
