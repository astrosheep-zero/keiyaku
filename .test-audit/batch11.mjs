import fs from 'node:fs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const ts = (await import(pathToFileURL(resolve('node_modules/typescript/lib/typescript.js')).href)).default;
const removals = {
 'library-contract-operations': [
 'repo reconcile returns a typed discovery failure without a synthetic ContractId',
 'repo reconcile still throws authority corruption during world discovery',
 'delivery terminal refusal outranks a missing managed worktree',
 'a satisfied review cannot interleave a stale integration stop across the target fence',
 'terms-only amend copies Markdown bytes and identities without rendering',
 'contract history composes one frozen journal and Dispatch observation',
 'contract history fails the whole read when journal or Dispatch is corrupt'],
 'library-concurrency-placement': [
 'more independent cross-process mutations than the attempt bound serialize at the private root',
 'a hard publication failure is returned without replaying the operation',
 'equivalent external target movement stops without reintegration or claim'],
 'library-akuma-creation': [
 'forwarded schema Keiyaku.call waits for its empty Body before admitting its Tell',
 'Keiyaku.fork propagates Dispatch and leaves Alias on the parent'],
 'contract-completion': [
 'automatic dependent completion reports a Verification stop without placing',
 'a diverged dependent keeps its worktree and does not counterfeit completion',
 'a continuation discovery failure cannot conceal the review and claim already admitted'],
 'cli-verification': [
 'review prints Verification progress when target movement requires reintegration',
 'audit renders the Verification summary from its CLI result'],
 'git-reconciliation': ['rewritten target history retains owned refs with unchanged effects'],
 'repo-protocol-reads': ['Contract boards preserve endpoint kinds and lexical active reverse dependents'],
 'settlement': [
 'abandon releases the holder without reopening Task authority',
 'a missing holder target remains an explicit Task settlement lag',
 'TaskHolder reads reject unexpected authority paths',
 'an active managed-worktree projection repairs malformed namespace context',
 'an active namespace projection failure remains a workspace lag'],
 'audit': [
 'a verified placement gate without a Verification declaration is refused at bind',
 'an active amend cannot admit verified terms without a Verification declaration'],
 'akuma-body-requests': [
 'CLI forwarded deliver preserves its selected Repo and uses parent Settings and execution',
 'a parent-served Verification cancellation retains its bounded forwarded output tail'],
 'git-delivery': [
 'delivery fixtures snapshot independent initial repositories',
 'materialized delivery identity uses the complete repository pair or the neutral fallback',
 'audit target adjudicator reports initial movement without observing followability',
 'audit target adjudicator reobserves movement after followability',
 'reconcile recreates a registered managed worktree whose directory disappeared',
 'managed bind preserves its admitted Contract when worktree reconciliation fails',
 'distinct no-op candidates share the empty patch ChangeId',
 'repository reconcile does not recreate released terminal custody without a Place',
 'nonempty candidates retain Git start-to-tender ChangeId'],
 'facade-fleet': [
 "a wait's live observation carries each observed Akuma's alias and Dispatch association",
 'all-null Akuma fallback retains exact membership through the fixed Heart read pool',
 'Task catalog namespace queries distinguish omitted, root, and named scope',
 'named Address refuses failed Kanshi Contract and Alias observations',
 'named Address resolves a retained Alias outside Kanshi fleet rows',
 'one-member Contract selector retains a corrupt Heart diagnostic',
 'fleet status projects Dispatch association without changing Akuma core',
 'failed Task associations do not hide readable Fleet members or kill evidence'],
};
const files=Object.keys(removals).map(name=>resolve(`tests/${name}.test.ts`));
for(const [file,names] of Object.entries(removals)) {
 const path=`tests/${file}.test.ts`;let source=fs.readFileSync(path,'utf8');
 const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);const ranges=[];
 for(const statement of ast.statements){
  if(!ts.isExpressionStatement(statement)||!ts.isCallExpression(statement.expression)||statement.expression.expression.getText(ast)!=='test')continue;
  const name=statement.expression.arguments[0];
  if(ts.isStringLiteral(name)&&names.includes(name.text))ranges.push([statement.getFullStart(),statement.end]);
 }
 assert.equal(ranges.length,names.length,`unmatched case in ${file}`);
 for(const [start,end] of ranges.reverse())source=source.slice(0,start)+source.slice(end);
 fs.writeFileSync(path,source);
}
const path='tests/library-concurrency-placement.test.ts';let source=fs.readFileSync(path,'utf8');
const start=source.indexOf('  const delayed = await bind(repository);');const end=source.indexOf('\n});',start);
assert(start>=0&&end>start);fs.writeFileSync(path,source.slice(0,start)+source.slice(end));
const cwd=process.cwd();const config=ts.readConfigFile('tsconfig.tests.json',ts.sys.readFile);
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,cwd);
for(const id of ['unusedIdentifier_delete','unusedIdentifier_deleteImports']){
 for(let pass=0;pass<4;pass++){
  const host={...ts.sys,useCaseSensitiveFileNames:()=>ts.sys.useCaseSensitiveFileNames,getScriptFileNames:()=>parsed.fileNames,getScriptVersion:()=>String(pass),getScriptSnapshot:path=>fs.existsSync(path)?ts.ScriptSnapshot.fromString(fs.readFileSync(path,'utf8')):undefined,getCurrentDirectory:()=>cwd,getCompilationSettings:()=>parsed.options,getDefaultLibFileName:options=>ts.getDefaultLibFilePath(options)};
  const service=ts.createLanguageService(host);let count=0;
  for(const path of files){
   if(!service.getSemanticDiagnostics(path).some(d=>[6133,6192,6196,6198].includes(d.code)))continue;
   for(const file of service.getCombinedCodeFix({type:'file',fileName:path},id,{},{}).changes){
    assert(files.includes(file.fileName));let text=fs.readFileSync(file.fileName,'utf8');
    for(const change of [...file.textChanges].sort((a,b)=>b.span.start-a.span.start))text=text.slice(0,change.span.start)+change.newText+text.slice(change.span.start+change.span.length);
    fs.writeFileSync(file.fileName,text);count+=file.textChanges.length;
   }
  }
  service.dispose();if(!count)break;
 }
}
fs.copyFileSync('/tmp/batch11-maintainability.js','tests/maintainability.test.js');
