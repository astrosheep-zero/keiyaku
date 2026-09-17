import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(`${process.cwd()}/package.json`);
const ts = require('typescript');
const read = (file) => readFileSync(file, 'utf8');
const write = (file, text) => writeFileSync(file, text);

const api = read('tests/akuma-api.test.ts');
const start = api.indexOf('type FixtureSession =');
const stop = api.indexOf('test("plain tell returns');
let shared = api.slice(start, stop)
  .replace(/^function /gm, 'export function ')
  .replace(/^async function /gm, 'export async function ')
  .replaceAll('"api-fixture-turn"', '"tell-fixture-turn"')
  .replaceAll('"api-answer"', '"tell-answer"')
  .replaceAll('"api-session"', '"tell-session"')
  .replaceAll('"api-history"', '"tell-history"');
const birthStart = shared.indexOf('  await holder.birth(');
const birthEnd = shared.indexOf('  return { world,', birthStart);
const birth = shared.slice(birthStart, birthEnd).replace('  holder.release();\n', '');
shared = shared.slice(0, birthStart) + '  try {\n' + birth.split('\n').filter(Boolean).map((line) => `  ${line}\n`).join('') + '  } finally {\n    holder.release();\n  }\n' + shared.slice(birthEnd);
const header = `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Akuma } from "../../src/akuma/index.js";
import { ALLOWED_ACTIONS } from "../../src/akuma/allowed.js";
import { AkumaHandle } from "../../src/akuma/akuma-handle.js";
import { driveAkumaBody, type TellWakeRuntime } from "../../src/akuma/body.js";
import { HeldAkumaLeash, initializeHeart } from "../../src/akuma/heart/index.js";
import { allocateAkumaDirectory } from "../../src/akuma/identity.js";
import { createProviderAttempt, type ProviderAdapter, type Session } from "../../src/akuma/provider.js";
import { World } from "../../src/world.js";

`;
write('tests/support/akuma-tell.ts', header + shared);
for (const name of ['akuma-api', 'akuma-schema']) {
  const file = `tests/${name}.test.ts`;
  let text = read(file);
  const from = text.indexOf('type FixtureSession =');
  const to = text.indexOf(name === 'akuma-api' ? 'test("plain tell returns' : 'function foreignSchema');
  const names = ['answering', 'bornWorld', 'fixtureRuntime', 'installTellRuntime', 'settleFixtureBodies'];
  if (name === 'akuma-api') names.splice(2, 0, 'fixtureAttempt');
  text = text.slice(0, from) + 'import {\n' + names.map((key) => `  ${key},\n`).join('') + '} from "./support/akuma-tell.js";\n\n' + text.slice(to);
  text = text.replace('import { createProviderAttempt, type ProviderAdapter, type Session }', 'import { type ProviderAdapter }');
  if (name === 'akuma-api') {
    text = text.replace('import { HeldAkumaLeash, initializeHeart, readTell, readTurn, recordTell }', 'import { initializeHeart, readTell, readTurn, recordTell }');
    text = text.replace('import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";\n', '');
    text = text.replace('import { AkumaHandle } from "../src/akuma/akuma-handle.js";\n', '');
    text = text.replace('import { allocateAkumaDirectory } from "../src/akuma/identity.js";\n', '');
    text = text.replace('import { driveAkumaBody, type TellWakeRuntime }', 'import { AkumaHandle } from "../src/akuma/akuma-handle.js";\nimport { allocateAkumaDirectory } from "../src/akuma/identity.js";\nimport { driveAkumaBody }');
  } else {
    text = text.replace('import { mkdirSync, mkdtempSync, rmSync, writeFileSync }', 'import { mkdtempSync, rmSync }');
    text = text.replace('import { Akuma, Schema, type StandardSchemaV1 }', 'import { Schema, type StandardSchemaV1 }');
    for (const line of [
      'import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";',
      'import { AkumaHandle } from "../src/akuma/akuma-handle.js";',
      'import { driveAkumaBody, type TellWakeRuntime } from "../src/akuma/body.js";',
      'import { HeldAkumaLeash, initializeHeart } from "../src/akuma/heart/index.js";',
      'import { allocateAkumaDirectory } from "../src/akuma/identity.js";',
      'import { World } from "../src/world.js";',
    ]) text = text.replace(`${line}\n`, '');
  }
  write(file, text);
}

function rewrite(file, inspect) {
  const text = read(file);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const edits = [];
  function walk(node) { inspect(node, source, edits); ts.forEachChild(node, walk); }
  walk(source);
  let result = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  console.log(file, edits.length);
  return result;
}
let provider = rewrite('tests/akuma-provider.test.ts', (node, source, edits) => {
  if (!ts.isObjectLiteralExpression(node) || node.properties.length < 6) return;
  if (!node.properties.some((p) => ts.isSpreadAssignment(p) && p.expression.getText(source) === 'DRIVE_DEFAULTS')) return;
  const props = new Map(node.properties.filter(ts.isPropertyAssignment).map((p) => [p.name.getText(source), p]));
  if (!['body', 'launchTells', 'cwd', 'options', 'session'].every((key) => props.has(key))) return;
  if (props.get('session').initializer.getText(source).replace(/\s+/g, '') !== '{kind:"fresh"}') return;
  const extra = node.properties.filter((p) => {
    if (ts.isSpreadAssignment(p)) return p.expression.getText(source) !== 'DRIVE_DEFAULTS';
    if (!ts.isPropertyAssignment(p)) return true;
    const key = p.name.getText(source), value = p.initializer.getText(source).replace(/\s+/g, '');
    if (key === 'body' || key === 'session') return false;
    if (key === 'cwd' && value === '"/tmp"') return false;
    if (key === 'launchTells' && value === '[]') return false;
    if (key === 'options' && value === '{}') return false;
    return true;
  });
  const body = props.get('body').initializer.getText(source);
  edits.push({ start: node.getStart(source), end: node.end, text: `freshInput(${body}${extra.length ? ', { ' + extra.map((p) => p.getText(source)).join(', ') + ' }' : ''})` });
});
provider = provider.replace('  type TurnResult,', '  type TurnResult,\n  type DriveInput,');
const helperAt = provider.indexOf('function attemptResult');
provider = provider.slice(0, helperAt) + `/** Fresh carrier objects; non-default recipe and admission inputs remain at each call site. */
function freshInput(body: string, extra: Partial<Omit<DriveInput, "session">> = {}): DriveInput & { session: { kind: "fresh" } } {
  return { ...DRIVE_DEFAULTS, body, launchTells: [], cwd: "/tmp", options: {}, ...extra, session: { kind: "fresh" } };
}

` + provider.slice(helperAt);
write('tests/akuma-provider.test.ts', provider);

let requests = rewrite('tests/akuma-body-requests.test.ts', (node, source, edits) => {
  if (!ts.isCallExpression(node) || node.expression.getText(source) !== 'openContractPump' || !node.arguments[1] || !ts.isObjectLiteralExpression(node.arguments[1])) return;
  const object = node.arguments[1];
  const kept = object.properties.filter((p) => !p.name || !['wait', 'tell', 'kill'].includes(p.name.getText(source)));
  if (kept.length === object.properties.length) return;
  const removed = object.properties.filter((p) => !kept.includes(p));
  if (!removed.every((p) => /throw new Error\("unexpected (wait|tell|kill)"\)/.test(p.getText(source)))) throw new Error('refusing to remove meaningful mock');
  edits.push({ start: object.getStart(source), end: object.end, text: '{\n' + kept.map((p) => p.getText(source)).join(',\n') + ',\n}' });
});
requests = requests.replace('  port: Pick<ContractRequestPort, "deliver"> &\n    Partial<Pick<ContractRequestPort, "audit" | "review">> &\n    Partial<FleetRequestPort>,', '  port: Partial<ContractRequestPort>,');
requests = requests.replace('commands: contractRequestCommands(port as ContractRequestPort),', 'commands: contractRequestCommands({ ...unusedContractPort, ...port }),');
write('tests/akuma-body-requests.test.ts', requests);
let render = read('tests/cli-render.test.ts');
const a = render.indexOf('test("CLI lag scope');
const b = render.indexOf('test(', a + 6);
render = (render.slice(0, a) + render.slice(b)).replace('InvocationResult, Lag', 'InvocationResult');
write('tests/cli-render.test.ts', render);
