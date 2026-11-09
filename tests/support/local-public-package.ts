import { registerHooks } from "node:module";

// Observer workspaces otherwise resolve the primary checkout through shared
// node_modules. Exercise this worktree's built public entry, never private APIs.
const entry = new URL(
  import.meta.url.endsWith(".js") ? "../../../build/src/index.js" : "../../build/src/index.js",
  import.meta.url,
).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "@astrosheep/keiyaku"
      ? { url: entry, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
