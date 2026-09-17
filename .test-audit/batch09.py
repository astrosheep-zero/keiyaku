from pathlib import Path

def replace(s, old, new):
    assert s.count(old) == 1, (old[:80], s.count(old))
    return s.replace(old, new)

def remove_test(s, name):
    start = s.index('test("' + name + '"')
    end = s.find('\ntest(', start + 1)
    assert end > start
    return s[:start] + s[end + 1:]

p = Path('tests/facade-fleet.test.ts'); s = p.read_text()
s = replace(s, 'const oldCount = 490;', '// Fifty-one members cross the default page boundary without a 501-database stress fixture.\n  const oldCount = 40;')
s = replace(s, '''    const page = await world.list({ limit: 10 });
    DatabaseSync.prototype.prepare = originalPrepare;
    const defaultPage = await world.list();
    const maximumPage = await world.list({ limit: 500 });
    const complete = await world.listComplete();''', '''    const page = await world.list({ limit: 10 });
    const pageReads = prepareCalls;
    prepareCalls = 0;
    const complete = await world.listComplete();
    const completeReads = prepareCalls;
    DatabaseSync.prototype.prepare = originalPrepare;
    const defaultPage = await world.list();
    const maximumPage = await world.list({ limit: 500 });''')
s = replace(s, '    assert.ok(prepareCalls < 500, `expected a bounded Heart read pool, received ${prepareCalls} database prepares`);', '''    assert.ok(pageReads > 0, "the page must read actual Hearts");
    assert.ok(pageReads < completeReads, `page reads ${pageReads} must prune the full ${completeReads} reads`);''')
s = replace(s, '    assert.equal(maximumPage.hasMore, true);', '    assert.equal(maximumPage.hasMore, false);')
p.write_text(s)
p = Path('tests/library-akuma-creation.test.ts'); s = p.read_text()
s = replace(s, '    const owner = (await bound.keiyaku.state()).id;', '''    const owner = (await bound.keiyaku.state()).id;
    const appointment = await readManagedWorktreeAppointment(git, owner);
    assert.ok(appointment.kind === "appointed", 'expected appointment.kind = "appointed"');''')
s = replace(s, '''        "--contract",
        owner,
        "--workdir",
        ".",
        "--alias",''', '''        "--contract",
        owner,
        "--alias",''')
s = replace(s, '''    assert.deepEqual(associated.execution, { cwd: realpathSync(executionCwd), source: "input" });
    assert.equal((await readSoul(pathsForAkuId(world, associated.akuma)))?.cwd, realpathSync(executionCwd));''', '''    assert.deepEqual(associated.execution, { cwd: appointment.path, source: "contract-worktree" });
    assert.equal((await readSoul(pathsForAkuId(world, associated.akuma)))?.cwd, appointment.path);''')
s = replace(s, '    assert.notEqual(await readDispatch(git, partial.akuma), null);', '''    assert.notEqual(await readDispatch(git, partial.akuma), null);
    assert.deepEqual(partial.execution, { cwd: realpathSync(executionCwd), source: "input" });
    assert.equal((await readSoul(pathsForAkuId(world, partial.akuma)))?.cwd, realpathSync(executionCwd));''')
s = replace(s, '''    const routed = await routedKeiyaku.call({
      path: world,
      archetype: "worker",
      body: "routed",
      ...configured.placement,
      mode: "detach",
    });
    assert.deepEqual(routed.observation, { kind: "detached" });
''', '')
s = remove_test(s, 'managed Contract calls use the appointed Place only when cwd is omitted')
s = s.replace('Keiyaku.call keeps optional Dispatch and Alias stages honest', 'Keiyaku.call preserves dispatch, alias failure, and managed versus explicit cwd')
p.write_text(s)
p = Path('tests/contract-completion.test.ts'); s = p.read_text()
name = 'review after delivery uses the same completion node without replaying delivery facts'
start = s.index('test("' + name + '"'); end = s.index('\ntest(', start + 1)
block = s[start:end]
block = replace(block, '  const review = await contract.review({ verdict: "satisfied" });', '''  const rejected = await contract.review({ verdict: "unsatisfied", summary: "not accepted" });
  assert.deepEqual(rejected.facts.map((fact) => fact.kind), ["attestation"]);
  assert.equal(rejected.value.completion, undefined);
  assert.equal(rejected.value.placement, undefined);
  assert.equal((await contract.state()).terminal, null);

  const review = await contract.review({ verdict: "satisfied" });''')
s = s[:start] + block + s[end:]
s = remove_test(s, 'an unsatisfied review never requests trailing placement')
s = s.replace(name, 'review after delivery can reject then complete without replaying delivery facts')
p.write_text(s)
