import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Keiyaku, z } from "../src/index.js";
import { outputFieldPaths } from "../scripts/dump-output-schemas.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/native-output-budget", name + ".json"), "utf8"));
const approvedFields = z.record(z.string(), z.array(z.string())).parse(fixture("field-paths"));
const candidate = z
  .strictObject({ samples: z.array(z.strictObject({ name: z.string(), verb: z.string(), wire: z.unknown() })) })
  .parse(fixture("candidate"));

test("every verb's public field paths equal the approved ledger", () => {
  assert.deepEqual(Object.keys(Keiyaku.verbs).sort(), Object.keys(approvedFields).sort());
  for (const [name, verb] of Object.entries(Keiyaku.verbs)) {
    const schema = z.toJSONSchema(verb.output, { io: "input", reused: "ref", unrepresentable: "throw" });
    assert.deepEqual(outputFieldPaths(schema), approvedFields[name], name);
  }
});

test("sampled native owner answers round-trip their public schemas", () => {
  assert.equal(new Set(candidate.samples.map((sample) => sample.name)).size, candidate.samples.length);
  const measured = new Set(candidate.samples.map((sample) => sample.verb));
  for (const verb of Object.keys(Keiyaku.verbs)) assert.ok(measured.has(verb), `missing owner sample for ${verb}`);
  for (const sample of candidate.samples) {
    assert.ok(Object.hasOwn(Keiyaku.verbs, sample.verb), `${sample.name}: unknown verb`);
    const schema = Keiyaku.verbs[sample.verb as keyof typeof Keiyaku.verbs].output;
    assert.deepEqual(schema.parse(sample.wire), sample.wire, `${sample.name}: native owner schema`);
  }
});
