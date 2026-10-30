import assert from "node:assert/strict";
import test from "node:test";
import { createOpencodeProvider } from "../src/akuma/providers/opencode-sdk/index.js";
import { opencodeFixture } from "./support/opencode-v2.js";

test("OpenCode runtime entry supersedes identity and bare removes only that entry on native resume", async () => {
  const fake = opencodeFixture();
  const provider = createOpencodeProvider({ loader: fake.loader });
  const personality = { systemPrompt: "Keep the personality.", systemPromptMode: "append" as const };
  const finish = async (attempt: ReturnType<typeof provider.start>) => {
    const session = await attempt.result;
    const nativeID = fake.prompts.at(-1)!.body.id;
    fake.admitted(nativeID);
    fake.delivered(nativeID);
    fake.step();
    fake.complete();
    assert.equal((await session.completion).kind, "answered");
    await attempt.closed;
    return session;
  };
  await finish(provider.start({ ...fake.input, options: personality, runtimeInstructions: "<keiyaku>source</keiyaku>" }));
  const resumed = provider.resume!({
    ...fake.input, options: personality, runtimeInstructions: "<keiyaku>child</keiyaku>",
    session: { kind: "resume", coordinate: { sessionId: fake.id } },
  });
  await finish(resumed);
  await finish(provider.resume!({
    ...fake.input, options: personality,
    session: { kind: "resume", coordinate: { sessionId: fake.id } },
  }));
  assert.deepEqual(fake.calls.filter((call) => call.method === "instructions" || call.method === "removeInstruction"), [
    { method: "instructions", value: { id: fake.id, text: personality.systemPrompt } },
    { method: "instructions", value: { id: fake.id, key: "keiyaku.runtime", text: "<keiyaku>source</keiyaku>" } },
    { method: "instructions", value: { id: fake.id, text: personality.systemPrompt } },
    { method: "instructions", value: { id: fake.id, key: "keiyaku.runtime", text: "<keiyaku>child</keiyaku>" } },
    { method: "instructions", value: { id: fake.id, text: personality.systemPrompt } },
    { method: "removeInstruction", value: { id: fake.id, key: "keiyaku.runtime" } },
  ]);
  assert.ok(fake.prompts.every((prompt) => prompt.body.text === "launch"), "system context never becomes user text");
});
