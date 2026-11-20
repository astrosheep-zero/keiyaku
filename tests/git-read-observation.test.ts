import assert from "node:assert/strict";
import test from "node:test";
import { GIT_REF, readGitPaths, repositoryAt } from "../src/git/repository.js";
import {
  withGitDecodeChannel,
  withGitReadObservation,
  type GitDecodeChannel,
  type GitReadObservation,
} from "../src/git/read-observation.js";
import { makeGitRepository } from "./support/git.js";

const MISSING_OID = "0000000000000000000000000000000000000000";

test("Git read observation returns typed missing objects and closes its capabilities", async () => {
  const repository = makeGitRepository();
  let retained: GitReadObservation | undefined;
  let retainedChannel: GitDecodeChannel | undefined;
  const git = await repositoryAt(repository.path);
  const result = await withGitDecodeChannel(git, (channel) => {
    retainedChannel = channel;
    return withGitReadObservation(git, channel, async (observation) => {
      retained = observation;
      return (await observation.readBlobs([MISSING_OID])).get(MISSING_OID);
    });
  });
  assert.deepEqual(result, { kind: "missing" });
  await assert.rejects(readGitPaths(git, ["../invalid"]), /invalid Git path/u);
  await assert.rejects(retained!.selectPaths([]), /Git read observation is closed/u);
  await assert.rejects(retained!.readBlobs([]), /Git read observation is closed/u);
  await assert.rejects(retained!.resolveRef("refs/heads/main"), /Git read observation is closed/u);
  await assert.rejects(retainedChannel!.readObjects([]), /Git decode channel is closed/u);
  await assert.rejects(retainedChannel!.readRef(GIT_REF), /Git decode channel is closed/u);
  await assert.rejects(retainedChannel!.readTreeSelection(MISSING_OID, {}), /Git decode channel is closed/u);
});
