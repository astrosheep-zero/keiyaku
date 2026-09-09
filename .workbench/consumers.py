from pathlib import Path
import subprocess,re
root=Path('.')
old=subprocess.check_output(['git','show','6d69c35:tests/public-library.test.ts'],cwd=root,text=True)
p=root/'tests/public-library.test.ts'; cur=p.read_text()
def testblock(text,name):
    start=text.index('test("'+name+'"')
    end=text.find('\ntest(',start+1)
    return start, len(text) if end<0 else end
newname='built package supports Contract, Task, Kanshi and plugin consumers'
a,b=testblock(old,newname); new=old[a:b]
for name in ['package root exposes only the ruled library values and declarations','kanshi package export names the three-arm Region read union','task package export exposes only the Tasks-first native surface']:
    a,b=testblock(cur,name);cur=cur[:a]+(new if name.startswith('package root') else '')+cur[b:]
cur=cur.replace('import { existsSync,','import { copyFileSync, rmSync, existsSync,')
cur=cur.replace('import { execFileSync }','import { execFileSync, spawnSync }')
cur=cur.replace('import test from "node:test";','import test, { type TestContext } from "node:test";')
cur=cur.replace('function externalConsumer(): string {','function externalConsumer(context: TestContext): string {')
cur=cur.replace('const directory = mkdtempSync(join(tmpdir(), "keiyaku-v4-consumer-"));','const directory = mkdtempSync(join(tmpdir(), "keiyaku-v4-consumer-"));\n  context.after(() => rmSync(directory, { recursive: true, force: true }));')
cur=cur.replace('test("package exports reject deep internal imports", () => {\n  const directory = externalConsumer();','test("package exports reject deep internal imports", (context) => {\n  const directory = externalConsumer(context);')
a=cur.index('  assert.deepEqual(\n    Object.getOwnPropertyNames(Keiyaku)')
b=cur.index('  assert.equal(await repo.currentBranch()',a)
cur=cur[:a]+cur[b:]
a,b=testblock(cur,'public handle values are type tokens, not alternate constructors')
cur=cur[:a]+cur[b:];cur=cur.replace('  Delivery,\n','')
p.write_text(cur)
for name in ['contract','task','kanshi','plugin']:
    dest=root/f'tests/fixtures/consumers/{name}.ts';dest.parent.mkdir(exist_ok=True,parents=True)
    dest.write_text(subprocess.check_output(['git','show',f'6d69c35:tests/fixtures/consumers/{name}.ts'],cwd=root,text=True))
f=root/'tests/fixtures/consumers/contract.ts'
s=f.read_text()+'''
// @ts-expect-error selectors require branded Contract identities
Keiyaku.of({ repo, id: "kei/unbranded" });
// @ts-expect-error prerequisite identities cannot be unbranded strings
Keiyaku.bind({ repo, markdown, after: ["kei/unbranded"] });
// @ts-expect-error obsolete singular cleanup is not a public result
reviewed.leak;
// @ts-expect-error a Repo cannot act as an alternative construction facade
repo.bind(input);
// @ts-expect-error a Delivery review takes an input object
(null as unknown as Delivery).review("satisfied");
// @ts-expect-error abandonment takes an options object
selected.abandon("manual");
'''
f.write_text(s)
(root/'tests/plugin-types.test.ts').unlink()
for name in ['scripts/test-manifests.mjs','tsconfig.tests.json']:
    f=root/name; s=f.read_text();s=re.sub(r'^.*"tests/plugin-types\.test\.ts",?\n','',s,flags=re.M);f.write_text(s)
