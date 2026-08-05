import path from "node:path";
import ts from "typescript";
import { functionMetric, isFunctionNode, type FunctionMetric } from "./function-metrics.js";

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
  owners: readonly Readonly<{ source: string; symbols: readonly string[] }>[];
}>;

export type CapabilityRule = Readonly<{
  capability: Capability;
  owners: readonly string[];
}>;

export type ArchitecturePolicy = Readonly<{
  limits: Readonly<{
    fileLines: number;
    functionLines: number;
    complexity: number;
    nesting: number;
    parameters: number;
    duplicateFunctionLines: number;
    duplicateFunctionTokens: number;
  }>;
  zones: readonly DependencyZone[];
  sensitiveImports: readonly SensitiveImportRule[];
  forbiddenModules: readonly string[];
  capabilityRules: readonly CapabilityRule[];
  forbiddenFileNames: readonly string[];
  forbiddenDeclarations: readonly RegExp[];
  verbDirectory: string;
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
  | "require";

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
  functions: readonly FunctionMetric[];
  declarations: readonly Declaration[];
  runtimeReExports: readonly Readonly<{ line: number; column: number }>[];
  capabilities: readonly CapabilityUse[];
  lines: number;
}>;

export type ArchitectureResult = Readonly<{
  files: readonly string[];
  diagnostics: readonly Diagnostic[];
}>;

function normalized(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^src\//, "");
}

function matches(pattern: string, candidate: string): boolean {
  if (pattern === "**") return true;
  if (pattern.endsWith("/**")) return candidate.startsWith(pattern.slice(0, -3));
  return pattern === candidate;
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
      pushSymbol(element.isTypeOnly || node.isTypeOnly ? types : runtime, element.propertyName?.text ?? element.name.text);
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
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isImportEqualsDeclaration(node)
    && ts.isExternalModuleReference(node.moduleReference)
    && node.moduleReference.expression
    && ts.isStringLiteral(node.moduleReference.expression)
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
  return ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : [];
}

function declarationOf(node: ts.Node, sourceFile: ts.SourceFile): Declaration | null {
  let name: ts.DeclarationName | undefined;
  let functionDeclaration = false;
  let runtime = false;
  let functionInitializer: ts.ArrowFunction | ts.FunctionExpression | undefined;
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
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
  const owner = ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) && ts.isVariableStatement(node.parent.parent)
    ? node.parent.parent
    : node;
  const nodeModifiers = modifiers(owner);
  const at = location(sourceFile, node);
  return {
    name: name.text,
    exported: nodeModifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
    runtime,
    function: functionDeclaration,
    async: nodeModifiers.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      || (functionInitializer !== undefined && modifiers(functionInitializer).some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)),
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

function propertyCapability(node: ts.PropertyAccessExpression): Capability | null {
  if (ts.isIdentifier(node.expression) && node.expression.text === "Date" && node.name.text === "now") return "date-now";
  if (ts.isIdentifier(node.expression) && node.expression.text === "Math" && node.name.text === "random") return "math-random";
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "process") return null;
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
    case "eval": return "eval";
    case "require": return "require";
    case "Function": return "function-constructor";
    default: return null;
  }
}

function constructedCapability(node: ts.NewExpression): Capability | null {
  if (!ts.isIdentifier(node.expression)) return null;
  if (node.expression.text === "Date" && (node.arguments?.length ?? 0) === 0) return "new-date-current";
  if (node.expression.text === "Function") return "function-constructor";
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
    ts.isVariableStatement(node)
    && ts.isSourceFile(node.parent)
    && (node.declarationList.flags & ts.NodeFlags.Const) === 0
  ) return "module-mutable-state";
  return null;
}

function parseSources(inputs: readonly SourceInput[]): readonly ParsedSource[] {
  const normalizedInputs = inputs.map((input) => ({ path: normalized(input.path), source: input.source }));
  const known = new Set(normalizedInputs.map((input) => input.path));
  return normalizedInputs.map((input) => {
    const sourceFile = ts.createSourceFile(input.path, input.source, ts.ScriptTarget.Latest, true);
    const references: ImportReference[] = [];
    const functions: FunctionMetric[] = [];
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
      if (isFunctionNode(node)) functions.push(functionMetric(input.path, sourceFile, node));
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
      functions,
      declarations,
      runtimeReExports,
      capabilities,
      lines: sourceFile.getLineAndCharacterOfPosition(sourceFile.end).line + 1,
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
  if (reference.relative && reference.target === null) return [{
    rule: "architecture/unresolved-import",
    file: unit.path,
    line: reference.line,
    column: reference.column,
    detail: `cannot resolve ${reference.specifier}`,
  }];
  const diagnostics: Diagnostic[] = [];
  if (reference.target && zone && !zone.allow.some((allowance) => allowanceMatches(reference, allowance))) diagnostics.push({
    rule: "architecture/dependency-direction",
    file: unit.path,
    line: reference.line,
    column: reference.column,
    detail: `${unit.path} -> ${reference.target} imports ${importedSymbols(reference).join(", ") || "<none>"}`,
  });
  if (reference.relative) return diagnostics;
  if (policy.forbiddenModules.some((module) => moduleMatches(module, reference.specifier))) diagnostics.push({
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
    return matches(owner.source, unit.path) && symbols.every((symbol) => permitted.has(symbol));
  });
  if (!allowed) diagnostics.push({
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
    if (!zone) diagnostics.push({ rule: "architecture/unowned-source", file: unit.path, line: 1, column: 1, detail: "source file has no declared owner zone" });
    for (const reference of unit.references) diagnostics.push(...referenceDiagnostics(unit, reference, zone, policy));
  }
  return diagnostics;
}

function stronglyConnected(units: readonly ParsedSource[]): readonly (readonly string[])[] {
  const graph = new Map(units.map((unit) => [unit.path, new Set(unit.references.flatMap((reference) => reference.target ? [reference.target] : []))]));
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
  return components.filter((component) => component.length > 1 || (graph.get(component[0]!)?.has(component[0]!) ?? false));
}

function metricDiagnostics(units: readonly ParsedSource[], policy: ArchitecturePolicy): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const originals = new Map<string, FunctionMetric>();
  for (const unit of units) {
    if (unit.lines > policy.limits.fileLines) diagnostics.push({
      rule: "maintainability/file-lines",
      file: unit.path,
      line: 1,
      column: 1,
      detail: `${unit.lines} lines exceeds ${policy.limits.fileLines}`,
    });
    for (const metric of unit.functions) {
      const checks: readonly Readonly<{ rule: string; actual: number; maximum: number; label: string }>[] = [
        { rule: "maintainability/function-lines", actual: metric.lines, maximum: policy.limits.functionLines, label: "lines" },
        { rule: "maintainability/complexity", actual: metric.complexity, maximum: policy.limits.complexity, label: "complexity" },
        { rule: "maintainability/nesting", actual: metric.nesting, maximum: policy.limits.nesting, label: "nesting" },
        { rule: "maintainability/parameters", actual: metric.parameters, maximum: policy.limits.parameters, label: "parameters" },
      ];
      for (const check of checks) if (check.actual > check.maximum) diagnostics.push({
        rule: check.rule,
        file: metric.file,
        line: metric.line,
        column: metric.column,
        detail: `${metric.name} has ${check.actual} ${check.label}; maximum is ${check.maximum}`,
      });
      if (
        metric.lines >= policy.limits.duplicateFunctionLines
        && metric.tokens >= policy.limits.duplicateFunctionTokens
      ) {
        const original = originals.get(metric.fingerprint);
        if (original) diagnostics.push({
          rule: "maintainability/duplicate-function",
          file: metric.file,
          line: metric.line,
          column: metric.column,
          detail: `${metric.name} duplicates ${original.file}:${original.line}`,
        });
        else originals.set(metric.fingerprint, metric);
      }
    }
  }
  return diagnostics;
}

function verbOwnerDiagnostic(unit: ParsedSource, policy: ArchitecturePolicy): Diagnostic | null {
  if (!unit.path.startsWith(policy.verbDirectory) || !unit.path.endsWith(".ts")) return null;
  const name = path.posix.basename(unit.path, ".ts");
  const expected = `decide${name[0]!.toUpperCase()}${name.slice(1)}`;
  const runtimeExports = unit.declarations.filter((declaration) => declaration.exported && declaration.runtime);
  const decision = runtimeExports[0];
  const valid = runtimeExports.length === 1
    && unit.runtimeReExports.length === 0
    && decision?.name === expected
    && decision.function
    && !decision.async;
  if (valid) return null;
  return {
    rule: "architecture/verb-owner",
    file: unit.path,
    line: unit.runtimeReExports[0]?.line ?? decision?.line ?? 1,
    column: unit.runtimeReExports[0]?.column ?? decision?.column ?? 1,
    detail: `verb owner must expose exactly one runtime export: non-async ${expected}`,
  };
}

function structureDiagnostics(units: readonly ParsedSource[], policy: ArchitecturePolicy): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const unit of units) {
    const basename = path.posix.basename(unit.path);
    if (policy.forbiddenFileNames.includes(basename)) diagnostics.push({
      rule: "architecture/removed-owner",
      file: unit.path,
      line: 1,
      column: 1,
      detail: `removed owner ${basename} must not exist`,
    });
    for (const declaration of unit.declarations) {
      if (policy.forbiddenDeclarations.some((pattern) => pattern.test(declaration.name))) diagnostics.push({
        rule: "architecture/removed-declaration",
        file: unit.path,
        line: declaration.line,
        column: declaration.column,
        detail: `removed declaration ${declaration.name}`,
      });
    }
    const verbOwner = verbOwnerDiagnostic(unit, policy);
    if (verbOwner) diagnostics.push(verbOwner);
    for (const use of unit.capabilities) {
      const rule = policy.capabilityRules.find((candidate) => candidate.capability === use.capability);
      if (rule && !rule.owners.some((owner) => matches(owner, unit.path))) diagnostics.push({
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
    ...metricDiagnostics(units, policy),
    ...structureDiagnostics(units, policy),
  ];
  for (const component of stronglyConnected(units)) diagnostics.push({
    rule: "architecture/dependency-cycle",
    file: component[0]!,
    line: 1,
    column: 1,
    detail: component.join(" -> "),
  });
  diagnostics.sort((left, right) => left.file.localeCompare(right.file)
    || left.line - right.line
    || left.column - right.column
    || left.rule.localeCompare(right.rule)
    || left.detail.localeCompare(right.detail));
  return { files: units.map((unit) => unit.path).sort(), diagnostics };
}
