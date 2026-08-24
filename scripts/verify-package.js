import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const artifact = resolve(root, "build/src/runtime/proc/windows-launch.exe");

function assertWindowsArtifact(path) {
  if (!existsSync(path)) throw new Error(`Windows launcher artifact is missing: ${path}`);
  const bytes = readFileSync(path);
  if (bytes.toString("ascii", 0, 2) !== "MZ") throw new Error("Windows launcher is not a PE image");
  const peOffset = bytes.readUInt32LE(0x3c);
  if (bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0")
    throw new Error("Windows launcher has no PE signature");
  if (bytes.readUInt16LE(peOffset + 4) !== 0x8664) throw new Error("Windows launcher is not x64");
  const optionalHeader = peOffset + 24;
  if (bytes.readUInt16LE(optionalHeader) !== 0x20b) throw new Error("Windows launcher is not a PE32+ image");
  if (bytes.readUInt16LE(optionalHeader + 68) !== 2) throw new Error("Windows launcher is not a GUI-subsystem image");
}

function assertArchive(path) {
  const listing = execFileSync("tar", ["-tzf", path], { cwd: root, encoding: "utf8" });
  if (!listing.split(/\r?\n/u).includes("package/build/src/runtime/proc/windows-launch.exe")) {
    throw new Error(`npm tarball omits package/build/src/runtime/proc/windows-launch.exe: ${path}`);
  }
}

assertWindowsArtifact(artifact);
if (process.env.npm_lifecycle_event === "postpack" && process.env.npm_config_dry_run !== "true") {
  const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
  const archive = JSON.parse(output)[0]?.filename;
  if (typeof archive !== "string")
    throw new Error("npm pack did not return its tarball path for Windows launcher inspection");
  const archivePath = resolve(root, archive);
  try {
    assertArchive(archivePath);
  } finally {
    rmSync(archivePath, { force: true });
  }
}
