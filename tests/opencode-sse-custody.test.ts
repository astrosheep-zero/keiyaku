import assert from "node:assert/strict";
import test from "node:test";
import { createProviderAttempt } from "../src/akuma/provider.js";
import type { RuntimeOpener } from "../src/akuma/providers/opencode-sdk/session.js";
import { json, nativeEndpoint, nativeInfo, sse } from "./support/opencode-v2.js";
import { isolateUserHome } from "./support/user-home.js";

isolateUserHome();

const recipe = { name: "opencode-sdk", kind: "opencode-sdk" } as const;
function openRuntime(open: RuntimeOpener, cwd = "/tmp", execution: Parameters<RuntimeOpener>[0]["execution"] = recipe) {
  return createProviderAttempt(undefined, (custody) => open({ execution, cwd, signal: custody.signal, custody }));
}

test("OpenCode v2 HTML and foreign JSON cannot satisfy native readiness", async (t) => {
  const requests: string[] = [];
  const native = nativeEndpoint(t, (request, response) => {
    requests.push(request.url!);
    if (requests.length === 1) {
      response.writeHead(200, { "content-type": "text/html" });
      return void response.end("<html>app</html>");
    }
    if (requests.length === 2) return json(response, { data: [] });
    if (request.url === "/api/info") return json(response, nativeInfo);
    response.writeHead(200, { "content-type": "text/event-stream" });
    sse(response, { type: "server.connected", data: {} });
  });
  const attempt = openRuntime(native.open);
  await attempt.result;
  assert.deepEqual(requests, ["/api/info", "/api/info", "/api/info", "/api/event"]);
  await attempt.forceDispose();
  await attempt.closed;
  await native.retired();
});
