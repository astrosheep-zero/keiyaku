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
