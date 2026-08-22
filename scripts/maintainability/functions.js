export function functionName(node) {
  if (node.id?.type === "Identifier") return node.id.name;
  const parent = node.parent;
  if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") return parent.id.name;
  if ((parent?.type === "MethodDefinition" || parent?.type === "Property") && parent.key) {
    return parent.key.type === "Identifier" ? parent.key.name : String(parent.key.value);
  }
  return null;
}

function isEmbedded(node) {
  const parent = node.parent;
  if (!parent || node !== parent.value) return false;
  if (parent.type === "MethodDefinition") return true;
  return parent.type === "Property" && (parent.method === true || parent.kind === "get" || parent.kind === "set");
}

function fullCommentLines(sourceCode) {
  const lines = new Set();
  for (const comment of sourceCode.getAllComments()) {
    let start = comment.loc.start.line;
    let end = comment.loc.end.line;
    let before = comment;
    do before = sourceCode.getTokenBefore(before, { includeComments: true });
    while (before?.type === "Block" || before?.type === "Line");
    let after = comment;
    do after = sourceCode.getTokenAfter(after, { includeComments: true });
    while (after?.type === "Block" || after?.type === "Line");
    if (before && before.loc.end.line === comment.loc.start.line) start += 1;
    if (after && after.loc.start.line === comment.loc.end.line) end -= 1;
    for (let line = start; line <= end; line += 1) lines.add(line);
  }
  return lines;
}

export function effectiveFileLineCount(sourceCode) {
  const comments = fullCommentLines(sourceCode);
  const lastLine = sourceCode.lines.at(-1) === "" ? sourceCode.lines.length - 1 : sourceCode.lines.length;
  let count = 0;
  for (let line = 1; line <= lastLine; line += 1) {
    if (sourceCode.lines[line - 1].trim() === "" || comments.has(line)) continue;
    count += 1;
  }
  return count;
}

export function effectiveFunctionLineCount(node, sourceCode) {
  const target = isEmbedded(node) ? node.parent : node;
  const comments = fullCommentLines(sourceCode);
  let count = 0;
  for (let line = target.loc.start.line; line <= target.loc.end.line; line += 1) {
    if (sourceCode.lines[line - 1].trim() === "" || comments.has(line)) continue;
    count += 1;
  }
  return count;
}

export function functionVisitor(callback) {
  return {
    FunctionDeclaration: (node) => callback(node),
    FunctionExpression: (node) => callback(node),
    ArrowFunctionExpression: (node) => callback(node),
  };
}
