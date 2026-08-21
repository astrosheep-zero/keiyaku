import path from "node:path";
import ts from "typescript";

export type ModelSource = Readonly<{ path: string; source: string }>;

export type ModelImpactPolicy = Readonly<{
  owners: readonly Readonly<{ source: string; owner: string }>[];
}>;

export type UsageKind = "construct" | "declaration" | "destructure" | "read" | "write";

export type FieldUsage = Readonly<{
  file: string;
  line: number;
  column: number;
  owner: string;
  kind: UsageKind;
}>;

export type FieldSnapshot = Readonly<{
  signature: string;
  usages: readonly FieldUsage[];
}>;

export type FieldImpact = Readonly<{
  key: string;
  file: string;
  model: string;
  field: string;
  change: "added" | "changed" | "removed";
  before?: FieldSnapshot;
  after?: FieldSnapshot;
  owners: readonly string[];
  files: readonly string[];
}>;

export type ModelImpactReport = Readonly<{
  base: string;
  head: string;
  fields: readonly FieldImpact[];
}>;

type FieldDeclaration = Readonly<{
  key: string;
  file: string;
  model: string;
  field: string;
  signature: string;
  locations: readonly Readonly<{ file: string; position: number }>[];
}>;

type SnapshotAnalysis = Readonly<{
  fields: ReadonlyMap<string, Readonly<{ declaration: FieldDeclaration; usages: readonly FieldUsage[] }>>;
}>;

function normalized(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function matches(pattern: string, candidate: string): boolean {
  if (pattern === "**") return true;
  if (pattern.endsWith("/**")) return candidate.startsWith(pattern.slice(0, -3));
  return pattern === candidate;
}

function ownerOf(file: string, policy: ModelImpactPolicy): string {
  return policy.owners.find((rule) => matches(rule.source, file))?.owner ?? "unowned";
}

function exported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function declarationsOf(
  program: ts.Program,
  root: string,
  sourceFile: ts.SourceFile,
  file: string,
): readonly FieldDeclaration[] {
  const checker = program.getTypeChecker();
  const grouped = new Map<string, FieldDeclaration>();
  for (const statement of sourceFile.statements) {
    if (!exported(statement) || (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)))
      continue;
    const model = statement.name.text;
    const modelType = checker.getTypeAtLocation(statement.name);
    for (const property of checker.getPropertiesOfType(modelType)) {
      const members = (property.declarations ?? []).filter((member): member is ts.PropertySignature => {
        if (!ts.isPropertySignature(member)) return false;
        return normalized(path.relative(root, member.getSourceFile().fileName)).startsWith("src/");
      });
      if (members.length === 0) continue;
      const field = property.getName();
      const key = `${file}#${model}.${field}`;
      const readonly = members.some((member) =>
        (ts.getModifiers(member) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword),
      );
      const optional = (property.flags & ts.SymbolFlags.Optional) !== 0;
      const propertyType = checker.getTypeOfSymbolAtLocation(property, statement);
      const type = checker.typeToString(propertyType, statement, ts.TypeFormatFlags.NoTruncation);
      const locations = members.map((member) => ({
        file: normalized(path.relative(root, member.getSourceFile().fileName)),
        position: member.name.getStart(member.getSourceFile()),
      }));
      const existing = grouped.get(key);
      grouped.set(key, {
        key,
        file,
        model,
        field,
        signature: `${readonly ? "readonly " : ""}${optional ? "optional " : ""}${type}`,
        locations: [...(existing?.locations ?? []), ...locations].filter(
          (location, index, all) =>
            all.findIndex(
              (candidate) => candidate.file === location.file && candidate.position === location.position,
            ) === index,
        ),
      });
    }
  }
  return [...grouped.values()];
}

function languageService(root: string, sources: readonly ModelSource[]): ts.LanguageService {
  const contents = new Map(sources.map((input) => [path.resolve(root, input.path), input.source]));
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    exactOptionalPropertyTypes: true,
    skipLibCheck: true,
  };
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getCurrentDirectory: () => root,
    getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
    getScriptFileNames: () => [...contents.keys()],
    getScriptSnapshot: (fileName) => {
      const source = contents.get(path.resolve(fileName)) ?? ts.sys.readFile(fileName);
      return source === undefined ? undefined : ts.ScriptSnapshot.fromString(source);
    },
    getScriptVersion: () => "0",
    fileExists: (fileName) => contents.has(path.resolve(fileName)) || ts.sys.fileExists(fileName),
    readFile: (fileName) => contents.get(path.resolve(fileName)) ?? ts.sys.readFile(fileName),
    readDirectory: ts.sys.readDirectory,
  };
  return ts.createLanguageService(host);
}

function nodeAt(sourceFile: ts.SourceFile, position: number): ts.Node {
  let found: ts.Node = sourceFile;
  const visit = (node: ts.Node): void => {
    if (position < node.getFullStart() || position >= node.end) return;
    found = node;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

const ASSIGNMENTS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

function usageKind(node: ts.Node): UsageKind {
  if (ts.isPropertySignature(node.parent)) return "declaration";
  if (ts.isPropertyAssignment(node.parent) || ts.isShorthandPropertyAssignment(node.parent)) return "construct";
  if (ts.isBindingElement(node.parent)) return "destructure";
  const access =
    ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent) ? node.parent : node;
  if (
    ts.isBinaryExpression(access.parent) &&
    access.parent.left === access &&
    ASSIGNMENTS.has(access.parent.operatorToken.kind)
  )
    return "write";
  if (
    (ts.isPrefixUnaryExpression(access.parent) || ts.isPostfixUnaryExpression(access.parent)) &&
    access.parent.operand === access
  )
    return "write";
  return "read";
}

function fieldUsage(
  service: ts.LanguageService,
  root: string,
  reference: ts.ReferenceEntry,
  policy: ModelImpactPolicy,
  isDefinition: boolean,
): FieldUsage | null {
  const relative = normalized(path.relative(root, reference.fileName));
  if (!relative.startsWith("src/") || relative.endsWith(".d.ts")) return null;
  const sourceFile = service.getProgram()?.getSourceFile(reference.fileName);
  if (!sourceFile) return null;
  const location = sourceFile.getLineAndCharacterOfPosition(reference.textSpan.start);
  return {
    file: relative,
    line: location.line + 1,
    column: location.character + 1,
    owner: ownerOf(relative, policy),
    kind: isDefinition ? "declaration" : usageKind(nodeAt(sourceFile, reference.textSpan.start)),
  };
}

function referenceUsages(
  service: ts.LanguageService,
  root: string,
  declaration: FieldDeclaration,
  policy: ModelImpactPolicy,
): readonly FieldUsage[] {
  const collected = new Map<string, FieldUsage>();
  const declarationLocations = new Set(
    declaration.locations.map((location) => `${path.resolve(root, location.file)}:${location.position}`),
  );
  for (const location of declaration.locations) {
    const declarationFile = path.resolve(root, location.file);
    const references = (service.findReferences(declarationFile, location.position) ?? []).flatMap(
      (group) => group.references,
    );
    for (const reference of references) {
      const isDefinition = declarationLocations.has(`${path.resolve(reference.fileName)}:${reference.textSpan.start}`);
      const usage = fieldUsage(service, root, reference, policy, isDefinition);
      if (usage) collected.set(`${usage.file}:${usage.line}:${usage.column}:${usage.kind}`, usage);
    }
  }
  return [...collected.values()].sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column ||
      left.kind.localeCompare(right.kind),
  );
}

function analyzeSnapshot(sources: readonly ModelSource[], policy: ModelImpactPolicy): SnapshotAnalysis {
  const root = path.resolve("/virtual-keiyaku-model-impact");
  const normalizedSources = sources.map((input) => ({ path: normalized(input.path), source: input.source }));
  const service = languageService(root, normalizedSources);
  const program = service.getProgram();
  if (!program) return { fields: new Map() };
  const fields = new Map<string, Readonly<{ declaration: FieldDeclaration; usages: readonly FieldUsage[] }>>();
  for (const input of normalizedSources) {
    const fileName = path.resolve(root, input.path);
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) continue;
    for (const declaration of declarationsOf(program, root, sourceFile, input.path)) {
      fields.set(declaration.key, { declaration, usages: referenceUsages(service, root, declaration, policy) });
    }
  }
  service.dispose();
  return { fields };
}

function snapshot(
  field: Readonly<{ declaration: FieldDeclaration; usages: readonly FieldUsage[] }> | undefined,
): FieldSnapshot | undefined {
  return field ? { signature: field.declaration.signature, usages: field.usages } : undefined;
}

export function analyzeModelImpact(
  base: readonly ModelSource[],
  head: readonly ModelSource[],
  labels: Readonly<{ base: string; head: string }>,
  policy: ModelImpactPolicy,
): ModelImpactReport {
  const before = analyzeSnapshot(base, policy);
  const after = analyzeSnapshot(head, policy);
  const keys = [...new Set([...before.fields.keys(), ...after.fields.keys()])].sort();
  const fields: FieldImpact[] = [];
  for (const key of keys) {
    const oldField = before.fields.get(key);
    const newField = after.fields.get(key);
    if (oldField?.declaration.signature === newField?.declaration.signature) continue;
    const declaration = newField?.declaration ?? oldField!.declaration;
    const usages = [...(oldField?.usages ?? []), ...(newField?.usages ?? [])];
    fields.push({
      key,
      file: declaration.file,
      model: declaration.model,
      field: declaration.field,
      change: oldField ? (newField ? "changed" : "removed") : "added",
      ...(oldField ? { before: snapshot(oldField)! } : {}),
      ...(newField ? { after: snapshot(newField)! } : {}),
      owners: [...new Set(usages.filter((usage) => usage.kind !== "declaration").map((usage) => usage.owner))].sort(),
      files: [...new Set(usages.filter((usage) => usage.kind !== "declaration").map((usage) => usage.file))].sort(),
    });
  }
  return { base: labels.base, head: labels.head, fields };
}
