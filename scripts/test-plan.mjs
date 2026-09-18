/**
 * Run one independent source gate at a time alongside release preparation.
 * Runtime tests require successful build + transpilation, never a cached result.
 * Every started phase settles, including after another phase fails.
 * @param {(name: string) => Promise<number>} run
 * @returns {Promise<number>}
 */
export async function runReleasePlan(run) {
  /** @param {string} name */
  async function phase(name) {
    try {
      return await run(name);
    } catch (error) {
      console.error(`[test:release] ${name} could not complete`, error);
      return 1;
    }
  }
  const building = phase("build");
  const independent = (async () => {
    const results = [];
    for (const name of ["format:check", "test:architecture", "test:maintainability"]) {
      results.push(await phase(name));
    }
    return results;
  })();
  const results = [await building];
  if (results[0] === 0) {
    results.push(await phase("test:compile"));
    if (results[1] === 0) {
      // Reachability reads built exports; it shares the runtime phase, not build.
      results.push(...await Promise.all([phase("test:reachability"), phase("tests")]));
    }
  }
  results.push(...await independent);
  return results.find((status) => status !== 0) ?? 0;
}


// Median per-file costs from the three passing Node 24.20.0 / four-core
// candidate sweeps in Actions run 35311494909. These are scheduling estimates,
// never cached test outcomes, timeouts or a file-selection allowlist.
/** @type {Readonly<Record<string, number>>} */
const SWEEP_COST_MS = Object.freeze({
  "tests/actor.test.ts": 200,
  "tests/akuma-api.test.ts": 4700,
  "tests/akuma-body-requests.test.ts": 8600,
  "tests/akuma-body.test.ts": 7600,
  "tests/akuma-heart-admission.test.ts": 900,
  "tests/akuma-heart.test.ts": 4200,
  "tests/akuma-identity.test.ts": 400,
  "tests/akuma-observation.test.ts": 1600,
  "tests/akuma-physical.test.ts": 400,
  "tests/akuma-provider.test.ts": 6700,
  "tests/akuma-public.test.ts": 8900,
  "tests/akuma-requests.test.ts": 7100,
  "tests/akuma-schema.test.ts": 1300,
  "tests/amend-body.test.ts": 300,
  "tests/arc.test.ts": 2900,
  "tests/architecture.test.ts": 1200,
  "tests/audit.test.ts": 4400,
  "tests/boundary-validation.test.ts": 1900,
  "tests/build-windows-launcher.test.ts": 1000,
  "tests/cli-adaptation.test.ts": 900,
  "tests/cli-akuma-msys.test.ts": 1000,
  "tests/cli-akuma-render.test.ts": 700,
  "tests/cli-draft.test.ts": 400,
  "tests/cli-gates.test.ts": 2700,
  "tests/cli-help.test.ts": 1100,
  "tests/cli-install.test.ts": 700,
  "tests/cli-overlap-render.test.ts": 300,
  "tests/cli-parse.test.ts": 600,
  "tests/cli-progress.test.ts": 800,
  "tests/cli-projection-evidence.test.ts": 900,
  "tests/cli-render.test.ts": 1500,
  "tests/cli-selectors.test.ts": 800,
  "tests/cli-usage.test.ts": 4100,
  "tests/cli-verification.test.ts": 3200,
  "tests/completion-progress.test.ts": 400,
  "tests/contract-completion.test.ts": 10500,
  "tests/contract-document.test.ts": 300,
  "tests/contract-execution-observation.test.ts": 300,
  "tests/contract-fork.test.ts": 4900,
  "tests/contract-forwarding-result.test.ts": 1000,
  "tests/contract-guidance.test.ts": 200,
  "tests/dependency-currentness.test.ts": 200,
  "tests/dispatch-alias.test.ts": 3600,
  "tests/duration.test.ts": 200,
  "tests/facade-fleet.test.ts": 9000,
  "tests/fold.test.ts": 200,
  "tests/git-change-id.test.ts": 2700,
  "tests/git-delivery.test.ts": 11600,
  "tests/git-read-observation.test.ts": 3300,
  "tests/git-reconciliation.test.ts": 6800,
  "tests/git-repository.test.ts": 2100,
  "tests/kanshi.test.ts": 2400,
  "tests/library-akuma-creation.test.ts": 7700,
  "tests/library-concurrency-placement.test.ts": 7000,
  "tests/library-contract-operations.test.ts": 4200,
  "tests/lifecycle.test.ts": 300,
  "tests/maintainability.test.js": 600,
  "tests/markdown-ast.test.ts": 200,
  "tests/model-impact.test.ts": 3500,
  "tests/mutation-finality.test.ts": 1300,
  "tests/namespace-context.test.ts": 400,
  "tests/normalized-identity.test.ts": 300,
  "tests/nuke.test.ts": 4400,
  "tests/observation.test.ts": 300,
  "tests/package-consumers.test.ts": 4000,
  "tests/path-coordinates.test.ts": 2200,
  "tests/pi-extension.test.ts": 300,
  "tests/pi-native-identity.test.ts": 2700,
  "tests/plugin-runtime.test.ts": 1200,
  "tests/plugin-square.test.ts": 1800,
  "tests/private-state-seat.test.ts": 400,
  "tests/protocol-bind-observe.test.ts": 4900,
  "tests/protocol-concurrent-publication.test.ts": 6200,
  "tests/region-observation.test.ts": 4700,
  "tests/region-read.test.ts": 3700,
  "tests/region.test.ts": 300,
  "tests/repo-protocol-reads.test.ts": 4700,
  "tests/run-tests.test.ts": 13100,
  "tests/runtime-proc.test.ts": 10900,
  "tests/settings.test.ts": 1600,
  "tests/settlement.test.ts": 8900,
  "tests/sqlite-transaction-lock.test.ts": 400,
  "tests/target-checkout-reconcile.test.ts": 13000,
  "tests/target-placement-preparation.test.ts": 5500,
  "tests/task-compose.test.ts": 4200,
  "tests/task-document.test.ts": 400,
  "tests/task-operations.test.ts": 3400,
  "tests/task-store.test.ts": 1000,
  "tests/v4-cut.test.ts": 300,
  "tests/verification-producer.test.ts": 1000,
  "tests/verification-scratch.test.ts": 4600,
  "tests/windows-akuma-process.test.ts": 5400,
  "tests/worktree-hooks.test.ts": 8200,
  "tests/worktree-places.test.ts": 8200,
  "tests/world.test.ts": 800
});

/**
 * Start expensive files first even when their source is short. Unknown files
 * still run, using source size as a conservative initial estimate.
 * @template {{ file: string, size: number }} T
 * @param {readonly T[]} entries
 * @returns {T[]}
 */
export function orderSweepEntries(entries) {
  /** @param {T} entry */
  const cost = (entry) => SWEEP_COST_MS[entry.file.replaceAll("\\", "/")] ?? entry.size / 10;
  return [...entries].sort((left, right) =>
    cost(right) - cost(left) || right.size - left.size || left.file.localeCompare(right.file));
}
