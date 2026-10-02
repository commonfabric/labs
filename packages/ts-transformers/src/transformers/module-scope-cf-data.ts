import ts from "typescript";
import { isCommonFabricSymbol } from "@commonfabric/schema-generator/common-fabric-symbols";
import { declaresFabricPrimitiveBrand } from "@commonfabric/schema-generator/fabric-primitive-brand";
import {
  isTrustedBuilder,
  isTrustedDataHelper,
} from "@commonfabric/utils/sandbox-contract";
import { preserveSourceMapRange } from "../ast/mod.ts";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";
import { unwrapExpression } from "../utils/expression.ts";

const CF_DATA_CONSTRUCTOR_NAMES = new Set(["Map", "Set"]);

export class ModuleScopeCfDataTransformer extends HelpersOnlyTransformer {
  override transform(context: TransformationContext): ts.SourceFile {
    const { factory, sourceFile } = context;
    const localCallableBindings = collectTopLevelCallableBindings(sourceFile);
    const defaultExportedDataCallableBindings =
      collectDefaultExportedDataCallables(
        sourceFile,
        localCallableBindings,
      );
    let changed = false;
    const transformedStatements = sourceFile.statements.map((statement) => {
      const next = transformTopLevelStatement(
        statement,
        context,
        localCallableBindings,
        defaultExportedDataCallableBindings,
      );
      changed ||= next !== statement;
      return next;
    });
    if (!changed) {
      return sourceFile;
    }

    return factory.updateSourceFile(sourceFile, transformedStatements);
  }
}

function transformTopLevelStatement(
  statement: ts.Statement,
  context: TransformationContext,
  localCallableBindings: ReadonlySet<string>,
  defaultExportedDataCallableBindings: ReadonlySet<string>,
): ts.Statement {
  const { factory } = context;

  if (ts.isVariableStatement(statement)) {
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) {
      return statement;
    }

    let changed = false;
    const declarations = statement.declarationList.declarations.map(
      (declaration) => {
        if (
          !declaration.initializer ||
          !shouldWrapTopLevelExpression(
            declaration.initializer,
            context,
            localCallableBindings,
          )
        ) {
          return declaration;
        }
        changed = true;
        return factory.updateVariableDeclaration(
          declaration,
          declaration.name,
          declaration.exclamationToken,
          declaration.type,
          wrapWithCfData(declaration.initializer, context),
        );
      },
    );

    if (!changed) return statement;
    return factory.updateVariableStatement(
      statement,
      statement.modifiers,
      factory.updateVariableDeclarationList(
        statement.declarationList,
        declarations,
      ),
    );
  }

  if (ts.isExportAssignment(statement)) {
    const shouldWrap = shouldWrapTopLevelExpression(
      statement.expression,
      context,
      localCallableBindings,
    ) ||
      isDefaultExportedDataCallableIdentifier(
        statement.expression,
        defaultExportedDataCallableBindings,
      );
    if (!shouldWrap) {
      return statement;
    }
    return factory.updateExportAssignment(
      statement,
      statement.modifiers,
      wrapWithCfData(statement.expression, context),
    );
  }

  return statement;
}

function isDefaultExportedDataCallableIdentifier(
  expression: ts.Expression,
  defaultExportedDataCallableBindings: ReadonlySet<string>,
): boolean {
  const expr = unwrapExpression(expression);
  return ts.isIdentifier(expr) &&
    defaultExportedDataCallableBindings.has(expr.text);
}

function wrapWithCfData(
  expression: ts.Expression,
  context: TransformationContext,
): ts.CallExpression {
  // The HelpersOnlyTransformer filter guarantees the helpers import is
  // present; getHelperExpr throws if that invariant is ever violated.
  return preserveSourceMapRange(
    context.factory.createCallExpression(
      context.cfHelpers.getHelperExpr("__cf_data"),
      undefined,
      [expression],
    ),
    expression,
  );
}

function shouldWrapTopLevelExpression(
  expression: ts.Expression,
  context: TransformationContext,
  localCallableBindings: ReadonlySet<string>,
): boolean {
  if (isAnyLikeTypeAssertion(expression)) {
    return false;
  }

  const expr = unwrapExpression(expression);

  if (
    ts.isArrowFunction(expr) ||
    ts.isFunctionExpression(expr) ||
    ts.isClassExpression(expr)
  ) {
    return false;
  }

  if (ts.isCallExpression(expr)) {
    if (isTrustedBuilderCall(expr)) return false;
    return isTrustedDataHelperCall(expr) ||
      isImmediatelyInvokedFunction(expr) ||
      isIntrinsicCtDataCall(expr) ||
      isTopLevelLocalHelperCall(expr, localCallableBindings) ||
      isPrimitiveSnapshotCall(expr, context) ||
      ts.isPropertyAccessExpression(unwrapExpression(expr.expression));
  }

  if (ts.isNewExpression(expr)) {
    return hasNamedTarget(expr.expression, CF_DATA_CONSTRUCTOR_NAMES) ||
      constructsFabricPrimitive(expr, context);
  }

  if (
    expr.kind === ts.SyntaxKind.RegularExpressionLiteral ||
    ts.isObjectLiteralExpression(expr) ||
    ts.isArrayLiteralExpression(expr)
  ) {
    return true;
  }

  return false;
}

/**
 * Whether `expression` constructs a `FabricPrimitive`, such as
 * `new FabricDurationNsec(600n)`. The runtime freezer keeps one as it is
 * (`SES_SANDBOXING_SPEC.md` §4.2.3), so the construction is data to wrap.
 *
 * The class has to be one `commonfabric` declares, and its instance type has
 * to carry the `FabricPrimitive` brand. Neither is a matter of name: a renamed
 * import, a namespace member (`cf.FabricDurationNsec`), and a `const` bound to
 * either are wrapped, and a user class that shares a primitive's name is not.
 * The brand alone is not enough, since it is read by the name of its key
 * (`declaresFabricPrimitiveBrand`): a class of the author's own, whether it
 * declares a member under a symbol of that name or under the real one, or
 * extends a primitive, is not wrapped, so its constructor does not get to run
 * at top level on the strength of a wrap the freezer would then refuse.
 */
function constructsFabricPrimitive(
  expression: ts.NewExpression,
  context: TransformationContext,
): boolean {
  const { checker } = context;
  const constructor = constructorNamedBy(
    expression.expression,
    checker,
    new Set(),
  );
  return constructor !== undefined &&
    isCommonFabricSymbol(constructor) &&
    declaresFabricPrimitiveBrand(checker.getTypeAtLocation(expression));
}

/**
 * Helper for `constructsFabricPrimitive()`, which returns the symbol of the
 * constructor `expression` names: the declaration an import or a namespace
 * member resolves to, read through any `const` bound to a bare reference to
 * one, `const D = FabricDurationNsec`, at any depth. Returns `undefined` for
 * an expression that names nothing, such as an inline class, and for a
 * `const` that names itself. `seen` holds the symbols already read.
 */
function constructorNamedBy(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): ts.Symbol | undefined {
  const named = checker.getSymbolAtLocation(unwrapExpression(expression));
  const symbol = named && named.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(named)
    : named;
  if (!symbol || seen.has(symbol)) {
    return undefined;
  }
  seen.add(symbol);

  const declaration = symbol.valueDeclaration;
  if (
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0
  ) {
    const bound = unwrapExpression(declaration.initializer);
    if (ts.isIdentifier(bound) || ts.isPropertyAccessExpression(bound)) {
      return constructorNamedBy(bound, checker, seen);
    }
  }

  return symbol;
}

function isTrustedBuilderCall(expression: ts.CallExpression): boolean {
  return hasNamedTarget(expression.expression, isTrustedBuilder);
}

function isTrustedDataHelperCall(expression: ts.CallExpression): boolean {
  return hasNamedTarget(expression.expression, isTrustedDataHelper);
}

function isImmediatelyInvokedFunction(expression: ts.CallExpression): boolean {
  const target = unwrapExpression(expression.expression);
  return ts.isArrowFunction(target) || ts.isFunctionExpression(target);
}

function isIntrinsicCtDataCall(expression: ts.CallExpression): boolean {
  const target = unwrapExpression(expression.expression);
  return ts.isPropertyAccessExpression(target) &&
    ts.isIdentifier(target.expression) &&
    (
      target.expression.text === "Array" && target.name.text === "from" ||
      target.expression.text === "Object" &&
        target.name.text === "fromEntries"
    );
}

function isTopLevelLocalHelperCall(
  expression: ts.CallExpression,
  localCallableBindings: ReadonlySet<string>,
): boolean {
  const target = unwrapExpression(expression.expression);
  return ts.isIdentifier(target) && localCallableBindings.has(target.text);
}

function isPrimitiveSnapshotCall(
  expression: ts.CallExpression,
  context: TransformationContext,
): boolean {
  const target = unwrapExpression(expression.expression);
  if (!ts.isIdentifier(target)) {
    return false;
  }

  const type = context.checker.getTypeAtLocation(expression);
  return isPrimitiveLikeType(type);
}

function isPrimitiveLikeType(type: ts.Type): boolean {
  if (type.isUnion()) {
    return type.types.every((member) => isPrimitiveLikeType(member));
  }

  if (type.isIntersection()) {
    return type.types.every((member) => isPrimitiveLikeType(member));
  }

  return !!(
    type.flags &
    (
      ts.TypeFlags.StringLike |
      ts.TypeFlags.NumberLike |
      ts.TypeFlags.BooleanLike |
      ts.TypeFlags.BigIntLike |
      ts.TypeFlags.Null |
      ts.TypeFlags.Undefined |
      ts.TypeFlags.Void
    )
  );
}

function hasNamedTarget(
  expression: ts.Expression,
  namesOrMatcher: ReadonlySet<string> | ((name: string) => boolean),
): boolean {
  const matchesName = typeof namesOrMatcher === "function"
    ? namesOrMatcher
    : (name: string) => namesOrMatcher.has(name);
  const target = unwrapExpression(expression);
  if (ts.isIdentifier(target)) {
    return matchesName(target.text);
  }
  if (ts.isPropertyAccessExpression(target)) {
    return matchesName(target.name.text);
  }
  return false;
}

function collectTopLevelCallableBindings(
  sourceFile: ts.SourceFile,
): ReadonlySet<string> {
  const names = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      names.add(statement.name.text);
      continue;
    }

    if (!ts.isVariableStatement(statement)) continue;
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;

    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer
      ) {
        continue;
      }

      const initializer = unwrapExpression(declaration.initializer);
      if (
        ts.isArrowFunction(initializer) ||
        ts.isFunctionExpression(initializer)
      ) {
        names.add(declaration.name.text);
      }
    }
  }

  return names;
}

function collectDefaultExportedDataCallables(
  sourceFile: ts.SourceFile,
  localCallableBindings: ReadonlySet<string>,
): ReadonlySet<string> {
  const names = new Set<string>();
  const callableDeclarations = collectTopLevelCallableDeclarations(sourceFile);

  for (const statement of sourceFile.statements) {
    if (!ts.isExportAssignment(statement)) {
      continue;
    }
    const expression = unwrapExpression(statement.expression);
    if (
      ts.isIdentifier(expression) &&
      localCallableBindings.has(expression.text) &&
      callableMayReturnCallResult(callableDeclarations.get(expression.text))
    ) {
      names.add(expression.text);
    }
  }

  return names;
}

function collectTopLevelCallableDeclarations(
  sourceFile: ts.SourceFile,
): ReadonlyMap<string, ts.FunctionLikeDeclaration> {
  const declarations = new Map<string, ts.FunctionLikeDeclaration>();

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      declarations.set(statement.name.text, statement);
      continue;
    }

    if (!ts.isVariableStatement(statement)) continue;
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;

    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer
      ) {
        continue;
      }

      const initializer = unwrapExpression(declaration.initializer);
      if (
        ts.isArrowFunction(initializer) ||
        ts.isFunctionExpression(initializer)
      ) {
        declarations.set(declaration.name.text, initializer);
      }
    }
  }

  return declarations;
}

function callableMayReturnCallResult(
  declaration: ts.FunctionLikeDeclaration | undefined,
): boolean {
  if (!declaration?.body) {
    return false;
  }

  if (!ts.isBlock(declaration.body)) {
    return isCallOnCallResultExpression(declaration.body);
  }

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }
    if (node !== declaration.body && isFunctionBoundary(node)) {
      return;
    }
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      isCallOnCallResultExpression(node.expression)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.body);
  return found;
}

function isCallOnCallResultExpression(expression: ts.Expression): boolean {
  const expr = unwrapExpression(expression);
  if (isExpressionTraversalBoundary(expr)) {
    return false;
  }
  if (isDirectCallOnCallResultExpression(expr)) {
    return true;
  }

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }
    if (node !== expr && isExpressionTraversalBoundary(node)) {
      return;
    }
    if (
      ts.isExpression(node) &&
      isDirectCallOnCallResultExpression(node)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(expr, visit);
  return found;
}

function isDirectCallOnCallResultExpression(
  expression: ts.Expression,
): boolean {
  const expr = unwrapExpression(expression);
  return ts.isCallExpression(expr) &&
    ts.isCallExpression(unwrapExpression(expr.expression));
}

function isExpressionTraversalBoundary(node: ts.Node): boolean {
  return isFunctionBoundary(node) ||
    ts.isClassExpression(node) ||
    ts.isClassDeclaration(node);
}

function isFunctionBoundary(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node);
}

function isAnyLikeTypeAssertion(expression: ts.Expression): boolean {
  if (
    ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
  ) {
    return expression.type.kind === ts.SyntaxKind.AnyKeyword ||
      expression.type.kind === ts.SyntaxKind.UnknownKeyword;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return isAnyLikeTypeAssertion(expression.expression);
  }
  return false;
}
