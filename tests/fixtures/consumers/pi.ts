import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerKeiyakuTools } from "@astrosheep/keiyaku/pi";
import { Keiyaku } from "@astrosheep/keiyaku";

declare const pi: ExtensionAPI;
registerKeiyakuTools(pi);
const invocation = Keiyaku.at({
  cwd: "/consumer", environment: {},
  caller: { kind: "external", integration: "pi", id: "current-session" },
});
void invocation;
