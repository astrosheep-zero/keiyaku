import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { akumaCallerFromEnvironment } from "../src/cli/akuma-caller.js";
import { akumaExecutionEnvironment } from "../src/akuma/providers/execution-environment.js";
import { temporaryDirectory } from "./support/process.js";

test("CLI captures native host IDs in the existing external caller and ignores non-ID hints", async () => {
  for (const [integration, variable] of [
    ["codex", "CODEX_THREAD_ID"], ["pi", "PI_SESSION_ID"], ["claude", "CLAUDE_CODE_SESSION_ID"],
  ]) {
    assert.deepEqual(await akumaCallerFromEnvironment({ [variable!]: "native-session",
      KEIYAKU_EXTERNAL_CALLER: "paseo:stale-parent" }),
    { kind: "external", integration, id: "native-session" });
  }
  assert.equal(await akumaCallerFromEnvironment({ CODEX_THREAD_ID: "", PI_SESSION_ID: "",
    CLAUDE_CODE_SESSION_ID: "", PI_SESSION_FILE: "/tmp/not-an-id", PASEO_AGENT_ID: "not-a-native-id" }), undefined);
  assert.deepEqual(await akumaCallerFromEnvironment({ KEIYAKU_EXTERNAL_CALLER: "paseo:legacy-parent" }),
    { kind: "external", integration: "paseo", id: "legacy-parent" });
  await assert.rejects(akumaCallerFromEnvironment({ PI_SESSION_ID: "\ninvalid" }), /Invalid Akuma caller/u);
});

test("complete Akuma parent wins; incomplete custody and ambiguous native hosts refuse", async (t) => {
  const world = join(temporaryDirectory(t, "native-caller-"), "world");
  mkdirSync(world);
  const hosts = { CODEX_THREAD_ID: "codex", PI_SESSION_ID: "pi", CLAUDE_CODE_SESSION_ID: "claude" };
  assert.deepEqual(await akumaCallerFromEnvironment({ ...hosts,
    KEIYAKU_ACTOR_ID: "aku/parent/1234abcd", KEIYAKU_ACTOR_WORLD: world }),
    { kind: "akuma", akuId: "aku/parent/1234abcd", world: realpathSync(world) });
  await assert.rejects(akumaCallerFromEnvironment({ ...hosts, KEIYAKU_ACTOR_ID: "aku/parent/1234abcd" }),
    /requires both/u);
  await assert.rejects(akumaCallerFromEnvironment(hosts), /Ambiguous native host caller: codex, pi, claude/u);
  await assert.rejects(akumaCallerFromEnvironment({ CODEX_THREAD_ID: "codex", PI_SESSION_ID: "pi",
    KEIYAKU_EXTERNAL_CALLER: "paseo:legacy" }), /Ambiguous native host caller/u);
});

test("existing execution boundary prevents inherited host identity from attributing the next Akuma", async () => {
  const inherited = { CODEX_THREAD_ID: "codex-parent", PI_SESSION_ID: "pi-parent",
    CLAUDE_CODE_SESSION_ID: "claude-parent", KEIYAKU_EXTERNAL_CALLER: "paseo:old-parent", KEEP: "yes" };
  const cleaned = akumaExecutionEnvironment(inherited);
  assert.deepEqual(cleaned, { KEEP: "yes" });
  assert.equal(await akumaCallerFromEnvironment(cleaned), undefined);
  assert.deepEqual(await akumaCallerFromEnvironment({ ...cleaned, PI_SESSION_ID: "child-session" }),
    { kind: "external", integration: "pi", id: "child-session" });
});
