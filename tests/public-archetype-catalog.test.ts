import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  AkumaNameError,
  Akumas,
  World,
  type AkumaNameCatalog,
  type AkumaNameCatalogInput,
  type AkumaNameCatalogRow,
} from "../src/index.js";
import { cliJson } from "./support/cli-fixtures.js";

/**
 * A root-only consumer of the public akumaName catalogue: this file reaches the
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
    mkdirSync(join(root, ".keiyaku", "akumas"), { recursive: true });
    writeFileSync(join(root, ".keiyaku", "akumas", `${name}.md`), markdown);
  }
  for (const [name, markdown] of Object.entries(files.home ?? {})) {
    mkdirSync(join(home, "akumas"), { recursive: true });
    writeFileSync(join(home, "akumas", `${name}.md`), markdown);
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

  const input: AkumaNameCatalogInput = { cwd: root, home };
  const catalog: AkumaNameCatalog = await Akumas.akumaNames(input);
  const akumas = Akumas.of(await World.at(root));
  assert.deepEqual(await akumas.akumaNames({ home }), catalog);
  await assert.rejects(akumas.akumaNames({ cwd: home } as never), TypeError);
  const rows: readonly AkumaNameCatalogRow[] = catalog.rows ?? [];
  assert.deepEqual(rows, [
    { name: "child" },
    { name: "home-only" },
    { name: "project-only" },
    { name: "shared", description: "Project" },
  ]);
  assert.deepEqual(await Akumas.akumaNames({ cwd: root, home, limit: 2 }), {
    kind: "akuma-name-catalogue",
    rows: [{ name: "child" }, { name: "home-only" }],
    more: true,
  });

  // Omitted project keeps no project scope: the shared name falls back to Home.
  assert.deepEqual(await Akumas.akumaNames({ home }), {
    kind: "akuma-name-catalogue",
    rows: [{ name: "child" }, { name: "home-only" }, { name: "shared", description: "Home" }],
  });

  const bounded = await akumas.akumaNames({ home, limit: 1 });
  assert.deepEqual(bounded, { kind: "akuma-name-catalogue", rows: [{ name: "child" }], more: true });
  const cli = await cliJson<AkumaNameCatalog>(["-C", root, "ls", "aku/"], { environment: { KEIYAKU_HOME: home } });
  assert.deepEqual(cli.value, catalog);
});

test("the public catalogue rejects malformed caller input before observing any definition", async (context) => {
  const { root, home } = catalogueFixture(context, {
    root: { broken: '---\nprovider: claude\nhidden: "true"\n---\n' },
  });

  for (const malformed of [null, "aku/", []]) {
    await assert.rejects(Akumas.akumaNames(malformed as never), /Akuma catalogue input must be an object/u);
  }
  await assert.rejects(
    Akumas.akumaNames({ cwd: root, home, akumaName: "worker" } as never),
    /Akuma catalogue input has unknown field: akumaName/u,
  );
  await assert.rejects(
    Akumas.akumaNames({ cwd: 7 } as never),
    /Akuma catalogue cwd must be a nonblank string/u,
  );
  await assert.rejects(
    Akumas.akumaNames({ home: "   " } as never),
    /Akuma catalogue home must be a nonblank string/u,
  );
  await assert.rejects(
    Akumas.akumaNames({ home: "relative/home" } as never),
    /Akuma catalogue home must be absolute: relative\/home/u,
  );
  await assert.rejects(
    Akumas.akumaNames({ cwd: root, limit: 0 } as never),
    /limit must be an integer from 1 to 500/u,
  );

  // The boundary wins over the invalid definition the same request would have read.
  await assert.rejects(Akumas.akumaNames({ cwd: root, home: 7 } as never), (error: unknown) => {
    assert.ok(error instanceof TypeError);
    assert.equal(error.message, "Akuma catalogue home must be a nonblank string");
    return true;
  });
  await assert.rejects(Akumas.akumaNames({ cwd: root, home }), (error: unknown) => {
    assert.ok(error instanceof AkumaNameError);
    return true;
  });
});

test("the native akumaName error keeps its class, kind, reason and searched paths", async (context) => {
  const { root, home } = catalogueFixture(context, {
    root: { broken: '---\nprovider: claude\nhidden: "true"\n---\n' },
  });

  await assert.rejects(Akumas.akumaNames({ cwd: root, home }), (error: unknown) => {
    assert.ok(error instanceof AkumaNameError);
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AkumaNameError");
    assert.equal(error.kind, "akuma-name");
    assert.equal(error.akumaName, "broken");
    assert.deepEqual(error.searched, [join(root, ".keiyaku", "akumas", "broken.md")]);
    assert.equal(error.reason, "is invalid: Akuma hidden must be a boolean");
    assert.match(error.message, /`broken` is invalid/u);
    return true;
  });
});

test("spawn accepts a bare alias and a missing akumaName points to the catalogue", async (context) => {
  const { root, home } = catalogueFixture(context, {});
  const akumas = Akumas.of(await World.at(root));
  await assert.rejects(akumas.spawn({ akumaName: "missing", alias: "lane", home }), (error: unknown) => {
    assert.ok(error instanceof AkumaNameError);
    assert.equal(error.akumaName, "missing");
    assert.match(error.message, /use `ls` with selector `aku\/` to list available akumaName values/u);
    return true;
  });
});
