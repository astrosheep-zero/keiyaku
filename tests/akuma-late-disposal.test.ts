import assert from "node:assert/strict";
import test from "node:test";
import { abortable, awaitLateDisposal } from "../src/akuma/abort.js";

test("late provider disposal remains owned and its rejection is observable", async () => {
  const controller = new AbortController();
  let resolveResource!: (value: { dispose(): Promise<void> }) => void;
  const resource = new Promise<{ dispose(): Promise<void> }>((resolve) => {
    resolveResource = resolve;
  });
  const operation = abortable(resource, controller.signal, (value) => value.dispose());
  const disposal = awaitLateDisposal(controller.signal);
  controller.abort(new Error("cancelled before admission"));
  await assert.rejects(operation, /cancelled before admission/u);

  resolveResource({
    dispose: async () => {
      throw new Error("late dispose failed");
    },
  });
  await assert.rejects(disposal, /late dispose failed/u);
});

test("late provider operation rejection settles custody after abort", async () => {
  const controller = new AbortController();
  let rejectResource!: (error: unknown) => void;
  const resource = new Promise<never>((_resolve, reject) => {
    rejectResource = reject;
  });
  const operation = abortable(resource, controller.signal, () => undefined);
  const disposal = awaitLateDisposal(controller.signal);
  controller.abort(new Error("cancelled before admission"));
  await assert.rejects(operation, /cancelled before admission/u);
  rejectResource(new Error("resource failed after abort"));
  await disposal;
});
