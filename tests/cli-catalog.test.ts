import assert from "node:assert/strict";
import test from "node:test";
import type { AkumaList } from "../src/akuma/akuma.js";
import type { AkumaCaller } from "../src/akuma/caller.js";
import { renderAkumaCatalogue } from "../src/cli/render/catalog.js";

const AT = "2026-08-12T00:00:00.000Z";

function row(
  id: string,
  caller: AkumaCaller,
  lifeAt = "2026-08-11T23:00:00.000Z",
): AkumaList["rows"][number] {
  return {
    id: id as never,
    archetype: "worker",
    life: "asleep",
    lifeAt,
    lastActivityAt: lifeAt,
    pending: [],
    aliases: [],
    caller,
  };
}

const external: AkumaCaller = { kind: "external", integration: "test", id: "root" };
const parent: AkumaCaller = { kind: "akuma", world: "/world" as never, akuId: "aku/lead/aaaa0001" as never };

function catalogue(rows: AkumaList["rows"]): AkumaList {
  return { observedAt: AT, rows, searched: ["/world/.keiyaku/akuma/run"], hasMore: false };
}

test("an ordinary Akuma catalogue keeps its rows unchanged", () => {
  assert.equal(
    renderAkumaCatalogue(catalogue([row("aku/worker/1234abcd", parent)]), null),
    ["AKUMA // recent", "", "○ aku/worker/1234abcd · asleep · 1h"].join("\n"),
  );
});

test("a caller-scoped catalogue names the immediate Akuma caller of descendants", () => {
  assert.equal(
    renderAkumaCatalogue(
      catalogue([row("aku/worker/1234abcd", external), row("aku/worker/1234abce", parent)]),
      null,
      external,
    ),
    [
      "AKUMA // recent",
      "",
      "○ aku/worker/1234abcd · asleep · 1h",
      "○ aku/worker/1234abce · asleep · 1h · by aku/lead/aaaa0001",
    ].join("\n"),
  );
  assert.equal(
    renderAkumaCatalogue(catalogue([row("aku/worker/1234abcd", parent)]), null, parent),
    ["AKUMA // recent", "", "○ aku/worker/1234abcd · asleep · 1h"].join("\n"),
    "a direct child of the Akuma root names no caller",
  );
});
