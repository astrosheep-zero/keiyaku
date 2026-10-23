import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { Keiyaku, Repo } from "../src/index.js";
import { consumeGitStdout, executeGit, runGitPipe } from "../src/git/process.js";
import { withGitDecodeChannel } from "../src/git/read-observation.js";
import { GIT_REF } from "../src/git/repository.js";
import { cachedRepositoryAt } from "./support/git.js";
import { accepted, document, repositoryWithMain } from "./support/library-verbs.js";

async function withEnvironment(environment: NodeJS.ProcessEnv, action: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    await action();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function redirectTo(path: string): NodeJS.ProcessEnv {
  return {
    GIT_DIR: join(path, ".git"),
    GIT_WORK_TREE: path,
    GIT_INDEX_FILE: join(path, ".git", "index"),
    GIT_OBJECT_DIRECTORY: join(path, ".git", "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(path, ".git", "objects"),
    GIT_COMMON_DIR: join(path, ".git"),
    GIT_NAMESPACE: "foreign",
  };
}

test("a resolved Repo reads and binds only its own repository after ambient Git redirection", async () => {
  const a = repositoryWithMain({ files: { "a.txt": "A\n" } });
  const b = repositoryWithMain({ files: { "b.txt": "B\n" } });
  a.run(["branch", "-m", "pinned-a"]);
  b.run(["branch", "-m", "foreign-b"]);
  const repo = await Repo.at({ path: a.path });
  await withEnvironment(redirectTo(b.path), async () => {
    assert.equal(await repo.currentBranch(), "refs/heads/pinned-a");
    const contract = await Keiyaku.with().bind({
      repo,
      markdown: document(),
      workspace: "worktree",
      target: null,
      gates: [],
    });
    const handle = accepted(contract).value.keiyaku;
    assert.notEqual(await handle.state(), null, "the journal must also decode under ambient redirection");
  });

  assert.notEqual(a.run(["for-each-ref", "--format=%(refname)", GIT_REF]).trim(), "");
  assert.equal(b.run(["for-each-ref", "--format=%(refname)", "refs/keiyaku", GIT_REF]), "");
});

test("Git pipelines, stdout consumers and batch readers keep pinned object custody and explicit metadata", async () => {
  const a = repositoryWithMain({ files: { "payload.txt": "pinned payload\n" } });
  const b = repositoryWithMain({ files: { "payload.txt": "foreign payload\n" } });
  const git = await cachedRepositoryAt(a.path);
  const head = a.run(["rev-parse", "HEAD"]).trim();
  const tree = a.run(["rev-parse", "HEAD^{tree}"]).trim();
  const blob = a.run(["rev-parse", "HEAD:payload.txt"]).trim();
  let piped = "";

  await withEnvironment(
    {
      ...redirectTo(b.path),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "keiyaku.environment",
      GIT_CONFIG_VALUE_0: "preserved",
      GIT_AUTHOR_NAME: "Ambient Author",
      GIT_COMMITTER_NAME: "Ambient Committer",
    },
    async () => {
      assert.equal((await executeGit(git, ["config", "--get", "keiyaku.environment"])).toString(), "preserved\n");
      const chunks: Buffer[] = [];
      await consumeGitStdout(git, ["show", "HEAD:payload.txt"], (chunk) => chunks.push(chunk));
      assert.equal(Buffer.concat(chunks).toString(), "pinned payload\n");
      await withGitDecodeChannel(git, async (channel) => {
        assert.deepEqual((await channel.readObjects([blob])).get(blob), {
          kind: "present",
          type: "blob",
          bytes: Buffer.from("pinned payload\n"),
        });
      });
      piped = (await runGitPipe(git, ["rev-parse", "HEAD"], ["hash-object", "-w", "--stdin"])).toString().trim();
      const commit = (
        await executeGit(git, ["commit-tree", tree], "explicit identity\n", {
          GIT_AUTHOR_NAME: "Explicit Author",
          GIT_AUTHOR_EMAIL: "author@example.invalid",
          GIT_COMMITTER_NAME: "Explicit Committer",
          GIT_COMMITTER_EMAIL: "committer@example.invalid",
          GIT_AUTHOR_DATE: "2025-01-02T03:04:05Z",
          GIT_COMMITTER_DATE: "2025-01-02T03:04:05Z",
        })
      )
        .toString()
        .trim();
      assert.equal(
        (await executeGit(git, ["show", "-s", "--format=%an%n%ae%n%cn%n%ce%n%at%n%ct", commit])).toString(),
        "Explicit Author\nauthor@example.invalid\nExplicit Committer\ncommitter@example.invalid\n1735787045\n1735787045\n",
      );
    },
  );

  assert.equal(a.run(["cat-file", "blob", piped]), `${head}\n`, "both pipeline commands must use A");
  assert.equal(
    b.run(["cat-file", "--batch-check"], `${piped}\n`),
    `${piped} missing\n`,
    "the sink must not write into B",
  );
});
