import { temporaryDirectory } from "./support/process.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { Schema, type StandardSchemaV1 } from "../src/akuma/index.js";
import { schemaFromStandard } from "../src/akuma/schema.js";
import { type ProviderAdapter } from "../src/akuma/provider.js";

import { answering, bornWorld, fixtureRuntime, installTellRuntime, settleFixtureBodies } from "./support/akuma-tell.js";

function foreignSchema<T>(
  vendor: string,
  output: T,
  decode: (value: unknown) => T,
  project?: () => unknown,
): StandardSchemaV1<T> {
  return {
    "~standard": {
      version: 1,
      vendor,
      validate: (value) => {
        try {
          return { value: decode(value) };
        } catch (error) {
          return { issues: [{ message: error instanceof Error ? error.message : String(error) }] };
        }
      },
      types: { input: null, output },
      ...(project === undefined ? {} : { jsonSchema: { output: project } }),
    },
  };
}

function objectAnswer(): () => unknown {
  return () => ({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  });
}

test("tell accepts a bare zod schema and decodes by inference", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-schema-direct-"));
  const bodies: Promise<unknown>[] = [];
  const fixtures = new Map<string, Readonly<{ adapter: ProviderAdapter; now: string }>>();
  const restoreTellRuntime = installTellRuntime(fixtureRuntime(bodies, fixtures));
  try {
    const { allocated, akuma } = await bornWorld(root, "a2000001");
    fixtures.set(allocated.paths.directory, { adapter: answering('{"ok":true}'), now: "2026-08-10T00:00:01.000Z" });
    const decoded = await akuma.tell("direct", { schema: z.object({ ok: z.boolean() }) });
    const typed: { ok: boolean } = decoded;
    assert.equal(typed.ok, true);
    await settleFixtureBodies(bodies);
  } finally {
    restoreTellRuntime();
    await settleFixtureBodies(bodies);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a foreign standard schema carrying a toJSONSchema method decodes", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-schema-foreign-method-"));
  const bodies: Promise<unknown>[] = [];
  const fixtures = new Map<string, Readonly<{ adapter: ProviderAdapter; now: string }>>();
  const restoreTellRuntime = installTellRuntime(fixtureRuntime(bodies, fixtures));
  const foreign: StandardSchemaV1<{ ok: boolean }> & Readonly<{ toJSONSchema: () => unknown }> = {
    "~standard": {
      version: 1,
      vendor: "widget",
      validate: (value) => {
        const candidate = value as { ok?: unknown };
        if (typeof candidate?.ok !== "boolean") return { issues: [{ message: "expected { ok: boolean }" }] };
        return { value: { ok: candidate.ok } };
      },
      types: { input: null, output: { ok: true } },
    },
    toJSONSchema: objectAnswer(),
  };
  try {
    const { allocated, akuma } = await bornWorld(root, "a2000005");
    fixtures.set(allocated.paths.directory, { adapter: answering('{"ok":true}'), now: "2026-08-10T00:00:01.000Z" });
    const decoded = await akuma.tell("foreign-method", { schema: foreign });
    assert.deepEqual(decoded, { ok: true });
    await settleFixtureBodies(bodies);
  } finally {
    restoreTellRuntime();
    await settleFixtureBodies(bodies);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a foreign standard schema without a projection refuses naming vendor and escape hatch", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-schema-foreign-refusal-");
  const { akuma } = await bornWorld(root, "a2000003");
  const foreign = foreignSchema("acme", { ok: true }, (value) => value as { ok: boolean });
  await assert.rejects(
    akuma.tell("foreign", { schema: foreign }),
    (error: unknown) =>
      error instanceof TypeError && /acme/u.test(error.message) && /Schema\.json/u.test(error.message),
  );
  assert.equal(
    (await akuma.history()).rows.some((row) => row.kind === "tell"),
    false,
  );
});

test("an asynchronously validating vendor refuses at decode instead of decoding", () => {
  const foreign = {
    "~standard": {
      version: 1,
      vendor: "async-vendor",
      validate: async () => ({ value: { ok: true } }),
      types: { input: null, output: { ok: true } },
      jsonSchema: { output: objectAnswer() },
    },
  } satisfies StandardSchemaV1<{ ok: boolean }>;
  const schema = schemaFromStandard(foreign);
  assert.throws(
    () => schema.decode({}),
    (error: unknown) =>
      error instanceof TypeError && /async-vendor/u.test(error.message) && /asynchronously/u.test(error.message),
  );
});

test("the simplicity guard refuses unsupported keywords and names them", () => {
  assert.throws(
    () => Schema.zod(z.object({ name: z.string().max(3) })),
    (error: unknown) => {
      return (
        error instanceof TypeError && /maxLength/u.test(error.message) && /simple shapes only/u.test(error.message)
      );
    },
  );
  assert.throws(
    () => Schema.zod(z.object({ tags: z.array(z.string().regex(/x/)) })),
    (error: unknown) => {
      return error instanceof TypeError && /pattern/u.test(error.message);
    },
  );
  assert.throws(
    () => Schema.zod(z.array(z.string()).max(2)),
    (error: unknown) => {
      return error instanceof TypeError && /maxItems/u.test(error.message);
    },
  );
  assert.doesNotThrow(() => Schema.zod(z.object({ maxLength: z.string(), pattern: z.string() })));
});

test("Schema.json stays unguarded for a caller-owned document", () => {
  const document = {
    type: "object",
    properties: { name: { type: "string", maxLength: 3 } },
    required: ["name"],
    additionalProperties: false,
  };
  const schema = Schema.json(document, (value) => value as { name: string });
  assert.deepEqual(schema.jsonSchema, document);
  assert.deepEqual(schema.decode({ name: "abcd" }), { name: "abcd" });
});
