import assert from "node:assert/strict";
import test from "node:test";
import { akumaCallerSchema, type AkumaCaller } from "../src/akuma/caller.js";
import { listedAkumaSchema, type AkumaList, type ListedAkuma } from "../src/akuma/akuma.js";
import { parseAkumaId } from "../src/akuma/identity.js";
import { renderAkumaCatalogue } from "../src/cli/render/catalog.js";

const AT = "2026-08-12T00:00:00.000Z";
const LIFE_AT = "2026-08-11T23:00:00.000Z";

function row(id: string, parentAkumaId?: string): ListedAkuma {
  return listedAkumaSchema.parse({
    id: parseAkumaId(id).id,
    life: "asleep",
    lifeAt: LIFE_AT,
    lastActivityAt: LIFE_AT,
    ...(parentAkumaId === undefined ? {} : { parentAkumaId: parseAkumaId(parentAkumaId).id }),
  });
}

const external: AkumaCaller = akumaCallerSchema.parse({ kind: "external", integration: "test", id: "root" });
const parent: AkumaCaller = akumaCallerSchema.parse({
  kind: "akuma",
  world: "/world",
  akumaId: parseAkumaId("aku/lead/aaaa0001").id,
});

function catalogue(rows: readonly ListedAkuma[]): AkumaList {
  return { observedAt: AT, rows };
}

test("an ordinary Akuma catalogue keeps its rows unchanged", () => {
  assert.equal(
    renderAkumaCatalogue(catalogue([row("aku/worker/1234abcd", "aku/lead/aaaa0001")]), null),
    ["AKUMA // recent", "", "○ aku/worker/1234abcd · asleep · 1h"].join("\n"),
  );
});

test("a caller-scoped catalogue names the immediate Akuma caller of descendants", () => {
  assert.equal(
    renderAkumaCatalogue(
      catalogue([row("aku/worker/1234abcd"), row("aku/worker/1234abce", "aku/lead/aaaa0001")]),
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
    renderAkumaCatalogue(catalogue([row("aku/worker/1234abcd", "aku/lead/aaaa0001")]), null, parent),
    ["AKUMA // recent", "", "○ aku/worker/1234abcd · asleep · 1h"].join("\n"),
    "a direct child of the Akuma root names no caller",
  );
});
