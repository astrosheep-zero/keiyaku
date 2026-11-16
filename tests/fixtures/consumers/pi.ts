import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerKeiyakuTools } from "@astrosheep/keiyaku/pi";
import { Keiyaku, type KeiyakuFor } from "@astrosheep/keiyaku";
import { harnessOwner } from "@astrosheep/square";

declare const pi: ExtensionAPI;
registerKeiyakuTools(pi);
const context: KeiyakuFor = {
  cwd: "/consumer", environment: {},
  identity: { owner: harnessOwner({ channel: "pi", session: "current-session" }) },
};
const invocation = Keiyaku.for(context);
void invocation;
