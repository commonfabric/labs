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
 * The key of an index signature's values in `DeclaredPositions`. No traced
 * value declares one on its own, so a position under it is declared only by an
 * enclosing value declared whole.
 */
const ANY_KEY = "*";

//
// Declared positions
//

/**
 * The positions of a pattern's result that an author declared, read from what
 * `callback` returns. Its parameters are the pattern's input: a value
 * destructured from it is one of its fields, and the input taken whole
 * declares the fields its type has. Each return of `callback` contributes, and
 * a position is declared only where every one declares it. Positions this
 * cannot trace to a declaration are not declared.
 */
export function collectDeclaredResultPositions(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
): DeclaredPositions | undefined {
  const authored = ts.getOriginalNode(callback);
  if (!ts.isArrowFunction(authored) && !ts.isFunctionExpression(authored)) {
    return undefined;
  }
  const scope: TraceScope = {
    checker,
    bindings: new Map(),
    tracing: new Set(),
  };
  for (const parameter of authored.parameters) {
    // A value destructured from the input is one of its fields.
    bindName(
      parameter.name,
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
  readonly bindings: Map<ts.Symbol, DeclaredPositions | undefined>;

  /** The variable declarations being traced, so a trace never re-enters one. */
  readonly tracing: Set<ts.Declaration>;
}

/** The positions both `a` and `b` declare, for a value that may be either. */
function bothDeclare(
  a: DeclaredPositions | undefined,
  b: DeclaredPositions | undefined,
): DeclaredPositions | undefined {
  if (a === undefined || b === undefined) return undefined;
  if (a === true) return b;
  if (b === true) return a;
  const both = new Map<string, DeclaredPositions>();
  for (const [key, positions] of a) {
    const shared = bothDeclare(positions, b.get(key));
    if (shared !== undefined) both.set(key, shared);
  }
  return both;
}

/** The declared positions below `key` of a value with `positions`. */
function below(
  positions: DeclaredPositions | undefined,
  key: string,
): DeclaredPositions | undefined {
  return positions === true ? true : positions?.get(key);
}

/**
 * Binds the identifiers in `name` to the declared positions of the value they
 * destructure from one with `positions`.
 */
function bindName(
  name: ts.BindingName,
  positions: DeclaredPositions | undefined,
  scope: TraceScope,
): void {
  if (ts.isIdentifier(name)) {
    const symbol = scope.checker.getSymbolAtLocation(name);
    if (symbol) scope.bindings.set(symbol, positions);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (element.dotDotDotToken || ts.isArrayBindingPattern(name)) {
      const part = ts.isArrayBindingPattern(name) && !element.dotDotDotToken
        ? below(positions, ELEMENTS)
        : positions;
      bindName(element.name, part, scope);
      continue;
    }
    const key = element.propertyName
      ? getPropertyNameText(element.propertyName, scope.checker)
      : ts.isIdentifier(element.name)
      ? element.name.text
      : undefined;
    bindName(
      element.name,
      key === undefined ? undefined : below(positions, key),
      scope,
    );
  }
}

/** The positions every return of `fn` declares. */
function returnedPositions(
  fn: ts.SignatureDeclaration,
  scope: TraceScope,
): DeclaredPositions | undefined {
  // A return type the author wrote declares the fields of what the body
  // returns.
  if (fn.type) {
    return typePositions(
      scope.checker.getTypeFromTypeNode(fn.type),
      scope.checker,
    );
  }
  if (!("body" in fn) || fn.body === undefined) return undefined;
  if (!ts.isBlock(fn.body)) return expressionPositions(fn.body, scope);
  let positions: DeclaredPositions | undefined;
  let returned = false;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      const here = node.expression
        ? expressionPositions(node.expression, scope)
        : true;
      positions = returned ? bothDeclare(positions, here) : here;
      returned = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return returned ? positions : undefined;
}

/** The positions of the value `expression` evaluates to that an author declared. */
function expressionPositions(
  expression: ts.Expression,
  scope: TraceScope,
): DeclaredPositions | undefined {
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
    return symbolPositions(checker.getSymbolAtLocation(expression), scope) ??
      (expression.text === "undefined" ? true : undefined);
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return objectLiteralPositions(expression, scope);
  }
  if (ts.isArrayLiteralExpression(expression)) {
    let elements: DeclaredPositions | undefined = true;
    for (const element of expression.elements) {
      elements = bothDeclare(
        elements,
        ts.isSpreadElement(element)
          ? below(expressionPositions(element.expression, scope), ELEMENTS)
          : ts.isOmittedExpression(element)
          ? true
          : expressionPositions(element, scope),
      );
    }
    return elements === undefined ? new Map() : new Map([[ELEMENTS, elements]]);
  }
  if (ts.isConditionalExpression(expression)) {
    return bothDeclare(
      expressionPositions(expression.whenTrue, scope),
      expressionPositions(expression.whenFalse, scope),
    );
  }
  if (ts.isBinaryExpression(expression)) {
    switch (expression.operatorToken.kind) {
      case ts.SyntaxKind.QuestionQuestionToken:
      case ts.SyntaxKind.BarBarToken:
      case ts.SyntaxKind.AmpersandAmpersandToken:
        return bothDeclare(
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
      expression.expression,
      expression.name.text,
      expression.name,
      scope,
    );
  }
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    const key =
      ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument)
        ? argument.text
        : undefined;
    const object = expressionPositions(expression.expression, scope);
    if (object === true) return true;
    // An index into an array reads one of its elements.
    const element = below(object, ELEMENTS);
    if (element !== undefined) return element;
    return key === undefined
      ? undefined
      : memberPositions(expression.expression, key, argument, scope);
  }
  if (ts.isCallExpression(expression)) return callPositions(expression, scope);
  if (ts.isTaggedTemplateExpression(expression)) {
    return signaturePositions(expression, scope);
  }
  // A class declares the fields of its instances.
  if (ts.isNewExpression(expression)) return true;
  return undefined;
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

/** The declared positions of the value bound to `symbol`. */
function symbolPositions(
  symbol: ts.Symbol | undefined,
  scope: TraceScope,
): DeclaredPositions | undefined {
  if (!symbol) return undefined;
  const { checker } = scope;
  const resolved = symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
  if (scope.bindings.has(resolved)) return scope.bindings.get(resolved);
  const declaration = resolved.valueDeclaration ?? resolved.declarations?.[0];
  if (!declaration) return undefined;
  if (ts.isVariableDeclaration(declaration)) {
    if (declaration.type) {
      return typePositions(
        checker.getTypeFromTypeNode(declaration.type),
        checker,
      );
    }
    if (!declaration.initializer || scope.tracing.has(declaration)) {
      return undefined;
    }
    scope.tracing.add(declaration);
    const positions = expressionPositions(declaration.initializer, scope);
    scope.tracing.delete(declaration);
    return positions;
  }
  if (ts.isBindingElement(declaration)) {
    // A destructured binding holds a field of the value it came from, declared
    // by that field's written type or by the value's own declared positions.
    const declared = getDeclaredTypeNodeForBindingElement(declaration, checker);
    return declared && !mentionsTypeParameter(declared, checker)
      ? true
      : destructuredPositions(declaration, scope);
  }
  if (ts.isParameter(declaration)) {
    return declaration.type
      ? typePositions(checker.getTypeFromTypeNode(declaration.type), checker)
      : undefined;
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
  return undefined;
}

/**
 * The declared positions of the part of a destructured value that `element`
 * binds, when that value is a local's initializer or a part of one.
 */
function destructuredPositions(
  element: ts.BindingElement,
  scope: TraceScope,
): DeclaredPositions | undefined {
  const pattern = element.parent;
  const owner = pattern.parent;
  let positions: DeclaredPositions | undefined;
  if (ts.isVariableDeclaration(owner)) {
    if (!owner.initializer || scope.tracing.has(owner)) return undefined;
    scope.tracing.add(owner);
    positions = expressionPositions(owner.initializer, scope);
    scope.tracing.delete(owner);
  } else if (ts.isBindingElement(owner)) {
    positions = symbolPositions(
      scope.checker.getSymbolAtLocation(owner.name),
      scope,
    ) ?? destructuredPositions(owner, scope);
  } else {
    return undefined;
  }
  if (ts.isArrayBindingPattern(pattern)) {
    return element.dotDotDotToken ? positions : below(positions, ELEMENTS);
  }
  if (element.dotDotDotToken) return positions;
  const key = element.propertyName
    ? getPropertyNameText(element.propertyName, scope.checker)
    : ts.isIdentifier(element.name)
    ? element.name.text
    : undefined;
  return key === undefined ? undefined : below(positions, key);
}

/**
 * The declared positions of member `key` of the value `object` evaluates to,
 * read through `name`, the node naming the member. A member of a value with
 * nothing declared is still declared when its own declaration writes its type
 * out without naming a type parameter, whose argument may have been inferred.
 */
function memberPositions(
  object: ts.Expression,
  key: string,
  name: ts.Node,
  scope: TraceScope,
): DeclaredPositions | undefined {
  const positions = below(expressionPositions(object, scope), key);
  if (positions !== undefined) return positions;
  const { checker } = scope;
  const symbol = checker.getSymbolAtLocation(name);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  return declaration &&
      (ts.isPropertySignature(declaration) ||
        ts.isPropertyDeclaration(declaration)) &&
      declaration.type &&
      !mentionsTypeParameter(declaration.type, checker)
    ? true
    : undefined;
}

/** The declared positions of an object literal's value, by property. */
function objectLiteralPositions(
  literal: ts.ObjectLiteralExpression,
  scope: TraceScope,
): DeclaredPositions {
  const { checker } = scope;
  const positions = new Map<string, DeclaredPositions>();
  const assign = (key: string, value: DeclaredPositions | undefined) => {
    if (value === undefined) positions.delete(key);
    else positions.set(key, value);
  };
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = expressionPositions(property.expression, scope);
      const type = checker.getTypeAtLocation(property.expression);
      for (const member of type.getProperties()) {
        assign(member.name, below(spread, member.name));
      }
      continue;
    }
    const key = getPropertyNameText(property.name, checker);
    if (key === undefined) continue;
    if (ts.isPropertyAssignment(property)) {
      assign(key, expressionPositions(property.initializer, scope));
    } else if (ts.isShorthandPropertyAssignment(property)) {
      assign(
        key,
        symbolPositions(
          checker.getShorthandAssignmentValueSymbol(property),
          scope,
        ),
      );
    } else {
      // A method holds a function; an accessor's value is not traced.
      assign(key, ts.isMethodDeclaration(property) ? true : undefined);
    }
  }
  return positions;
}

/** The declared positions of the value `call` returns. */
function callPositions(
  call: ts.CallExpression,
  scope: TraceScope,
): DeclaredPositions | undefined {
  const { checker } = scope;
  // A type argument written out declares the fields of the result.
  if (call.typeArguments?.length) {
    return typePositions(checker.getTypeAtLocation(call), checker);
  }
  // Another pattern's result passed the same check in its own compile.
  if (isPatternFactoryCalleeExpression(call.expression, checker)) return true;
  const kind = detectCallKind(call, checker);
  switch (kind?.kind) {
    case "lift-applied": {
      const inner = getLiftAppliedInnerCall(call);
      if (inner?.typeArguments?.length) {
        return typePositions(checker.getTypeAtLocation(call), checker);
      }
      return callbackPositions(
        inner?.arguments[0],
        call.arguments[0] === undefined
          ? undefined
          : expressionPositions(call.arguments[0], scope),
        scope,
      );
    }
    case "builder":
      return kind.builderName === "computed"
        ? callbackPositions(call.arguments[0], undefined, scope)
        : signaturePositions(call, scope);
    case "ifElse":
      return bothDeclare(
        argumentPositions(call, 1, scope),
        argumentPositions(call, 2, scope),
      );
    case "when":
    case "unless":
      return bothDeclare(
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
      return undefined;
    default:
      return isArrayMethodCall(call, checker)
        ? arrayMethodPositions(call, scope)
        : signaturePositions(call, scope);
  }
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
): DeclaredPositions | undefined {
  const argument = call.arguments[index];
  return argument === undefined
    ? undefined
    : expressionPositions(argument, scope);
}

/**
 * The declared positions of what the callback `expression` names returns,
 * with its first parameter bound to a value with `argument`.
 */
function callbackPositions(
  expression: ts.Expression | undefined,
  argument: DeclaredPositions | undefined,
  scope: TraceScope,
): DeclaredPositions | undefined {
  let callback = expression;
  while (
    callback &&
    (ts.isParenthesizedExpression(callback) || ts.isAsExpression(callback) ||
      ts.isSatisfiesExpression(callback))
  ) {
    callback = callback.expression;
  }
  if (
    !callback ||
    !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
  ) {
    return undefined;
  }
  const parameter = callback.parameters[0];
  if (parameter) bindName(parameter.name, argument, scope);
  return returnedPositions(callback, scope);
}

/** The declared positions of an array method's result. */
function arrayMethodPositions(
  call: ts.CallExpression,
  scope: TraceScope,
): DeclaredPositions | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const receiver = expressionPositions(callee.expression, scope);
  switch (callee.name.text) {
    case "map": {
      const each = callbackPositions(
        call.arguments[0],
        below(receiver, ELEMENTS),
        scope,
      );
      return each === undefined ? new Map() : new Map([[ELEMENTS, each]]);
    }
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
): DeclaredPositions | undefined {
  const { checker } = scope;
  const signature = checker.getResolvedSignature(call);
  const declaration = signature?.declaration;
  return signature && declaration && !ts.isJSDocSignature(declaration) &&
      declaration.type && !mentionsTypeParameter(declaration.type, checker)
    ? typePositions(checker.getReturnTypeOfSignature(signature), checker)
    : undefined;
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
): DeclaredPositions | undefined {
  const value = unwrapOpaqueLikeType(type, checker) ?? type;
  if ((value.flags & ts.TypeFlags.Unknown) !== 0) return undefined;
  if (seen.has(value)) return true;
  seen.add(value);
  let positions: DeclaredPositions | undefined = true;
  if (value.isUnion()) {
    for (const member of value.types) {
      positions = bothDeclare(positions, typePositions(member, checker, seen));
    }
  } else if (checker.isArrayType(value) || checker.isTupleType(value)) {
    let elements: DeclaredPositions | undefined = true;
    for (const element of checker.getTypeArguments(value as ts.TypeReference)) {
      elements = bothDeclare(elements, typePositions(element, checker, seen));
    }
    positions = elements === undefined
      ? new Map()
      : new Map([[ELEMENTS, elements]]);
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
  declared?: DeclaredPositions,
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
  declared: DeclaredPositions | undefined,
): boolean {
  let positions = declared;
  for (const key of keys) {
    if (positions === true) return true;
    positions = positions?.get(key);
  }
  return positions === true;
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
  declared: DeclaredPositions | undefined,
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
