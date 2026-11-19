import assert from "node:assert/strict";
import test from "node:test";
import { createOpencodeProvider } from "../src/akuma/providers/opencode-sdk/index.js";
import { opencodeFixture } from "./support/opencode-v2.js";

test("OpenCode runtime entry supersedes identity and bare removes only that entry on native resume", async (t) => {
  const native = opencodeFixture(t);
  const provider = createOpencodeProvider(undefined, native.open);
  const personality = { systemPrompt: "Keep the personality.", systemPromptMode: "append" as const };
  const finish = async (attempt: ReturnType<typeof provider.start>) => {
    const session = await attempt.result;
    const nativeID = native.prompts.at(-1)!.body.id;
    native.admitted(nativeID);
    native.delivered(nativeID);
    native.step();
    native.complete();
    assert.equal((await session.completion).kind, "answered");
    await attempt.closed;
    await native.retired();
  };
  await finish(
    provider.start({ ...native.input, options: personality, runtimeInstructions: "<keiyaku>source</keiyaku>" }),
  );
  await finish(
    provider.resume!({
      ...native.input,
      options: personality,
      runtimeInstructions: "<keiyaku>child</keiyaku>",
      session: { kind: "resume", coordinate: { sessionId: native.id } },
    }),
  );
  await finish(
    provider.resume!({
      ...native.input,
      options: personality,
      session: { kind: "resume", coordinate: { sessionId: native.id } },
    }),
  );
  const system = {
    method: "PUT",
    path: `${native.instructionsPath}/keiyaku.system`,
    body: { value: personality.systemPrompt },
  };
  const runtime = `${native.instructionsPath}/keiyaku.runtime`;
  assert.deepEqual(
    native.calls.filter((call) => call.path.startsWith(native.instructionsPath)),
    [
      system,
      { method: "PUT", path: runtime, body: { value: "<keiyaku>source</keiyaku>" } },
      system,
      { method: "PUT", path: runtime, body: { value: "<keiyaku>child</keiyaku>" } },
      system,
      { method: "DELETE", path: runtime },
    ],
  );
  assert.ok(
    native.prompts.every((prompt) => prompt.body.text === "launch"),
    "system context never becomes user text",
  );
});
