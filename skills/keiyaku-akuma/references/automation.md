# Automation With The Akuma API

Use this guide when the work calls for a JavaScript program that coordinates
agents rather than manual CLI calls: multi-agent tournaments, pairwise
comparisons, adversarial claim checking, or custom experiment loops.

## When To Write A Job-Specific Harness

Write a small `.mjs` script when intermediate answers belong in JavaScript
variables and control flow (branching, filtering, bounded concurrency,
stopping conditions) rather than in the flagship's conversation context:

| Job | Orchestration shape |
| --- | --- |
| Visual or naming tournament | Generate candidates from distinct directions; anonymize; run pairwise judges; generate another round targeting discovered weaknesses. |
| Qualitative ranking | Use agents as pairwise comparators while code maintains buckets or brackets; repeat disputed comparisons. |
| Claim or doc verification | Extract checkable claims; fan out verification against sources; send only `supported` verdicts to fresh adversarial skeptics. |
| Rare failure diagnosis | Generate competing hypotheses from logs/code; have agents propose distinguishing experiments; eliminate hypotheses from actual results. |
| Untrusted issue triage | Separate readers of untrusted text (returning bounded structured evidence) from actors with mutation authority. |

Create separate Akumas (`@judge-1`, etc., or distinct `Akumas.spawn`
instances) for blind comparisons and adversarial checks so a judge never grades
its own earlier work.

## Public Entry And Structured Turns

Run an ESM script in a project where `@astrosheep/keiyaku` resolves. Keep
schemas inside simple JSON shape vocabulary (`object`, `array`, `string`,
`number`, `boolean`, `enum`, `literal`, `optional`, `nullable`); do not attach
`.min`, `.max`, `.regex`, `.refine`, or `.transform` (the seam refuses fragile
provider constraints at submission — enforce bounds in ordinary JS after the
answer arrives).

```js
import { Akuma, Akumas, World, z } from "@astrosheep/keiyaku";

const root = await World.at(process.cwd());
const akumaName = process.env.AKUMA_NAME ?? "worker";

const Verdict = z.object({
  verdict: z.enum(["supported", "contradicted", "unknown"]),
  evidence: z.array(z.object({ path: z.string(), observation: z.string() })),
  reason: z.string(),
});

// 1. One-shot structured spawn (birth + first Tell + wait):
const spawned = await Akumas.of(root).spawn({
  akumaName,
  cwd: process.cwd(),
  body: "Read-only check: verify whether src/index.ts exports World.",
  schema: Verdict,
  mode: "wait",
});
if (spawned.observation.kind !== "observed" || spawned.observation.observation.reason !== "answered") {
  throw new Error("Did not answer: " + JSON.stringify(spawned.observation));
}
console.log(spawned.akuma, spawned.observation.observation.answer);

// 2. Reconnect to the same AkuId for a follow-up turn after Body settlement:
const worker = Akuma.select(root, spawned.akuma);
await worker.idle();
const followUp = await worker.ask("Now check whether Repo is also exported.", {
  schema: Verdict,
});
if (followUp.observation.reason === "answered") {
  console.log(followUp.observation.answer);
}
```

## Control, Concurrency, And Reconnection Rules

- **Await `idle()` before the next schema Tell on the same Akuma:** an answer
  can become visible slightly before its Body finishes settling. Separate
  Akumas can run in parallel without waiting for each other.
- **`idle({ timeoutMs })` and `Promise.race` do not stop the worker:** a
  timeout only ends the wait. `idle()` resolves `{ kind: "idle", status, reason }`
  (`"asleep" | "killed" | "hung" | "untidy" | "stranded"`) or
  `{ kind: "timeout", status, reason: { running, pendingTell } }`.
- **Check the observation arm before reading `answer`:** `AskResult`
  distinguishes `"answered"`, `"failed"`, `"invalid-output"`, `"unanswered"`,
  and `"deadline"`.
- **Persist `AkuId`s and completed stage results in your own file if the script
  must survive restarts:** `Akuma.select(root, savedId)` reconnects
  synchronously (`status()` and `history()` inspect prior state), rather than
  blindly rerunning completed turns.
- **Worktree isolation:** `Akumas.spawn` does not create an isolated Contract
  worktree; give parallel writers non-overlapping paths or dedicated worktrees.
