import path from "node:path";
import ts from "typescript";
import type {
  Capability,
  CapabilityUse,
  Declaration,
  ImportReference,
  ImportedSymbols,
  ParsedSource,
  SourceInput,
} from "./engine.js";

function normalized(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^src\//, "");
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

export { parseSources };
