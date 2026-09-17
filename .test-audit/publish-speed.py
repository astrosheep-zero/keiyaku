from pathlib import Path
p=Path('tests/facade-fleet.test.ts')
s=p.read_text().replace('import { mkdirSync,','import { constants, copyFileSync, mkdirSync,',1)
i=s.index('function catalogOf')
s=s[:i]+'''// The template is a closed, unborn database pair: no Soul or identity-bound facts.
// Copy bytes, never hard-link them, so every catalog member keeps independent custody.
async function initializeUnbornFixture(
  paths: Parameters<typeof initializeHeart>[0],
  template: Parameters<typeof initializeHeart>[0] | undefined,
): Promise<void> {
  if (template === undefined) return initializeHeart(paths);
  copyFileSync(template.heart, paths.heart, constants.COPYFILE_EXCL);
  copyFileSync(template.leash, paths.leash, constants.COPYFILE_EXCL);
}

'''+s[i:]
a=s.index('test("recent Akuma page prunes'); b=s.index('test("Task catalog uses',a)
section=s[a:b]
section=section.replace('  const originalPrepare = DatabaseSync.prototype.prepare;', '  const originalPrepare = DatabaseSync.prototype.prepare;\n  let template: Parameters<typeof initializeHeart>[0] | undefined;')
section=section.replace('      await initializeHeart(allocated.paths);', '      await initializeUnbornFixture(allocated.paths, template);\n      template ??= allocated.paths;')
section=section.replace('      await initializeHeart(value.paths);','      await initializeUnbornFixture(value.paths, template);\n      template ??= value.paths;')
s=s[:a]+section+s[b:]
p.write_text(s)
p=Path('tests/plugin-runtime.test.ts')
s=p.read_text().replace('import test from "node:test";', 'import test, { type TestContext } from "node:test";')
s=s.replace('    await new Promise<void>((resolve) => setTimeout(resolve, 5));','    // Real I/O readiness must still progress when an individual test controls deadlines.\n    await new Promise<void>((resolve) => setImmediate(resolve));')
i=s.index('test("plugin runtime selects')
s=s[:i]+'''// Keep the monotonic budget and its timers on the same clock. Readiness polling
// uses real Date/setImmediate, so a missing effect fails instead of hanging on fake time.
function deadlineClock(context: TestContext): (milliseconds: number) => void {
  let now = 0;
  context.mock.timers.enable({ apis: ["setTimeout"] });
  context.mock.method(performance, "now", () => now);
  return (milliseconds) => {
    now += milliseconds;
    context.mock.timers.tick(milliseconds);
  };
}

'''+s[i:]
for title in ['hanging activation is bounded independently and does not replay an emission','hanging handler is cancelled at the delivery bound without blocking another handler','a timed-out handler does not share cancellation with another handler']:
 s=s.replace(f'test("{title}", async () => {{',f'test("{title}", async (context) => {{')
a=s.index('test("hanging activation'); b=s.index('test("hanging handler',a)
part=s[a:b]
part=part.replace('activate(context, cancellation) { return new Promise', 'activate(context, cancellation) { appendFileSync(context.config.trace, "activation-started\\\\n"); return new Promise')
old='''    const runtime = await Promise.race([
      pluginRuntime({ world: await World.at(value.root), reportDiagnostic: (value) => diagnostics.push(value) }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("runtime blocked")), 100)),
    ]);
    await eventually(() => trace(output).includes("activated"));
    await runtime.emit({ kind: "akuma.called", akumaId: "aku/example" }, (value) => diagnostics.push(value));
    assert.deepEqual(trace(output), ["activated", "activation-aborted", "called"]);'''
new='''    const advance = deadlineClock(context);
    const runtime = await pluginRuntime({ world: await World.at(value.root), reportDiagnostic: (value) => diagnostics.push(value) });
    await eventually(() => trace(output).includes("activated"));
    assert.deepEqual(trace(output), ["activation-started", "activated"]);
    // The emission starts after activation and therefore owns a later deadline.
    advance(1);
    const emission = runtime.emit({ kind: "akuma.called", akumaId: "aku/example" }, (value) => diagnostics.push(value));
    await new Promise<void>((resolve) => setImmediate(resolve));
    advance(4_998);
    assert.deepEqual(trace(output), ["activation-started", "activated"]);
    advance(1);
    await emission;
    assert.deepEqual(trace(output), ["activation-started", "activated", "activation-aborted", "called"]);'''
assert old in part
part=part.replace(old,new)
s=s[:a]+part+s[b:]
a=s.index('test("hanging handler'); b=s.index('test("a timed-out handler',a)
part=s[a:b]
old='''      const started = Date.now();
      await runtime.emit({ kind: "akuma.called", akumaId: "aku/example" }, (value) => diagnostics.push(value));
      assert.equal(Date.now() - started >= 4_500, true);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));'''
new='''      const advance = deadlineClock(context);
      const emission = runtime.emit({ kind: "akuma.called", akumaId: "aku/example" }, (value) => diagnostics.push(value));
      await eventually(() => trace(output).includes("called"));
      advance(4_999);
      assert.deepEqual(trace(output), ["activated", "called"]);
      advance(1);
      await emission;
      await new Promise<void>((resolve) => setImmediate(resolve));'''
assert old in part
part=part.replace(old,new)
s=s[:a]+part+s[b:]
a=s.index('test("a timed-out handler'); b=s.index('test("completed plugin emissions',a)
part=s[a:b]
old='''    const runtime = await pluginRuntime({ world: await World.at(value.root) });
    await runtime.emit({ kind: "akuma.called", akumaId: "aku/example" });
    assert.notEqual(cancellations.first, cancellations.second);'''
new='''    const advance = deadlineClock(context);
    const runtime = await pluginRuntime({ world: await World.at(value.root) });
    const emission = runtime.emit({ kind: "akuma.called", akumaId: "aku/example" });
    await eventually(() => cancellations.first !== undefined && cancellations.second !== undefined);
    assert.notEqual(cancellations.first, cancellations.second);
    advance(4_999);
    assert.equal(cancellations.first?.aborted, false);
    assert.equal(cancellations.second?.aborted, false);
    assert.deepEqual(trace(output), []);
    advance(1);
    await emission;'''
assert old in part
part=part.replace(old,new)
s=s[:a]+part+s[b:]
for title in ['hanging activation is bounded independently and does not replay an emission','hanging handler is cancelled at the delivery bound without blocking another handler','a timed-out handler does not share cancellation with another handler']:
 s=s.replace(f'test("{title}", async (context) => {{', f'test("{title}", {{ timeout: 5_000 }}, async (context) => {{')
s=s.replace('    const runtime = await pluginRuntime({ world: await World.at(value.root), reportDiagnostic: (value) => diagnostics.push(value) });','    const runtime = await pluginRuntime({\n      world: await World.at(value.root),\n      reportDiagnostic: (value) => diagnostics.push(value),\n    });')
p.write_text(s)
