import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const root = resolve(import.meta.dirname, import.meta.url.endsWith(".js") ? "../.." : "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { types: string };
const entry = resolve(root, manifest.types);
const options: ts.CompilerOptions = {
  noEmit: true,
  strict: true,
  exactOptionalPropertyTypes: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  typeRoots: [dirname(dirname(createRequire(import.meta.url).resolve("@types/node/package.json")))],
  types: ["node"],
};
const banned = new Set([
  "z",
  "actorId",
  "DebtUpdateInvocation",
  "RecentDebtSummary",
  "observeRecentDebtStatus",
  "debtRowViewLimit",
  "KEIYAKU_HANDLE",
  "RepositoryScope",
  "LocalContractCompositionCapture",
  "NukeGitOptions",
  "nukeWithGit",
  "ScopedAkumaHost",
  "BodyLauncher",
  "createKeiHandle",
  "projectFailure",
  "classifyVerb",
  "FailureProjection",
  "KanshiObservation",
  "KanshiInput",
  "KanshiCountsInput",
]);
const schemaName = (name: string) => name.endsWith("Schema") && name !== "JsonSchema";
const diagnostics = (program: ts.Program) =>
  ts.formatDiagnosticsWithColorAndContext(ts.getPreEmitDiagnostics(program), {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  });

// Follow local declarations by symbol identity and reachable signature/class side.
// Transparent data aliases, schemas and brands need not become root exports.
function assertDeclarationClosure(program: ts.Program, entryFile: ts.SourceFile): void {
  const checker = program.getTypeChecker();
  const unalias = (symbol: ts.Symbol): ts.Symbol =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const exported = checker.getExportsOfModule(checker.getSymbolAtLocation(entryFile)!);
  const publicSymbols = new Set(exported.map(unalias));
  const publicValues = new Set(
    exported
      .filter(
        (symbol) =>
          Boolean(unalias(symbol).flags & ts.SymbolFlags.Value) &&
          !symbol.declarations?.some(ts.isTypeOnlyImportOrExportDeclaration),
      )
      .map(unalias),
  );
  const publicNames = new Map([...publicSymbols].map((symbol) => [symbol.name, symbol]));
  const canonical = (file: string): string => resolve(file).replaceAll("\\", "/");
  const localRoot = canonical(dirname(entryFile.fileName)) + "/";
  const local = (symbol: ts.Symbol): boolean =>
    (symbol.declarations ?? []).some((declaration) =>
      canonical(declaration.getSourceFile().fileName).startsWith(localRoot),
    );
  assert.ok([...publicSymbols].some(local), "the declaration walk must reach local public owners");
  const backingClasses = new Set<ts.Symbol>();
  for (const symbol of publicSymbols)
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isTypeAliasDeclaration(declaration) && ts.isTypeReferenceNode(declaration.type)) {
        const backing = checker.getSymbolAtLocation(declaration.type.typeName);
        if (backing !== undefined) backingClasses.add(unalias(backing));
      }
    }
  type ClassSide = "instance" | "static" | "value";
  const visited = new Map<ts.Symbol, Set<string>>();
  const failures = new Set<string>();
  const privateMember = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword,
    );
  // Representation aliases may expand privately; explicit callable names stay public.
  const transparent = (symbol: ts.Symbol, reference: ts.Node): boolean => {
    const owner = ts.findAncestor(
      reference,
      (node) =>
        ts.isFunctionLike(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isPropertySignature(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isVariableDeclaration(node),
    );
    if (owner !== undefined && ts.isFunctionLike(owner)) return false;
    return (symbol.declarations ?? []).some((declaration) => {
      if (!ts.isTypeAliasDeclaration(declaration)) return false;
      const type = checker.getTypeAtLocation(declaration);
      return type.getCallSignatures().length === 0 && type.getConstructSignatures().length === 0;
    });
  };
  function visitSymbol(symbol: ts.Symbol, callable = false, classSide: ClassSide = "instance"): void {
    symbol = unalias(symbol);
    if (!local(symbol)) return;
    const context = `${callable}:${classSide}`;
    const contexts = visited.get(symbol) ?? new Set<string>();
    if (contexts.has(context)) return;
    contexts.add(context);
    visited.set(symbol, contexts);
    for (const declaration of symbol.declarations ?? []) visit(declaration, callable, classSide);
  }
  function visit(node: ts.Node, callable = false, classSide: ClassSide = "instance"): void {
    if (privateMember(node) || ts.isTypeParameterDeclaration(node)) return;
    if (ts.isTypeQueryNode(node)) {
      const reference = checker.getSymbolAtLocation(node.exprName);
      if (reference !== undefined) {
        const symbol = unalias(reference);
        if (banned.has(symbol.name))
          failures.add(`Private capability reachable: ${node.getSourceFile().fileName}: ${symbol.name}`);
        visitSymbol(symbol, callable, "value");
      }
      for (const argument of node.typeArguments ?? []) visit(argument, callable);
      return;
    }
    if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node) || ts.isImportTypeNode(node)) {
      const name = ts.isTypeReferenceNode(node)
        ? node.typeName
        : ts.isExpressionWithTypeArguments(node)
          ? node.expression
          : node.qualifier;
      const reference = name === undefined ? undefined : checker.getSymbolAtLocation(name);
      if (reference !== undefined) {
        const symbol = unalias(reference);
        if (!(symbol.flags & ts.SymbolFlags.TypeParameter) && local(symbol)) {
          const location = `${node.getSourceFile().fileName}: ${symbol.name}`;
          if (banned.has(symbol.name)) failures.add(`Private capability reachable: ${location}`);
          const canonical = publicNames.get(symbol.name);
          if (canonical !== undefined && canonical !== symbol) failures.add(`Distinct public symbol: ${location}`);
          if (
            callable &&
            !ts.isExpressionWithTypeArguments(node) &&
            !publicSymbols.has(symbol) &&
            !backingClasses.has(symbol) &&
            !transparent(symbol, node)
          )
            failures.add(`Unexported callable type: ${location}`);
          visitSymbol(
            symbol,
            callable,
            ts.isImportTypeNode(node) && node.isTypeOf
              ? "value"
              : ts.isExpressionWithTypeArguments(node)
                ? classSide
                : "instance",
          );
        }
      }
      for (const argument of node.typeArguments ?? []) visit(argument, callable);
      return;
    }
    if (ts.isClassDeclaration(node)) {
      const heritageSide =
        classSide === "value" && node.members.some(ts.isConstructorDeclaration) ? "static" : classSide;
      for (const heritage of node.heritageClauses ?? []) visit(heritage, callable, heritageSide);
      for (const member of node.members) {
        if (ts.isConstructorDeclaration(member) && classSide !== "value") continue;
        if (
          classSide === "instance" &&
          ts.canHaveModifiers(member) &&
          ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
        )
          continue;
        visit(member, true, classSide);
      }
      return;
    }
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isCallSignatureDeclaration(node) ||
      ts.isConstructSignatureDeclaration(node) ||
      ts.isFunctionTypeNode(node)
    ) {
      for (const parameter of node.parameters) if (parameter.type !== undefined) visit(parameter.type, true);
      if (node.type !== undefined) visit(node.type, true);
      return;
    }
    if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
      if (node.type !== undefined) visit(node.type, true);
      return;
    }
    ts.forEachChild(node, (child) => visit(child, callable, classSide));
  }
  for (const symbol of publicSymbols) visitSymbol(symbol, false, publicValues.has(symbol) ? "value" : "instance");
  assert.deepEqual([...failures].sort(), []);
}

function memoryHost(files: Readonly<Record<string, string>>): ts.CompilerHost {
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.readFile = (path) => files[path] ?? read(path);
  host.fileExists = (path) => path in files || exists(path);
  return host;
}

test("package types close public signatures and compile external callers", () => {
  const file = resolve(tmpdir(), "keiyaku-public-sdk-consumer.mts").replaceAll("\\", "/");
  const source = `
import { Kei, Keis, Keiyaku, AkumaHost, Akumas, Kanshi, Settings, KeiyakuError,
  KeiyakuArcDocumentError, AkumaObservationError, nuke, type ContractId, type Gate,
  type KeiyakuErrorCategory, type KeiyakuErrorOptions, type PartialOutcomeEnvelope,
  type SpawnResult, type AkumaTellResult, type AkumaId, type KanshiScopeInput,
  type KanshiBoardOptions, type KanshiCountsReport, type KanshiContractReport, type RegionRead,
  type SettingsInput, type AkumaNameCatalogInput, type AkumaNamesInput, type AkumaNameCatalog,
  type KeisOptions, type MutationObservation, type WorldInput, type KeisReconcile,
  type KeiyakuRunOptions, type ResetCounts, type AkumaAlias, type AkumaAddressRefusal,
  type AkumaSetAddressInput, type AkumaRosterInput, type AskObserver, type SpawnWaitObserver,
  type LiveStatusObservation, type ActivityRow, type TellResult, type TellWake,
  type JsonSchema, type JsonSchemaDocument, type VerbInput, type VerbRunFor, type BindOutcome,
  type Repo, type WorldRoot, type AddDebtDocumentInput, type AddDebtInput, type BlockedDebtList,
  type BlockedDebtRow, type Debt, type DebtAbsent, type DebtCatalogue, type DebtChange, type DebtDetail,
  type DebtDoctorIssue, type DebtDoctorReport, type DebtId, type DebtList, type DebtMutationResult,
  type DebtPriority, type DebtReadPage, type DebtReadResult,
  type DebtReadyList, type DebtRef, type DebtRefusal, type DebtRetry, type DebtShowItem,
  type DebtShowResult, type DebtState, type DebtSummary,
  type DebtUpdateResult, type DebtWarning, type ReadyDebtRow, type UpdateDebtInput
} from "@astrosheep/keiyaku";
declare const repo: Repo;
declare const world: WorldRoot;
declare const akumaId: AkumaId;
declare const outcome: PartialOutcomeEnvelope;
declare const spawn: SpawnResult;
declare const tell: AkumaTellResult;
const errorOptions: KeiyakuErrorOptions = { outcome, spawn, tell, cause: new Error("native") };
const error = new KeiyakuError("internal", "failure", errorOptions);
const category: KeiyakuErrorCategory = error.category;
const receipts: [PartialOutcomeEnvelope | undefined, SpawnResult | undefined, AkumaTellResult | undefined] =
  [error.outcome, error.spawn, error.tell];
const specialized: KeiyakuError[] = [
  new KeiyakuArcDocumentError("kei/example" as ContractId, error),
  new AkumaObservationError(akumaId, "unavailable"),
];
// @ts-expect-error direct evidence remains readonly
error.outcome = outcome;
// @ts-expect-error direct evidence remains readonly
error.spawn = spawn;
// @ts-expect-error direct evidence remains readonly
error.tell = tell;
const scope: KanshiScopeInput = { world, repo };
const watch: Kanshi = Kanshi.of(scope);
const boardOptions: KanshiBoardOptions = { akumaLimit: 10 };
const board: Promise<import("@astrosheep/keiyaku").KanshiReport> = watch.board(boardOptions);
const counts: Promise<KanshiCountsReport> = watch.counts();
const regions: Promise<RegionRead> = watch.region();
const contract: Promise<KanshiContractReport> = watch.contract("kei/example" as ContractId);
const settingsInput: SettingsInput = { cwd: world, home: "/explicit/home" };
const loaded: Promise<Settings> = Settings.load(settingsInput);
const catalogueInput: AkumaNameCatalogInput = { cwd: world, home: "/explicit/home", limit: 10 };
const catalogue: Promise<AkumaNameCatalog> = Akumas.akumaNames(catalogueInput);
const boundCatalogueInput: AkumaNamesInput = { home: "/explicit/home", limit: 10 };
const boundCatalogue: Promise<AkumaNameCatalog> = Akumas.of(world).akumaNames(boundCatalogueInput);
// @ts-expect-error Settings project coordinates use cwd
Settings.load({ root: world });
// @ts-expect-error standalone archetype coordinates use cwd
Akumas.akumaNames({ project: world });
// @ts-expect-error bound catalogue already captures its project coordinate
Akumas.of(world).akumaNames({ cwd: world });
// @ts-expect-error World and Repo are independent coordinates
Kanshi.of({ world: repo });
declare const kei: Kei;
const id: ContractId = kei.id;
const gate: Gate = "ordinary word";
const policy: KeisOptions = {};
const reconcile: KeisReconcile = Keis.of(repo, policy).reconcile;
const host = AkumaHost.inProcess();
const close: Promise<void> = host.close();
const api = Keiyaku.for({ cwd: "/explicit/cwd", environment: {} });
const run: KeiyakuRunOptions = { signal: AbortSignal.abort() };
const bind: Promise<BindOutcome> = api.bind({ terms: "terms" }, run);
bind.then(answer => { if (answer.kind === "accepted") { const handle: Kei = answer.kei; void handle.id; } });
api.deliver(); api.verify(); api.abandon(); api.show({ selector: "kei/example" }); api.reconcile(); api.whoami();
// @ts-expect-error show requires explicit business input
api.show();
// @ts-expect-error show requires explicit selection
api.show({});
// @ts-expect-error generic show also requires explicit selection
api.run("show", {});
// @ts-expect-error id is not an invocation show input
api.show({ id: "kei/example" });
api.settings(); api.nuke(); api.kanshi(); api.region(); api.debtDoctor();
api.debtAdd({ title: "caller" }, run);
api.debtAddDocument({ markdown: "document" }, run);
api.debtUpdate({ id: "debt/caller", note: "update" }, run);
// @ts-expect-error construction custody is private
new Kei();
// @ts-expect-error public reset has one business input
nuke({ world }, {});
// @ts-expect-error host scope carries no launch capability
host.launcher;
// @ts-expect-error cancellation belongs to execution
const add: VerbInput<"debt.add"> = { title: "caller", signal: run.signal };
// @ts-expect-error cancellation belongs to execution
const document: VerbInput<"debt.addDocument"> = { markdown: "document", signal: run.signal };
// @ts-expect-error cancellation belongs to execution
const update: VerbInput<"debt.update"> = { id: "debt/caller", note: "note", signal: run.signal };
`;
  const host = memoryHost({ [file]: source });
  host.resolveModuleNames = (names, containingFile) =>
    names.map((name) =>
      name === "@astrosheep/keiyaku"
        ? { resolvedFileName: entry, extension: ts.Extension.Dts, isExternalLibraryImport: true }
        : ts.resolveModuleName(name, containingFile, options, host).resolvedModule,
    );
  const program = ts.createProgram([entry, file], options, host);
  assert.equal(diagnostics(program), "");
  const entryFile = program.getSourceFile(entry)!;
  for (const file of [
    entryFile,
    ts.createSourceFile("index.ts", readFileSync(join(root, "src/index.ts"), "utf8"), ts.ScriptTarget.Latest, true),
  ]) {
    assert.equal(
      file.statements.some(
        (statement) =>
          ts.isExportDeclaration(statement) &&
          (statement.exportClause === undefined || ts.isNamespaceExport(statement.exportClause)),
      ),
      false,
    );
  }
  const checker = program.getTypeChecker();
  const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(entryFile)!);
  assert.deepEqual(
    exports
      .filter((symbol) => schemaName(symbol.name) || banned.has(symbol.name))
      .map((symbol) => symbol.name),
    [],
  );
  assertDeclarationClosure(program, entryFile);
});
