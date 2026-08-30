import { KeiyakuHandle, bindKeiyaku, keiyakuOf, listKeiyaku, observeKeiyaku } from "./contract.js";
import { callKeiyaku, forkKeiyaku } from "./akuma-creation.js";
import { historyAkuma, interruptAkuma, killAkuma, statusAkuma, tellAkuma, waitAkuma } from "./fleet.js";
import { listCatalog } from "./catalog.js";
import { nukeKeiyaku } from "./nuke.js";
import { executionChannel, localExecutionContext, type ExecutionContext } from "../akuma/requests.js";

/** Internal composition root for one immutable execution channel. */
export function composeLibrary(
  context: ExecutionContext = localExecutionContext(),
  composition?: Parameters<typeof bindKeiyaku>[2],
) {
  const captured = Object.freeze({ channel: executionChannel(context) });
  return Object.freeze({
    prototype: KeiyakuHandle.prototype,
    [Symbol.hasInstance]: (value: unknown): boolean => value instanceof KeiyakuHandle,
    bind: (input: Parameters<typeof bindKeiyaku>[0]) => bindKeiyaku(input, captured, composition),
    call: (input: Parameters<typeof callKeiyaku>[0]) => callKeiyaku(input, captured),
    fork: forkKeiyaku,
    history: historyAkuma,
    interrupt: interruptAkuma,
    kill: (input: Parameters<typeof killAkuma>[0]) => killAkuma(input, captured),
    ls: listCatalog,
    nuke: nukeKeiyaku,
    list: listKeiyaku,
    observe: observeKeiyaku,
    of: (input: Parameters<typeof keiyakuOf>[0]) => keiyakuOf(input, captured, composition),
    status: statusAkuma,
    tell: (input: Parameters<typeof tellAkuma>[0]) => tellAkuma(input, captured),
    wait: (input: Parameters<typeof waitAkuma>[0]) => waitAkuma(input, captured),
  });
}
