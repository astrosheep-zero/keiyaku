import { appendFileSync } from "node:fs";

const endpoint = "https://fixture.invalid/v1/chat/completions";
const receiptPath = process.env.KEIYAKU_TEST_OPENAI_COMPLETION_RECEIPT;
if (receiptPath === undefined || receiptPath.length === 0) {
  throw new Error("missing KEIYAKU_TEST_OPENAI_COMPLETION_RECEIPT");
}

const chunks = [
  `data: ${JSON.stringify({
    id: "fixture-completion",
    object: "chat.completion.chunk",
    created: 0,
    model: "fixture-chat",
    choices: [{ index: 0, delta: { role: "assistant", content: "fixture answer" }, finish_reason: null }],
  })}\n\n`,
  `data: ${JSON.stringify({
    id: "fixture-completion",
    object: "chat.completion.chunk",
    created: 0,
    model: "fixture-chat",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  })}\n\n`,
  "data: [DONE]\n\n",
];

let requests = 0;
const encoder = new TextEncoder();
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (request.method !== "POST" || request.url !== endpoint) {
    throw new Error(`unexpected fixture fetch request: ${request.method} ${request.url}`);
  }
  requests += 1;
  if (requests !== 1) throw new Error(`fixture fetch received more than one request: ${requests}`);
  appendFileSync(receiptPath, "request\n", "utf8");

  let index = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (index === chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index++]));
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
};
