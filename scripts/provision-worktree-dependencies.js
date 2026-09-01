import { execFile, spawn } from "node:child_process";
import { lstat, readlink, realpath, symlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** @param {string} cwd */
async function installDependencies(cwd) {
  const child = spawn("npm", ["ci", "--ignore-scripts", "--prefer-offline"], { cwd, stdio: "inherit" });
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      if (signal !== null) reject(new Error(`npm ci terminated by ${signal}`));
      else resolveExit(exitCode);
    });
  });
  if (code !== 0) throw new Error(`npm ci exited with code ${code}`);
}

/** @param {string} output */
function firstWorktreeFromPorcelain(output) {
  const worktree = output.split("\0")[0];
  if (worktree === undefined || !worktree.startsWith("worktree ")) {
    throw new Error("Git worktree porcelain output is missing a worktree path");
  }
  const path = worktree.slice("worktree ".length);
  if (path.length === 0) throw new Error("Git worktree porcelain output has an empty worktree path");
  return resolve(path);
}

/** @param {string} path */
async function insideWorkTree(path) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: path });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** @param {string} cwd */
function primaryFromManagedCwd(cwd) {
  const parent = dirname(cwd);
  return basename(parent) === "wt" && basename(dirname(parent)) === ".keiyaku" ? dirname(dirname(parent)) : undefined;
}

const cwd = await realpath(process.cwd());
const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain", "-z"], { cwd });
const main = firstWorktreeFromPorcelain(stdout);
const primaryWorktree = await realpath((await insideWorkTree(main)) ? main : (primaryFromManagedCwd(cwd) ?? cwd));
const managedWorktrees = join(primaryWorktree, ".keiyaku", "wt");
const isManagedWorktree = dirname(cwd) === managedWorktrees;

if (!isManagedWorktree) {
  await installDependencies(cwd);
} else {
  const sharedDependencies = join(primaryWorktree, "node_modules");
  const sharedStat = await lstat(sharedDependencies);
  if (!sharedStat.isDirectory()) throw new Error(`${sharedDependencies} is not a dependency directory`);

  const worktreeDependencies = join(cwd, "node_modules");
  try {
    const worktreeStat = await lstat(worktreeDependencies);
    const linkedTarget = worktreeStat.isSymbolicLink()
      ? resolve(dirname(worktreeDependencies), await readlink(worktreeDependencies))
      : undefined;
    if (linkedTarget !== sharedDependencies) {
      throw new Error(`${worktreeDependencies} already exists and is not the shared dependency link`);
    }
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    await symlink(relative(cwd, sharedDependencies), worktreeDependencies, "dir");
  }
}
