import ts from "typescript";
import {
  BINDING_IDENTITY_HELPER_NAME,
  FUNCTION_HARDENING_HELPER_NAME,
  VERIFIED_BINDING_METADATA_FIELD,
} from "@commonfabric/utils/sandbox-contract";
import { TransformationContext, Transformer } from "../core/mod.ts";
import { resolveWriterBinding } from "@commonfabric/schema-generator/writer-binding";
import { isCommonFabricModuleName } from "@commonfabric/schema-generator/common-fabric-symbols";
import { unwrapExpression } from "../utils/expression.ts";
import { normalizeWriterIdentityFile } from "../utils/writer-identity-file.ts";

export class ModuleScopeFunctionHardeningTransformer extends Transformer {
  override transform(context: TransformationContext): ts.SourceFile {
    const { factory, sourceFile } = context;
    const helperName = factory.createUniqueName(FUNCTION_HARDENING_HELPER_NAME);
    const bindingHelperName = factory.createUniqueName(
      BINDING_IDENTITY_HELPER_NAME,
    );
    let helperNeeded = false;
    let bindingHelperNeeded = false;
    // A writer is trusted where it is DECLARED, whichever module wrote the
    // claim that names it: the schema names the declaring module, and the
    // runtime verifies the write against that module's binding identity.
    const trustedBindingNames = new Set([
      ...collectWriteAuthorizedByBindingNames(sourceFile),
      ...(collectTrustedBindingsByFile(context).get(sourceFile.fileName) ??
        []),
    ]);
    const sourceFileName = normalizeWriterIdentityFile(
      sourceFile.fileName,
      context.options.canonicalWriterIdentityFile,
    );

    const statements = sourceFile.statements.flatMap((statement) =>
      transformTopLevelStatement(statement, context, {
        helperName: helperName.text,
        bindingHelperName: bindingHelperName.text,
        trustedBindingNames,
        sourceFileName,
        useHelper: () => {
          helperNeeded = true;
        },
        useBindingHelper: () => {
          bindingHelperNeeded = true;
        },
      })
    );

    return factory.updateSourceFile(
      sourceFile,
      [
        ...(bindingHelperNeeded
          ? [
            createBindingIdentityHelper(
              bindingHelperName.text,
            ),
          ]
          : []),
        ...(helperNeeded
          ? [
            createFunctionHardeningHelper(helperName.text),
          ]
          : []),
        ...statements,
      ],
    );
  }
}

interface HardeningState {
  readonly helperName: string;
  readonly bindingHelperName: string;
  readonly trustedBindingNames: ReadonlySet<string>;
  readonly sourceFileName: string;
  readonly useHelper: () => void;
  readonly useBindingHelper: () => void;
}

function transformTopLevelStatement(
  statement: ts.Statement,
  context: TransformationContext,
  state: HardeningState,
): ts.Statement[] {
  const { factory, sourceFile } = context;

  if (ts.isFunctionDeclaration(statement)) {
    return transformFunctionDeclaration(statement, sourceFile, factory, state);
  }

  if (ts.isVariableStatement(statement)) {
    return transformVariableStatement(statement, sourceFile, factory, state);
  }

  if (
    ts.isExportAssignment(statement) &&
    isDirectFunctionExpression(statement.expression)
  ) {
    state.useHelper();
    return [
      factory.updateExportAssignment(
        statement,
        statement.modifiers,
        wrapWithFunctionHardener(
          statement.expression,
          factory,
          state.helperName,
        ),
      ),
    ];
  }

  return [statement];
}

function transformFunctionDeclaration(
  statement: ts.FunctionDeclaration,
  _sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  state: HardeningState,
): ts.Statement[] {
  if (!statement.body) {
    return [statement];
  }

  if (statement.name) {
    state.useHelper();
    const postStatements: ts.Statement[] = [];
    if (state.trustedBindingNames.has(statement.name.text)) {
      state.useBindingHelper();
      postStatements.push(
        factory.createExpressionStatement(
          annotateBindingIdentifier(
            factory.createIdentifier(statement.name.text),
            statement.name.text,
            factory,
            state,
          ),
        ),
      );
    }
    return [
      statement,
      ...postStatements,
      factory.createExpressionStatement(
        wrapWithFunctionHardener(
          factory.createIdentifier(statement.name.text),
          factory,
          state.helperName,
        ),
      ),
    ];
  }

  if (!hasDefaultExportModifier(statement.modifiers)) {
    return [statement];
  }

  state.useHelper();
  const fnExpr = factory.createFunctionExpression(
    retainRuntimeFunctionModifiers(statement.modifiers),
    statement.asteriskToken,
    undefined,
    statement.typeParameters,
    statement.parameters,
    statement.type,
    statement.body,
  );

  // Wrapped in place — the same shape the export-assignment branch emits for
  // `export default <fn-expr>` — so no synthetic binding is minted whose
  // declaration and export names would have to be kept in sync.
  return [
    factory.createExportAssignment(
      undefined,
      false,
      wrapWithFunctionHardener(fnExpr, factory, state.helperName),
    ),
  ];
}

function transformVariableStatement(
  statement: ts.VariableStatement,
  _sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  state: HardeningState,
): ts.Statement[] {
  let changed = false;
  const postStatements: ts.Statement[] = [];
  const exported = hasExportModifier(statement.modifiers);
  const declarations = statement.declarationList.declarations.map(
    (declaration) => {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer
      ) {
        return declaration;
      }
      const initializer = unwrapExpression(declaration.initializer);
      const isTrustedBinding = state.trustedBindingNames.has(
        declaration.name.text,
      );
      const isDirectFunction = isDirectFunctionExpression(initializer);
      const isTrustedCallable = isTrustedBinding &&
        (ts.isCallExpression(initializer) || isDirectFunction);

      if (!isTrustedCallable && !isDirectFunction) {
        return declaration;
      }

      changed = true;
      const inlineBindingAnnotation = isTrustedCallable && exported;
      let rewritten = declaration.initializer;
      if (isTrustedCallable) {
        state.useBindingHelper();
        if (inlineBindingAnnotation) {
          rewritten = annotateBindingIdentifier(
            rewritten,
            declaration.name.text,
            factory,
            state,
          );
        } else {
          postStatements.push(
            factory.createExpressionStatement(
              annotateBindingIdentifier(
                factory.createIdentifier(declaration.name.text),
                declaration.name.text,
                factory,
                state,
              ),
            ),
          );
        }
      }

      if (isDirectFunction && isTrustedBinding && !inlineBindingAnnotation) {
        state.useHelper();
        postStatements.push(
          factory.createExpressionStatement(
            wrapWithFunctionHardener(
              factory.createIdentifier(declaration.name.text),
              factory,
              state.helperName,
            ),
          ),
        );
        return declaration;
      }

      if (isDirectFunction) {
        state.useHelper();
        rewritten = wrapWithFunctionHardener(
          rewritten,
          factory,
          state.helperName,
        );
      }

      return factory.updateVariableDeclaration(
        declaration,
        declaration.name,
        declaration.exclamationToken,
        declaration.type,
        rewritten,
      );
    },
  );

  if (!changed) {
    return [statement];
  }

  return [
    factory.updateVariableStatement(
      statement,
      statement.modifiers,
      factory.updateVariableDeclarationList(
        statement.declarationList,
        declarations,
      ),
    ),
    ...postStatements,
  ];
}

function wrapWithFunctionHardener(
  expression: ts.Expression,
  factory: ts.NodeFactory,
  helperName: string,
): ts.CallExpression {
  return factory.createCallExpression(
    factory.createIdentifier(helperName),
    undefined,
    [expression],
  );
}

function annotateBindingIdentifier(
  identifier: ts.Expression,
  bindingName: string,
  factory: ts.NodeFactory,
  state: HardeningState,
): ts.CallExpression {
  return factory.createCallExpression(
    factory.createIdentifier(state.bindingHelperName),
    undefined,
    [
      identifier,
      createBindingIdentityMetadata(bindingName, factory, state),
    ],
  );
}

function createBindingIdentityMetadata(
  bindingName: string,
  factory: ts.NodeFactory,
  state: HardeningState,
): ts.ObjectLiteralExpression {
  return factory.createObjectLiteralExpression([
    factory.createPropertyAssignment(
      factory.createIdentifier("sourceFile"),
      factory.createStringLiteral(state.sourceFileName),
    ),
    factory.createPropertyAssignment(
      factory.createIdentifier("bindingPath"),
      factory.createArrayLiteralExpression([
        factory.createStringLiteral(bindingName),
      ]),
    ),
  ], true);
}

function createFunctionHardeningHelper(
  helperName: string,
): ts.FunctionDeclaration {
  const factory = ts.factory;
  return factory.createFunctionDeclaration(
    undefined,
    undefined,
    factory.createIdentifier(helperName),
    undefined,
    [
      factory.createParameterDeclaration(
        undefined,
        undefined,
        factory.createIdentifier("fn"),
        undefined,
        factory.createTypeReferenceNode("Function"),
      ),
    ],
    undefined,
    factory.createBlock([
      factory.createExpressionStatement(
        factory.createCallExpression(
          factory.createPropertyAccessExpression(
            factory.createIdentifier("Object"),
            "freeze",
          ),
          undefined,
          [factory.createIdentifier("fn")],
        ),
      ),
      factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(
          [
            factory.createVariableDeclaration(
              factory.createIdentifier("prototype"),
              undefined,
              undefined,
              factory.createPropertyAccessExpression(
                factory.createIdentifier("fn"),
                "prototype",
              ),
            ),
          ],
          ts.NodeFlags.Const,
        ),
      ),
      factory.createIfStatement(
        factory.createBinaryExpression(
          factory.createIdentifier("prototype"),
          factory.createToken(ts.SyntaxKind.AmpersandAmpersandToken),
          factory.createBinaryExpression(
            factory.createTypeOfExpression(
              factory.createIdentifier("prototype"),
            ),
            factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
            factory.createStringLiteral("object"),
          ),
        ),
        factory.createBlock([
          factory.createExpressionStatement(
            factory.createCallExpression(
              factory.createPropertyAccessExpression(
                factory.createIdentifier("Object"),
                "freeze",
              ),
              undefined,
              [factory.createIdentifier("prototype")],
            ),
          ),
        ], true),
      ),
      factory.createReturnStatement(factory.createIdentifier("fn")),
    ], true),
  );
}

function createBindingIdentityHelper(
  helperName: string,
): ts.FunctionDeclaration {
  const factory = ts.factory;
  const value = factory.createIdentifier("value");
  const metadata = factory.createIdentifier("metadata");
  const implementation = factory.createIdentifier("implementation");

  return factory.createFunctionDeclaration(
    undefined,
    undefined,
    factory.createIdentifier(helperName),
    undefined,
    [
      factory.createParameterDeclaration(
        undefined,
        undefined,
        value,
        undefined,
        factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
      ),
      factory.createParameterDeclaration(
        undefined,
        undefined,
        metadata,
        undefined,
        factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
      ),
    ],
    undefined,
    factory.createBlock([
      factory.createIfStatement(
        createExtensibleObjectOrFunctionCheck(value, factory),
        factory.createBlock([
          factory.createExpressionStatement(
            createDefineBindingMetadataCall(value, metadata, factory),
          ),
        ], true),
      ),
      factory.createIfStatement(
        factory.createBinaryExpression(
          createObjectOrFunctionCheck(value, factory),
          factory.createToken(ts.SyntaxKind.AmpersandAmpersandToken),
          factory.createBinaryExpression(
            factory.createTypeOfExpression(
              factory.createPropertyAccessExpression(value, "implementation"),
            ),
            factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
            factory.createStringLiteral("function"),
          ),
        ),
        factory.createBlock([
          factory.createVariableStatement(
            undefined,
            factory.createVariableDeclarationList([
              factory.createVariableDeclaration(
                implementation,
                undefined,
                undefined,
                factory.createPropertyAccessExpression(value, "implementation"),
              ),
            ], ts.NodeFlags.None),
          ),
          factory.createIfStatement(
            createExtensibleObjectOrFunctionCheck(implementation, factory),
            factory.createBlock([
              factory.createExpressionStatement(
                createDefineBindingMetadataCall(
                  implementation,
                  metadata,
                  factory,
                ),
              ),
            ], true),
          ),
        ], true),
      ),
      factory.createReturnStatement(value),
    ], true),
  );
}

function createDefineBindingMetadataCall(
  target: ts.Expression,
  metadata: ts.Expression,
  factory: ts.NodeFactory,
): ts.CallExpression {
  return factory.createCallExpression(
    factory.createPropertyAccessExpression(
      factory.createIdentifier("Object"),
      "defineProperty",
    ),
    undefined,
    [
      target,
      factory.createStringLiteral(VERIFIED_BINDING_METADATA_FIELD),
      factory.createObjectLiteralExpression([
        factory.createPropertyAssignment(
          factory.createIdentifier("value"),
          metadata,
        ),
        factory.createPropertyAssignment(
          factory.createIdentifier("configurable"),
          factory.createTrue(),
        ),
      ], true),
    ],
  );
}

function createExtensibleObjectOrFunctionCheck(
  value: ts.Expression,
  factory: ts.NodeFactory,
): ts.Expression {
  return factory.createBinaryExpression(
    createObjectOrFunctionCheck(value, factory),
    factory.createToken(ts.SyntaxKind.AmpersandAmpersandToken),
    factory.createCallExpression(
      factory.createPropertyAccessExpression(
        factory.createIdentifier("Object"),
        "isExtensible",
      ),
      undefined,
      [value],
    ),
  );
}

function createObjectOrFunctionCheck(
  value: ts.Expression,
  factory: ts.NodeFactory,
): ts.Expression {
  return factory.createBinaryExpression(
    value,
    factory.createToken(ts.SyntaxKind.AmpersandAmpersandToken),
    factory.createParenthesizedExpression(
      factory.createBinaryExpression(
        factory.createBinaryExpression(
          factory.createTypeOfExpression(value),
          factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
          factory.createStringLiteral("object"),
        ),
        factory.createToken(ts.SyntaxKind.BarBarToken),
        factory.createBinaryExpression(
          factory.createTypeOfExpression(value),
          factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
          factory.createStringLiteral("function"),
        ),
      ),
    ),
  );
}

/** Which type argument of a policy alias carries the writer binding. */
type BindingPositions = (
  reference: ts.TypeReferenceNode,
) => ReadonlySet<number> | undefined;

/**
 * The key a reference stands for in a positions index, and the key an alias
 * declaration is indexed under. The library's policy types are keyed by
 * their bare names; an authored alias's key must never collide with those,
 * since an alias that borrows the name `WriteAuthorizedBy` names no writer.
 */
interface AliasKeys {
  readonly reference: (reference: ts.TypeReferenceNode) => string | undefined;
  readonly declaration: (declaration: ts.TypeAliasDeclaration) => string;
}

const referenceName = (reference: ts.TypeReferenceNode): ts.Identifier =>
  ts.isIdentifier(reference.typeName)
    ? reference.typeName
    : reference.typeName.right;

const leftmostName = (name: ts.EntityName): ts.Identifier =>
  ts.isIdentifier(name) ? name : leftmostName(name.left);

const LIBRARY_BINDING_POSITIONS: ReadonlyMap<string, ReadonlySet<number>> =
  new Map([
    ["WriteAuthorizedBy", new Set([1])],
    ["TrustedActionWrite", new Set([1])],
    ["TrustedActionWriteWithIntegrity", new Set([1])],
  ]);

/**
 * The binding names this file's own claims cite, read from the file as it
 * reaches this stage and by spelling. Kept beside the program-wide index
 * below for a claim an earlier stage synthesized, which the program's
 * original files do not hold.
 */
function collectWriteAuthorizedByBindingNames(
  sourceFile: ts.SourceFile,
): Set<string> {
  const bySpelling: AliasKeys = {
    reference: (reference) =>
      ts.isIdentifier(reference.typeName) ? reference.typeName.text : undefined,
    declaration: (declaration) => declaration.name.text,
  };
  const positionsByKey = discoverAliasBindingPositions(
    [sourceFile],
    bySpelling,
  );
  const names = new Set<string>();
  visitWriterBindings(
    sourceFile,
    (reference) => {
      const key = bySpelling.reference(reference);
      return key === undefined ? undefined : positionsByKey.get(key);
    },
    (binding) => names.add(binding.text),
  );
  return names;
}

const trustedBindingsByProgram = new WeakMap<
  ts.Program,
  ReadonlyMap<string, ReadonlySet<string>>
>();

/**
 * Every writer binding a claim anywhere in the program names, indexed by the
 * module that DECLARES it. A claim in an importing module names a writer
 * declared elsewhere — `cfc-spec-gallery` binds the trusted surfaces' writers
 * this way — and that writer's own module must give it the binding identity,
 * or the runtime finds no identity to verify the claim against. Claims and
 * policy aliases are read from the program's original files and resolved
 * through the checker: an alias declared in another module, and a binding
 * imported under another name, resolve to what they stand for.
 */
function collectTrustedBindingsByFile(
  context: TransformationContext,
): ReadonlyMap<string, ReadonlySet<string>> {
  const { program, checker } = context;
  const cached = trustedBindingsByProgram.get(program);
  if (cached) return cached;
  const files = program.getSourceFiles().filter((file) =>
    !file.isDeclarationFile && !program.isSourceFileDefaultLibrary(file)
  );
  // A reference stands for one of the library's policy types when it is
  // imported from the library, through any chain of authored re-exports; an
  // authored alias, including one that borrows the name, is keyed by its
  // own declaration and reads as what it declares.
  const declarationKey = (declaration: ts.TypeAliasDeclaration): string =>
    `${declaration.getSourceFile().fileName}\0${declaration.name.text}`;
  const byDeclaration: AliasKeys = {
    reference: (reference) => {
      const name = referenceName(reference);
      const symbol = checker.getSymbolAtLocation(name);
      const resolved = symbol && symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol;
      const declaration = resolved?.declarations?.find(
        ts.isTypeAliasDeclaration,
      );
      // The library's type is known by its DECLARED name, whatever the
      // reference spells it — `import { WriteAuthorizedBy as Guarded }` — and
      // by where it comes from. A qualified `cf.WriteAuthorizedBy` is the
      // library's when its namespace is: the right-hand name resolves past
      // every import hop.
      const canonical = declaration?.name.text ?? name.text;
      const qualifier = ts.isQualifiedName(reference.typeName)
        ? checker.getSymbolAtLocation(leftmostName(reference.typeName))
        : undefined;
      if (
        LIBRARY_BINDING_POSITIONS.has(canonical) &&
        (isImportedFromLibrary(symbol, checker) ||
          isImportedFromLibrary(qualifier, checker))
      ) {
        return canonical;
      }
      return declaration && declarationKey(declaration);
    },
    declaration: declarationKey,
  };
  const positionsByKey = discoverAliasBindingPositions(files, byDeclaration);
  const positionsFor: BindingPositions = (reference) => {
    const key = byDeclaration.reference(reference);
    return key === undefined ? undefined : positionsByKey.get(key);
  };
  const byFile = new Map<string, Set<string>>();
  for (const file of files) {
    visitWriterBindings(file, positionsFor, (binding) => {
      const resolved = resolveWriterBinding(binding, checker);
      if (!resolved) return;
      let names = byFile.get(resolved.fileName);
      if (!names) {
        names = new Set();
        byFile.set(resolved.fileName, names);
      }
      names.add(resolved.name);
    });
  }
  trustedBindingsByProgram.set(program, byFile);
  return byFile;
}

/**
 * Whether `symbol`, followed one import or re-export at a time, is brought in
 * from a Common Fabric module: a hop that imports from one by name, or a hop
 * declared in a declaration file, which authored code never is — that is how
 * a namespace-qualified `cf.WriteAuthorizedBy` resolves, straight to the
 * library's own re-export. The first hop out of authored code is what
 * decides it: the library's own files are roots of the compile too, and its
 * `WriteAuthorizedBy` is declared in a companion module the path-based
 * provenance check does not recognize, so neither the roots nor the final
 * declaration can say whose type this is.
 */
function isImportedFromLibrary(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): boolean {
  const seen = new Set<ts.Symbol>();
  let current = symbol;
  while (
    current && current.flags & ts.SymbolFlags.Alias && !seen.has(current)
  ) {
    seen.add(current);
    for (const declaration of current.declarations ?? []) {
      if (declaration.getSourceFile().isDeclarationFile) return true;
      const specifier = importModuleSpecifier(declaration);
      if (
        specifier !== undefined &&
        (isCommonFabricModuleName(specifier) ||
          specifier.startsWith("commonfabric/"))
      ) {
        return true;
      }
    }
    current = checker.getImmediateAliasedSymbol(current);
  }
  return false;
}

/** The module an import or re-export declaration names, if it names one. */
function importModuleSpecifier(
  declaration: ts.Declaration,
): string | undefined {
  let node: ts.Node | undefined = declaration;
  while (
    node && !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)
  ) {
    node = node.parent;
  }
  const specifier = node?.moduleSpecifier;
  return specifier && ts.isStringLiteral(specifier)
    ? specifier.text
    : undefined;
}

/**
 * For every type alias in `files` that forwards a type parameter into a
 * binding position of a policy it names, which of its own positions those
 * are — to a fixed point, so an alias of an alias is read too. Keyed as
 * `keys` says, seeded with the library's policy types under their names.
 */
function discoverAliasBindingPositions(
  files: readonly ts.SourceFile[],
  keys: AliasKeys,
): Map<string, Set<number>> {
  const positionsByKey = new Map<string, Set<number>>(
    [...LIBRARY_BINDING_POSITIONS].map(([name, positions]) => [
      name,
      new Set(positions),
    ]),
  );
  const positionsFor: BindingPositions = (reference) => {
    const key = keys.reference(reference);
    return key === undefined ? undefined : positionsByKey.get(key);
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const file of files) {
      for (const statement of file.statements) {
        if (
          !ts.isTypeAliasDeclaration(statement) ||
          !ts.isIdentifier(statement.name)
        ) {
          continue;
        }

        const positions = collectAliasBindingPositions(
          statement,
          positionsFor,
        );
        if (!positions.size) {
          continue;
        }

        const key = keys.declaration(statement);
        const existing = positionsByKey.get(key) ?? new Set();
        for (const position of positions) {
          if (!existing.has(position)) {
            existing.add(position);
            changed = true;
          }
        }
        positionsByKey.set(key, existing);
      }
    }
  }

  return positionsByKey;
}

/** Calls `onBinding` for each `typeof` identifier in a binding position. */
function visitWriterBindings(
  root: ts.Node,
  positionsFor: BindingPositions,
  onBinding: (binding: ts.Identifier) => void,
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node)) {
      const positions = positionsFor(node);
      if (positions) {
        for (const position of positions) {
          const bindingNode = node.typeArguments?.[position];
          if (bindingNode) {
            collectTypeQueryIdentifiers(bindingNode, onBinding);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
}

function collectAliasBindingPositions(
  declaration: ts.TypeAliasDeclaration,
  positionsFor: BindingPositions,
): Set<number> {
  const typeParameterPositions = new Map<string, number>();
  declaration.typeParameters?.forEach((parameter, index) => {
    typeParameterPositions.set(parameter.name.text, index);
  });

  const positions = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node)) {
      const bindingPositions = positionsFor(node);
      if (bindingPositions) {
        for (const bindingPosition of bindingPositions) {
          const bindingNode = node.typeArguments?.[bindingPosition];
          if (bindingNode) {
            collectTypeParameterPositions(
              bindingNode,
              typeParameterPositions,
              positions,
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.type);

  return positions;
}

function collectTypeParameterPositions(
  node: ts.Node,
  typeParameterPositions: ReadonlyMap<string, number>,
  positions: Set<number>,
): void {
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const position = typeParameterPositions.get(node.typeName.text);
    if (position !== undefined) {
      positions.add(position);
    }
  }
  ts.forEachChild(
    node,
    (child) =>
      collectTypeParameterPositions(child, typeParameterPositions, positions),
  );
}

function collectTypeQueryIdentifiers(
  node: ts.Node,
  onBinding: (binding: ts.Identifier) => void,
): void {
  if (ts.isTypeQueryNode(node) && ts.isIdentifier(node.exprName)) {
    onBinding(node.exprName);
  }
  ts.forEachChild(
    node,
    (child) => collectTypeQueryIdentifiers(child, onBinding),
  );
}

function isDirectFunctionExpression(expression: ts.Expression): boolean {
  const expr = unwrapExpression(expression);
  return ts.isArrowFunction(expr) || ts.isFunctionExpression(expr);
}

function hasDefaultExportModifier(
  modifiers: ts.NodeArray<ts.ModifierLike> | undefined,
): boolean {
  return !!modifiers?.some((modifier) =>
    modifier.kind === ts.SyntaxKind.DefaultKeyword
  );
}

function hasExportModifier(
  modifiers: ts.NodeArray<ts.ModifierLike> | undefined,
): boolean {
  return !!modifiers?.some((modifier) =>
    modifier.kind === ts.SyntaxKind.ExportKeyword
  );
}

function retainRuntimeFunctionModifiers(
  modifiers: ts.NodeArray<ts.ModifierLike> | undefined,
): ts.Modifier[] | undefined {
  const retained = modifiers?.filter((modifier): modifier is ts.Modifier =>
    modifier.kind === ts.SyntaxKind.AsyncKeyword
  );
  return retained?.length ? retained : undefined;
}
