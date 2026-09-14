---
name: keiyaku-field-test
description: Use when evaluating Keiyaku by watching agents use it for real work in isolated repositories, then reproducing and reporting the friction they encounter.
---

# Keiyaku Field Test

Give agents useful work. Let them discover how to do it with Keiyaku. Watch
where the tool helps, where they hesitate, and where their understanding of
what happened diverges from reality. Follow those moments to reproducible
findings, not just a pass/fail score.

This skill supplies a testing method, not product law. Read `SOUL.md` and
`docs/README.md`; consult the relevant owner chapters when judging a behavior.
Current help and shipped skills are the interface being tested, not a command
sequence to duplicate here.

## Pick Work That Reveals Something

Inspect the target repository and choose small, real changes with checkable
outcomes. A test-only task can reveal whether lightweight work is economical.
A bug fix with a reviewer can expose handoff friction. Related parallel changes
can exercise supervision and integration. These are useful contrasts, not a
required three-lane suite. Follow the user's question and what you learn.

Use the requested model; when the choice is open, pi-flash is a useful starting
point for observing discovery and recovery. Record what actually ran. Do not
silently switch models to make the experiment succeed.

## Give The Agent The Problem, Not The Answer

The brief needs an objective, workspace, tool entry point, scope, and a place
to report results. Add a workflow condition only when it is what you are testing,
such as independent review or nested delegation. Let the agent find the skills,
read help, choose commands, encounter refusals, and recover.

Do not preload known bugs or workarounds. Do not turn every wrong turn into a
coaching message. Ask for the confusing commands and outputs in the final
report, but treat that report as leads to investigate, not established findings.

## Make Room For Mistakes Without Damaging Real Work

Use independent clones outside the original repositories. Keep evidence outside
candidate patches. Record the starting commits and existing dirty work; forbid
pushes, releases, global configuration edits, and acceptance bypasses. Use npm
only and establish a working baseline before attributing failures to Keiyaku.

Keep the tested runtime stable and identifiable. A copied build with hashes is
one option; record shared dependencies and inherited settings rather than
calling it hermetic. Make sure nested agents use the same intended runtime.
Do not fix the product during an observation run. Fixes are separate work.

## Watch The Caller Experience

Use public waits, status, history, and receipts. Can the holder tell who is doing
what, whether a delivery is reviewed, why it stopped, and what actually landed?
Notice extra lookups, misleading summaries, configuration guesses, and outcomes
sent to the wrong caller. A workflow that eventually succeeds can still be costly
to use. A clear refusal followed by easy recovery may be working as intended.

Retain enough context to revisit an incident: command, cwd, exit code, output,
identities, and the relevant state. Prefer evidence at meaningful transitions
over indiscriminate polling. Do not infer private history from missing output
or inspect private databases to compensate for a confusing public interface.

Intervene when safety, scope, or an actual external blocker requires it, and
record the intervention. Never run observer builds or tests in a checkout an
agent is still using: two builds cleaning the same output directory can create
your own failure. Preserve contaminated evidence, label it, and rerun exclusively.

## Turn Surprises Into Findings

Reproduce the smallest surprising case once the state is stable. Distinguish a
product defect from a help gap, normal refusal, agent error, provider failure,
or your own interference. Check the owner documents before declaring a bug.
Trace causes against the implementation matching the tested runtime.

Compare like with like: exact and grouped reads of the same settled state, or
text and JSON rendered from the same saved observation. Synthetic probes can
isolate a cause, but do not pretend they happened in the real run. Leave an
unresolved suspicion unresolved when the evidence cannot settle it.

Independently verify final patches, placement, and tests. Report findings by
impact with concrete reproductions and evidence links, alongside what worked,
what needed help, and what was not exercised. Do not inflate one small run into
a claim about every provider or workflow.

Before closing, account for all experimental agents, stop any observer you
started, and check the original repositories were preserved. Keep the report
and evidence available. The useful result is a clearer account of the caller's
experience and its causes, not a completed checklist or an unsolicited fix.
