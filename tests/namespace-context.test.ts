import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installNamespaceContext, readNamespaceContext, repairNamespaceContext } from "../src/task/context.js";

function temporary(): string { return mkdtempSync(join(tmpdir(), "keiyaku-namespace-")); }

test("namespace context stores root and nested namespaces in canonical bytes", () => {
  const root = temporary();
  assert.equal(readNamespaceContext(root), "absent");
  installNamespaceContext(root, ["contract", "inside"]);
  assert.deepEqual(readNamespaceContext(root), ["contract", "inside"]);
  assert.equal(readFileSync(join(root, ".keiyaku", "namespace", ".gitignore"), "utf8"), "*\n");
  assert.equal(readFileSync(join(root, ".keiyaku", "namespace", "current"), "utf8"), "contract/inside\n");
  installNamespaceContext(root, []);
  assert.deepEqual(readNamespaceContext(root), []);
  assert.equal(readFileSync(join(root, ".keiyaku", "namespace", "current"), "utf8"), "\n");
});
test("repair preserves a valid override and repairs the ignored Git", () => {
  const root = temporary();
  installNamespaceContext(root, ["override"]);
  const current = join(root, ".keiyaku", "namespace", "current"), inode = lstatSync(current).ino;
  writeFileSync(join(root, ".keiyaku", "namespace", ".gitignore"), "wrong\n");
  assert.equal(repairNamespaceContext(root, ["default"]), "kept");
  assert.deepEqual(readNamespaceContext(root), ["override"]);
  assert.equal(lstatSync(current).ino, inode);
  assert.equal(readFileSync(join(root, ".keiyaku", "namespace", ".gitignore"), "utf8"), "*\n");
});

test("repair replaces malformed current bytes and readers reject symlinks", () => {
  const root = temporary(), directory = join(root, ".keiyaku", "namespace");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "current"), "Bad Namespace\n");
  assert.equal(readNamespaceContext(root), "malformed");
  assert.equal(repairNamespaceContext(root, ["default"]), "installed");
  assert.deepEqual(readNamespaceContext(root), ["default"]);

  const linked = temporary(), target = join(linked, "target");
  mkdirSync(join(linked, ".keiyaku", "namespace"), { recursive: true });
  writeFileSync(target, "linked\n");
  symlinkSync(target, join(linked, ".keiyaku", "namespace", "current"));
  assert.equal(readNamespaceContext(linked), "malformed");
});
