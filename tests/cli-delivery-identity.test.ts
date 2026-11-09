import assert from "node:assert/strict";
import test from "node:test";
import { harnessOwner } from "@astrosheep/square";
import { akumaExecutionEnvironment } from "../src/akuma/providers/execution-environment.js";
import { deliveryOwner } from "../src/library/keiyaku-attribution.js";

test("one native coordinate selects its host Owner, ahead of Paseo", () => {
  for (const [variable, channel] of [
    ["CLAUDE_CODE_SESSION_ID", "claude-code"],
    ["CODEX_THREAD_ID", "codex"],
    ["OPENCODE_SESSION_ID", "opencode"],
    ["PI_SESSION_ID", "pi"],
  ] as const) {
    assert.equal(
      deliveryOwner({ [variable]: "session", PASEO_AGENT_ID: "fallback" }),
      harnessOwner({ channel, session: "session" }),
    );
  }
  assert.equal(deliveryOwner({ PASEO_AGENT_ID: "managed" }), harnessOwner({ channel: "paseo", session: "managed" }));
});

test("explicit opaque initiator wins; absent and ambiguous coordinates select nothing", () => {
  assert.equal(
    deliveryOwner({ KEIYAKU_INITIATOR: "  custom:opaque  ", PI_SESSION_ID: "one", CODEX_THREAD_ID: "two" }),
    "custom:opaque",
  );
  assert.equal(
    deliveryOwner({ KEIYAKU_INITIATOR: "  ", PI_SESSION_ID: "one" }),
    harnessOwner({ channel: "pi", session: "one" }),
  );
  assert.equal(deliveryOwner({ PI_SESSION_ID: "one", CODEX_THREAD_ID: "two", PASEO_AGENT_ID: "fallback" }), undefined);
  assert.equal(deliveryOwner({ CLAUDE_CODE_CHILD_SESSION: "1", PASEO_AGENT_ID: "fallback" }), undefined);
  assert.equal(deliveryOwner({}), undefined);
});

test("a child execution does not inherit its parent host or initiator", () => {
  const child = akumaExecutionEnvironment(
    {
      PI_SESSION_ID: "parent-session",
      KEIYAKU_INITIATOR: "parent-owner",
      KEIYAKU_EXTERNAL_CALLER: "paseo:parent",
      PATH: "/usr/bin",
    },
    {},
  );
  assert.equal(child.PI_SESSION_ID, undefined);
  assert.equal(child.KEIYAKU_INITIATOR, undefined);
  assert.equal(child.KEIYAKU_EXTERNAL_CALLER, undefined);
  assert.equal(child.PATH, "/usr/bin");
});
