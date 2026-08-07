import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const temporaryPaths: string[] = [];
let bin = "";

type ShellResult = Readonly<{ status: number | null; stdout: string; stderr: string }>;
type AuditReport = Readonly<{
  reworks: number;
  reviews: number;
  timeline: readonly unknown[];
  attempt?: Readonly<{ failure: "candidate-unavailable" | "timeout" | "spawn-error" | "unknown-exit" }>;
  diff?: string;
}>;

test.before(() => {
  const packed = temporaryDirectory("keiyaku-v4-packed-");
  const installed = temporaryDirectory("keiyaku-v4-installed-bin-");
  const cache = temporaryDirectory("keiyaku-v4-npm-cache-");
  command("npm", ["pack", "--cache", cache, "--ignore-scripts", "--pack-destination", packed], root);
  const archives = readdirSync(packed).filter((path) => path.endsWith(".tgz"));
  assert.equal(archives.length, 1, `expected one packed archive, received: ${archives.join(", ")}`);

  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies?: Readonly<Record<string, string>>;
  };
  const dependencies = Object.fromEntries(Object.keys(manifest.dependencies ?? {}).map((name) => [
    name,
    `file:${join(root, "node_modules", name)}`,
  ]));
  writeFileSync(join(installed, "package.json"), `${JSON.stringify({
    name: "keiyaku-v4-installed-bin-dogfood",
    private: true,
    dependencies,
  }, null, 2)}\n`);
  command("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--offline",
    "--package-lock=false",
    "--cache",
    cache,
    join(packed, archives[0]!),
  ], installed);
  bin = join(installed, "node_modules", ".bin", "keiyaku-v4");
  assert.equal(existsSync(bin), true, "npm did not create the packaged CLI bin");
});

test.after(() => {
  for (const path of temporaryPaths.reverse()) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

function command(executable: string, args: readonly string[], cwd: string, input = ""): string {
  return execFileSync(executable, args, {
    cwd,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).toString();
}

function shell(executable: string, args: readonly string[], cwd: string, input = ""): ShellResult {
  const result = spawnSync(executable, args, {
    cwd,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

function succeeds(result: ShellResult): string {
  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.equal(result.stderr, "");
  return result.stdout;
}

function git(repository: string, args: readonly string[]): string {
  return command("git", ["-C", repository, ...args], repository);
}

function gitRef(repository: string, ref: string): string | null {
  try {
    const value = git(repository, ["rev-parse", "--verify", "--quiet", ref]).trim();
    return value === "" ? null : value;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return null;
    throw error;
  }
}

function invoke(repository: string, args: readonly string[], input = ""): string {
  assert.equal(args.includes("--json"), false, "shell dogfood consumes text output only");
  return command(bin, args, repository, input);
}

function invokeResult(repository: string, args: readonly string[], input = ""): ShellResult {
  assert.equal(args.includes("--json"), false, "shell dogfood consumes text output only");
  return shell(bin, ["-C", repository, ...args], repository, input);
}

function contractDocument(title: string): string {
  return [
    `# ${title}`,
    "",
    "## Context",
    "A real shell workflow.",
    "",
    "## Objective",
    "Exercise managed delivery.",
    "",
    "## Design",
    "Use the installed command.",
    "",
    "## Region",
    "~~~",
    "src/**",
    "~~~",
    "",
    "## Criteria",
    "### Works",
    "The command records the outcome.",
    "",
  ].join("\n");
}

function acceptedId(text: string, expected: string): string {
  const match = /^accepted bind (kei\/[^\s]+) head=/m.exec(text);
  assert.ok(match, `bind did not render a minted contract ID:\n${text}`);
  const id = match[1]!;
  assert.equal(id, expected);
  return id;
}

function acceptedFactKinds(text: string, id: string): string[] {
  return [...text.matchAll(new RegExp(`^fact ${id} [^\\s]+ ([^\\s]+)$`, "gm"))].map((match) => match[1]!);
}

function managedWorktree(text: string): string {
  const match = /^effect worktree created (.+)$/m.exec(text);
  assert.ok(match, `bind did not report creating a managed worktree:\n${text}`);
  return match[1]!;
}

function effectRef(text: string, prefix: string): string {
  const match = new RegExp(`^effect ref (?:created|updated|unchanged) (${prefix}[^\\s]+) `, "m").exec(text);
  assert.ok(match, `command did not report ${prefix} in normal text output:\n${text}`);
  return match[1]!;
}

function journalEntries(repository: string, id: string): Array<Readonly<{
  kind: string;
  data?: Readonly<{ note?: string }>;
}>> {
  const journals = git(repository, ["ls-tree", "-r", "--name-only", "refs/heads/keiyaku-state"])
    .split("\n")
    .filter((path) => path.startsWith("contracts/") && path.endsWith(".jsonl"));
  const journal = journals.find((path) => {
    const first = git(repository, ["show", `refs/heads/keiyaku-state:${path}`]).split("\n")[0];
    if (first === undefined || first.length === 0) return false;
    return (JSON.parse(first) as { contract?: unknown }).contract === id;
  });
  assert.ok(journal, `carrier journal for ${id} is absent`);
  return git(repository, ["show", `refs/heads/keiyaku-state:${journal}`])
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as { kind: string; data?: { note?: string } });
}

function journalKinds(repository: string, id: string): string[] {
  return journalEntries(repository, id).map((entry) => entry.kind);
}

function auditReport(text: string): AuditReport {
  assert.match(text, /^accepted audit kei\/[^\s]+ head=/m, `audit did not render an accepted result:\n${text}`);
  const line = text.split("\n").find((entry) => entry.startsWith("report "));
  assert.ok(line, `audit report is absent:\n${text}`);
  return JSON.parse(line.slice("report ".length)) as AuditReport;
}

function worktreePaths(repository: string): string[] {
  return git(repository, ["worktree", "list", "--porcelain"])
    .split("\n")
    .flatMap((line) => line.startsWith("worktree ") ? [line.slice("worktree ".length)] : [])
    .sort();
}

function commit(repository: string, file: string, contents: string, message: string): string {
  writeFileSync(join(repository, file), contents);
  git(repository, ["add", file]);
  git(repository, ["commit", "--quiet", "-m", message]);
  return git(repository, ["rev-parse", "HEAD"]).trim();
}

function repositoryWithMain(): string {
  const repository = temporaryDirectory("keiyaku-v4-managed-shell-");
  command("git", ["init", "--quiet", "--initial-branch=main", repository], repository);
  git(repository, ["config", "user.name", "Keiyaku Shell Test"]);
  git(repository, ["config", "user.email", "shell-test@example.com"]);
  commit(repository, "README.md", "initial\n", "initial");
  return repository;
}

function hereContractDocument(marker: string, poison: string): string {
  return [
    "# Here verification shell dogfood",
    "",
    "## Context",
    "Exercise the built CLI in a caller-owned worktree.",
    "",
    "## Objective",
    "Keep verification and placement independently observable.",
    "",
    "## Design",
    "Use text output at the installed command boundary.",
    "",
    "## Region",
    "~~~",
    "candidate.txt",
    "~~~",
    "",
    "## Criteria",
    "### Shell",
    "The real Git worktree stays caller-owned.",
    "",
    "## Verification",
    "~~~bash",
    `test -f ${marker} && test ! -f ${poison}`,
    "~~~",
    "",
  ].join("\n");
}

test("installed binary dogfoods managed delivery, replacement review, and terminal cleanup", () => {
  const repository = repositoryWithMain();
  const target = "refs/heads/main";
  const start = gitRef(repository, target);
  assert.ok(start);

  const bound = invoke(repository, ["bind", "--target", target, "-"], contractDocument("Managed shell dogfood"));
  const id = acceptedId(bound, "kei/managed-shell-dogfood");
  assert.deepEqual(acceptedFactKinds(bound, id), ["bind", "bound"]);
  const managed = managedWorktree(bound);
  const deliveryRef = effectRef(bound, "refs/heads/keiyaku-delivery/");
  assert.equal(existsSync(managed), true);
  assert.notEqual(resolve(managed), resolve(repository));
  assert.equal(gitRef(repository, deliveryRef), start);

  const firstCandidate = commit(managed, "candidate.txt", "first candidate\n", "first candidate");
  const firstDelivery = invoke(repository, ["deliver", id]);
  assert.deepEqual(acceptedFactKinds(firstDelivery, id), ["deliver"]);
  const candidatePin = effectRef(firstDelivery, "refs/heads/keiyaku-candidate/");
  assert.equal(gitRef(repository, candidatePin), firstCandidate);
  assert.equal(gitRef(repository, deliveryRef), firstCandidate);
  assert.equal(gitRef(repository, target), start);

  const targetBeforeUnsatisfiedReview = gitRef(repository, target);
  const managedHeadBeforeUnsatisfiedReview = git(managed, ["rev-parse", "HEAD"]).trim();
  const deliveryRefBeforeUnsatisfiedReview = gitRef(repository, deliveryRef);
  const candidatePinBeforeUnsatisfiedReview = gitRef(repository, candidatePin);
  const unsatisfiedReview = invoke(repository, ["review", id, "--unsatisfied", "--summary", "replace this candidate"]);
  assert.deepEqual(acceptedFactKinds(unsatisfiedReview, id), ["attestation"]);
  assert.equal(gitRef(repository, target), targetBeforeUnsatisfiedReview);
  assert.equal(git(managed, ["rev-parse", "HEAD"]).trim(), managedHeadBeforeUnsatisfiedReview);
  assert.equal(gitRef(repository, deliveryRef), deliveryRefBeforeUnsatisfiedReview);
  assert.equal(gitRef(repository, candidatePin), candidatePinBeforeUnsatisfiedReview);
  assert.equal(git(managed, ["status", "--porcelain"]), "");

  const replacementCandidate = commit(managed, "candidate.txt", "replacement candidate\n", "replacement candidate");
  const replacementDelivery = invoke(repository, ["deliver", id]);
  assert.deepEqual(acceptedFactKinds(replacementDelivery, id), ["deliver"]);
  assert.equal(gitRef(repository, candidatePin), replacementCandidate);
  assert.equal(gitRef(repository, deliveryRef), replacementCandidate);
  assert.equal(gitRef(repository, target), start);

  const satisfiedReview = invoke(repository, ["review", id, "--satisfied"]);
  assert.deepEqual(acceptedFactKinds(satisfiedReview, id), ["attestation", "claimed"]);
  assert.equal(gitRef(repository, target), replacementCandidate, "claimed CAS places the reviewed replacement");
  assert.deepEqual(journalKinds(repository, id), ["bind", "bound", "deliver", "attestation", "deliver", "attestation", "claimed"]);
  assert.equal(gitRef(repository, candidatePin), null);
  assert.equal(gitRef(repository, deliveryRef), null);
  assert.equal(existsSync(managed), false);
});

test("installed binary abandonment preserves the target and user commit", () => {
  const repository = repositoryWithMain();
  const target = "refs/heads/main";
  const bound = invoke(repository, ["bind", "--target", target, "-"], contractDocument("Abandon shell dogfood"));
  const id = acceptedId(bound, "kei/abandon-shell-dogfood");
  const managed = managedWorktree(bound);
  const deliveryRef = effectRef(bound, "refs/heads/keiyaku-delivery/");

  const userCommit = commit(repository, "user-owned.txt", "keep this user commit\n", "user commit after bind");
  const abandoned = invoke(repository, ["abandon", id, "--note", "scope changed"]);
  assert.deepEqual(acceptedFactKinds(abandoned, id), ["abandoned"]);
  assert.equal(gitRef(repository, target), userCommit);
  assert.equal(git(repository, ["show", `${userCommit}:user-owned.txt`]), "keep this user commit\n");
  assert.deepEqual(journalKinds(repository, id), ["bind", "bound", "abandoned"]);
  const terminal = journalEntries(repository, id).find((entry) => entry.kind === "abandoned");
  assert.deepEqual(terminal?.data, { note: "scope changed" });
  assert.equal(gitRef(repository, deliveryRef), null);
  assert.equal(existsSync(managed), false);
});

test("installed binary dogfoods here verification and gate-controlled placement", () => {
  const fixture = temporaryDirectory("keiyaku-v4-here-shell-");
  const repository = join(fixture, "primary");
  const here = join(fixture, "caller");
  const marker = join(fixture, "verification-pass");
  const poison = join(fixture, "verification-poison");
  const target = "refs/heads/main";

  command("git", ["init", "--quiet", "--initial-branch=main", repository], fixture);
  git(repository, ["config", "user.name", "Shell Dogfood"]);
  git(repository, ["config", "user.email", "shell-dogfood@example.test"]);
  commit(repository, "README.md", "initial\n", "initial");
  git(repository, ["worktree", "add", "--quiet", "-b", "caller", here]);
  const originalTarget = gitRef(repository, target);
  assert.ok(originalTarget);
  const originalWorktrees = worktreePaths(repository);
  mkdirSync(join(repository, ".keiyaku"));
  writeFileSync(join(repository, ".keiyaku", "settings.json"), JSON.stringify({
    gates: { default: ["reviewed", "verified"] },
  }));

  const bound = succeeds(invokeResult(
    here,
    ["bind", "--here", "--target", target, "-"],
    hereContractDocument(marker, poison),
  ));
  const id = acceptedId(bound, "kei/here-verification-shell-dogfood");
  assert.deepEqual(acceptedFactKinds(bound, id), ["bind", "bound"]);
  assert.equal(git(here, ["branch", "--show-current"]).trim(), "caller");
  assert.deepEqual(worktreePaths(repository), originalWorktrees);

  const candidate = commit(here, "candidate.txt", "candidate\n", "candidate");
  const preDeliveryReview = succeeds(invokeResult(here, ["review", id, "--satisfied"]));
  assert.deepEqual(acceptedFactKinds(preDeliveryReview, id), ["attestation"]);
  assert.match(preDeliveryReview, /stop placement \{"refusal"/);

  const delivered = succeeds(invokeResult(here, ["deliver", id]));
  assert.deepEqual(acceptedFactKinds(delivered, id), ["deliver", "attestation"]);
  assert.equal(gitRef(repository, target), originalTarget, "failed Verification must not place the target");

  writeFileSync(marker, "pass\n");
  const audited = succeeds(invokeResult(here, ["audit", id, "--show-diff-body"]));
  assert.deepEqual(acceptedFactKinds(audited, id), ["attestation"]);
  assert.match(audited, /diff --git a\/candidate\.txt b\/candidate\.txt/);
  assert.match(audited, /\+candidate/);
  assert.equal(gitRef(repository, target), originalTarget, "audit admission must not place the target");

  writeFileSync(poison, "rerun must not occur\n");
  const rerun = succeeds(invokeResult(here, ["audit", id, "--show-diff-body"]));
  assert.deepEqual(acceptedFactKinds(rerun, id), ["attestation"]);
  assert.match(rerun, /diff --git a\/candidate\.txt b\/candidate\.txt/);
  assert.deepEqual(journalKinds(repository, id), ["bind", "bound", "attestation", "deliver", "attestation", "attestation", "attestation"]);

  rmSync(poison);
  const repaired = succeeds(invokeResult(here, ["audit", id, "--show-diff-body"]));
  assert.deepEqual(acceptedFactKinds(repaired, id), ["attestation"]);
  assert.match(repaired, /diff --git a\/candidate\.txt b\/candidate\.txt/);
  assert.deepEqual(journalKinds(repository, id), ["bind", "bound", "attestation", "deliver", "attestation", "attestation", "attestation", "attestation"]);

  const satisfiedReview = succeeds(invokeResult(here, ["review", id, "--satisfied"]));
  assert.deepEqual(acceptedFactKinds(satisfiedReview, id), ["attestation", "claimed"]);
  assert.equal(gitRef(repository, target), candidate, "review places only after the verified gate is satisfied");

  const terminal = auditReport(succeeds(invokeResult(here, ["audit", id, "--show-diff-body"])));
  assert.deepEqual(terminal.attempt, {
    refusal: { kind: "terminal", contractId: id },
  });
  assert.deepEqual(
    journalKinds(repository, id),
    ["bind", "bound", "attestation", "deliver", "attestation", "attestation", "attestation", "attestation", "attestation", "claimed"],
  );
  assert.equal(git(here, ["branch", "--show-current"]).trim(), "caller");
  assert.equal(git(here, ["rev-parse", "HEAD"]).trim(), candidate);
  assert.equal(git(here, ["status", "--porcelain"]), "");
  assert.deepEqual(worktreePaths(repository), originalWorktrees);
});
