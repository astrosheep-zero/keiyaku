import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  AkumaArchetypeError,
  listArchetypeDefinitions,
  type ArchetypeCatalog,
  type ArchetypeCatalogInput,
  type ArchetypeCatalogRow,
} from "../src/index.js";
import { cliJson } from "./support/cli-fixtures.js";

/**
 * A root-only consumer of the public Archetype catalogue: this file reaches the
 * owner listing and its native error through the package root alone, exactly as
 * an external caller would, and the CLI is checked against that same value.
 */
function catalogueFixture(
  context: TestContext,
  files: Readonly<{ root?: Readonly<Record<string, string>>; home?: Readonly<Record<string, string>> }>,
): Readonly<{ root: string; home: string }> {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-public-archetypes-root-"));
  const home = mkdtempSync(join(tmpdir(), "keiyaku-public-archetypes-home-"));
  context.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  for (const [name, markdown] of Object.entries(files.root ?? {})) {
    mkdirSync(join(root, ".keiyaku", "akuma"), { recursive: true });
    writeFileSync(join(root, ".keiyaku", "akuma", `${name}.md`), markdown);
  }
  for (const [name, markdown] of Object.entries(files.home ?? {})) {
    mkdirSync(join(home, "akuma"), { recursive: true });
    writeFileSync(join(home, "akuma", `${name}.md`), markdown);
  }
  return { root, home };
}

test("a root-only caller lists the same callable definitions the CLI shows", async (context) => {
  const { root, home } = catalogueFixture(context, {
    root: {
      "project-only": "---\nprovider: claude\n---\nProject only.\n",
      shared: "---\nprovider: claude\ndescription: Project\n---\nProject body.\n",
    },
    home: {
      "home-only": "---\nprovider: claude\n---\nHome only.\n",
      shared: "---\nprovider: claude\ndescription: Home\n---\nHome body.\n",
      secret: "---\nprovider: claude\nhidden: true\n---\nHidden.\n",
      child: "---\nbase: secret\n---\nChild of a hidden base.\n",
    },
  });

  const input: ArchetypeCatalogInput = { project: root, home };
  const catalog: ArchetypeCatalog = await listArchetypeDefinitions(input);
  const rows: readonly ArchetypeCatalogRow[] = catalog.rows;
  assert.deepEqual(rows, [
    { name: "child" },
    { name: "home-only" },
    { name: "project-only" },
    { name: "shared", description: "Project" },
  ]);
  assert.deepEqual(await listArchetypeDefinitions({ project: root, home, limit: 2 }), {
    rows: [{ name: "child" }, { name: "home-only" }],
    hasMore: true,
  });

  // Omitted project keeps no project scope: the shared name falls back to Home.
  assert.deepEqual(await listArchetypeDefinitions({ home }), {
    rows: [{ name: "child" }, { name: "home-only" }, { name: "shared", description: "Home" }],
    hasMore: false,
  });

  const cli = await cliJson<ArchetypeCatalog>(["-C", root, "ls", "aku/"], { environment: { KEIYAKU_HOME: home } });
  assert.deepEqual(cli.value, catalog);
});

test("the public catalogue rejects malformed caller input before observing any definition", async (context) => {
  const { root, home } = catalogueFixture(context, {
    root: { broken: '---\nprovider: claude\nhidden: "true"\n---\n' },
  });

  for (const malformed of [null, "aku/", []]) {
    await assert.rejects(listArchetypeDefinitions(malformed as never), /Akuma catalogue input must be an object/u);
  }
  await assert.rejects(
    listArchetypeDefinitions({ project: root, home, archetype: "worker" } as never),
    /Akuma catalogue input has unknown field: archetype/u,
  );
  await assert.rejects(
    listArchetypeDefinitions({ project: 7 } as never),
    /Akuma catalogue project must be a nonblank string/u,
  );
  await assert.rejects(
    listArchetypeDefinitions({ home: "   " } as never),
    /Akuma catalogue home must be a nonblank string/u,
  );
  await assert.rejects(
    listArchetypeDefinitions({ home: "relative/home" } as never),
    /Akuma catalogue home must be absolute: relative\/home/u,
  );
  await assert.rejects(
    listArchetypeDefinitions({ project: root, limit: 0 } as never),
    /limit must be an integer from 1 to 500/u,
  );

  // The boundary wins over the invalid definition the same request would have read.
  await assert.rejects(listArchetypeDefinitions({ project: root, home: 7 } as never), (error: unknown) => {
    assert.ok(error instanceof TypeError);
    assert.equal(error.message, "Akuma catalogue home must be a nonblank string");
    return true;
  });
  await assert.rejects(listArchetypeDefinitions({ project: root, home }), (error: unknown) => {
    assert.ok(error instanceof AkumaArchetypeError);
    return true;
  });
});

test("the native Archetype error keeps its class, kind, reason and searched paths", async (context) => {
  const { root, home } = catalogueFixture(context, {
    root: { broken: '---\nprovider: claude\nhidden: "true"\n---\n' },
  });

  await assert.rejects(listArchetypeDefinitions({ project: root, home }), (error: unknown) => {
    assert.ok(error instanceof AkumaArchetypeError);
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AkumaArchetypeError");
    assert.equal(error.kind, "akuma-archetype");
    assert.equal(error.archetype, "broken");
    assert.deepEqual(error.searched, [join(root, ".keiyaku", "akuma", "broken.md")]);
    assert.equal(error.reason, "is invalid: Akuma hidden must be a boolean");
    assert.match(error.message, /`broken` is invalid/u);
    return true;
  });
});
