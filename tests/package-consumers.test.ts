import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

const root = resolve(import.meta.dirname, import.meta.url.endsWith(".js") ? "../.." : "..");

function externalConsumer(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-v4-consumer-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "node_modules", "@astrosheep"), { recursive: true });
  symlinkSync(root, join(directory, "node_modules", "@astrosheep", "keiyaku"), "dir");
  writeFileSync(join(directory, "package.json"), '{"type": "module"}\n');
  return directory;
}

test("built package supports branded Contract, standalone Akuma, Akumas, Task, Kanshi and plugin consumers", (context) => {
  const directory = externalConsumer(context);
  mkdirSync(join(directory, "node_modules", "@types"), { recursive: true });
  symlinkSync(
    join(root, "plugins", "square"),
    join(directory, "node_modules", "@astrosheep", "keiyaku-plugin-square"),
    "dir",
  );
  symlinkSync(join(root, "node_modules", "@types", "node"), join(directory, "node_modules", "@types", "node"), "dir");
  symlinkSync(join(root, "node_modules", "undici-types"), join(directory, "node_modules", "undici-types"), "dir");
  const examples = ["contract", "akumas", "task", "kanshi", "plugin"].map((name) => name + ".ts");
  for (const example of examples) {
    copyFileSync(join(root, "tests", "fixtures", "consumers", example), join(directory, example));
  }
  const checked = spawnSync(
    process.execPath,
    [
      join(root, "node_modules", "typescript", "bin", "tsc"),
      "--noEmit",
      "--strict",
      "--target",
      "ES2023",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--preserveSymlinks",
      // Check our consumers, not every transitive dependency declaration again.
      "--skipLibCheck",
      ...examples,
    ],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  const loaded = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'import assert from "node:assert/strict";',
        'import { createRequire } from "node:module";',
        'import { Akuma, Akumas, Delivery, Keiyaku, nuke } from "@astrosheep/keiyaku";',
        'import { Akumas as AkumasSubpath } from "@astrosheep/keiyaku/akumas";',
        'import plugin from "@astrosheep/keiyaku-plugin-square";',
        'assert.throws(() => Reflect.construct(Keiyaku, []), TypeError);',
        'assert.equal(typeof Keiyaku.with, "function");',
        'assert.equal(Keiyaku.call, Function.prototype.call);',
        'assert.equal(Keiyaku.bind, Function.prototype.bind);',
        'assert.equal("fork" in Keiyaku, false);',
        'assert.equal("history" in Keiyaku, false);',
        'assert.equal("interrupt" in Keiyaku, false);',
        'assert.equal("kill" in Keiyaku, false);',
        'assert.equal("nuke" in Keiyaku, false);',
        'assert.equal("ls" in Keiyaku, false);',
        'assert.equal("list" in Keiyaku, false);',
        'assert.equal("observe" in Keiyaku, false);',
        'assert.equal("of" in Keiyaku, false);',
        'assert.equal("status" in Keiyaku, false);',
        'assert.equal("tell" in Keiyaku, false);',
        'assert.equal("wait" in Keiyaku, false);',
        'assert.equal(Object.hasOwn(Keiyaku, Symbol.hasInstance), false);',
        'assert.equal(typeof Akuma.birth, "function");',
        'assert.equal(typeof Akuma.select, "function");',
        'assert.equal(typeof Akumas.of, "function");',
        'assert.equal(AkumasSubpath, Akumas);',
        'assert.equal(typeof nuke, "function");',
        'assert.throws(() => Reflect.construct(Delivery, []), TypeError);',
        'assert.equal(plugin.manifest.id, "square");',
        'assert.equal(typeof plugin.activate, "function");',
        'assert.ok(createRequire(import.meta.url).resolve("@astrosheep/keiyaku-plugin-square").endsWith("index.js"));',
      ].join("\n"),
    ],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(loaded.status, 0, loaded.stderr);
});

test("package exports reject deep internal imports", (context) => {
  const directory = externalConsumer(context);
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        ["--input-type=module", "-e", 'await import("@astrosheep/keiyaku/build/src/core/facts/types.js")'],
        { cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
      ),
    (error: unknown) => {
      const value = error as { stderr?: Buffer };
      return value.stderr?.toString("utf8").includes("ERR_PACKAGE_PATH_NOT_EXPORTED") === true;
    },
  );
});
