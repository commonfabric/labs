import ts from "typescript";
import { isObjectNotArray } from "@commonfabric/utils/types";

import {
  classifyArrayMethodCall,
  classifyArrayMethodCallSite,
  detectCallKind,
  detectDirectBuilderCall,
  detectNewExpressionKind,
  getEnclosingFunctionLikeDeclaration,
  getPatternBuilderCallbackArgument,
  getTypeAtLocationWithFallback,
  hasReactiveCollectionProvenance,
  isCellLikeType,
  isReactiveValueExpression,
} from "../ast/mod.ts";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";
import {
  isTransparentWrapper,
  unwrapExpression,
  unwrapParentheses,
} from "../utils/expression.ts";
import {
  isPatternFactoryCalleeExpression,
  isPatternFactoryHelperExpression,
} from "./structural-reactive-factory.ts";

type CausePathElement = string | number;
type CausePath = readonly CausePathElement[];
type ForCause = string | CausePath | { readonly stream: string | CausePath };

const PATTERN_RESULT_CAUSE = "__patternResult";

/**
 * Per transform run, the variables whose initializer this stage found to be a
 * reactive value by construction: a call or `new` it classified as one, or
 * a chain that already carries an authored `.for()`. A reference to one is a
 * reactive node whatever its type says (`isCellByType()`).
 */
const causedVariablesByRun = new WeakMap<
  TransformationContext,
  Set<ts.Symbol>
>();

function causedVariablesOf(context: TransformationContext): Set<ts.Symbol> {
  let variables = causedVariablesByRun.get(context);
  if (!variables) {
    variables = new Set();
    causedVariablesByRun.set(context, variables);
  }
  return variables;
}

export class ReactiveVariableForTransformer extends HelpersOnlyTransformer {
  override transform(context: TransformationContext): ts.SourceFile {
    const visitor = createReactiveVariableForVisitor(context);
    return ts.visitNode(context.sourceFile, visitor) as ts.SourceFile;
  }
}

function createReactiveVariableForVisitor(
  context: TransformationContext,
): ts.Visitor {
  const visit: ts.Visitor = (node: ts.Node): ts.Node => {
    if (ts.isCallExpression(node)) {
      const patternCallback = getPatternBuilderCallbackArgument(
        node,
        context.checker,
      );
      if (patternCallback) {
        return visitPatternCall(node, patternCallback, context, visit);
      }
    }

    if (!ts.isVariableDeclarationList(node)) {
      return ts.visitEachChild(node, visit, context.tsContext);
    }

    if ((node.flags & ts.NodeFlags.Const) === 0) {
      return ts.visitEachChild(node, visit, context.tsContext);
    }

    let changed = false;
    const declarations = node.declarations.map((declaration) => {
      if (
        !ts.isIdentifier(declaration.name) ||
        isInternalSyntheticName(declaration.name.text) ||
        !declaration.initializer
      ) {
        const visited = ts.visitEachChild(
          declaration,
          visit,
          context.tsContext,
        ) as ts.VariableDeclaration;
        changed ||= visited !== declaration;
        return visited;
      }

      let initializer = visitExpressionWithCausePath(
        declaration.initializer,
        [declaration.name.text],
        context,
        visit,
        { includeRoot: false },
      );

      if (isReactiveByConstruction(initializer, context)) {
        const symbol = context.checker.getSymbolAtLocation(declaration.name);
        if (symbol) {
          causedVariablesOf(context).add(symbol);
        }
      }

      if (shouldAddVariableFor(initializer, context)) {
        initializer = createForCall(
          initializer,
          declaration.name.text,
          context,
        );
      }

      if (initializer === declaration.initializer) {
        return declaration;
      }

      changed = true;
      return context.factory.updateVariableDeclaration(
        declaration,
        declaration.name,
        declaration.exclamationToken,
        declaration.type,
        initializer,
      );
    });

    return changed
      ? context.factory.updateVariableDeclarationList(
        node,
        declarations,
      )
      : node;
  };

  return visit;
}

function visitPatternCall(
  node: ts.CallExpression,
  patternCallback: ts.ArrowFunction | ts.FunctionExpression,
  context: TransformationContext,
  visit: ts.Visitor,
): ts.CallExpression {
  let changed = false;
  const callTarget = ts.visitNode(node.expression, visit) as ts.Expression;
  changed ||= callTarget !== node.expression;

  const args = node.arguments.map((argument) => {
    const visited = visitPatternCallbackArgument(
      argument,
      patternCallback,
      context,
      visit,
    );
    changed ||= visited !== argument;
    return visited;
  });

  return changed
    ? context.factory.updateCallExpression(
      node,
      callTarget,
      node.typeArguments,
      args,
    )
    : node;
}

function visitPatternCallbackArgument(
  argument: ts.Expression,
  patternCallback: ts.ArrowFunction | ts.FunctionExpression,
  context: TransformationContext,
  visit: ts.Visitor,
): ts.Expression {
  if (argument === patternCallback) {
    return visitPatternCallbackFunction(patternCallback, context, visit);
  }

  return ts.visitEachChild(
    argument,
    (child) =>
      child === patternCallback
        ? visitPatternCallbackFunction(patternCallback, context, visit)
        : visit(child),
    context.tsContext,
  ) as ts.Expression;
}

function visitPatternCallbackFunction(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  context: TransformationContext,
  visit: ts.Visitor,
): ts.ArrowFunction | ts.FunctionExpression {
  if (ts.isArrowFunction(callback) && !ts.isBlock(callback.body)) {
    const body = visitExpressionWithCausePath(
      callback.body,
      [PATTERN_RESULT_CAUSE],
      context,
      visit,
      { includeRoot: true },
    );
    return context.factory.updateArrowFunction(
      callback,
      callback.modifiers,
      callback.typeParameters,
      callback.parameters,
      callback.type,
      callback.equalsGreaterThanToken,
      body,
    );
  }

  const body = ts.visitNode(
    callback.body,
    (node) => visitPatternCallbackBodyNode(node, context, visit),
    ts.isBlock,
  );
  if (!body || body === callback.body) {
    return callback;
  }

  return ts.isArrowFunction(callback)
    ? context.factory.updateArrowFunction(
      callback,
      callback.modifiers,
      callback.typeParameters,
      callback.parameters,
      callback.type,
      callback.equalsGreaterThanToken,
      body,
    )
    : context.factory.updateFunctionExpression(
      callback,
      callback.modifiers,
      callback.asteriskToken,
      callback.name,
      callback.typeParameters,
      callback.parameters,
      callback.type,
      body,
    );
}

function visitPatternCallbackBodyNode(
  node: ts.Node,
  context: TransformationContext,
  visit: ts.Visitor,
): ts.Node {
  if (
    node !== undefined &&
    (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isConstructorDeclaration(node)
    )
  ) {
    return ts.visitEachChild(node, visit, context.tsContext);
  }

  if (ts.isReturnStatement(node) && node.expression) {
    return context.factory.updateReturnStatement(
      node,
      visitExpressionWithCausePath(
        node.expression,
        [PATTERN_RESULT_CAUSE],
        context,
        visit,
        { includeRoot: true },
      ),
    );
  }

  if (ts.isExpression(node) || ts.isVariableDeclarationList(node)) {
    return visit(node) as ts.Node;
  }

  return ts.visitEachChild(
    node,
    (child) => visitPatternCallbackBodyNode(child, context, visit),
    context.tsContext,
  );
}

function visitExpressionWithCausePath(
  expression: ts.Expression,
  causePath: CausePath,
  context: TransformationContext,
  visit: ts.Visitor,
  options: {
    includeRoot: boolean;
    allowReactiveIdentifierRetargeting?: boolean;
  },
): ts.Expression {
  const addRootFor = options.includeRoot &&
    shouldAddPropertyFor(expression, context);
  if (
    ts.isArrowFunction(expression) ||
    ts.isFunctionExpression(expression)
  ) {
    return ts.visitEachChild(
      expression,
      visit,
      context.tsContext,
    ) as ts.Expression;
  }
  if (addRootFor && isTransparentWrapper(expression)) {
    return createForCall(expression, causePath, context);
  }

  const visited = visitExpressionChildrenWithCausePath(
    expression,
    causePath,
    context,
    visit,
    {
      skipCallArguments: addRootFor,
      allowReactiveIdentifierRetargeting:
        options.allowReactiveIdentifierRetargeting ?? true,
    },
  );

  if (!addRootFor) {
    return visited;
  }

  return createForCall(visited, causePath, context);
}

function visitExpressionChildrenWithCausePath(
  expression: ts.Expression,
  causePath: CausePath,
  context: TransformationContext,
  visit: ts.Visitor,
  options: {
    skipCallArguments: boolean;
    allowReactiveIdentifierRetargeting: boolean;
  },
): ts.Expression {
  if (ts.isObjectLiteralExpression(expression)) {
    let changed = false;
    const properties = expression.properties.map((property) => {
      if (
        !ts.isPropertyAssignment(property) &&
        !ts.isShorthandPropertyAssignment(property)
      ) {
        const visited = ts.visitEachChild(
          property,
          visit,
          context.tsContext,
        ) as ts.ObjectLiteralElementLike;
        changed ||= visited !== property;
        return visited;
      }

      const propertyName = getStablePropertyName(property.name);
      if (
        !propertyName ||
        isInternalSyntheticName(propertyName)
      ) {
        const visited = ts.visitEachChild(
          property,
          visit,
          context.tsContext,
        ) as ts.PropertyAssignment;
        changed ||= visited !== property;
        return visited;
      }

      const initializerExpression = ts.isPropertyAssignment(property)
        ? property.initializer
        : property.name;
      const initializer = visitObjectPropertyInitializerWithCausePath(
        initializerExpression,
        [...causePath, propertyName],
        context,
        visit,
        {
          allowReactiveIdentifierRetargeting:
            options.allowReactiveIdentifierRetargeting,
        },
      );
      if (initializer === initializerExpression) {
        return property;
      }

      changed = true;
      const updatedProperty = context.factory.createPropertyAssignment(
        property.name,
        initializer,
      );
      return context.cfHelpers.preserveNodeSourceMap(
        updatedProperty,
        property,
        property,
      );
    });

    return changed
      ? context.factory.updateObjectLiteralExpression(expression, properties)
      : expression;
  }

  if (ts.isArrayLiteralExpression(expression)) {
    let changed = false;
    const elements = expression.elements.map((element, index) => {
      if (ts.isOmittedExpression(element) || ts.isSpreadElement(element)) {
        const visited = ts.visitEachChild(
          element,
          visit,
          context.tsContext,
        ) as ts.Expression;
        changed ||= visited !== element;
        return visited;
      }

      const visited = visitExpressionWithCausePath(
        element,
        [...causePath, index],
        context,
        visit,
        {
          includeRoot: true,
          allowReactiveIdentifierRetargeting:
            options.allowReactiveIdentifierRetargeting,
        },
      );
      changed ||= visited !== element;
      return visited;
    });

    return changed
      ? context.factory.updateArrayLiteralExpression(expression, elements)
      : expression;
  }

  if (ts.isCallExpression(expression)) {
    if (options.skipCallArguments) {
      return expression;
    }

    let changed = false;
    const allowArgumentReactiveIdentifierRetargeting =
      options.allowReactiveIdentifierRetargeting &&
      !shouldPreserveStructuralCallArgumentReferences(expression, context);
    const callTarget = ts.visitNode(
      expression.expression,
      visit,
    ) as ts.Expression;
    changed ||= callTarget !== expression.expression;

    const argumentsArray = expression.arguments.map((argument, index) => {
      const argumentPath = getCallArgumentCausePath(
        causePath,
        argument,
        index,
        expression.arguments.length,
      );
      const visited = visitExpressionWithCausePath(
        argument,
        argumentPath,
        context,
        visit,
        {
          includeRoot: true,
          allowReactiveIdentifierRetargeting:
            allowArgumentReactiveIdentifierRetargeting,
        },
      );
      changed ||= visited !== argument;
      return visited;
    });

    return changed
      ? context.factory.updateCallExpression(
        expression,
        callTarget,
        expression.typeArguments,
        argumentsArray,
      )
      : expression;
  }

  if (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) {
    return ts.visitEachChild(
      expression,
      (child) =>
        child === expression.expression
          ? visitExpressionWithCausePath(
            child as ts.Expression,
            causePath,
            context,
            visit,
            {
              includeRoot: false,
              allowReactiveIdentifierRetargeting:
                options.allowReactiveIdentifierRetargeting,
            },
          )
          : visit(child),
      context.tsContext,
    ) as ts.Expression;
  }

  return ts.visitEachChild(
    expression,
    (child) =>
      ts.isExpression(child)
        ? visitExpressionWithCausePath(
          child,
          causePath,
          context,
          visit,
          {
            includeRoot: true,
            allowReactiveIdentifierRetargeting:
              options.allowReactiveIdentifierRetargeting,
          },
        )
        : visit(child),
    context.tsContext,
  ) as ts.Expression;
}

function getCallArgumentCausePath(
  causePath: CausePath,
  argument: ts.Expression,
  index: number,
  argumentCount: number,
): CausePath {
  const unwrappedArgument = unwrapExpression(argument);
  if (
    argumentCount === 1 &&
    (
      ts.isObjectLiteralExpression(unwrappedArgument) ||
      ts.isArrayLiteralExpression(unwrappedArgument)
    )
  ) {
    return causePath;
  }

  return [...causePath, index];
}

function visitObjectPropertyInitializerWithCausePath(
  expression: ts.Expression,
  causePath: CausePath,
  context: TransformationContext,
  visit: ts.Visitor,
  options: {
    allowReactiveIdentifierRetargeting: boolean;
  },
): ts.Expression {
  const visited = visitExpressionWithCausePath(
    expression,
    causePath,
    context,
    visit,
    {
      includeRoot: true,
      allowReactiveIdentifierRetargeting:
        options.allowReactiveIdentifierRetargeting,
    },
  );
  return options.allowReactiveIdentifierRetargeting &&
      shouldRetargetReactiveReference(visited, context)
    ? createForCall(visited, causePath, context)
    : visited;
}

function shouldAddVariableFor(
  initializer: ts.Expression,
  context: TransformationContext,
): boolean {
  return shouldAddReactiveFor(initializer, context, {
    includeRuntimeCalls: true,
    useTypeFallback: true,
  });
}

/**
 * Reports whether `initializer` is a reactive value by construction: a call or
 * `new` this stage classifies as one without consulting its type, or a chain
 * that already carries an authored `.for()`.
 */
function isReactiveByConstruction(
  initializer: ts.Expression,
  context: TransformationContext,
): boolean {
  return chainContainsForCall(initializer) ||
    shouldAddReactiveFor(initializer, context, {
      includeRuntimeCalls: true,
      useTypeFallback: false,
    });
}

function shouldAddPropertyFor(
  initializer: ts.Expression,
  context: TransformationContext,
): boolean {
  return shouldAddReactiveFor(initializer, context, {
    includeRuntimeCalls: false,
    useTypeFallback: false,
  });
}

function shouldAddReactiveFor(
  initializer: ts.Expression,
  context: TransformationContext,
  options: {
    includeRuntimeCalls: boolean;
    useTypeFallback: boolean;
  },
): boolean {
  if (chainContainsForCall(initializer)) {
    return false;
  }

  const expression = unwrapExpression(initializer);
  if (ts.isNewExpression(expression)) {
    return detectNewExpressionKind(expression, context.checker)?.kind ===
      "cell-factory";
  }

  if (!ts.isCallExpression(expression)) {
    return false;
  }

  if (
    isPatternFactoryCalleeExpression(expression.expression, context.checker)
  ) {
    return false;
  }

  if (isReactiveArrayMethodCall(expression, context)) {
    return true;
  }

  const callKind = detectCallKind(expression, context.checker);
  if (callKind) {
    switch (callKind.kind) {
      case "array-method":
        return isReactiveArrayMethodCall(expression, context);
      case "builder":
        return isReactiveBuilderResult(
          expression,
          callKind.builderName,
          context,
        );
      case "cell-factory":
      case "lift-applied":
      case "ifElse":
      case "when":
      case "unless":
      case "wish":
      case "generate-text":
      case "generate-object":
        return true;
      case "runtime-call":
        return options.includeRuntimeCalls && callKind.reactiveOrigin;
      case "cell-for":
      case "pattern-tool":
        return false;
    }
  }

  if (!options.useTypeFallback) {
    return false;
  }

  const type = getTypeAtLocationWithFallback(
    expression,
    context.checker,
    context.state.typeRegistry,
  );
  return isCellByType(expression, type, context);
}

function isInternalSyntheticName(name: string): boolean {
  return name.startsWith("__cf");
}

function getStablePropertyName(name: ts.PropertyName): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteralLike(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }

  if (!ts.isComputedPropertyName(name)) {
    return undefined;
  }

  const expression = unwrapExpression(name.expression);
  if (
    ts.isStringLiteralLike(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression) ||
    ts.isNumericLiteral(expression)
  ) {
    return expression.text;
  }

  return undefined;
}

function isReactiveBuilderResult(
  call: ts.CallExpression,
  builderName: string,
  context: TransformationContext,
): boolean {
  const direct = detectDirectBuilderCall(call, context.checker);
  if (!direct) {
    return true;
  }

  return builderName === "action" || builderName === "computed";
}

function isReactiveArrayMethodCall(
  call: ts.CallExpression,
  context: TransformationContext,
): boolean {
  const access = classifyArrayMethodCall(call);
  if (!access) {
    return false;
  }

  const callSite = classifyArrayMethodCallSite(call, context.checker);
  if (access.lowered && callSite?.ownership === "reactive") {
    return true;
  }

  const target = unwrapExpression(call.expression);
  if (
    !ts.isPropertyAccessExpression(target) &&
    !ts.isElementAccessExpression(target)
  ) {
    return false;
  }

  return hasReactiveCollectionProvenance(
    target.expression,
    context.checker,
    {
      allowTypeBasedRoot: false,
      allowImplicitReactiveParameters: false,
      allowReactiveArrayCallbackParameters: false,
      sameScope: getEnclosingFunctionLikeDeclaration(call),
      typeRegistry: context.state.typeRegistry,
      syntheticReactiveCollectionRegistry: context.state
        .syntheticReactiveCollectionRegistry,
    },
  ) || isExplicitReactiveCall(target.expression, context);
}

function isExplicitReactiveCall(
  expression: ts.Expression,
  context: TransformationContext,
): boolean {
  const target = unwrapExpression(expression);
  return ts.isCallExpression(target) &&
    shouldAddReactiveFor(target, context, {
      includeRuntimeCalls: true,
      useTypeFallback: true,
    });
}

function shouldRetargetReactiveReference(
  expression: ts.Expression,
  context: TransformationContext,
): boolean {
  const target = unwrapExpression(expression);
  if (
    !ts.isIdentifier(target) ||
    isPatternFactoryHelperExpression(target, context.checker)
  ) {
    return false;
  }

  const type = getTypeAtLocationWithFallback(
    target,
    context.checker,
    context.state.typeRegistry,
  );
  if (type) {
    return isCellByType(target, type, context);
  }

  return isReactiveValueExpression(target, context.checker);
}

function shouldPreserveStructuralCallArgumentReferences(
  call: ts.CallExpression,
  context: TransformationContext,
): boolean {
  return isPatternFactoryCalleeExpression(call.expression, context.checker) ||
    isPatternFactoryHelperExpression(call.expression, context.checker);
}

function chainContainsForCall(expression: ts.Expression): boolean {
  let current = unwrapExpression(expression);

  while (ts.isCallExpression(current)) {
    const target = unwrapExpression(current.expression);
    if (isForAccess(target)) {
      return true;
    }
    if (
      ts.isPropertyAccessExpression(target) ||
      ts.isElementAccessExpression(target)
    ) {
      current = unwrapExpression(target.expression);
      continue;
    }
    break;
  }

  return false;
}

function isForAccess(expression: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === "for";
  }

  if (!ts.isElementAccessExpression(expression)) {
    return false;
  }

  const argument = expression.argumentExpression;
  return !!argument &&
    (
      ts.isStringLiteralLike(argument) ||
      ts.isNoSubstitutionTemplateLiteral(argument)
    ) &&
    argument.text === "for";
}

function createForCall(
  initializer: ts.Expression,
  cause: string | CausePath,
  context: TransformationContext,
): ts.Expression {
  const stableCause: ForCause = shouldUseStreamCause(initializer, context)
    ? { stream: cause }
    : cause;
  const args = [
    createCauseExpression(stableCause, context),
    context.factory.createTrue(),
  ];
  // A value that may be nullish has no cell to name, so it gets `?.for()`.
  const call = mayBeNullish(initializer, context)
    ? context.factory.createCallChain(
      context.factory.createPropertyAccessChain(
        initializer,
        context.factory.createToken(ts.SyntaxKind.QuestionDotToken),
        "for",
      ),
      undefined,
      undefined,
      args,
    )
    : context.factory.createCallExpression(
      context.factory.createPropertyAccessExpression(initializer, "for"),
      undefined,
      args,
    );
  return context.cfHelpers.preserveNodeSourceMap(
    call,
    initializer,
    initializer,
  );
}

/**
 * Helper for `createForCall()`, which reports whether `expression` may
 * evaluate to `null` or `undefined` when it runs. That is so of an optional
 * chain, and of a variable or a call to a plain function whose type admits
 * either one. A call the runtime provides is left out: it returns a cell
 * whatever type the value in that cell has.
 *
 * A non-null assertion `!` around the expression says the value is present,
 * and wins over both the chain and the type. The other wrappers, `as` and
 * `satisfies`, leave the question to the expression inside them: `satisfies`
 * never changes a type, a cast to a type that admits a cell is refused
 * (`cast-validation.ts`), and `as unknown` only hides the arm the type inside
 * still has.
 */
function mayBeNullish(
  expression: ts.Expression,
  context: TransformationContext,
): boolean {
  if (assertsNonNull(unwrapParentheses(expression))) {
    return false;
  }

  const target = unwrapExpression(expression);
  if (ts.isOptionalChain(target)) {
    return true;
  }

  const isPlainCall = ts.isCallExpression(target) &&
    detectCallKind(target, context.checker) === undefined;
  if (!isPlainCall && !ts.isIdentifier(target)) {
    return false;
  }

  const type = getTypeAtLocationWithFallback(
    target,
    context.checker,
    context.state.typeRegistry,
  );
  return unionMembers(type).some(isNullishType);
}

/**
 * Helper for `mayBeNullish()`, which reports whether the wrappers around an
 * expression include a non-null assertion `!`.
 */
function assertsNonNull(expression: ts.Expression): boolean {
  for (
    let current = expression;
    isTransparentWrapper(current);
    current = current.expression
  ) {
    if (ts.isNonNullExpression(current)) {
      return true;
    }
  }

  return false;
}

/**
 * Reports whether `expression`, of type `type`, is a cell on the strength of
 * its type: the test behind a `.for()` added at variable position as the last
 * resort in `shouldAddReactiveFor()`, and behind a re-rooted identifier
 * (`shouldRetargetReactiveReference()`).
 *
 * A type that is a cell in every arm a value can take qualifies: a cell-like
 * type, or a union whose every member is one apart from `undefined`, `null`,
 * and `void` (those arms make the access optional, `mayBeNullish()`). A type
 * with a plain-value arm beside a cell arm, such as `Writable<string> |
 * string`, qualifies only for an identifier that is a reactive node by
 * provenance: a parameter of a reactive scope (`isReactiveScopeParameter`),
 * or a variable whose lowered initializer this stage classified as reactive
 * (`causedVariablesOf`). In a pattern body, a `??` over a cell and a
 * `Reactive<T>` read hoists to a lift whose result is typed `Cell<T> | T` yet
 * is a reactive node, and a pattern input of that type is one too; in a
 * handler the same type, on a plain call or on a state member, is a value
 * that may be the string, on which `.for()` would throw. The type alone
 * cannot tell the two apart, and `isReactiveValueExpression` answers from
 * the type first (as does `isReactiveValueSymbol` for any builder's
 * parameter, a handler's included), so the symbol is asked directly. A type
 * with no cell arm, or that could not be determined, is no cell.
 */
function isCellByType(
  expression: ts.Expression,
  type: ts.Type | undefined,
  context: TransformationContext,
): boolean {
  const arms = unionMembers(type).filter((member) => !isNullishType(member));
  const cellArms = arms.filter((arm) => isCellLikeType(arm, context.checker));
  if (cellArms.length === 0) {
    return false;
  }
  if (cellArms.length === arms.length) {
    return true;
  }
  if (!ts.isIdentifier(expression)) {
    return false;
  }
  const symbol = context.checker.getSymbolAtLocation(expression);
  return symbol !== undefined &&
    (causedVariablesOf(context).has(symbol) ||
      isReactiveScopeParameter(symbol, context.checker));
}

/**
 * Helper for `isCellByType()`, which reports whether `symbol` is declared as
 * a parameter of a reactive scope, where every value is a reactive node: the
 * callback of a pattern builder call, or of a reactive array method such as a
 * `.map()` over a reactive collection. A handler's, lift's, or `computed()`'s
 * parameter is not one: its values are real.
 */
function isReactiveScopeParameter(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): boolean {
  return (symbol.getDeclarations() ?? []).some((declaration) => {
    let node: ts.Node = declaration;
    while (
      ts.isBindingElement(node) ||
      ts.isObjectBindingPattern(node) ||
      ts.isArrayBindingPattern(node)
    ) {
      node = node.parent;
    }
    if (!ts.isParameter(node) || !ts.isFunctionLike(node.parent)) {
      return false;
    }
    const callback = node.parent;
    const call = callback.parent;
    if (!call || !ts.isCallExpression(call)) {
      return false;
    }
    return getPatternBuilderCallbackArgument(call, checker) === callback ||
      (classifyArrayMethodCallSite(call, checker)?.ownership === "reactive" &&
        call.arguments.includes(callback as ts.Expression));
  });
}

/**
 * The members of a union type, or the type itself; a type that could not be
 * determined has none.
 */
function unionMembers(type: ts.Type | undefined): readonly ts.Type[] {
  return type === undefined ? [] : type.isUnion() ? type.types : [type];
}

function isNullishType(type: ts.Type): boolean {
  return (type.flags &
    (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)) !== 0;
}

function createCauseExpression(
  cause: ForCause,
  context: TransformationContext,
): ts.Expression {
  if (typeof cause === "string") {
    return context.factory.createStringLiteral(cause);
  }

  if (isStreamCause(cause)) {
    return context.factory.createObjectLiteralExpression([
      context.factory.createPropertyAssignment(
        "stream",
        createCauseExpression(cause.stream, context),
      ),
    ], false);
  }

  if (cause.length === 1 && typeof cause[0] === "string") {
    return context.factory.createStringLiteral(cause[0]);
  }

  return context.factory.createArrayLiteralExpression(
    cause.map((part) =>
      typeof part === "number"
        ? context.factory.createNumericLiteral(part)
        : context.factory.createStringLiteral(part)
    ),
    false,
  );
}

function isStreamCause(
  cause: ForCause,
): cause is { readonly stream: string | CausePath } {
  return isObjectNotArray(cause) && "stream" in cause;
}

function shouldUseStreamCause(
  expression: ts.Expression,
  context: TransformationContext,
): boolean {
  const target = unwrapExpression(expression);
  if (ts.isCallExpression(target)) {
    const callKind = detectCallKind(target, context.checker);
    if (
      callKind?.kind === "builder" &&
      (callKind.builderName === "handler" || callKind.builderName === "action")
    ) {
      return true;
    }
  }

  const type = getTypeAtLocationWithFallback(
    target,
    context.checker,
    context.state.typeRegistry,
  );
  return isStreamLikeType(type, context.checker);
}

function isStreamLikeType(
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
): boolean {
  if (!type) return false;

  const parts = type.isUnionOrIntersection() ? type.types : [type];
  return parts.some((part) => {
    const symbols = [
      part.aliasSymbol,
      part.getSymbol(),
      checker.getApparentType(part).aliasSymbol,
      checker.getApparentType(part).getSymbol(),
    ];
    return symbols.some((symbol) => symbol?.getName() === "Stream");
  });
}
