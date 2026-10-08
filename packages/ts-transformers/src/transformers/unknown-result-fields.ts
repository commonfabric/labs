/**
 * `pattern-result:unknown-type`, which refuses an inferred pattern result whose
 * schema is `{ type: "unknown" }` at a position no declaration accounts for.
 *
 * A field declared `unknown` holds a reference to another piece
 * (`docs/common/concepts/types-and-schemas/unknown.md`), and a reader of such
 * a position gets an opaque reference rather than a value. Where the position
 * is such a field — of the pattern's input, of a type written out, or of
 * another pattern's result — the reference is declared. An `unknown` that is
 * not a field's declared type declares nothing: as the type of a whole value,
 * written or inferred, it says only that the type is not known. A generic call
 * that infers a type argument from nothing produces one, and so does a helper
 * written to return `unknown`. An inferred result carrying one publishes a
 * reference no author declared.
 *
 * The check reads each half where it is known. Which positions an author
 * declared is read from the pattern's authored return expression, in
 * SchemaInjection. Which positions are `unknown` is read from the schema the
 * result generated, in SchemaGeneration, so it agrees with what a consumer
 * receives whatever path inference took to that schema.
 */
import { getPropertyNameText } from "@commonfabric/schema-generator/property-name";
import { subschemaEdges } from "@commonfabric/data-model-schema/schema-walk";
import { isObjectNotArray } from "@commonfabric/utils/types";
import ts from "typescript";

import { detectCallKind, getLiftAppliedInnerCall } from "../ast/mod.ts";
import { getDeclaredTypeNodeForBindingElement } from "../ast/type-building.ts";
import { unwrapOpaqueLikeType } from "../ast/type-inference.ts";
import type { DeclaredPositions, TransformationContext } from "../core/mod.ts";
import { localDefinition } from "../utils/schema-definitions.ts";
import { isPatternFactoryCalleeExpression } from "./structural-reactive-factory.ts";

/** The key of an array's elements in `DeclaredPositions`. */
const ELEMENTS = "[]";

/**
 * The key of an index signature's values in `DeclaredPositions`, under which
 * an object literal also records a property whose key the trace cannot name.
 */
const ANY_KEY = "*";

//
// Declared positions
//

/**
 * The positions of a pattern's result that an author declared, read from what
 * `callback` returns. Its parameters are the pattern's input: a value
 * destructured from it is one of its fields, and the input taken whole
 * declares the fields its type has. Each return of `callback` is one
 * alternative for the result, combined as `alternatives()` combines two.
 * Positions this cannot trace to a declaration are not declared.
 */
export function collectDeclaredResultPositions(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
): DeclaredPositions {
  const authored = ts.getOriginalNode(callback);
  if (!ts.isArrowFunction(authored) && !ts.isFunctionExpression(authored)) {
    return false;
  }
  const scope: TraceScope = {
    checker,
    bindings: new Map(),
    tracing: new Set(),
    written: writtenSymbols(authored.getSourceFile(), checker),
  };
  for (const parameter of authored.parameters) {
    // A value destructured from the input is one of its fields.
    bindParameter(
      parameter,
      ts.isIdentifier(parameter.name)
        ? typePositions(checker.getTypeAtLocation(parameter), checker)
        : true,
      scope,
    );
  }
  return returnedPositions(authored, scope);
}

/** What a trace of declared positions carries from one expression to the next. */
interface TraceScope {
  /** The checker every symbol is resolved through. */
  readonly checker: ts.TypeChecker;

  /** Declared positions of the values bound to callback parameters. */
  readonly bindings: Map<ts.Symbol, DeclaredPositions>;

  /** The declarations being traced, so a trace never re-enters one. */
  readonly tracing: Set<ts.Declaration>;

  /**
   * The bindings in the source file that are reassigned, or whose value is
   * changed through them, so that what they were declared with may not be
   * what they hold.
   */
  readonly written: ReadonlySet<ts.Symbol>;
}

/**
 * The positions declared for a value that is either `a` or `b`. A position
 * either leaves undeclared is undeclared. A part only one of them has takes
 * that one's verdict: the other has no value there, so it contributes nothing
 * that could be undeclared.
 */
function alternatives(
  a: DeclaredPositions,
  b: DeclaredPositions,
): DeclaredPositions {
  if (a === false || b === false) return false;
  if (a === true) return b;
  if (b === true) return a;
  const both = new Map(a);
  for (const [key, positions] of b) {
    const other = a.get(key);
    both.set(
      key,
      other === undefined ? positions : alternatives(other, positions),
    );
  }
  return both;
}

/**
 * The declared positions below `key` of a value with `positions`. A part held
 * under a key the trace could not name may be the one under `key`, so it is
 * an alternative there. A part the value does not have contributes nothing,
 * so it is declared.
 */
function below(positions: DeclaredPositions, key: string): DeclaredPositions {
  if (typeof positions === "boolean") return positions;
  const named = positions.get(key);
  const unnamed = key === ANY_KEY ? undefined : positions.get(ANY_KEY);
  if (named === undefined) return unnamed ?? true;
  return unnamed === undefined ? named : alternatives(named, unnamed);
}

/** Whether every position of a value with `positions` is declared. */
function wholly(positions: DeclaredPositions): boolean {
  return typeof positions === "boolean"
    ? positions
    : [...positions.values()].every(wholly);
}

/**
 * Binds `parameter` to a value with `positions`, or to its default where the
 * default may supply it.
 */
function bindParameter(
  parameter: ts.ParameterDeclaration,
  positions: DeclaredPositions,
  scope: TraceScope,
): void {
  bindName(
    parameter.name,
    parameter.initializer
      ? alternatives(
        positions,
        expressionPositions(parameter.initializer, scope),
      )
      : positions,
    scope,
  );
}

/**
 * Binds the identifiers in `name` to the declared positions of the parts they
 * destructure from a value with `positions`, each combined with its default.
 */
function bindName(
  name: ts.BindingName,
  positions: DeclaredPositions,
  scope: TraceScope,
): void {
  if (ts.isIdentifier(name)) {
    const symbol = scope.checker.getSymbolAtLocation(name);
    if (symbol) scope.bindings.set(symbol, positions);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    const part = bindingPart(name, element, positions, scope.checker);
    bindName(
      element.name,
      element.initializer
        ? alternatives(part, expressionPositions(element.initializer, scope))
        : part,
      scope,
    );
  }
}

/**
 * The declared positions of the part of a value with `positions` that
 * `element` of `pattern` binds, before its default.
 */
function bindingPart(
  pattern: ts.BindingPattern,
  element: ts.BindingElement,
  positions: DeclaredPositions,
  checker: ts.TypeChecker,
): DeclaredPositions {
  if (element.dotDotDotToken) return positions;
  if (ts.isArrayBindingPattern(pattern)) return below(positions, ELEMENTS);
  const key = element.propertyName
    ? getPropertyNameText(element.propertyName, checker)
    : ts.isIdentifier(element.name)
    ? element.name.text
    : undefined;
  return key === undefined ? positions === true : below(positions, key);
}

/** The positions every return of `fn` declares, as alternatives. */
function returnedPositions(
  fn: ts.SignatureDeclaration,
  scope: TraceScope,
): DeclaredPositions {
  // A return type the author wrote declares the fields of what the body
  // returns.
  if (fn.type) {
    return typePositions(
      scope.checker.getTypeFromTypeNode(fn.type),
      scope.checker,
    );
  }
  if (!("body" in fn) || fn.body === undefined) return false;
  if (!ts.isBlock(fn.body)) return expressionPositions(fn.body, scope);
  // A body that returns nothing gives `undefined`, which holds no position.
  let positions: DeclaredPositions = true;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      if (node.expression) {
        positions = alternatives(
          positions,
          expressionPositions(node.expression, scope),
        );
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return positions;
}

/** The positions of the value `expression` evaluates to that an author declared. */
function expressionPositions(
  expression: ts.Expression,
  scope: TraceScope,
): DeclaredPositions {
  const { checker } = scope;
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isAwaitExpression(expression)
  ) {
    return expressionPositions(expression.expression, scope);
  }
  if (
    ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
  ) {
    // A cast writes the value's type out, except `as const`, which keeps the
    // type the value has and makes it literal.
    return ts.isConstTypeReference(expression.type)
      ? expressionPositions(expression.expression, scope)
      : typePositions(checker.getTypeFromTypeNode(expression.type), checker);
  }
  if (isScalarExpression(expression)) return true;
  if (ts.isIdentifier(expression)) {
    return expression.text === "undefined" &&
        !checker.getSymbolAtLocation(expression)?.valueDeclaration
      ? true
      : symbolPositions(checker.getSymbolAtLocation(expression), scope);
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return objectLiteralPositions(expression, scope);
  }
  if (ts.isArrayLiteralExpression(expression)) {
    let elements: DeclaredPositions = true;
    for (const element of expression.elements) {
      elements = alternatives(
        elements,
        ts.isSpreadElement(element)
          ? below(expressionPositions(element.expression, scope), ELEMENTS)
          : ts.isOmittedExpression(element)
          ? true
          : expressionPositions(element, scope),
      );
    }
    return new Map([[ELEMENTS, elements]]);
  }
  if (ts.isConditionalExpression(expression)) {
    return alternatives(
      expressionPositions(expression.whenTrue, scope),
      expressionPositions(expression.whenFalse, scope),
    );
  }
  if (ts.isBinaryExpression(expression)) {
    switch (expression.operatorToken.kind) {
      case ts.SyntaxKind.QuestionQuestionToken:
      case ts.SyntaxKind.BarBarToken:
      case ts.SyntaxKind.AmpersandAmpersandToken:
        return alternatives(
          expressionPositions(expression.left, scope),
          expressionPositions(expression.right, scope),
        );
      case ts.SyntaxKind.CommaToken:
      case ts.SyntaxKind.EqualsToken:
        return expressionPositions(expression.right, scope);
      default:
        // Arithmetic, comparison, `in`, and `instanceof` give a primitive.
        return true;
    }
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return memberPositions(
      expressionPositions(expression.expression, scope),
      expression.name.text,
      expression.name,
      scope,
    );
  }
  if (ts.isElementAccessExpression(expression)) {
    const object = expressionPositions(expression.expression, scope);
    if (typeof object === "boolean") return object;
    // An index into an array reads one of its elements.
    const element = object.get(ELEMENTS);
    if (element !== undefined) return element;
    const argument = expression.argumentExpression;
    return ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument)
      ? memberPositions(object, argument.text, argument, scope)
      : object.get(ANY_KEY) ?? false;
  }
  if (ts.isCallExpression(expression)) return callPositions(expression, scope);
  if (ts.isTaggedTemplateExpression(expression)) {
    return signaturePositions(expression, scope);
  }
  if (ts.isNewExpression(expression)) {
    return instancePositions(expression, scope);
  }
  return false;
}

/** Whether `expression` evaluates to a value whose schema holds no `unknown`. */
function isScalarExpression(expression: ts.Expression): boolean {
  return ts.isStringLiteralLike(expression) ||
    ts.isNumericLiteral(expression) ||
    ts.isBigIntLiteral(expression) ||
    ts.isRegularExpressionLiteral(expression) ||
    ts.isTemplateExpression(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword ||
    ts.isPrefixUnaryExpression(expression) ||
    ts.isPostfixUnaryExpression(expression) ||
    ts.isTypeOfExpression(expression) ||
    ts.isVoidExpression(expression) ||
    ts.isDeleteExpression(expression) ||
    ts.isArrowFunction(expression) ||
    ts.isFunctionExpression(expression) ||
    ts.isJsxElement(expression) ||
    ts.isJsxSelfClosingElement(expression) ||
    ts.isJsxFragment(expression);
}

/** `symbol`, or what it aliases when it is an import. */
function resolveAlias(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

/**
 * The declared positions of the value bound to `symbol`. A binding another
 * write may change holds what it was declared with only when its type is
 * written out, which every write to it must then satisfy.
 */
function symbolPositions(
  symbol: ts.Symbol | undefined,
  scope: TraceScope,
): DeclaredPositions {
  if (!symbol) return false;
  const { checker } = scope;
  const resolved = resolveAlias(symbol, checker);
  const bound = scope.bindings.get(resolved);
  // A written binding is read from its declaration below, where only a type
  // written out still declares what it holds.
  if (bound !== undefined && !scope.written.has(resolved)) return bound;
  const declaration = resolved.valueDeclaration ?? resolved.declarations?.[0];
  if (!declaration) return false;
  if (ts.isVariableDeclaration(declaration)) {
    if (declaration.type) {
      return typePositions(
        checker.getTypeFromTypeNode(declaration.type),
        checker,
      );
    }
    if (scope.written.has(resolved)) return false;
    return traced(declaration, declaration.initializer, scope);
  }
  if (ts.isBindingElement(declaration)) {
    if (scope.written.has(resolved)) return false;
    // A destructured binding holds a field of the value it came from,
    // declared by that field's written type or by the value's own declared
    // positions.
    const declared = getDeclaredTypeNodeForBindingElement(declaration, checker);
    const positions = declared && !mentionsTypeParameter(declared, checker)
      ? true
      : destructuredPositions(declaration, scope);
    return declaration.initializer
      ? alternatives(
        positions,
        expressionPositions(declaration.initializer, scope),
      )
      : positions;
  }
  if (ts.isParameter(declaration)) {
    return declaration.type
      ? typePositions(checker.getTypeFromTypeNode(declaration.type), checker)
      : false;
  }
  // A function, a class, or an enum declares what its name holds.
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isClassDeclaration(declaration) ||
    ts.isEnumDeclaration(declaration) ||
    ts.isEnumMember(declaration)
  ) {
    return true;
  }
  return false;
}

/**
 * The declared positions of `initializer`, traced on behalf of `declaration`,
 * which a trace that reaches it again finds undeclared.
 */
function traced(
  declaration: ts.Declaration,
  initializer: ts.Expression | undefined,
  scope: TraceScope,
): DeclaredPositions {
  if (!initializer || scope.tracing.has(declaration)) return false;
  scope.tracing.add(declaration);
  const positions = expressionPositions(initializer, scope);
  scope.tracing.delete(declaration);
  return positions;
}

/**
 * The declared positions of the part of a destructured value that `element`
 * binds, before its default, when that value is a local's initializer or a
 * part of one.
 */
function destructuredPositions(
  element: ts.BindingElement,
  scope: TraceScope,
): DeclaredPositions {
  const pattern = element.parent;
  const owner = pattern.parent;
  let positions: DeclaredPositions;
  if (ts.isVariableDeclaration(owner)) {
    positions = traced(owner, owner.initializer, scope);
  } else if (ts.isBindingElement(owner)) {
    positions = destructuredPositions(owner, scope);
    if (owner.initializer) {
      positions = alternatives(
        positions,
        expressionPositions(owner.initializer, scope),
      );
    }
  } else {
    return false;
  }
  return bindingPart(pattern, element, positions, scope.checker);
}

/**
 * The declared positions of member `key` of a value with `object`, read
 * through `name`, the node naming the member. A member of a value with nothing
 * declared is still declared when its own declaration writes its type out.
 */
function memberPositions(
  object: DeclaredPositions,
  key: string,
  name: ts.Node,
  scope: TraceScope,
): DeclaredPositions {
  if (object !== false) return below(object, key);
  return writesOwnType(
    scope.checker.getSymbolAtLocation(name),
    false,
    scope.checker,
  );
}

/**
 * The declared positions of the instance `construction` makes, by field. A
 * class declares a field of its instances when the field's declaration writes
 * its type out; a field whose type is inferred from its initializer declares
 * nothing.
 */
function instancePositions(
  construction: ts.NewExpression,
  scope: TraceScope,
): DeclaredPositions {
  const { checker } = scope;
  const typeArgumentsWritten = !!construction.typeArguments?.length;
  const positions = new Map<string, DeclaredPositions>();
  for (
    const member of checker.getTypeAtLocation(construction).getProperties()
  ) {
    positions.set(
      member.name,
      writesOwnType(member, typeArgumentsWritten, checker),
    );
  }
  return positions;
}

/**
 * Whether the declaration of `member` writes its type out: a property's type,
 * a parameter property's, or a getter's return type. A type naming a type
 * parameter counts only when `typeArgumentsWritten`, since otherwise the
 * parameter's argument may have been inferred.
 */
function writesOwnType(
  member: ts.Symbol | undefined,
  typeArgumentsWritten: boolean,
  checker: ts.TypeChecker,
): boolean {
  const declaration = member?.valueDeclaration ?? member?.declarations?.[0];
  const type = declaration &&
      (ts.isPropertySignature(declaration) ||
        ts.isPropertyDeclaration(declaration) ||
        ts.isParameter(declaration) ||
        ts.isGetAccessorDeclaration(declaration))
    ? declaration.type
    : undefined;
  return !!type &&
    (typeArgumentsWritten || !mentionsTypeParameter(type, checker));
}

/**
 * The declared positions of an object literal's value, by property. A spread
 * member the spread value may lack, being optional, is an alternative to what
 * the literal held there before, rather than a replacement for it, and so is a
 * property whose key the trace cannot name, recorded under `ANY_KEY`.
 */
function objectLiteralPositions(
  literal: ts.ObjectLiteralExpression,
  scope: TraceScope,
): DeclaredPositions {
  const { checker } = scope;
  const positions = new Map<string, DeclaredPositions>();
  const supply = (key: string, value: DeclaredPositions, maybe: boolean) => {
    const before = positions.get(key);
    positions.set(
      key,
      maybe && before !== undefined ? alternatives(before, value) : value,
    );
  };
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = expressionPositions(property.expression, scope);
      const type = checker.getTypeAtLocation(property.expression);
      for (const member of type.getProperties()) {
        supply(
          member.name,
          below(spread, member.name),
          (member.flags & ts.SymbolFlags.Optional) !== 0,
        );
      }
      if (checker.getIndexInfosOfType(type).length > 0) {
        supply(ANY_KEY, below(spread, ANY_KEY), true);
      }
      continue;
    }
    let value: DeclaredPositions;
    if (ts.isPropertyAssignment(property)) {
      value = expressionPositions(property.initializer, scope);
    } else if (ts.isShorthandPropertyAssignment(property)) {
      value = symbolPositions(
        checker.getShorthandAssignmentValueSymbol(property),
        scope,
      );
    } else if (ts.isGetAccessorDeclaration(property)) {
      value = returnedPositions(property, scope);
    } else if (ts.isMethodDeclaration(property)) {
      value = true;
    } else {
      continue;
    }
    const key = getPropertyNameText(property.name, checker);
    if (key === undefined) supply(ANY_KEY, value, true);
    else supply(key, value, false);
  }
  return positions;
}

/** The declared positions of the value `call` returns. */
function callPositions(
  call: ts.CallExpression,
  scope: TraceScope,
): DeclaredPositions {
  const { checker } = scope;
  // A type argument written out declares the fields of the result.
  if (call.typeArguments?.length) {
    return typePositions(checker.getTypeAtLocation(call), checker);
  }
  // Another pattern's result passed the same check in its own compile.
  if (isPatternFactoryCalleeExpression(call.expression, checker)) return true;
  const kind = detectCallKind(call, checker);
  switch (kind?.kind) {
    case "lift-applied":
      return liftPositions(getLiftAppliedInnerCall(call), call, scope);
    case "builder":
      if (kind.builderName === "computed") {
        return callbackPositions(call.arguments[0], true, scope);
      }
      if (kind.builderName === "lift") {
        // A call of a lift bound to a name classifies as the builder itself.
        const factory = liftFactoryCall(call.expression, scope);
        if (factory) return liftPositions(factory, call, scope);
        // Otherwise this call makes the lift, and its value is a function.
        return resolveCallback(call.arguments[0], scope)
          ? true
          : signaturePositions(call, scope);
      }
      return signaturePositions(call, scope);
    case "ifElse":
      return alternatives(
        argumentPositions(call, 1, scope),
        argumentPositions(call, 2, scope),
      );
    case "when":
    case "unless":
      return alternatives(
        argumentPositions(call, 0, scope),
        argumentPositions(call, 1, scope),
      );
    case "array-method":
      return arrayMethodPositions(call, scope);
    case "cell-factory":
    case "cell-for":
      // A cell is a handle, whatever it holds.
      return true;
    case "wish":
    case "generate-object":
    case "generate-text":
      // With no type argument written, the result type is inferred.
      return false;
    default:
      return isArrayMethodCall(call, checker)
        ? arrayMethodPositions(call, scope)
        : signaturePositions(call, scope);
  }
}

/**
 * The declared positions of `applied`, an application of the lift `factory`
 * makes: what the lift's callback returns for `applied`'s argument, or the
 * fields of the lift's result type when its type arguments are written out.
 */
function liftPositions(
  factory: ts.CallExpression | undefined,
  applied: ts.CallExpression,
  scope: TraceScope,
): DeclaredPositions {
  if (factory?.typeArguments?.length) {
    return typePositions(
      scope.checker.getTypeAtLocation(applied),
      scope.checker,
    );
  }
  return callbackPositions(
    factory?.arguments[0],
    argumentPositions(applied, 0, scope),
    scope,
  );
}

/** The call that makes the lift `callee` denotes, as `definitionOf()` reads it. */
function liftFactoryCall(
  callee: ts.Expression,
  scope: TraceScope,
): ts.CallExpression | undefined {
  const definition = definitionOf(callee, scope);
  if (!definition || !ts.isCallExpression(definition)) return undefined;
  const kind = detectCallKind(definition, scope.checker);
  return kind?.kind === "builder" && kind.builderName === "lift"
    ? definition
    : undefined;
}

/**
 * What `expression` denotes, read through the names it is spelled with: the
 * function a name declares, or what a binding nothing writes was initialized
 * with, read in turn. A name the trace cannot follow, or one it reaches a
 * second time, denotes nothing.
 */
function definitionOf(
  expression: ts.Expression,
  scope: TraceScope,
): ts.Node | undefined {
  const followed = new Set<ts.Symbol>();
  let current = unwrapCallee(expression);
  while (ts.isIdentifier(current)) {
    const symbol = scope.checker.getSymbolAtLocation(current);
    const resolved = symbol && resolveAlias(symbol, scope.checker);
    if (!resolved || followed.has(resolved) || scope.written.has(resolved)) {
      return undefined;
    }
    followed.add(resolved);
    const declaration = resolved.valueDeclaration ??
      resolved.declarations?.find((candidate) =>
        ts.isFunctionDeclaration(candidate) && candidate.body !== undefined
      );
    if (declaration && ts.isFunctionDeclaration(declaration)) {
      return declaration;
    }
    if (
      !declaration || !ts.isVariableDeclaration(declaration) ||
      !declaration.initializer
    ) {
      return undefined;
    }
    current = unwrapCallee(declaration.initializer);
  }
  return current;
}

/** `expression` without parentheses, casts, and non-null assertions. */
function unwrapCallee(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Whether `call` calls a method of an array, reactive or not. */
function isArrayMethodCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const receiver = checker.getTypeAtLocation(callee.expression);
  const value = unwrapOpaqueLikeType(receiver, checker) ?? receiver;
  return checker.isArrayType(value) || checker.isTupleType(value);
}

/** The declared positions of argument `index` of `call`, if it has one. */
function argumentPositions(
  call: ts.CallExpression,
  index: number,
  scope: TraceScope,
): DeclaredPositions {
  const argument = call.arguments[index];
  return argument === undefined ? true : expressionPositions(argument, scope);
}

/**
 * The function `expression` denotes, as `definitionOf()` reads it: written in
 * place, or named, as a function declaration or a binding initialized with
 * one.
 */
function resolveCallback(
  expression: ts.Expression | undefined,
  scope: TraceScope,
): ts.SignatureDeclaration | undefined {
  const definition = expression && definitionOf(expression, scope);
  return definition &&
      (ts.isArrowFunction(definition) ||
        ts.isFunctionExpression(definition) ||
        ts.isFunctionDeclaration(definition))
    ? definition
    : undefined;
}

/**
 * The declared positions of what the function `expression` denotes returns,
 * with its first parameter bound to a value with `argument`.
 */
function callbackPositions(
  expression: ts.Expression | undefined,
  argument: DeclaredPositions,
  scope: TraceScope,
): DeclaredPositions {
  const callback = resolveCallback(expression, scope);
  if (!callback || scope.tracing.has(callback)) return false;
  scope.tracing.add(callback);
  const parameter = callback.parameters[0];
  if (parameter) bindParameter(parameter, argument, scope);
  const positions = returnedPositions(callback, scope);
  scope.tracing.delete(callback);
  return positions;
}

/** The declared positions of an array method's result. */
function arrayMethodPositions(
  call: ts.CallExpression,
  scope: TraceScope,
): DeclaredPositions {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const receiver = expressionPositions(callee.expression, scope);
  switch (callee.name.text) {
    case "map":
      return new Map([[
        ELEMENTS,
        callbackPositions(call.arguments[0], below(receiver, ELEMENTS), scope),
      ]]);
    case "filter":
    case "slice":
    case "toSorted":
    case "toReversed":
      // These keep the receiver's elements.
      return receiver;
    case "find":
    case "findLast":
    case "at":
      // These return one of the receiver's elements.
      return below(receiver, ELEMENTS);
    default:
      return signaturePositions(call, scope);
  }
}

/**
 * The declared positions of a call's result read from its signature, which
 * declares the fields of what it returns when it writes its return type out
 * without naming a type parameter, whose argument may have been inferred.
 */
function signaturePositions(
  call: ts.CallLikeExpression,
  scope: TraceScope,
): DeclaredPositions {
  const { checker } = scope;
  const signature = checker.getResolvedSignature(call);
  const declaration = signature?.declaration;
  return signature && declaration && !ts.isJSDocSignature(declaration) &&
      declaration.type && !mentionsTypeParameter(declaration.type, checker)
    ? typePositions(checker.getReturnTypeOfSignature(signature), checker)
    : false;
}

/**
 * The positions a value of `type`, a type an author wrote, declares. A field
 * declares what it holds, so a value with fields declares all of them. `unknown`
 * as the whole value's type, or as an array's elements, declares nothing there.
 * Reactive wrappers are read through, as schema generation reads them.
 */
function typePositions(
  type: ts.Type,
  checker: ts.TypeChecker,
  seen = new Set<ts.Type>(),
): DeclaredPositions {
  const value = unwrapOpaqueLikeType(type, checker) ?? type;
  if ((value.flags & ts.TypeFlags.Unknown) !== 0) return false;
  if (seen.has(value)) return true;
  seen.add(value);
  let positions: DeclaredPositions = true;
  if (value.isUnion()) {
    for (const member of value.types) {
      positions = alternatives(positions, typePositions(member, checker, seen));
    }
  } else if (checker.isArrayType(value) || checker.isTupleType(value)) {
    let elements: DeclaredPositions = true;
    for (const element of checker.getTypeArguments(value as ts.TypeReference)) {
      elements = alternatives(elements, typePositions(element, checker, seen));
    }
    positions = new Map([[ELEMENTS, elements]]);
  }
  seen.delete(value);
  return positions;
}

/** Whether the type node `node` names a type parameter anywhere in it. */
function mentionsTypeParameter(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
): boolean {
  const visit = (child: ts.Node): boolean => {
    if (
      ts.isTypeReferenceNode(child) &&
      (checker.getTypeFromTypeNode(child).flags &
          ts.TypeFlags.TypeParameter) !== 0
    ) {
      return true;
    }
    return ts.forEachChild(child, visit) === true;
  };
  return visit(node);
}

//
// Written bindings
//

/**
 * The methods that add a value to an array, a map, or a set they are called
 * on.
 */
const ADDING_METHODS: ReadonlySet<string> = new Set([
  "push",
  "unshift",
  "splice",
  "fill",
  "set",
  "add",
]);

/** The `Object` functions that write properties into their first argument. */
const OBJECT_WRITERS: ReadonlySet<string> = new Set([
  "assign",
  "defineProperty",
  "defineProperties",
]);

/** The written bindings of each source file, by the checker reading it. */
const writtenSymbolsCache = new WeakMap<
  ts.TypeChecker,
  WeakMap<ts.SourceFile, ReadonlySet<ts.Symbol>>
>();

/**
 * The bindings in `sourceFile` that are reassigned, or whose value is changed
 * through them: an assignment to a binding or through it, an increment, a
 * method that adds to an array, a map, or a set, or an `Object` function
 * writing into it. A `delete` only takes a part away, which leaves nothing
 * undeclared, so it is not a write here. A binding initialized with another
 * binding, or with a path through one, passes a change made through it on to
 * that other binding, since the two hold the same value. A write through any
 * other path, such as a value passed to a function, is not followed.
 */
function writtenSymbols(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): ReadonlySet<ts.Symbol> {
  let byFile = writtenSymbolsCache.get(checker);
  if (!byFile) {
    byFile = new WeakMap();
    writtenSymbolsCache.set(checker, byFile);
  }
  const cached = byFile.get(sourceFile);
  if (cached) return cached;

  const reassigned = new Set<ts.Symbol>();
  const changed = new Set<ts.Symbol>();
  const rootOf = (expression: ts.Expression): ts.Symbol | undefined => {
    let current = unwrapCallee(expression);
    while (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
    ) {
      current = unwrapCallee(current.expression);
    }
    const symbol = ts.isIdentifier(current)
      ? checker.getSymbolAtLocation(current)
      : undefined;
    return symbol && resolveAlias(symbol, checker);
  };
  const assignTo = (target: ts.Expression): void => {
    const unwrapped = unwrapCallee(target);
    if (ts.isObjectLiteralExpression(unwrapped)) {
      for (const property of unwrapped.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          // The name a shorthand writes is the binding's, not a property's.
          const symbol = checker.getShorthandAssignmentValueSymbol(property);
          if (symbol) reassigned.add(resolveAlias(symbol, checker));
        } else if (ts.isPropertyAssignment(property)) {
          assignTo(property.initializer);
        } else if (ts.isSpreadAssignment(property)) {
          assignTo(property.expression);
        }
      }
    } else if (ts.isArrayLiteralExpression(unwrapped)) {
      for (const element of unwrapped.elements) {
        assignTo(ts.isSpreadElement(element) ? element.expression : element);
      }
    } else if (ts.isIdentifier(unwrapped)) {
      const symbol = rootOf(unwrapped);
      if (symbol) reassigned.add(symbol);
    } else {
      const symbol = rootOf(unwrapped);
      if (symbol) changed.add(symbol);
    }
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      assignTo(node.left);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      assignTo(node.operand);
    } else if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      assignTo(node.initializer);
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const callee = node.expression;
      const target = ts.isIdentifier(callee.expression) &&
          callee.expression.text === "Object" &&
          OBJECT_WRITERS.has(callee.name.text)
        ? node.arguments[0]
        : ADDING_METHODS.has(callee.name.text)
        ? callee.expression
        : undefined;
      const symbol = target && rootOf(target);
      if (symbol) changed.add(symbol);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  // A change made through a binding is a change to the binding it aliases.
  const pending = [...changed];
  while (pending.length > 0) {
    const symbol = pending.pop()!;
    const declaration = symbol.valueDeclaration;
    if (
      declaration && ts.isVariableDeclaration(declaration) &&
      declaration.initializer
    ) {
      const aliased = rootOf(declaration.initializer);
      if (aliased && !changed.has(aliased)) {
        changed.add(aliased);
        pending.push(aliased);
      }
    }
  }
  const written: ReadonlySet<ts.Symbol> = new Set([...reassigned, ...changed]);
  byFile.set(sourceFile, written);
  return written;
}

//
// Unknown positions
//

/**
 * One position of a result schema: its path, written for a diagnostic, and the
 * keys a `DeclaredPositions` holds it under.
 */
interface SchemaPosition {
  /** The path as the diagnostic names it. */
  readonly path: string;

  /** The path's keys, as `DeclaredPositions` keys them. */
  readonly keys: readonly string[];
}

/**
 * Paths to the positions of a result schema that are `{ type: "unknown" }`
 * and that `declared` does not cover, in the order `subschemaEdges()` reaches
 * them, which lists properties as the schema does: `a.b` for a property, `a[]`
 * for an array's items, `a[0]` for a tuple slot and `a[1...]` for the rest of
 * a tuple, and `a.*` for the values of an index signature. Each arm of a union
 * or an intersection is read under the path of the position it describes. The
 * root is not one of these positions, since a result that is `unknown` as a
 * whole is a different report.
 *
 * A position marked `asCell` holds a cell or stream handle, which a reader
 * receives as a handle whatever its contents are, so the walk passes it by. A
 * `$ref` into `$defs` is followed into the definition, once per path; any
 * other `$ref` ends the walk there.
 */
export function collectUnknownResultFieldPaths(
  schema: unknown,
  declared: DeclaredPositions = false,
): string[] {
  if (declared === true || !isObjectNotArray(schema)) return [];
  const root = schema;
  const paths = new Set<string>();
  const inside = new Set<string>();
  const step = (position: SchemaPosition, label: string, key: string) => ({
    path: `${position.path}${label}`,
    keys: [...position.keys, key],
  });
  const walk = (node: unknown, position: SchemaPosition): void => {
    if (!isObjectNotArray(node) || node.asCell !== undefined) return;
    if (node.type === "unknown") {
      if (position.path !== "" && !isDeclared(position.keys, declared)) {
        paths.add(position.path);
      }
      return;
    }
    const definition = localDefinition(root, node.$ref);
    if (definition && !inside.has(definition.name)) {
      inside.add(definition.name);
      walk(definition.schema, position);
      inside.delete(definition.name);
    }
    const dot = position.path === "" ? "" : ".";
    const prefixLength = Array.isArray(node.prefixItems)
      ? node.prefixItems.length
      : undefined;
    for (const { schema: child, keyword, key, index } of subschemaEdges(node)) {
      switch (keyword) {
        case "properties":
          walk(child, step(position, `${dot}${key}`, key!));
          break;
        case "prefixItems":
          walk(child, step(position, `[${index}]`, ELEMENTS));
          break;
        case "items":
          walk(
            child,
            step(
              position,
              prefixLength === undefined ? "[]" : `[${prefixLength}...]`,
              ELEMENTS,
            ),
          );
          break;
        case "additionalProperties":
          walk(child, step(position, `${dot}${ANY_KEY}`, ANY_KEY));
          break;
        case "anyOf":
        case "oneOf":
        case "allOf":
          walk(child, position);
          break;
          // `not` describes values the position does not hold.
      }
    }
  };
  walk(root, { path: "", keys: [] });
  return [...paths];
}

/** Whether `declared` covers the position at `keys`. */
function isDeclared(
  keys: readonly string[],
  declared: DeclaredPositions,
): boolean {
  let positions = declared;
  for (const key of keys) {
    if (typeof positions === "boolean") return positions;
    positions = below(positions, key);
  }
  return wholly(positions);
}

/**
 * Report a pattern whose inferred result schema is `{ type: "unknown" }` at
 * any position `collectUnknownResultFieldPaths()` finds outside `declared`.
 *
 * A reader of such a field gets an opaque reference carrying no properties,
 * rather than the value. That is what `unknown` declares, and where an author
 * declared it, the reference is meant. A position nothing declared holds one
 * only because inference produced `unknown` there, so the author is asked to
 * write the type out.
 */
export function reportUnknownResultFields(
  context: Pick<TransformationContext, "reportDiagnosticOnce" | "options">,
  schema: unknown,
  declared: DeclaredPositions,
  anchor: ts.Node,
): void {
  const paths = collectUnknownResultFieldPaths(schema, declared);
  if (paths.length === 0) return;
  const plural = paths.length > 1;
  const fields = paths.map((path) => `\`${path}\``).join(", ");
  context.reportDiagnosticOnce({
    // A reload of stored source reconstructs what was admitted when it was
    // deployed, so a shape this check has covered only since then reports
    // there without refusing the reload.
    severity: context.options.storedSource ? "warning" : "error",
    type: "pattern-result:unknown-type",
    message: `pattern() output ${plural ? "fields" : "field"} ${fields} ` +
      `${plural ? "have" : "has"} inferred type \`unknown\`, so the output ` +
      `schema carries \`{ type: "unknown" }\` there. A consumer does not ` +
      `materialize such a field: it reads back as an opaque reference ` +
      `carrying no properties. Add an explicit Output type, e.g. ` +
      `pattern<Input, { /* shape */ }>(...).`,
    node: anchor,
  });
}
