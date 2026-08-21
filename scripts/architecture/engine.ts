import path from "node:path";
import ts from "typescript";

export type SourceInput = Readonly<{ path: string; source: string }>;

export type Diagnostic = Readonly<{
  rule: string;
  file: string;
  line: number;
  column: number;
  detail: string;
}>;

export type DependencyMode = "any" | "type-only";

export type DependencyAllowance = Readonly<{
  target: string;
  mode?: DependencyMode;
  symbols?: readonly string[];
}>;

export type DependencyZone = Readonly<{
  source: string;
  allow: readonly DependencyAllowance[];
}>;

export type SensitiveImportRule = Readonly<{
  module: string;
  owners: readonly Readonly<{ source: string; symbols: readonly string[]; mode?: DependencyMode }>[];
}>;

export type ForbiddenSourcePattern = Readonly<{
  source: string;
  pattern: RegExp;
  detail: string;
}>;

export type CapabilityRule = Readonly<{
  capability: Capability;
  owners: readonly string[];
}>;

export type ArchitecturePolicy = Readonly<{
  zones: readonly DependencyZone[];
  sensitiveImports: readonly SensitiveImportRule[];
  forbiddenSourcePatterns: readonly ForbiddenSourcePattern[];
  forbiddenModules: readonly string[];
  capabilityRules: readonly CapabilityRule[];
  forbiddenFileNames: readonly string[];
  forbiddenDeclarations: readonly RegExp[];
  verbDirectory: string;
  providerSdkRoots: readonly Readonly<{ module: string; root: string }>[];
  runtimeGraphRoots: readonly string[];
}>;

type Capability =
  | "dynamic-import-nonliteral"
  | "eval"
  | "function-constructor"
  | "math-random"
  | "module-mutable-state"
  | "new-date-current"
  | "date-now"
  | "process-argv"
  | "process-cwd"
  | "process-environment"
  | "process-output"
  | "process-pid"
  | "require"
  | "type-error-construction";

type ImportedSymbols = Readonly<{
  runtime: readonly string[];
  types: readonly string[];
}>;

type ImportReference = Readonly<{
  from: string;
  specifier: string;
  target: string | null;
  relative: boolean;
  symbols: ImportedSymbols;
  line: number;
  column: number;
}>;

type Declaration = Readonly<{
  name: string;
  exported: boolean;
  runtime: boolean;
  function: boolean;
  async: boolean;
  line: number;
  column: number;
}>;

type CapabilityUse = Readonly<{
  capability: Capability;
  line: number;
  column: number;
}>;

type ParsedSource = Readonly<{
  path: string;
  sourceFile: ts.SourceFile;
  references: readonly ImportReference[];
  declarations: readonly Declaration[];
  runtimeReExports: readonly Readonly<{ line: number; column: number }>[];
  capabilities: readonly CapabilityUse[];
}>;

export type ArchitectureResult = Readonly<{
  files: readonly string[];
  diagnostics: readonly Diagnostic[];
}>;

function normalized(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^src\//, "");
}

function matches(pattern: string, candidate: string): boolean {
  const patternSegments = pattern.split("/");
  const candidateSegments = candidate.split("/");
  const visit = (patternIndex: number, candidateIndex: number): boolean => {
    const segment = patternSegments[patternIndex];
    if (segment === undefined) return candidateIndex === candidateSegments.length;
    if (segment !== "**")
      return segment === candidateSegments[candidateIndex] && visit(patternIndex + 1, candidateIndex + 1);
    if (patternIndex === patternSegments.length - 1) return true;
    return (
      candidateSegments.slice(candidateIndex).some((_, offset) => visit(patternIndex + 1, candidateIndex + offset)) ||
      visit(patternIndex + 1, candidateSegments.length)
    );
  };
  return visit(0, 0);
}

function location(sourceFile: ts.SourceFile, node: ts.Node): Readonly<{ line: number; column: number }> {
  const result = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: result.line + 1, column: result.character + 1 };
}

function pushSymbol(target: string[], symbol: string): void {
  if (!target.includes(symbol)) target.push(symbol);
}

function importDeclarationSymbols(node: ts.ImportDeclaration): ImportedSymbols {
  const runtime: string[] = [];
  const types: string[] = [];
  const clause = node.importClause;
  if (!clause) return { runtime: ["*"], types };
  const defaultTarget = clause.isTypeOnly ? types : runtime;
  if (clause.name) pushSymbol(defaultTarget, "default");
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) pushSymbol(defaultTarget, "*");
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      const target = clause.isTypeOnly || element.isTypeOnly ? types : runtime;
      pushSymbol(target, element.propertyName?.text ?? element.name.text);
    }
  }
  return { runtime, types };
}

function exportDeclarationSymbols(node: ts.ExportDeclaration): ImportedSymbols {
  const runtime: string[] = [];
  const types: string[] = [];
  const target = node.isTypeOnly ? types : runtime;
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) pushSymbol(target, "*");
  else {
    for (const element of node.exportClause.elements) {
      pushSymbol(
        element.isTypeOnly || node.isTypeOnly ? types : runtime,
        element.propertyName?.text ?? element.name.text,
      );
    }
  }
  return { runtime, types };
}

function importSymbols(node: ts.Node): ImportedSymbols {
  if (ts.isImportDeclaration(node)) return importDeclarationSymbols(node);
  if (ts.isExportDeclaration(node)) return exportDeclarationSymbols(node);
  return { runtime: ["*"], types: [] };
}

function moduleSpecifier(node: ts.Node): string | null {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression &&
    ts.isStringLiteral(node.moduleReference.expression)
  ) {
    return node.moduleReference.expression.text;
  }
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const argument = node.arguments[0];
    return argument && ts.isStringLiteral(argument) ? argument.text : "<dynamic>";
  }
  return null;
}

function resolveRelative(from: string, specifier: string, known: ReadonlySet<string>): string | null {
  const unresolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const extensionless = unresolved.replace(/\.(?:c|m)?js$/, "");
  const candidates = [
    unresolved,
    extensionless,
    `${extensionless}.ts`,
    `${extensionless}.mts`,
    `${extensionless}.cts`,
    `${extensionless}.tsx`,
    `${extensionless}/index.ts`,
  ];
  return candidates.find((candidate) => known.has(candidate)) ?? null;
}

function modifiers(node: ts.Node): readonly ts.Modifier[] {
  return ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
}

function declarationOf(node: ts.Node, sourceFile: ts.SourceFile): Declaration | null {
  let name: ts.DeclarationName | undefined;
  let functionDeclaration = false;
  let runtime = false;
  let functionInitializer: ts.ArrowFunction | ts.FunctionExpression | undefined;
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    name = node.name;
    functionDeclaration = ts.isFunctionDeclaration(node);
    runtime = !ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node);
  } else if (ts.isVariableDeclaration(node)) {
    name = node.name;
    runtime = true;
    if (node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      functionDeclaration = true;
      functionInitializer = node.initializer;
    }
  }
  if (!name || !ts.isIdentifier(name)) return null;
  const owner =
    ts.isVariableDeclaration(node) &&
    ts.isVariableDeclarationList(node.parent) &&
    ts.isVariableStatement(node.parent.parent)
      ? node.parent.parent
      : node;
  const nodeModifiers = modifiers(owner);
  const at = location(sourceFile, node);
  return {
    name: name.text,
    exported: nodeModifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
    runtime,
    function: functionDeclaration,
    async:
      nodeModifiers.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
      (functionInitializer !== undefined &&
        modifiers(functionInitializer).some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)),
    line: at.line,
    column: at.column,
  };
}

function runtimeReExport(node: ts.Node, sourceFile: ts.SourceFile): Readonly<{ line: number; column: number }> | null {
  if (ts.isExportAssignment(node)) return location(sourceFile, node);
  if (!ts.isExportDeclaration(node) || node.isTypeOnly) return null;
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return location(sourceFile, node);
  return node.exportClause.elements.some((element) => !element.isTypeOnly) ? location(sourceFile, node) : null;
}

function isProcessReference(node: ts.Expression): boolean {
  return (
    (ts.isIdentifier(node) && node.text === "process") ||
    (ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "globalThis" &&
      node.name.text === "process")
  );
}

function propertyCapability(node: ts.PropertyAccessExpression): Capability | null {
  if (ts.isIdentifier(node.expression) && node.expression.text === "Date" && node.name.text === "now")
    return "date-now";
  if (ts.isIdentifier(node.expression) && node.expression.text === "Math" && node.name.text === "random")
    return "math-random";
  if (!isProcessReference(node.expression)) return null;
  if (node.name.text === "env") return "process-environment";
  if (node.name.text === "argv") return "process-argv";
  if (node.name.text === "cwd") return "process-cwd";
  if (node.name.text === "pid") return "process-pid";
  if (["stdout", "stderr", "exit", "exitCode"].includes(node.name.text)) return "process-output";
  return null;
}

function calledGlobalCapability(node: ts.CallExpression): Capability | null {
  if (!ts.isIdentifier(node.expression)) return null;
  switch (node.expression.text) {
    case "eval":
      return "eval";
    case "require":
      return "require";
    case "Function":
      return "function-constructor";
    default:
      return null;
  }
}

function constructedCapability(node: ts.NewExpression): Capability | null {
  if (!ts.isIdentifier(node.expression)) return null;
  if (node.expression.text === "Date" && (node.arguments?.length ?? 0) === 0) return "new-date-current";
  if (node.expression.text === "Function") return "function-constructor";
  if (node.expression.text === "TypeError") return "type-error-construction";
  return null;
}

function capabilityOf(node: ts.Node): Capability | null {
  if (ts.isPropertyAccessExpression(node)) return propertyCapability(node);
  if (ts.isNewExpression(node)) return constructedCapability(node);
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const argument = node.arguments[0];
    return argument && ts.isStringLiteral(argument) ? null : "dynamic-import-nonliteral";
  }
  if (ts.isCallExpression(node)) return calledGlobalCapability(node);
  if (
    ts.isVariableStatement(node) &&
    ts.isSourceFile(node.parent) &&
    (node.declarationList.flags & ts.NodeFlags.Const) === 0
  )
    return "module-mutable-state";
  return null;
}

function parseSources(inputs: readonly SourceInput[]): readonly ParsedSource[] {
  const normalizedInputs = inputs.map((input) => ({ path: normalized(input.path), source: input.source }));
  const known = new Set(normalizedInputs.map((input) => input.path));
  return normalizedInputs.map((input) => {
    const sourceFile = ts.createSourceFile(input.path, input.source, ts.ScriptTarget.Latest, true);
    const references: ImportReference[] = [];
    const declarations: Declaration[] = [];
    const runtimeReExports: Array<Readonly<{ line: number; column: number }>> = [];
    const capabilities: CapabilityUse[] = [];
    const visit = (node: ts.Node): void => {
      const specifier = moduleSpecifier(node);
      if (specifier !== null) {
        const relative = specifier.startsWith(".");
        const at = location(sourceFile, node);
        references.push({
          from: input.path,
          specifier,
          target: relative && specifier !== "<dynamic>" ? resolveRelative(input.path, specifier, known) : null,
          relative,
          symbols: importSymbols(node),
          line: at.line,
          column: at.column,
        });
      }
      const declaration = declarationOf(node, sourceFile);
      if (declaration) declarations.push(declaration);
      const reExport = runtimeReExport(node, sourceFile);
      if (reExport) runtimeReExports.push(reExport);
      const capability = capabilityOf(node);
      if (capability) {
        const at = location(sourceFile, node);
        capabilities.push({ capability, line: at.line, column: at.column });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return {
      path: input.path,
      sourceFile,
      references,
      declarations,
      runtimeReExports,
      capabilities,
    };
  });
}

function importedSymbols(reference: ImportReference): readonly string[] {
  return [...new Set([...reference.symbols.runtime, ...reference.symbols.types])].sort();
}

function allowanceMatches(reference: ImportReference, allowance: DependencyAllowance): boolean {
  if (!reference.target || !matches(allowance.target, reference.target)) return false;
  if (allowance.mode === "type-only" && reference.symbols.runtime.length > 0) return false;
  if (allowance.symbols) {
    const permitted = new Set(allowance.symbols);
    if (importedSymbols(reference).some((symbol) => !permitted.has(symbol))) return false;
  }
  return true;
}

function moduleMatches(rule: string, specifier: string): boolean {
  return rule.endsWith("/**") ? specifier.startsWith(rule.slice(0, -3)) : rule === specifier;
}

function referenceDiagnostics(
  unit: ParsedSource,
  reference: ImportReference,
  zone: DependencyZone | undefined,
  policy: ArchitecturePolicy,
): readonly Diagnostic[] {
  if (reference.relative && reference.target === null)
    return [
      {
        rule: "architecture/unresolved-import",
        file: unit.path,
        line: reference.line,
        column: reference.column,
        detail: `cannot resolve ${reference.specifier}`,
      },
    ];
  const diagnostics: Diagnostic[] = [];
  const providerSdk = policy.providerSdkRoots.find((candidate) => candidate.module === reference.specifier);
  if (providerSdk && reference.symbols.runtime.length > 0 && !matches(`${providerSdk.root}/**`, unit.path))
    diagnostics.push({
      rule: "architecture/provider-sdk-boundary",
      file: unit.path,
      line: reference.line,
      column: reference.column,
      detail: `${reference.specifier} may be loaded only inside ${providerSdk.root}/`,
    });
  if (reference.target && zone && !zone.allow.some((allowance) => allowanceMatches(reference, allowance)))
    diagnostics.push({
      rule: "architecture/dependency-direction",
      file: unit.path,
      line: reference.line,
      column: reference.column,
      detail: `${unit.path} -> ${reference.target} imports ${importedSymbols(reference).join(", ") || "<none>"}`,
    });
  if (reference.relative) return diagnostics;
  if (policy.forbiddenModules.some((module) => moduleMatches(module, reference.specifier)))
    diagnostics.push({
      rule: "architecture/forbidden-module",
      file: unit.path,
      line: reference.line,
      column: reference.column,
      detail: `forbidden module ${reference.specifier}`,
    });
  const sensitive = policy.sensitiveImports.find((rule) => rule.module === reference.specifier);
  if (!sensitive) return diagnostics;
  const symbols = importedSymbols(reference);
  const allowed = sensitive.owners.some((owner) => {
    const permitted = new Set(owner.symbols);
    return (
      matches(owner.source, unit.path) &&
      (owner.mode !== "type-only" || reference.symbols.runtime.length === 0) &&
      symbols.every((symbol) => permitted.has(symbol))
    );
  });
  if (!allowed)
    diagnostics.push({
      rule: "architecture/capability-import",
      file: unit.path,
      line: reference.line,
      column: reference.column,
      detail: `${reference.specifier} imports ${symbols.join(", ") || "<none>"}`,
    });
  return diagnostics;
}

function dependencyDiagnostics(units: readonly ParsedSource[], policy: ArchitecturePolicy): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const unit of units) {
    const zone = policy.zones.find((candidate) => matches(candidate.source, unit.path));
    if (!zone)
      diagnostics.push({
        rule: "architecture/unowned-source",
        file: unit.path,
        line: 1,
        column: 1,
        detail: "source file has no declared owner zone",
      });
    for (const reference of unit.references) diagnostics.push(...referenceDiagnostics(unit, reference, zone, policy));
  }
  return diagnostics;
}

function stronglyConnected(units: readonly ParsedSource[]): readonly (readonly string[])[] {
  const graph = new Map(
    units.map((unit) => [
      unit.path,
      new Set(
        unit.references.flatMap((reference) =>
          reference.target && reference.symbols.runtime.length > 0 ? [reference.target] : [],
        ),
      ),
    ]),
  );
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const connect = (node: string): void => {
    indices.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of graph.get(node) ?? []) {
      if (!indices.has(target)) {
        connect(target);
        low.set(node, Math.min(low.get(node)!, low.get(target)!));
      } else if (onStack.has(target)) low.set(node, Math.min(low.get(node)!, indices.get(target)!));
    }
    if (low.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    components.push(component.sort());
  };
  for (const unit of units) if (!indices.has(unit.path)) connect(unit.path);
  return components.filter(
    (component) => component.length > 1 || (graph.get(component[0]!)?.has(component[0]!) ?? false),
  );
}

function runtimeGraphDiagnostics(units: readonly ParsedSource[], policy: ArchitecturePolicy): Diagnostic[] {
  const byPath = new Map(units.map((unit) => [unit.path, unit]));
  const visited = new Set<string>();
  const queue = [...policy.runtimeGraphRoots];
  const diagnostics: Diagnostic[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const unit = byPath.get(current);
    if (!unit) continue;
    for (const reference of unit.references) {
      if (reference.symbols.runtime.length === 0) continue;
      const providerSdk = policy.providerSdkRoots.find((candidate) => candidate.module === reference.specifier);
      if (providerSdk)
        diagnostics.push({
          rule: "architecture/provider-sdk-reachable-from-cli",
          file: unit.path,
          line: reference.line,
          column: reference.column,
          detail: `${reference.specifier} is reachable from ${policy.runtimeGraphRoots.join(", ")}`,
        });
      if (reference.target) queue.push(reference.target);
    }
  }
  return diagnostics;
}

function verbOwnerDiagnostic(unit: ParsedSource, policy: ArchitecturePolicy): Diagnostic | null {
  if (!unit.path.startsWith(policy.verbDirectory) || !unit.path.endsWith(".ts")) return null;
  const name = path.posix.basename(unit.path, ".ts");
  const expected = `decide${name[0]!.toUpperCase()}${name.slice(1)}`;
  const runtimeExports = unit.declarations.filter((declaration) => declaration.exported && declaration.runtime);
  const decision = runtimeExports.find((declaration) => declaration.name === expected);
  const invalidExport = runtimeExports.find((declaration) => !declaration.function || declaration.async);
  const reExport = unit.runtimeReExports[0];
  if (reExport === undefined && decision?.function === true && !decision.async && invalidExport === undefined)
    return null;
  const location = reExport ?? invalidExport ?? decision ?? runtimeExports[0];
  return {
    rule: "architecture/verb-owner",
    file: unit.path,
    line: location?.line ?? 1,
    column: location?.column ?? 1,
    detail: `verb owner must expose non-async ${expected}; other runtime exports must be non-async functions`,
  };
}

function structureDiagnostics(units: readonly ParsedSource[], policy: ArchitecturePolicy): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const unit of units) {
    const basename = path.posix.basename(unit.path);
    if (policy.forbiddenFileNames.includes(basename))
      diagnostics.push({
        rule: "architecture/removed-owner",
        file: unit.path,
        line: 1,
        column: 1,
        detail: `removed owner ${basename} must not exist`,
      });
    for (const declaration of unit.declarations) {
      if (policy.forbiddenDeclarations.some((pattern) => pattern.test(declaration.name)))
        diagnostics.push({
          rule: "architecture/removed-declaration",
          file: unit.path,
          line: declaration.line,
          column: declaration.column,
          detail: `removed declaration ${declaration.name}`,
        });
    }
    for (const rule of policy.forbiddenSourcePatterns.filter((candidate) => matches(candidate.source, unit.path))) {
      const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`;
      for (const match of unit.sourceFile.text.matchAll(new RegExp(rule.pattern.source, flags))) {
        const at = unit.sourceFile.getLineAndCharacterOfPosition(match.index);
        diagnostics.push({
          rule: "architecture/forbidden-source-pattern",
          file: unit.path,
          line: at.line + 1,
          column: at.character + 1,
          detail: rule.detail,
        });
      }
    }
    const verbOwner = verbOwnerDiagnostic(unit, policy);
    if (verbOwner) diagnostics.push(verbOwner);
    for (const use of unit.capabilities) {
      const rule = policy.capabilityRules.find((candidate) => candidate.capability === use.capability);
      if (rule && !rule.owners.some((owner) => matches(owner, unit.path)))
        diagnostics.push({
          rule: "architecture/capability-use",
          file: unit.path,
          line: use.line,
          column: use.column,
          detail: `${use.capability} is not owned here`,
        });
    }
  }
  return diagnostics;
}

export function checkArchitecture(inputs: readonly SourceInput[], policy: ArchitecturePolicy): ArchitectureResult {
  const units = parseSources(inputs);
  const diagnostics = [
    ...dependencyDiagnostics(units, policy),
    ...structureDiagnostics(units, policy),
    ...runtimeGraphDiagnostics(units, policy),
  ];
  for (const component of stronglyConnected(units))
    diagnostics.push({
      rule: "architecture/dependency-cycle",
      file: component[0]!,
      line: 1,
      column: 1,
      detail: component.join(" -> "),
    });
  diagnostics.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column ||
      left.rule.localeCompare(right.rule) ||
      left.detail.localeCompare(right.detail),
  );
  return { files: units.map((unit) => unit.path).sort(), diagnostics };
}
