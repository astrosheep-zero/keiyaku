import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import keiyakuExtension from "../integrations/pi/keiyaku.js";

type Handler = (event: unknown, context: ExtensionContext) => unknown;

test("Pi resident refresh never blocks startup or tool turns", async () => {
  const handlers = new Map<string, Handler>();
  const widgets: string[][] = [];
  let execCalls = 0;
  let finishExec: ((result: { stdout: string; stderr: string; code: number; killed: boolean }) => void) | undefined;
  const execResult = new Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>((resolve) => {
    finishExec = resolve;
  });
  const pi = {
    on(event: string, handler: Handler): void {
      handlers.set(event, handler);
    },
    registerCommand(): void {},
    exec(): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
      execCalls++;
      return execResult;
    },
  } as unknown as ExtensionAPI;
  const context = {
    hasUI: true,
    ui: {
      setWidget(_id: string, lines: string[]): void {
        widgets.push(lines);
      },
    },
  } as unknown as ExtensionContext;

  keiyakuExtension(pi);

  assert.equal(handlers.has("turn_end"), false);
  assert.equal(handlers.has("agent_end"), true);
  assert.equal(handlers.get("session_start")?.({}, context), undefined);
  assert.equal(handlers.get("agent_end")?.({}, context), undefined);
  assert.equal(execCalls, 1);

  finishExec?.({
    stdout: JSON.stringify({
      contracts: { kind: "present", value: { rows: [] } },
      akuma: { kind: "present", value: { rows: [] } },
      tasks: { kind: "present", value: { rows: [] } },
    }),
    stderr: "",
    code: 0,
    killed: false,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(widgets, [["Keiyaku · 0 contracts · 0 fleet · 0 tasks"]]);
});
