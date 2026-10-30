import assert from "node:assert/strict";
import test from "node:test";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { DriveInput, ProviderAttempt, Session } from "../src/akuma/provider.js";
import { createClaudeProvider } from "../src/akuma/providers/claude/index.js";

const SOURCE = "<keiyaku>\nsource identity\n</keiyaku>";
const CHILD = "<keiyaku>\nchild identity\n</keiyaku>";
const CLEAR = "Any inherited Keiyaku execution context is inactive for this execution.";

function claudeFixture() {
  const options: Options[] = [];
  const prompts: SDKUserMessage[] = [];
  const provider = createClaudeProvider(async () => ({
    async forkSession() {
      return { sessionId: "child-session" };
    },
    query(input) {
      options.push(input.options!);
      return (async function* () {
        const prompt = input.prompt as AsyncIterable<SDKUserMessage>;
        const iterator = prompt[Symbol.asyncIterator]();
        const first = await iterator.next();
        assert.equal(first.done, false);
        prompts.push(first.value!);
        void iterator.next();
        yield { type: "system", subtype: "init", session_id: "native-session" } as SDKMessage;
        yield {
          type: "result", subtype: "success", session_id: "native-session", result: "done",
        } as SDKMessage;
      })() as Query;
    },
  }));
  return { provider, options, prompts };
}

async function finish(attempt: ProviderAttempt<Session>): Promise<void> {
  const session = await attempt.result;
  assert.equal((await session.completion).kind, "answered");
  await attempt.closed;
}

test("Claude native system options replace runtime identity across start, fork resume, and bare resume", async () => {
  for (const mode of ["append", "replace"] as const) {
    const fake = claudeFixture();
    const personality = Object.freeze({ systemPrompt: "Keep the personality.", systemPromptMode: mode });
    const input: DriveInput & { session: { kind: "fresh" } } = {
      body: "work", launchTells: [], cwd: "/tmp", options: personality,
      signal: new AbortController().signal, requests: { dir: "/tmp/requests" },
      session: { kind: "fresh" }, runtimeInstructions: SOURCE,
    };
    await finish(fake.provider.start(input));
    const fork = fake.provider.fork!({ session: { sessionId: "source-session" }, at: "answer", cwd: "/tmp" });
    const child = await fork.result;
    await fork.closed;
    const resumed = { ...input, session: { kind: "resume" as const, coordinate: child.session } };
    await finish(fake.provider.resume!({ ...resumed, runtimeInstructions: CHILD }));
    await finish(fake.provider.resume!({ ...resumed, runtimeInstructions: CLEAR }));

    const expected = (runtime?: string) => {
      const text = [personality.systemPrompt, ...(runtime === undefined ? [] : [runtime])].join("\n\n");
      return mode === "replace" ? text : { type: "preset", preset: "claude_code", append: text };
    };
    assert.deepEqual(fake.options.map((options) => options.systemPrompt), [expected(SOURCE), expected(CHILD), expected(CLEAR)]);
    assert.equal(fake.options[1]!.resume, "child-session");
    assert.deepEqual(fake.prompts.map((prompt) => prompt.message.content), ["work", "work", "work"]);
    assert.deepEqual(personality, { systemPrompt: "Keep the personality.", systemPromptMode: mode });
  }
});

test("Claude runtime-only bare fork supersedes inherited context without replacing the native preset", async () => {
  const fake = claudeFixture();
  const input: DriveInput & { session: { kind: "fresh" } } = {
    body: "work", launchTells: [], cwd: "/tmp", options: {},
    signal: new AbortController().signal, requests: { dir: "/tmp/requests" },
    session: { kind: "fresh" }, runtimeInstructions: SOURCE,
  };
  await finish(fake.provider.start(input));
  await finish(fake.provider.resume!({
    ...input,
    runtimeInstructions: CLEAR,
    session: { kind: "resume", coordinate: { sessionId: "child-session" } },
  }));
  assert.deepEqual(fake.options.map((options) => options.systemPrompt), [
    { type: "preset", preset: "claude_code", append: SOURCE },
    { type: "preset", preset: "claude_code", append: CLEAR },
  ]);
});
