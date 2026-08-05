import ts from "typescript";

export type FunctionMetric = Readonly<{
  file: string;
  name: string;
  line: number;
  column: number;
  lines: number;
  complexity: number;
  nesting: number;
  parameters: number;
  tokens: number;
  fingerprint: string;
}>;

type FunctionWithBody = ts.FunctionLikeDeclaration & Readonly<{ body: ts.ConciseBody }>;

export function isFunctionNode(node: ts.Node): node is FunctionWithBody {
  return ts.isFunctionLike(node) && "body" in node && node.body !== undefined;
}

function functionName(node: ts.FunctionLikeDeclaration, sourceFile: ts.SourceFile, line: number): string {
  if (node.name) return node.name.getText(sourceFile);
  if (ts.isVariableDeclaration(node.parent)) return node.parent.name.getText(sourceFile);
  if (ts.isPropertyAssignment(node.parent)) return node.parent.name.getText(sourceFile);
  return `<anonymous@${line}>`;
}

function controlDepth(node: ts.Node): boolean {
  return ts.isIfStatement(node)
    || ts.isForStatement(node)
    || ts.isForInStatement(node)
    || ts.isForOfStatement(node)
    || ts.isWhileStatement(node)
    || ts.isDoStatement(node)
    || ts.isSwitchStatement(node)
    || ts.isTryStatement(node)
    || ts.isCatchClause(node);
}

function addsComplexity(node: ts.Node): boolean {
  return ts.isIfStatement(node)
    || ts.isForStatement(node)
    || ts.isForInStatement(node)
    || ts.isForOfStatement(node)
    || ts.isWhileStatement(node)
    || ts.isDoStatement(node)
    || ts.isCatchClause(node)
    || ts.isConditionalExpression(node)
    || ts.isSwitchStatement(node);
}

const LOGICAL_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

function logicalExpression(node: ts.Node): boolean {
  return ts.isBinaryExpression(node) && LOGICAL_OPERATORS.has(node.operatorToken.kind);
}

function optionalChain(node: ts.Node): boolean {
  return (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node))
    && node.questionDotToken !== undefined;
}

function syntaxFingerprint(sourceFile: ts.SourceFile, body: ts.ConciseBody): Readonly<{ fingerprint: string; tokens: number }> {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, body.getText(sourceFile));
  const syntax: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    syntax.push(`${token}:${scanner.getTokenText()}`);
  }
  return { fingerprint: syntax.join("\u0000"), tokens: syntax.length };
}

export function functionMetric(file: string, sourceFile: ts.SourceFile, root: FunctionWithBody): FunctionMetric {
  const position = sourceFile.getLineAndCharacterOfPosition(root.getStart(sourceFile));
  const line = position.line + 1;
  const endLine = sourceFile.getLineAndCharacterOfPosition(root.end).line + 1;
  let complexity = 1;
  let nesting = 0;
  const walk = (node: ts.Node, depth: number): void => {
    if (node !== root && isFunctionNode(node)) return;
    const nextDepth = depth + (controlDepth(node) ? 1 : 0);
    nesting = Math.max(nesting, nextDepth);
    if (addsComplexity(node) || logicalExpression(node) || optionalChain(node)) complexity += 1;
    ts.forEachChild(node, (child) => walk(child, nextDepth));
  };
  walk(root, 0);
  complexity += root.parameters.filter((parameter) => parameter.initializer !== undefined).length;
  const syntax = syntaxFingerprint(sourceFile, root.body);
  return {
    file,
    name: functionName(root, sourceFile, line),
    line,
    column: position.character + 1,
    lines: endLine - line + 1,
    complexity,
    nesting,
    parameters: root.parameters.length,
    tokens: syntax.tokens,
    fingerprint: syntax.fingerprint,
  };
}
