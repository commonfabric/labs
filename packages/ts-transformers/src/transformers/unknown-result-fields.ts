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

import {
  classifyReactiveContext,
  detectCallKind,
  getLiftAppliedInnerCall,
  isReactiveValueExpression,
} from "../ast/mod.ts";
import { getDeclaredTypeNodeForBindingElement } from "../ast/type-building.ts";
import { unwrapOpaqueLikeType } from "../ast/type-inference.ts";
import { ELEMENT_POSITIONS, UNNAMED_POSITIONS } from "../core/mod.ts";
import type {
  DeclaredPositions,
  PositionKey,
  TransformationContext,
} from "../core/mod.ts";
import { localDefinition } from "../utils/schema-definitions.ts";
import { isPatternFactoryCalleeExpression } from "./structural-reactive-factory.ts";

//
// Declared positions
//

/**
 * The positions of a pattern's result that an author declared, read from what
 * `callback` returns. Its parameters are the pattern's input, which declares
 * what its type writes, as `readTypeNode()` reads the type written on the
 * parameter or as the call's first type argument, or as `readType()` reads
 * its type as written where none is written, whether it is taken whole or
 * destructured. Each return of `callback` is one alternative for the
 * result, combined as `alternatives()` combines two. Positions this cannot
 * trace to a declaration are not declared.
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
    held: undefined,
  };
  // The input's type is written on its parameter or as the call's first type
  // argument.
  const call = authored.parent;
  const input = ts.isCallExpression(call) && call.arguments[0] === authored
    ? call.typeArguments?.[0]
    : undefined;
  authored.parameters.forEach((parameter, index) => {
    const written = parameter.type ?? (index === 0 ? input : undefined);
    bindParameter(
      parameter,
      written ? typeNodePositions(written, false, checker) : readType(
        checker.getTypeAtLocation(parameter),
        checker,
        "written",
        newReading(),
      ),
      scope,
    );
  });
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
   * How far below the top of the value being traced a binding holds a part
   * of it: `0` when the binding holds the value itself, `1` when it holds one
   * of the value's parts, and so on, or `undefined` when no binding holds it.
   * Whatever is done through a binding can change the structure of what it
   * holds, so a literal at that depth declares nothing there; the literals
   * above it, which the binding only reads its part out of, still do.
   */
  held: number | undefined;
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
  const both = new Map<PositionKey, DeclaredPositions>();
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const inA = partAt(a, key);
    const inB = partAt(b, key);
    both.set(
      key,
      inA === undefined
        ? inB!
        : inB === undefined
        ? inA
        : alternatives(inA, inB),
    );
  }
  return both;
}

/**
 * The declared positions of the part a value holds under `key`, which may be
 * a part it holds under a key the trace could not name, or `undefined` when
 * the value has no such part.
 */
function partAt(
  positions: ReadonlyMap<PositionKey, DeclaredPositions>,
  key: PositionKey,
): DeclaredPositions | undefined {
  return positions.get(key) ??
    (typeof key === "string" ? positions.get(UNNAMED_POSITIONS) : undefined);
}

/**
 * The declared positions below `key` of a value with `positions`. A part the
 * value does not have contributes nothing, so it is declared.
 */
function below(
  positions: DeclaredPositions,
  key: PositionKey,
): DeclaredPositions {
  return typeof positions === "boolean"
    ? positions
    : partAt(positions, key) ?? true;
}

/** Whether every position of a value with `positions` is declared. */
function wholly(positions: DeclaredPositions): boolean {
  return typeof positions === "boolean"
    ? positions
    : [...positions.values()].every(wholly);
}

/**
 * What `read` returns with `scope` tracing a value a binding holds `held`
 * levels below its top, or that no binding holds when `held` is `undefined`.
 */
function heldAs<T>(
  scope: TraceScope,
  held: number | undefined,
  read: () => T,
): T {
  const outer = scope.held;
  scope.held = held;
  try {
    return read();
  } finally {
    scope.held = outer;
  }
}

/** The depth at which a part of a value held at `held` is held. */
function partHeld(held: number | undefined): number | undefined {
  return held === undefined ? undefined : held - 1;
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
  const fallback = parameter.initializer;
  bindName(
    parameter.name,
    fallback
      ? alternatives(
        positions,
        heldAs(scope, 0, () => expressionPositions(fallback, scope)),
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
    const fallback = element.initializer;
    bindName(
      element.name,
      fallback
        ? alternatives(
          part,
          heldAs(scope, 0, () => expressionPositions(fallback, scope)),
        )
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
  if (ts.isArrayBindingPattern(pattern)) {
    return below(positions, ELEMENT_POSITIONS);
  }
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
  // returns, unless it names a type parameter, whose argument may have been
  // inferred; the body says what that call returns.
  if (fn.type && !mentionsTypeParameter(fn.type, scope.checker)) {
    return typeNodePositions(fn.type, false, scope.checker);
  }
  if (!("body" in fn) || fn.body === undefined) return false;
  return returnedExpressions(fn.body).reduce<DeclaredPositions>(
    (positions, returned) =>
      alternatives(positions, expressionPositions(returned, scope)),
    true,
  );
}

/**
 * The expressions a function with `body` returns: the body itself where it is
 * an expression, or each `return`'s value. A body that returns nothing gives
 * `undefined`, which holds no position, so it adds none.
 */
function returnedExpressions(body: ts.ConciseBody): ts.Expression[] {
  if (!ts.isBlock(body)) return [body];
  const returned: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      if (node.expression) returned.push(node.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return returned;
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
    // type the value has and makes it literal, and a cast to a type naming a
    // type parameter, whose argument may have been inferred.
    return ts.isConstTypeReference(expression.type) ||
        mentionsTypeParameter(expression.type, checker)
      ? expressionPositions(expression.expression, scope)
      : typeNodePositions(expression.type, false, checker);
  }
  if (isScalarExpression(expression)) return true;
  if (ts.isIdentifier(expression)) {
    return expression.text === "undefined" &&
        !checker.getSymbolAtLocation(expression)?.valueDeclaration
      ? true
      : symbolPositions(checker.getSymbolAtLocation(expression), scope);
  }
  if (ts.isObjectLiteralExpression(expression)) {
    // A binding can change the structure of the literal it holds, and an
    // accessor that uses `this` can change the literal it belongs to.
    return scope.held === 0 || changesItself(expression)
      ? false
      : objectLiteralPositions(expression, checker, valueParts(scope));
  }
  if (ts.isArrayLiteralExpression(expression)) {
    if (scope.held === 0) return false;
    const elementHeld = partHeld(scope.held);
    let elements: DeclaredPositions = true;
    for (const element of expression.elements) {
      elements = alternatives(
        elements,
        ts.isSpreadElement(element)
          ? below(
            expressionPositions(element.expression, scope),
            ELEMENT_POSITIONS,
          )
          : ts.isOmittedExpression(element)
          ? true
          : heldAs(
            scope,
            elementHeld,
            () => expressionPositions(element, scope),
          ),
      );
    }
    return new Map([[ELEMENT_POSITIONS, elements]]);
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
  if (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) {
    const object = expressionPositions(expression.expression, scope);
    // An index into an array reads one of its elements.
    const element = ts.isElementAccessExpression(expression) &&
        typeof object !== "boolean"
      ? object.get(ELEMENT_POSITIONS)
      : undefined;
    if (element !== undefined) return element;
    const keys = accessedKeys(expression, checker);
    // A key the trace cannot read may name any part the value holds.
    return keys
      ? memberPositions(object, keys, expression, scope)
      : anyPart(object);
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

/**
 * Whether `literal` has an accessor whose body uses `this`, through which the
 * literal can change its own parts when one of them is merely read or
 * written.
 */
function changesItself(literal: ts.ObjectLiteralExpression): boolean {
  return literal.properties.some((property) =>
    (ts.isGetAccessorDeclaration(property) ||
      ts.isSetAccessorDeclaration(property)) &&
    property.body !== undefined && usesThis(property.body)
  );
}

/** Whether `node` uses `this` anywhere within it. */
function usesThis(node: ts.Node): boolean {
  return node.kind === ts.SyntaxKind.ThisKeyword ||
    ts.forEachChild(node, usesThis) === true;
}

/**
 * The symbol of the value `identifier` reads: for the name of a shorthand
 * property, the binding it reads rather than the property it writes.
 */
function valueSymbol(
  identifier: ts.Identifier,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  const { parent } = identifier;
  return ts.isShorthandPropertyAssignment(parent) && parent.name === identifier
    ? checker.getShorthandAssignmentValueSymbol(parent)
    : checker.getSymbolAtLocation(identifier);
}

/**
 * The symbol `symbol` names, read through an import, with the declaration it
 * is read from, or `undefined` where it has none.
 */
function bindingOf(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): { resolved: ts.Symbol; declaration: ts.Declaration } | undefined {
  const resolved = symbol && resolveAlias(symbol, checker);
  const declaration = resolved?.valueDeclaration ??
    resolved?.declarations?.[0];
  return resolved && declaration && { resolved, declaration };
}

/**
 * Whether `declaration` declares a function, a class, or an enum, which
 * declares what its name holds.
 */
function namesItsValue(declaration: ts.Declaration): boolean {
  return ts.isFunctionDeclaration(declaration) ||
    ts.isClassDeclaration(declaration) ||
    ts.isEnumDeclaration(declaration) ||
    ts.isEnumMember(declaration);
}

/** `symbol`, or what it aliases when it is an import. */
function resolveAlias(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

/**
 * The declared positions of the value bound to `symbol`. A type written out
 * for the binding declares what it holds, which anything assigned to it or
 * changed through it must satisfy, and so do the written parts of the
 * binding's own type, however the binding came by it, as `writtenPositions()`
 * reads them. A binding something reassigns declares nothing more. One
 * nothing reassigns also holds what the trace reads of its value with the
 * binding holding it: whatever is done through the binding can change that
 * value's own structure, so the structure declares nothing, while a written
 * type or a reactive value it holds still declares its parts. A position
 * either of the two declares is declared.
 */
function symbolPositions(
  symbol: ts.Symbol | undefined,
  scope: TraceScope,
): DeclaredPositions {
  const { checker } = scope;
  const binding = bindingOf(symbol, checker);
  if (!binding) return false;
  const { resolved, declaration } = binding;
  // The binding's own type declares what any value it holds has under it, as
  // far as that type was written. A type written out for the binding, or a
  // function's, a class's or an enum's, is all there is.
  const ownType = symbolProvenance(resolved, checker, newReading());
  if (
    namesItsValue(declaration) || writtenBindingType(declaration, checker) ||
    reassigned(resolved, checker)
  ) {
    return ownType;
  }
  if (ts.isBindingElement(declaration)) {
    // A destructured binding holds a field of the value it came from, which
    // the field's written type declares.
    const field = getDeclaredTypeNodeForBindingElement(declaration, checker);
    if (field && !mentionsTypeParameter(field, checker)) {
      return typeNodePositions(field, true, checker);
    }
  }
  let positions: DeclaredPositions;
  const bound = scope.bindings.get(resolved);
  if (bound !== undefined) {
    positions = bound;
  } else if (ts.isVariableDeclaration(declaration)) {
    positions = heldAs(
      scope,
      0,
      () => traced(declaration, declaration.initializer, scope),
    );
  } else if (ts.isBindingElement(declaration)) {
    positions = destructuredPositions(declaration, scope);
    const fallback = declaration.initializer;
    if (fallback) {
      positions = alternatives(
        positions,
        heldAs(scope, 0, () => expressionPositions(fallback, scope)),
      );
    }
  } else {
    return false;
  }
  return eitherDeclares(positions, ownType);
}

/**
 * The positions declared for a value both `a` and `b` describe: a position
 * either declares is declared, and a part one of them shows the value lacks
 * is one the value does not have.
 */
function eitherDeclares(
  a: DeclaredPositions,
  b: DeclaredPositions,
): DeclaredPositions {
  if (a === true || b === false) return a;
  if (b === true || a === false) return b;
  const either = new Map<PositionKey, DeclaredPositions>();
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    either.set(
      key,
      eitherDeclares(partAt(a, key) ?? true, partAt(b, key) ?? true),
    );
  }
  return either;
}

/**
 * The type `declaration` writes out for the local or the parameter it
 * declares, unless that type names a type parameter, whose argument may have
 * been inferred.
 */
function writtenBindingType(
  declaration: ts.Declaration,
  checker: ts.TypeChecker,
): ts.TypeNode | undefined {
  const type =
    ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)
      ? declaration.type
      : undefined;
  return type && !mentionsTypeParameter(type, checker) ? type : undefined;
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
 * The declared positions of the part of a local's initializer that `element`
 * binds, before its own default. The binding holds only that part, so the
 * initializer is traced holding it as many levels down as `element` is nested,
 * and each enclosing element's default is an alternative at its own level.
 */
function destructuredPositions(
  element: ts.BindingElement,
  scope: TraceScope,
): DeclaredPositions {
  const { declaration, path } = destructuringPath(element);
  if (!declaration) return false;
  let positions = heldAs(
    scope,
    path.length,
    () => traced(declaration, declaration.initializer, scope),
  );
  path.forEach((step, index) => {
    positions = bindingPart(step.parent, step, positions, scope.checker);
    const depth = path.length - 1 - index;
    const fallback = step.initializer;
    if (depth > 0 && fallback) {
      positions = alternatives(
        positions,
        heldAs(scope, depth, () => expressionPositions(fallback, scope)),
      );
    }
  });
  return positions;
}

/**
 * The elements from the outermost down to `element` that bind it, and the
 * local whose initializer they destructure, if a local's is what they do.
 */
function destructuringPath(element: ts.BindingElement): {
  declaration: ts.VariableDeclaration | undefined;
  path: ts.BindingElement[];
} {
  const path: ts.BindingElement[] = [element];
  let owner = element.parent.parent;
  while (ts.isBindingElement(owner)) {
    path.unshift(owner);
    owner = owner.parent.parent;
  }
  return {
    declaration: ts.isVariableDeclaration(owner) ? owner : undefined,
    path,
  };
}

/**
 * The declared positions of the member of a value with `object` that `access`
 * reads under one of `keys`, as alternatives. A member of a value with nothing
 * declared still declares what its type does: what its own declaration writes,
 * where that names no type parameter, and as `writtenPositions()` reads it
 * otherwise.
 */
function memberPositions(
  object: DeclaredPositions,
  keys: readonly string[],
  access: MemberAccess,
  scope: TraceScope,
): DeclaredPositions {
  if (object !== false) return partsAt(object, keys);
  const { checker } = scope;
  const type = checker.getTypeAtLocation(access);
  return keys.reduce<DeclaredPositions>((positions, key) => {
    const member = accessedMember(access, key, checker);
    const node = memberTypeNode(member);
    return alternatives(
      positions,
      node && writesOwnType(member, checker)
        ? typeNodePositions(node, true, checker)
        : writtenPositions(type, checker),
    );
  }, true);
}

/** A read of a member, by its name or by a key. */
type MemberAccess = ts.PropertyAccessExpression | ts.ElementAccessExpression;

/**
 * The keys `access` may read a member under: its name, a literal key, or each
 * literal of the type of a key, as `const key = "a"` gives one. `undefined`
 * for a key whose type is no literal, which may read any member.
 */
function accessedKeys(
  access: MemberAccess,
  checker: ts.TypeChecker,
): readonly string[] | undefined {
  return ts.isPropertyAccessExpression(access)
    ? [access.name.text]
    : literalKeys(checker.getTypeAtLocation(access.argumentExpression));
}

/**
 * The keys a key of `type` may be: each literal of a literal type or a union
 * of them, or `undefined` for a type that is no literal.
 */
function literalKeys(type: ts.Type): readonly string[] | undefined {
  const literals = type.isUnion() ? type.types : [type];
  return literals.every((literal) =>
      literal.isStringLiteral() || literal.isNumberLiteral()
    )
    ? literals.map((literal) =>
      String((literal as ts.StringLiteralType | ts.NumberLiteralType).value)
    )
    : undefined;
}

/** The member `access` reads under `key`. */
function accessedMember(
  access: MemberAccess,
  key: string,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  if (ts.isPropertyAccessExpression(access)) {
    return checker.getSymbolAtLocation(access.name);
  }
  const argument = access.argumentExpression;
  return ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument)
    ? checker.getSymbolAtLocation(argument)
    : checker.getTypeAtLocation(access.expression).getProperty(key);
}

/**
 * The declared positions of the parts a value holds under `keys`, as
 * alternatives.
 */
function partsAt(
  positions: DeclaredPositions,
  keys: readonly string[],
): DeclaredPositions {
  return keys.reduce<DeclaredPositions>(
    (parts, key) => alternatives(parts, below(positions, key)),
    true,
  );
}

/** The declared positions of whichever part of a value a key may read. */
function anyPart(positions: DeclaredPositions): DeclaredPositions {
  return typeof positions === "boolean"
    ? positions
    : [...positions.values()].reduce<DeclaredPositions>(alternatives, true);
}

/**
 * Whether the declaration of `member` writes its type out, as a property's
 * type, a parameter property's, or a getter's return type, without naming a
 * type parameter, whose argument may have been inferred.
 */
function writesOwnType(
  member: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): boolean {
  const type = memberTypeNode(member);
  return !!type && !mentionsTypeParameter(type, checker);
}

/**
 * The type node the declaration of `member` writes out for it: a property's
 * type, a parameter property's, or a getter's return type.
 */
function memberTypeNode(
  member: ts.Symbol | undefined,
): ts.TypeNode | undefined {
  const declaration = member?.valueDeclaration ?? member?.declarations?.[0];
  return declaration &&
      (ts.isPropertySignature(declaration) ||
        ts.isPropertyDeclaration(declaration) ||
        ts.isParameter(declaration) ||
        ts.isGetAccessorDeclaration(declaration))
    ? declaration.type
    : undefined;
}

/**
 * Whether the declaration of `member` could write its type but does not, so
 * that its type was inferred: a member of an object literal, a class field or
 * a parameter property with no type written, or a getter with no return type
 * written.
 */
function infersOwnType(member: ts.Symbol): boolean {
  const declaration = member.valueDeclaration ?? member.declarations?.[0];
  return !!declaration && memberTypeNode(member) === undefined &&
    (ts.isPropertyAssignment(declaration) ||
      ts.isShorthandPropertyAssignment(declaration) ||
      ts.isPropertyDeclaration(declaration) ||
      ts.isParameter(declaration) ||
      ts.isGetAccessorDeclaration(declaration));
}

/**
 * The declared positions of the instance `construction` makes, by field. A
 * field whose declaration writes its type declares what that type does, read
 * by `readTypeNode()` with the class's type parameters standing for what
 * `constructionSubstitution()` finds the construction gives them, and an
 * inherited field with those of the class above standing for what the
 * `extends` clause writes. A field whose type is inferred from its
 * initializer declares what that initializer's type does by provenance, and
 * otherwise only what `writtenPositions()` reads of its type.
 */
function instancePositions(
  construction: ts.NewExpression,
  scope: TraceScope,
): DeclaredPositions {
  return instanceTypePositions(construction, scope.checker, newReading());
}

/** `instancePositions()`, read within `reading`. */
function instanceTypePositions(
  construction: ts.NewExpression,
  checker: ts.TypeChecker,
  reading: TypeReading,
): DeclaredPositions {
  const constructed = definitionOf(construction.expression, checker);
  return declaredMembers(
    checker.getTypeAtLocation(construction),
    constructed &&
      (ts.isClassDeclaration(constructed) || ts.isClassExpression(constructed))
      ? heritageSubstitutions(
        [constructed],
        constructionSubstitution(constructed, construction, checker, reading),
        checker,
      )
      : new Map(),
    checker,
    reading,
  );
}

/**
 * The declared positions of an object literal's value, by property, each part
 * read by `parts`. A part under a key the trace cannot name, a computed key or
 * a spread value's index signature, may be under any name, so it is an
 * alternative for every name the literal held before it, and a name the
 * literal writes after it replaces it there. A spread value's own parts land
 * in the literal as the spread value holds them. A spread member the spread
 * value may lack, being optional, is an alternative to what the literal held
 * under its name before it, rather than a replacement for it.
 */
function objectLiteralPositions(
  literal: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
  parts: LiteralParts,
): DeclaredPositions {
  const positions = new Map<PositionKey, DeclaredPositions>();
  const supply = (key: string, value: DeclaredPositions, optional: boolean) => {
    const before = partAt(positions, key);
    positions.set(
      key,
      optional && before !== undefined ? alternatives(before, value) : value,
    );
  };
  const supplyUnnamed = (value: DeclaredPositions) => {
    for (const [key, held] of positions) {
      positions.set(key, alternatives(held, value));
    }
    if (!positions.has(UNNAMED_POSITIONS)) {
      positions.set(UNNAMED_POSITIONS, value);
    }
  };
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = parts.spread(property.expression);
      const type = checker.getTypeAtLocation(property.expression);
      if (checker.getIndexInfosOfType(type).length > 0) {
        supplyUnnamed(below(spread, UNNAMED_POSITIONS));
      }
      for (const member of type.getProperties()) {
        supply(
          member.name,
          below(spread, member.name),
          (member.flags & ts.SymbolFlags.Optional) !== 0,
        );
      }
      continue;
    }
    let value: DeclaredPositions;
    if (ts.isPropertyAssignment(property)) {
      value = parts.value(property.initializer);
    } else if (ts.isShorthandPropertyAssignment(property)) {
      value = parts.shorthand(
        checker.getShorthandAssignmentValueSymbol(property),
      );
    } else if (ts.isGetAccessorDeclaration(property)) {
      value = parts.getter(property);
    } else if (ts.isMethodDeclaration(property)) {
      value = true;
    } else {
      continue;
    }
    const key = getPropertyNameText(property.name, checker);
    if (key === undefined) supplyUnnamed(value);
    else supply(key, value, false);
  }
  return positions;
}

/** How `objectLiteralPositions()` reads each part of a literal. */
interface LiteralParts {
  /** The positions of a value spread into the literal. */
  spread(expression: ts.Expression): DeclaredPositions;

  /** The positions of a property's value. */
  value(expression: ts.Expression): DeclaredPositions;

  /** The positions of the value a shorthand property names. */
  shorthand(symbol: ts.Symbol | undefined): DeclaredPositions;

  /** The positions of the value a getter returns. */
  getter(getter: ts.GetAccessorDeclaration): DeclaredPositions;
}

/**
 * The trace's reading of a literal's parts, each one level further below the
 * binding that holds the literal.
 */
function valueParts(scope: TraceScope): LiteralParts {
  const partDepth = partHeld(scope.held);
  return {
    spread: (expression) => expressionPositions(expression, scope),
    value: (expression) =>
      heldAs(scope, partDepth, () => expressionPositions(expression, scope)),
    shorthand: (symbol) => symbolPositions(symbol, scope),
    getter: (getter) =>
      heldAs(scope, partDepth, () => returnedPositions(getter, scope)),
  };
}

/**
 * The declared positions of the value `call` returns. A reactive value, as
 * `computed()`, a lift, `ifElse()`, `when()`, `unless()`, or an array method a
 * pattern's body calls on a reactive value makes, changes only when the
 * runtime recomputes it, so what makes it is traced as no binding holds it.
 * Any other array method makes a plain array, which a binding holding it can
 * change.
 */
function callPositions(
  call: ts.CallExpression,
  scope: TraceScope,
): DeclaredPositions {
  const { checker } = scope;
  // A type argument written out declares what the signature makes of it.
  if (call.typeArguments?.length) return signaturePositions(call, scope);
  // Another pattern's result passed the same check in its own compile.
  if (isPatternFactoryCalleeExpression(call.expression, checker)) return true;
  const kind = detectCallKind(call, checker);
  switch (kind?.kind) {
    case "lift-applied":
      return heldAs(
        scope,
        undefined,
        () => liftPositions(getLiftAppliedInnerCall(call), call, scope),
      );
    case "builder":
      if (kind.builderName === "computed") {
        return callbackPositions(call.arguments[0], true, scope);
      }
      if (kind.builderName === "lift") {
        // A call of a lift bound to a name classifies as the builder itself.
        const factory = liftFactoryCall(call.expression, checker);
        if (factory) {
          return heldAs(
            scope,
            undefined,
            () => liftPositions(factory, call, scope),
          );
        }
        // Otherwise this call makes the lift, and its value is a function.
        return resolveCallback(call.arguments[0], checker)
          ? true
          : signaturePositions(call, scope);
      }
      return signaturePositions(call, scope);
    case "ifElse":
      return heldAs(scope, undefined, () =>
        alternatives(
          argumentPositions(call, 1, scope),
          argumentPositions(call, 2, scope),
        ));
    case "when":
    case "unless":
      return heldAs(scope, undefined, () =>
        alternatives(
          argumentPositions(call, 0, scope),
          argumentPositions(call, 1, scope),
        ));
    case "cell-factory":
    case "cell-for":
      // A cell is a handle, whatever it holds.
      return true;
    case "wish":
    case "generate-object":
    case "generate-text":
      // With no type argument written, the result type is inferred.
      return false;
    default: {
      const method = methodCallee(call);
      if (
        !method ||
        (kind?.kind !== "array-method" &&
          !isArray(checker.getTypeAtLocation(method.receiver), checker))
      ) {
        return signaturePositions(call, scope);
      }
      if (yieldsReactiveValue(call, method, checker)) {
        return heldAs(
          scope,
          undefined,
          () => arrayMethodPositions(call, method, true, scope),
        );
      }
      return scope.held === undefined
        ? arrayMethodPositions(call, method, false, scope)
        : false;
    }
  }
}

/**
 * Whether `call`, a call of an array method, yields a reactive value, as one
 * a pattern's body makes on a reactive receiver does: lowering makes it a step
 * of the reactive graph. Inside a callback such as `computed()`'s, the
 * receiver is a plain array, and so is what its method makes.
 */
function yieldsReactiveValue(
  call: ts.CallExpression,
  method: MethodCallee,
  checker: ts.TypeChecker,
): boolean {
  return classifyReactiveContext(call, checker).kind === "pattern" &&
    isReactiveValueExpression(method.receiver, checker);
}

/**
 * The declared positions of `applied`, an application of the lift `factory`
 * makes: what the lift's callback returns for `applied`'s argument, which its
 * parameter holds, or the fields of the lift's result type when its type
 * arguments are written out.
 */
function liftPositions(
  factory: ts.CallExpression | undefined,
  applied: ts.CallExpression,
  scope: TraceScope,
): DeclaredPositions {
  // `lift<T, R>()` writes the result type `R`.
  const result = factory?.typeArguments?.[1];
  if (result) return typeNodePositions(result, false, scope.checker);
  return callbackPositions(
    factory?.arguments[0],
    heldAs(scope, 0, () => argumentPositions(applied, 0, scope)),
    scope,
  );
}

/** The call that makes the lift `callee` denotes, as `definitionOf()` reads it. */
function liftFactoryCall(
  callee: ts.Expression,
  checker: ts.TypeChecker,
): ts.CallExpression | undefined {
  const definition = definitionOf(callee, checker);
  if (!definition || !ts.isCallExpression(definition)) return undefined;
  const kind = detectCallKind(definition, checker);
  return kind?.kind === "builder" && kind.builderName === "lift"
    ? definition
    : undefined;
}

/**
 * What `expression` denotes, read through the names it is spelled with: the
 * function or the class a name declares, or what a binding nothing reassigns
 * was initialized with, read in turn. A name the trace cannot follow, or one
 * it reaches a second time, denotes nothing.
 */
function definitionOf(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.Node | undefined {
  const followed = new Set<ts.Symbol>();
  let current = unwrapCallee(expression);
  while (ts.isIdentifier(current)) {
    const symbol = checker.getSymbolAtLocation(current);
    const resolved = symbol && resolveAlias(symbol, checker);
    if (!resolved || followed.has(resolved) || reassigned(resolved, checker)) {
      return undefined;
    }
    followed.add(resolved);
    const declaration = resolved.valueDeclaration ??
      resolved.declarations?.find((candidate) =>
        ts.isFunctionDeclaration(candidate) && candidate.body !== undefined
      );
    if (
      declaration &&
      (ts.isFunctionDeclaration(declaration) ||
        ts.isClassDeclaration(declaration))
    ) {
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

/** A method a call calls, and the value it calls it on. */
interface MethodCallee {
  /** The method's name. */
  readonly name: string;

  /** The value the method is called on. */
  readonly receiver: ts.Expression;
}

/**
 * The method `call` calls and the value it calls it on, spelled as a member
 * or by a literal key.
 */
function methodCallee(call: ts.CallExpression): MethodCallee | undefined {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    return { name: callee.name.text, receiver: callee.expression };
  }
  if (
    ts.isElementAccessExpression(callee) &&
    ts.isStringLiteralLike(callee.argumentExpression)
  ) {
    return {
      name: callee.argumentExpression.text,
      receiver: callee.expression,
    };
  }
  return undefined;
}

/** Whether `type`, read through a reactive wrapper, is an array or a tuple. */
function isArray(type: ts.Type, checker: ts.TypeChecker): boolean {
  const value = unwrapOpaqueLikeType(type, checker) ?? type;
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
  checker: ts.TypeChecker,
): ts.SignatureDeclaration | undefined {
  const definition = expression && definitionOf(expression, checker);
  return definition &&
      (ts.isArrowFunction(definition) ||
        ts.isFunctionExpression(definition) ||
        ts.isFunctionDeclaration(definition))
    ? definition
    : undefined;
}

/**
 * The declared positions of what the function `expression` denotes returns,
 * with its first parameter bound to a value with `argument`. What a callback
 * returns goes straight into the value its call makes.
 */
function callbackPositions(
  expression: ts.Expression | undefined,
  argument: DeclaredPositions,
  scope: TraceScope,
): DeclaredPositions {
  const callback = resolveCallback(expression, scope.checker);
  if (!callback) {
    // A function the trace cannot follow, reassigned or read from an object,
    // returns what its type does, which any function in its place must.
    return expression
      ? functionProvenance(expression, scope.checker, newReading())
      : false;
  }
  if (scope.tracing.has(callback)) return false;
  scope.tracing.add(callback);
  const positions = heldAs(scope, undefined, () => {
    const parameter = callback.parameters[0];
    if (parameter) bindParameter(parameter, argument, scope);
    return returnedPositions(callback, scope);
  });
  scope.tracing.delete(callback);
  return positions;
}

/**
 * The declared positions of what `call` returns, which calls `method` of an
 * array. A method of a plain array, unlike a `reactive` one, may hand each
 * element to a callback, whose parameter holds the element and can change it,
 * so the receiver is read with its elements held.
 */
function arrayMethodPositions(
  call: ts.CallExpression,
  method: MethodCallee,
  reactive: boolean,
  scope: TraceScope,
): DeclaredPositions {
  const receiver = heldAs(
    scope,
    reactive ? undefined : 1,
    () => expressionPositions(method.receiver, scope),
  );
  switch (method.name) {
    case "map":
      return new Map([[
        ELEMENT_POSITIONS,
        callbackPositions(
          call.arguments[0],
          below(receiver, ELEMENT_POSITIONS),
          scope,
        ),
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
      return below(receiver, ELEMENT_POSITIONS);
    default:
      return signaturePositions(call, scope);
  }
}

/**
 * The declared positions of a call's result read from where its type was
 * written, as `callProvenance()` finds it, or from what `writtenPositions()`
 * reads of that type.
 */
function signaturePositions(
  call: ts.CallLikeExpression,
  scope: TraceScope,
): DeclaredPositions {
  const { checker } = scope;
  const reading = newReading();
  return (ts.isCallExpression(call) || ts.isTaggedTemplateExpression(call)
    ? callProvenance(call, checker, reading)
    : undefined) ??
    readType(checker.getTypeAtLocation(call), checker, "inferred", reading);
}

/**
 * The positions a value of the written type `node` declares, as
 * `readTypeNode()` reads one that names no type parameter.
 */
function typeNodePositions(
  node: ts.TypeNode,
  inField: boolean,
  checker: ts.TypeChecker,
): DeclaredPositions {
  return readTypeNode(node, new Map(), inField, checker, newReading());
}

/**
 * The positions a value of `type`, a type that may have been inferred,
 * declares: only those its written parts declare, as `objectTypePositions()`
 * finds them. `unknown` declares nothing, and neither does a type naming a
 * type parameter, whose argument may have been inferred.
 */
function writtenPositions(
  type: ts.Type,
  checker: ts.TypeChecker,
): DeclaredPositions {
  return readType(type, checker, "inferred", newReading());
}

/**
 * How `readType()` reads a type: as one an author wrote, for a whole value or
 * for a field, or as one that may have been inferred.
 */
type ReadingMode = "written" | "field" | "inferred";

/** The positions a value of `type` declares, read in `mode`. */
function readType(
  type: ts.Type,
  checker: ts.TypeChecker,
  mode: ReadingMode,
  reading: TypeReading,
): DeclaredPositions {
  const value = unwrapOpaqueLikeType(type, checker) ?? type;
  if ((value.flags & ts.TypeFlags.Unknown) !== 0) return mode === "field";
  // A type still naming a type parameter is whatever its argument turns out to
  // be, which may have been inferred.
  if ((value.flags & ts.TypeFlags.Instantiable) !== 0) return false;
  const read = reading.read[mode];
  const known = read.get(value);
  if (known !== undefined) return known;
  const openAt = reading.open.get(value);
  if (openAt !== undefined) {
    reading.reachedOpen = Math.min(reading.reachedOpen, openAt);
    return true;
  }
  // A type read inside an instantiation of its own declaration may instantiate
  // it without end, as `Nest<T[]>` inside `Nest<T>` does, each level a new
  // type. As the checker and the schema generator do, the reading takes one
  // nested `MAX_TYPE_NESTING` deep for a recursion. An array nests in an array
  // only as far as an author writes it.
  const declaration = checker.isArrayType(value) || checker.isTupleType(value)
    ? undefined
    : value.aliasSymbol ?? value.symbol;
  const nested = declaration && reading.nested.get(declaration);
  if (nested && nested.length >= MAX_TYPE_NESTING) {
    reading.reachedOpen = Math.min(reading.reachedOpen, nested[0]!);
    return true;
  }
  const depth = reading.open.size;
  reading.open.set(value, depth);
  if (declaration) reading.nested.set(declaration, [...nested || [], depth]);
  const outerReached = reading.reachedOpen;
  reading.reachedOpen = Infinity;
  let positions: DeclaredPositions = true;
  if (value.isUnion() || value.isIntersection()) {
    // Every part of an intersection describes the same value.
    for (const member of value.types) {
      positions = alternatives(
        positions,
        readType(member, checker, mode, reading),
      );
    }
  } else if (checker.isArrayType(value) || checker.isTupleType(value)) {
    let elements: DeclaredPositions = true;
    for (const element of checker.getTypeArguments(value as ts.TypeReference)) {
      elements = alternatives(
        elements,
        readType(element, checker, mode, reading),
      );
    }
    positions = new Map([[ELEMENT_POSITIONS, elements]]);
  } else if ((value.flags & ts.TypeFlags.Object) !== 0) {
    positions = objectTypePositions(value, checker, mode, reading);
  }
  reading.open.delete(value);
  if (declaration) {
    if (nested) reading.nested.set(declaration, nested);
    else reading.nested.delete(declaration);
  }
  // A read that reached no type open above this one gives the same positions
  // whichever path reaches the type.
  if (reading.reachedOpen >= depth) read.set(value, positions);
  reading.reachedOpen = Math.min(outerReached, reading.reachedOpen);
  return positions;
}

/**
 * The positions an object type's members and index signatures declare, read
 * in `mode`. A part read as written is read as a field, by `readTypeNode()`
 * where its declaration writes its type without naming a type parameter. In a
 * written type, a member is read as written unless its declaration infers its
 * type. In an inferred one, only a part whose declaration writes its type,
 * naming no type parameter, is.
 */
function objectTypePositions(
  value: ts.Type,
  checker: ts.TypeChecker,
  mode: ReadingMode,
  reading: TypeReading,
): DeclaredPositions {
  const inferred = mode === "inferred";
  // The members of a type the checker reverse mapped from a source are
  // declared by the source's members, whose values are not theirs, so each is
  // read by its type alone.
  const reversed =
    ((value as ts.ObjectType).objectFlags & ts.ObjectFlags.ReverseMapped) !==
      0;
  const fields = new Map<PositionKey, DeclaredPositions>();
  for (const property of value.getProperties()) {
    const written = inferred
      ? writesOwnType(property, checker)
      : !infersOwnType(property);
    const type = checker.getTypeOfSymbol(property);
    const node = memberTypeNode(property);
    fields.set(
      property.name,
      reversed
        ? readType(type, checker, "inferred", reading)
        : written && node && !mentionsTypeParameter(node, checker)
        ? readTypeNode(node, new Map(), true, checker, reading)
        : written
        ? readType(type, checker, "field", reading)
        : eitherDeclares(
          readType(type, checker, "inferred", reading),
          initializerProvenance(property, checker, reading),
        ),
    );
  }
  for (const index of checker.getIndexInfosOfType(value)) {
    const declared = index.declaration?.type;
    const written = !inferred ||
      (!!declared && !mentionsTypeParameter(declared, checker));
    fields.set(
      UNNAMED_POSITIONS,
      alternatives(
        fields.get(UNNAMED_POSITIONS) ?? true,
        readType(index.type, checker, written ? "field" : "inferred", reading),
      ),
    );
  }
  return wholly(fields) ? true : fields;
}

/** A read of a type with nothing read yet. */
function newReading(): TypeReading {
  return {
    open: new Map(),
    nested: new Map(),
    read: { written: new Map(), field: new Map(), inferred: new Map() },
    reachedOpen: Infinity,
    tracing: new Set(),
    substitution: new Map(),
    nodeOpen: new Map(),
    inferenceDepth: 0,
  };
}

/**
 * How many instantiations of one declaration `readType()` reads nested in one
 * another before it takes the innermost for a recursion without end.
 */
const MAX_TYPE_NESTING = 3;

/**
 * What one read by `readType()` carries from part to part. A type that holds
 * itself is taken as declared where the read reaches it again, which holds
 * only on the path that reached it, so only a read that reaches no type open
 * above it is kept for reuse.
 */
interface TypeReading {
  /** The types being read, each by its depth in the read. */
  readonly open: Map<ts.Type, number>;

  /** The depths of the types being read, by the declaration each instantiates. */
  readonly nested: Map<ts.Symbol, readonly number[]>;

  /** The positions read so far, by the mode each was read in. */
  readonly read: Readonly<Record<ReadingMode, Map<ts.Type, DeclaredPositions>>>;

  /** The shallowest depth of an open type the read has reached again. */
  reachedOpen: number;

  /**
   * The declarations whose provenance is being read, so a read never re-enters
   * one. Reaching one again keeps the read from being reused.
   */
  readonly tracing: Set<ts.Node>;

  /**
   * What the type parameters of the declaration whose body is being read
   * stand for, in the call that body is read for.
   */
  substitution: Substitution;

  /**
   * How many reads of each declaration, by `readTypeNode()` through a written
   * type, are open, so a type that holds itself is read a bounded depth.
   */
  readonly nodeOpen: Map<ts.Node, number>;

  /** How deep `inferFrom()` is reading, across the calls it reads into. */
  inferenceDepth: number;
}

//
// Type provenance
//

/**
 * The positions the static type of `expression` declares, read from where
 * that type was written: a cast, a binding's annotation, or a signature's
 * written return type, each read by `readTypeNode()`, with a call's or a
 * construction's type parameters standing for the type arguments it writes or
 * for the arguments that supply them. A type inferred from something else is
 * read from that: a literal's from its parts, a binding's from its
 * initializer, a call's from what the function's body returns. Whatever later
 * takes the value's place must have this type, so these positions hold where
 * the value's own structure does not. A type with no such origin declares what
 * `writtenPositions()` reads of it.
 */
function typeProvenance(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  reading: TypeReading,
): DeclaredPositions {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isAwaitExpression(expression)
  ) {
    return typeProvenance(expression.expression, checker, reading);
  }
  if (
    ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
  ) {
    if (ts.isConstTypeReference(expression.type)) {
      return typeProvenance(expression.expression, checker, reading);
    }
    return readTypeNode(
      expression.type,
      reading.substitution,
      false,
      checker,
      reading,
    );
  } else if (isScalarExpression(expression)) {
    return true;
  } else if (ts.isIdentifier(expression)) {
    return expression.text === "undefined" &&
        !checker.getSymbolAtLocation(expression)?.valueDeclaration
      ? true
      : symbolProvenance(valueSymbol(expression, checker), checker, reading);
  } else if (ts.isObjectLiteralExpression(expression)) {
    return objectLiteralPositions(
      expression,
      checker,
      provenanceParts(checker, reading),
    );
  } else if (ts.isArrayLiteralExpression(expression)) {
    let elements: DeclaredPositions = true;
    for (const element of expression.elements) {
      elements = alternatives(
        elements,
        ts.isSpreadElement(element)
          ? below(
            typeProvenance(element.expression, checker, reading),
            ELEMENT_POSITIONS,
          )
          : ts.isOmittedExpression(element)
          ? true
          : typeProvenance(element, checker, reading),
      );
    }
    return new Map([[ELEMENT_POSITIONS, elements]]);
  } else if (ts.isConditionalExpression(expression)) {
    return alternatives(
      typeProvenance(expression.whenTrue, checker, reading),
      typeProvenance(expression.whenFalse, checker, reading),
    );
  } else if (ts.isBinaryExpression(expression)) {
    switch (expression.operatorToken.kind) {
      case ts.SyntaxKind.QuestionQuestionToken:
      case ts.SyntaxKind.BarBarToken:
      case ts.SyntaxKind.AmpersandAmpersandToken:
        return alternatives(
          typeProvenance(expression.left, checker, reading),
          typeProvenance(expression.right, checker, reading),
        );
    }
  } else if (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) {
    const type = checker.getTypeAtLocation(expression);
    // A part read whole whose type is `unknown` declares nothing.
    if ((type.flags & ts.TypeFlags.Unknown) !== 0) return false;
    const keys = accessedKeys(expression, checker);
    const memberNode = keys?.length === 1
      ? memberTypeNode(accessedMember(expression, keys[0]!, checker))
      : undefined;
    if (memberNode) {
      // A member whose declaration writes its type declares what it writes.
      // A member of `this` may name its class's type parameters, which the
      // read's substitution binds for the instance a method is called on.
      if (!mentionsTypeParameter(memberNode, checker)) {
        return readTypeNode(memberNode, new Map(), false, checker, reading);
      }
      if (expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
        return eitherDeclares(
          readTypeNode(
            memberNode,
            reading.substitution,
            false,
            checker,
            reading,
          ),
          readType(type, checker, "inferred", reading),
        );
      }
    }
    // A part whose type the object's type gives takes the object's
    // provenance: an element of an array, a member under one of the keys the
    // access may read, or, by a key the trace cannot read, any part.
    const object = typeProvenance(expression.expression, checker, reading);
    const element = typeof object === "boolean"
      ? undefined
      : object.get(ELEMENT_POSITIONS);
    return eitherDeclares(
      readType(type, checker, "inferred", reading),
      element ?? (keys ? partsAt(object, keys) : anyPart(object)),
    );
  } else if (
    ts.isCallExpression(expression) ||
    ts.isTaggedTemplateExpression(expression)
  ) {
    const provenance = callProvenance(expression, checker, reading);
    if (provenance !== undefined) return provenance;
  } else if (ts.isNewExpression(expression)) {
    return instanceTypePositions(expression, checker, reading);
  }
  return readType(
    checker.getTypeAtLocation(expression),
    checker,
    "inferred",
    reading,
  );
}

/**
 * The provenance of what `call` returns, as `returnProvenance()` reads its
 * signature's declaration with each type parameter standing for what
 * `callSubstitution()` finds the call gives it, beside what
 * `writtenPositions()` reads of the type the call returns. A function declared
 * inside another is also read through the value the call is made on, which
 * carries what the outer function's type parameters stood for where it was
 * made. An untyped `wish()`, `generateObject()` or `generateText()` declares
 * nothing. `undefined` where the declaration says nothing.
 */
function callProvenance(
  call: ts.CallExpression | ts.TaggedTemplateExpression,
  checker: ts.TypeChecker,
  reading: TypeReading,
): DeclaredPositions | undefined {
  if (!call.typeArguments?.length && ts.isCallExpression(call)) {
    // With no type argument written, these results' types are inferred.
    const kind = detectCallKind(call, checker)?.kind;
    if (
      kind === "wish" || kind === "generate-object" ||
      kind === "generate-text"
    ) {
      return false;
    }
  }
  const signature = checker.getResolvedSignature(call);
  const declaration = signature?.declaration;
  const returned = declaration && !ts.isJSDocSignature(declaration)
    ? returnProvenance(
      declaration,
      checker,
      reading,
      callSubstitution(declaration, call, checker, reading),
    )
    : undefined;
  if (returned === undefined) return undefined;
  const made = returned !== true && ts.isCallExpression(call) &&
      ts.findAncestor(declaration!.parent, ts.isFunctionLike)
    ? valueSource(call.expression, checker, reading).returns().positions()
    : false;
  // A type parameter the call does not bind, as one of the lift a factory's
  // signature comes from, is bound in the type of the callee, which the type
  // the call returns is instantiated from.
  return eitherDeclares(
    eitherDeclares(returned, made),
    readType(checker.getTypeAtLocation(call), checker, "inferred", reading),
  );
}

/**
 * The provenance of what the function `declaration` declares returns, with its
 * type parameters standing for what `substitution` says, by default what they
 * stand for in `reading`: the return type it writes, or, where that type is
 * inferred, what its body returns. `undefined` where the declaration says
 * neither.
 */
function returnProvenance(
  declaration: ts.SignatureDeclaration,
  checker: ts.TypeChecker,
  reading: TypeReading,
  substitution: Substitution = reading.substitution,
): DeclaredPositions | undefined {
  if (declaration.type) {
    return readTypeNode(
      declaration.type,
      substitution,
      false,
      checker,
      reading,
    );
  }
  const body = "body" in declaration ? declaration.body : undefined;
  return body
    ? traceProvenance(
      declaration,
      reading,
      () =>
        withSubstitution(
          reading,
          substitution,
          () => returnsProvenance(body, checker, reading),
        ),
    )
    : undefined;
}

/** What `read` gives with `reading` reading under `substitution`. */
function withSubstitution<T>(
  reading: TypeReading,
  substitution: Substitution,
  read: () => T,
): T {
  const outer = reading.substitution;
  reading.substitution = substitution;
  try {
    return read();
  } finally {
    reading.substitution = outer;
  }
}

/**
 * The provenance of what the function `expression` denotes returns, read
 * through its type's signature as `returnProvenance()` reads one, or from
 * what `writtenPositions()` reads of the type it returns.
 */
function functionProvenance(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  reading: TypeReading,
): DeclaredPositions {
  const [signature] = checker.getTypeAtLocation(expression)
    .getCallSignatures();
  const declaration = signature?.declaration;
  const returned = declaration && !ts.isJSDocSignature(declaration)
    ? returnProvenance(declaration, checker, reading)
    : undefined;
  return returned ??
    (signature
      ? readType(
        checker.getReturnTypeOfSignature(signature),
        checker,
        "inferred",
        reading,
      )
      : false);
}

/** The provenance of what every return of `body` returns, as alternatives. */
function returnsProvenance(
  body: ts.ConciseBody,
  checker: ts.TypeChecker,
  reading: TypeReading,
): DeclaredPositions {
  return returnedExpressions(body).reduce<DeclaredPositions>(
    (positions, returned) =>
      alternatives(positions, typeProvenance(returned, checker, reading)),
    true,
  );
}

/**
 * The provenance of the type of the binding `symbol` names: its annotation,
 * read by `readTypeNode()` under the substitution `reading` holds, which is
 * all there is where the annotation names no type parameter. Otherwise, beside
 * what `writtenPositions()` reads of its type, what a local's or a parameter's
 * initializer declares, and for a destructured binding, the type its field
 * writes, read whole, and the part of an initializer it destructures.
 */
function symbolProvenance(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
  reading: TypeReading,
): DeclaredPositions {
  const binding = bindingOf(symbol, checker);
  if (!binding) return false;
  const { resolved, declaration } = binding;
  if (namesItsValue(declaration)) return true;
  const writtenNode =
    ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)
      ? declaration.type
      : ts.isBindingElement(declaration)
      ? getDeclaredTypeNodeForBindingElement(declaration, checker)
      : undefined;
  // A destructured binding holds the field's value, as the field's written
  // type declares it, until something reassigns it, after which its type,
  // inferred from the field's, declares only what a whole value of it does.
  const written = writtenNode
    ? readTypeNode(
      writtenNode,
      reading.substitution,
      ts.isBindingElement(declaration) && !reassigned(resolved, checker),
      checker,
      reading,
    )
    : false;
  if (
    writtenNode && !ts.isBindingElement(declaration) &&
    !mentionsTypeParameter(writtenNode, checker)
  ) {
    return written;
  }
  const type = checker.getTypeOfSymbolAtLocation(resolved, declaration);
  const own = eitherDeclares(
    written,
    readType(type, checker, "inferred", reading),
  );
  // A binding whose type is `unknown` holds a whole value of no known type,
  // which declares nothing, whatever field it was first read from.
  if ((type.flags & ts.TypeFlags.Unknown) !== 0) return own;
  if (
    (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) &&
    declaration.initializer
  ) {
    const initializer = declaration.initializer;
    return eitherDeclares(
      own,
      traceProvenance(
        declaration,
        reading,
        () => typeProvenance(initializer, checker, reading),
      ),
    );
  }
  if (ts.isBindingElement(declaration)) {
    return eitherDeclares(
      own,
      traceProvenance(
        declaration,
        reading,
        () => destructuredProvenance(declaration, checker, reading),
      ),
    );
  }
  return own;
}

/**
 * The provenance of the part of a local's initializer that `element` binds,
 * with each default an alternative at its own level.
 */
function destructuredProvenance(
  element: ts.BindingElement,
  checker: ts.TypeChecker,
  reading: TypeReading,
): DeclaredPositions {
  const { declaration, path } = destructuringPath(element);
  if (!declaration?.initializer) return false;
  let positions = typeProvenance(declaration.initializer, checker, reading);
  for (const step of path) {
    positions = bindingPart(step.parent, step, positions, checker);
    if (step.initializer) {
      positions = alternatives(
        positions,
        typeProvenance(step.initializer, checker, reading),
      );
    }
  }
  return positions;
}

/**
 * The provenance of the initializer of `member`'s declaration, a property of a
 * literal, a class field, or a parameter property, whose type that
 * initializer gave it. `false` for a member with none.
 */
function initializerProvenance(
  member: ts.Symbol,
  checker: ts.TypeChecker,
  reading: TypeReading,
): DeclaredPositions {
  const declaration = member.valueDeclaration ?? member.declarations?.[0];
  if (declaration && ts.isShorthandPropertyAssignment(declaration)) {
    return symbolProvenance(
      checker.getShorthandAssignmentValueSymbol(declaration),
      checker,
      reading,
    );
  }
  const initializer = declaration &&
      (ts.isPropertyAssignment(declaration) ||
        ts.isPropertyDeclaration(declaration) || ts.isParameter(declaration))
    ? declaration.initializer
    : undefined;
  return declaration && initializer
    ? traceProvenance(
      declaration,
      reading,
      () => typeProvenance(initializer, checker, reading),
    )
    : false;
}

/** How `typeProvenance()` reads each part of a literal. */
function provenanceParts(
  checker: ts.TypeChecker,
  reading: TypeReading,
): LiteralParts {
  return {
    spread: (expression) => typeProvenance(expression, checker, reading),
    value: (expression) => typeProvenance(expression, checker, reading),
    shorthand: (symbol) => symbolProvenance(symbol, checker, reading),
    getter: (getter) => returnProvenance(getter, checker, reading) ?? false,
  };
}

/**
 * What `read` gives with `reading` reading the provenance of `declaration`,
 * or `false` where that read is already under way, which also keeps the
 * types open around it from being reused.
 */
function traceProvenance(
  declaration: ts.Node,
  reading: TypeReading,
  read: () => DeclaredPositions,
): DeclaredPositions {
  if (reading.tracing.has(declaration)) {
    reading.reachedOpen = -1;
    return false;
  }
  reading.tracing.add(declaration);
  try {
    return read();
  } finally {
    reading.tracing.delete(declaration);
  }
}

//
// Type arguments
//
// What each type parameter of a call, a construction, or a written type
// stands for in a reading: the type argument written for it, or what the
// arguments passed supply it, or, where nothing can supply it, its written
// default or constraint. One left unbound was inferred from nothing the
// reading knows, and declares nothing.
//
// What the arguments supply is found the way the checker infers type
// arguments (`inferTypeArguments()` and `inferTypes()` in TypeScript's
// checker): each argument is read against the type of the parameter it is
// passed to, through that type's structure, and only the candidates found at
// the best priority count. Where the checker reads an argument's type, this
// reads its provenance, through a `Source` that follows the argument to where
// each of its parts was written.
//

/** What a type parameter stands for in a reading. */
type TypeArgument = WrittenArgument | InferredArgument;

/** A type argument written out, or a written default or constraint. */
interface WrittenArgument {
  /** Which kind of type argument this is. */
  readonly kind: "written";

  /** The type written for the parameter. */
  readonly node: ts.TypeNode;

  /** What the type parameters `node` names stand for where it is written. */
  readonly substitution: Substitution;
}

/** A type argument inferred from the arguments passed. */
interface InferredArgument {
  /** Which kind of type argument this is. */
  readonly kind: "inferred";

  /** The provenance of what it was inferred from, as alternatives. */
  readonly positions: DeclaredPositions;

  /**
   * The static type of each candidate it was inferred from, where every one
   * has a type, which tells the keys a key type parameter stands for.
   */
  readonly types?: readonly ts.Type[];
}

/** What each type parameter stands for, by its declaration. */
type Substitution = ReadonlyMap<ts.TypeParameterDeclaration, TypeArgument>;

/**
 * What each type parameter of `declaration` stands for in `call`: its written
 * type argument, or what the arguments infer, as `inferFromArguments()` finds
 * it. A method's call also binds the type parameters of the class or the
 * interface declaring it, as the value it is called on instantiates them, and
 * the type parameters of the declaration whose body holds the call keep what
 * they stand for.
 */
function callSubstitution(
  declaration: ts.SignatureDeclaration,
  call: ts.CallExpression | ts.TaggedTemplateExpression,
  checker: ts.TypeChecker,
  reading: TypeReading,
): Substitution {
  const receiver = ts.isCallExpression(call)
    ? methodCallee(call)?.receiver
    : undefined;
  const owner = declaration.parent;
  const outer = new Map([
    ...reading.substitution,
    ...(receiver &&
        (ts.isClassLike(owner) || ts.isInterfaceDeclaration(owner)) &&
        owner.typeParameters?.length
      ? valueSource(receiver, checker, reading).instance(owner) ?? []
      : []),
  ]);
  const own = declaration.typeParameters ?? [];
  if (own.length === 0) return outer;
  if (call.typeArguments?.length) {
    return new Map([
      ...outer,
      ...bindTypeArguments(own, call.typeArguments, reading.substitution),
    ]);
  }
  const inference = newInference(own, checker, reading);
  inferFromArguments(inference, declaration, callArguments(call), receiver);
  return new Map([...outer, ...inferredSubstitution(own, inference)]);
}

/**
 * The arguments `call` passes, as the checker's `getEffectiveCallArguments()`
 * reads them: a tagged template passes its strings, then each substitution.
 */
function callArguments(
  call: ts.CallExpression | ts.TaggedTemplateExpression,
): readonly ts.Expression[] {
  if (ts.isCallExpression(call)) return call.arguments;
  const { template } = call;
  return [
    template,
    ...(ts.isTemplateExpression(template)
      ? template.templateSpans.map((span) => span.expression)
      : []),
  ];
}

/**
 * What each type parameter of `constructed` stands for in the instance
 * `construction` makes: its written type argument, or what the arguments
 * infer. An inherited constructor's parameters are read in terms of the class
 * declaring it, and what that class's type parameters are inferred from is
 * read down through each `extends` clause on the way to `constructed`. Where
 * the construction calls a constructor `constructed` neither declares nor
 * inherits through an `extends` clause this reads, no argument can name a
 * type parameter of `constructed`, so each takes its default.
 */
function constructionSubstitution(
  constructed: ts.ClassLikeDeclaration,
  construction: ts.NewExpression,
  checker: ts.TypeChecker,
  reading: TypeReading,
): Substitution {
  const own = constructed.typeParameters ?? [];
  if (construction.typeArguments?.length) {
    return bindTypeArguments(
      own,
      construction.typeArguments,
      reading.substitution,
    );
  }
  const constructor = checker.getResolvedSignature(construction)?.declaration;
  const chain = constructor && ts.isConstructorDeclaration(constructor)
    ? classesUpTo(constructed, constructor.parent, checker)
    : undefined;
  if (!constructor || !ts.isConstructorDeclaration(constructor) || !chain) {
    return inferredSubstitution(own, newInference(own, checker, reading));
  }
  let inference = newInference(
    constructor.parent.typeParameters ?? [],
    checker,
    reading,
  );
  inferFromArguments(
    inference,
    constructor,
    construction.arguments ?? [],
    undefined,
  );
  for (let index = chain.length - 2; index >= 0; index--) {
    const child = chain[index]!;
    const heritage = extendsClause(child)!;
    const below = newInference(child.typeParameters ?? [], checker, reading);
    (chain[index + 1]!.typeParameters ?? []).forEach((parameter, position) => {
      const found = bestCandidates(inference, parameter);
      const argument = heritage.typeArguments?.[position];
      if (!found || !argument) return;
      inferFrom(
        below,
        unionSource(found),
        checker.getTypeFromTypeNode(argument),
      );
    });
    inference = below;
  }
  return inferredSubstitution(own, inference);
}

/**
 * The classes from `constructed` up through each `extends` clause to
 * `declaring`, or `undefined` where `declaring` is not above it.
 */
function classesUpTo(
  constructed: ts.ClassLikeDeclaration,
  declaring: ts.ClassLikeDeclaration,
  checker: ts.TypeChecker,
): ts.ClassLikeDeclaration[] | undefined {
  const chain: ts.ClassLikeDeclaration[] = [];
  let current: ts.Node | undefined = constructed;
  while (
    current &&
    (ts.isClassDeclaration(current) || ts.isClassExpression(current)) &&
    !chain.includes(current)
  ) {
    chain.push(current);
    if (current === declaring) return chain;
    const heritage = extendsClause(current);
    current = heritage && definitionOf(heritage.expression, checker);
  }
  return undefined;
}

/** The `extends` clause of `declaration`, if it has one. */
function extendsClause(
  declaration: ts.ClassLikeDeclaration | ts.InterfaceDeclaration,
): ts.ExpressionWithTypeArguments | undefined {
  return declaration.heritageClauses
    ?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
    ?.types[0];
}

/**
 * The substitution binding `parameters` to the type arguments `written`, each
 * read with `outer`, or, past them, to each parameter's default.
 */
function bindTypeArguments(
  parameters: readonly ts.TypeParameterDeclaration[],
  written: readonly ts.TypeNode[] | undefined,
  outer: Substitution,
): Substitution {
  const substitution = new Map<ts.TypeParameterDeclaration, TypeArgument>();
  parameters.forEach((parameter, index) => {
    const argument = written?.[index];
    if (argument) {
      substitution.set(parameter, {
        kind: "written",
        node: argument,
        substitution: outer,
      });
    } else if (parameter.default) {
      substitution.set(parameter, {
        kind: "written",
        node: parameter.default,
        substitution,
      });
    }
  });
  return substitution;
}

/**
 * The substitution `inference` gives `parameters`: each inferred from its
 * candidates, covariant ones first, or, with none, standing for its written
 * default, or else its written constraint, as the checker takes them. One
 * with none of these is unbound.
 */
function inferredSubstitution(
  parameters: readonly ts.TypeParameterDeclaration[],
  inference: Inference,
): Substitution {
  const substitution = new Map<ts.TypeParameterDeclaration, TypeArgument>();
  for (const parameter of parameters) {
    const found = bestCandidates(inference, parameter);
    const written = parameter.default ??
      (parameter.constraint &&
          !isUnconstrained(parameter.constraint, inference.checker)
        ? parameter.constraint
        : undefined);
    // A single candidate written out stands for the type written, which
    // declares a reference wherever the parameter is a field's type.
    const [only] = found ?? [];
    const writing = found?.length === 1 ? only!.written : undefined;
    if (writing) {
      substitution.set(parameter, { kind: "written", ...writing });
    } else if (found) {
      const types = found.map((candidate) => candidate.type());
      substitution.set(parameter, {
        kind: "inferred",
        positions: found
          .map((candidate) => candidate.positions())
          .reduce(alternatives, true),
        types: types.every((type) => type !== undefined) ? types : undefined,
      });
    } else if (written) {
      substitution.set(parameter, {
        kind: "written",
        node: written,
        substitution,
      });
    }
  }
  return substitution;
}

/**
 * Whether the constraint `node` denotes `unknown` or `any`, however it is
 * spelled, which a type parameter with no candidate then takes.
 */
function isUnconstrained(node: ts.TypeNode, checker: ts.TypeChecker): boolean {
  return (checker.getTypeFromTypeNode(node).flags &
    (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) !== 0;
}

//
// Inference
//

/** What `inferFrom()` collects for the type parameters of one call. */
interface Inference {
  /** The checker every type is read through. */
  readonly checker: ts.TypeChecker;

  /** The reading the arguments' provenance is read within. */
  readonly reading: TypeReading;

  /** The type parameters being inferred, by their type. */
  readonly targets: ReadonlyMap<ts.Type, ts.TypeParameterDeclaration>;

  /** The candidates found so far, by type parameter. */
  readonly candidates: Map<ts.TypeParameterDeclaration, Candidates>;

  /** The priority inferences are made at; lower takes precedence. */
  priority: number;

  /** Whether inferences are made from a parameter's position. */
  contravariant: boolean;

  /** Whether each type mentions a type parameter being inferred. */
  readonly mentions: Map<ts.Type, boolean>;

  /** How many candidates have been recorded, at whatever priority. */
  recorded: number;
}

/** The candidates a type parameter is inferred from, at one priority. */
interface Candidates {
  /** The priority they were found at. */
  readonly priority: number;

  /** Each candidate found in a covariant position. */
  readonly covariant: Source[];

  /** Each candidate found in a contravariant position. */
  readonly contravariant: Source[];
}

/**
 * Priorities a candidate is found at, as the checker ranks them: a candidate
 * found only at a worse priority is discarded once one at a better priority is
 * found.
 */
const InferencePriority = {
  /** A type parameter alone among a union's or an intersection's members. */
  NakedTypeVariable: 1,
  /** A homomorphic mapped type, read backwards. */
  HomomorphicMappedType: 8,
  /** A mapped type's key constraint. */
  MappedTypeConstraint: 32,
  /** A branch of a conditional type, in a contravariant position. */
  ContravariantConditional: 64,
  /** `keyof T`. */
  LiteralKeyof: 256,
} as const;

/** How deep `inferFrom()` reads before it takes what it has. */
const MAX_INFERENCE_DEPTH = 8;

/** An inference of `parameters` with nothing found yet. */
function newInference(
  parameters: readonly ts.TypeParameterDeclaration[],
  checker: ts.TypeChecker,
  reading: TypeReading,
): Inference {
  return {
    checker,
    reading,
    targets: new Map(
      parameters.map((parameter) => [
        checker.getTypeAtLocation(parameter.name),
        parameter,
      ]),
    ),
    candidates: new Map(),
    priority: 0,
    contravariant: false,
    mentions: new Map(),
    recorded: 0,
  };
}

/**
 * What `parameter` is inferred from, at the best priority: the covariant
 * candidates, or, with none, the contravariant ones.
 */
function bestCandidates(
  inference: Inference,
  parameter: ts.TypeParameterDeclaration,
): Source[] | undefined {
  const found = inference.candidates.get(parameter);
  const candidates = found?.covariant.length
    ? found.covariant
    : found?.contravariant;
  return candidates?.length ? candidates : undefined;
}

/** Records `candidate` as one for `parameter` at the current priority. */
function addCandidate(
  inference: Inference,
  parameter: ts.TypeParameterDeclaration,
  candidate: Source,
): void {
  let found = inference.candidates.get(parameter);
  if (!found || inference.priority < found.priority) {
    found = { priority: inference.priority, covariant: [], contravariant: [] };
    inference.candidates.set(parameter, found);
  } else if (inference.priority > found.priority) {
    return;
  }
  (inference.contravariant ? found.contravariant : found.covariant).push(
    candidate,
  );
  inference.recorded++;
}

/** What `read` does with `flag` added to the priority. */
function atPriority(inference: Inference, flag: number, read: () => void) {
  const outer = inference.priority;
  inference.priority |= flag;
  try {
    read();
  } finally {
    inference.priority = outer;
  }
}

/** What `read` does in the opposite variance. */
function inverted(inference: Inference, read: () => void) {
  inference.contravariant = !inference.contravariant;
  try {
    read();
  } finally {
    inference.contravariant = !inference.contravariant;
  }
}

/**
 * Infers what the arguments `passed` to the function `declaration` supply its
 * type parameters, as the checker does: the receiver against the `this`
 * parameter, each argument against the type of the parameter at its position,
 * a spread of a tuple slot by slot and any other spread against every
 * parameter after it, and the arguments a rest parameter collects as a tuple
 * against its type.
 */
function inferFromArguments(
  inference: Inference,
  declaration: ts.SignatureDeclaration,
  passed: readonly ts.Expression[],
  receiver: ts.Expression | undefined,
): void {
  const { checker, reading } = inference;
  const signature = checker.getSignatureFromDeclaration(declaration);
  const thisParameter = signature?.thisParameter;
  if (thisParameter && receiver) {
    inferFrom(
      inference,
      valueSource(receiver, checker, reading),
      checker.getTypeOfSymbol(thisParameter),
    );
  }
  // The arguments by the position they reach, up to the first spread whose
  // length is not known, which reaches every position after it, and the
  // arguments after that spread, which a rest parameter collects.
  const slots: Source[] = [];
  const trailing: Source[] = [];
  let open: Source | undefined;
  for (const argument of passed) {
    const reached = open ? trailing : slots;
    if (!ts.isSpreadElement(argument)) {
      reached.push(valueSource(argument, checker, reading));
      continue;
    }
    const spread = valueSource(argument.expression, checker, reading);
    const type = checker.getTypeAtLocation(argument.expression);
    const tuple = checker.isTupleType(type)
      ? (type as ts.TypeReference).target as ts.TupleType
      : undefined;
    if (tuple && !tuple.hasRestElement) {
      for (let slot = 0; slot < tuple.fixedLength; slot++) {
        reached.push(spread.element(slot));
      }
    } else if (open) {
      // A second spread of unknown length leaves where the ones after it
      // land unknown too.
      open = unionSource([open, ...trailing.splice(0), spread.element()]);
    } else {
      open = spread.element();
    }
  }
  const parameters = signature?.parameters ?? [];
  const last = declaration.parameters.at(-1);
  const rest = last?.dotDotDotToken ? parameters.length - 1 : undefined;
  const positional = rest ?? parameters.length;
  for (let index = 0; index < positional; index++) {
    const source = slots[index] ?? (index >= slots.length ? open : undefined);
    if (!source) continue;
    inferFrom(inference, source, checker.getTypeOfSymbol(parameters[index]!));
  }
  if (rest !== undefined) {
    inferFrom(
      inference,
      tupleSource(slots.slice(rest), open, trailing),
      checker.getTypeOfSymbol(parameters[rest]!),
    );
  }
}

/**
 * Infers what `source` supplies the type parameters `target` names, as the
 * checker's `inferFromTypes()` does: a type parameter takes the source whole;
 * `NoInfer<T>` supplies nothing, and another substitution type is read as its
 * type variable; a union's and an intersection's members are read as
 * `inferToMembers()` reads them; a conditional type's branches are each read;
 * a homomorphic mapped type is read backwards; an array, a tuple, an instance
 * of a generic declaration the source instantiates too, and any other object
 * type by its members, signatures and index signatures, as
 * `inferFromObjectType()` reads them.
 */
function inferFrom(inference: Inference, source: Source, target: ts.Type) {
  if (!mentionsTargets(inference, target)) return;
  // The inferences of calls read inside one another share one depth.
  const { reading } = inference;
  if (reading.inferenceDepth > MAX_INFERENCE_DEPTH) return;
  reading.inferenceDepth++;
  try {
    inferFromType(inference, source, target);
  } finally {
    reading.inferenceDepth--;
  }
}

/**
 * Helper for `inferFrom()`, which reads `target` once it mentions a type
 * parameter being inferred.
 */
function inferFromType(inference: Inference, source: Source, target: ts.Type) {
  const { checker } = inference;
  if (isNoInfer(target)) return;
  const parameter = inference.targets.get(target);
  if (parameter) {
    addCandidate(inference, parameter, source);
    return;
  }
  // Another substitution type is read as the type variable it stands for.
  if ((target.flags & ts.TypeFlags.Substitution) !== 0) {
    inferFrom(inference, source, (target as ts.SubstitutionType).baseType);
    return;
  }
  if (target.isUnion() || target.isIntersection()) {
    inferToMembers(inference, source, target.types, target.isUnion());
    return;
  }
  if ((target.flags & ts.TypeFlags.Conditional) !== 0) {
    const root = (target as ts.ConditionalType).root.node;
    atPriority(
      inference,
      inference.contravariant ? InferencePriority.ContravariantConditional : 0,
      () =>
        inferToMembers(inference, source, [
          checker.getTypeFromTypeNode(root.trueType),
          checker.getTypeFromTypeNode(root.falseType),
        ], true),
    );
    return;
  }
  if ((target.flags & ts.TypeFlags.Index) !== 0) {
    // `keyof T` infers `T` from an object of the source's keys, which holds
    // no `unknown`.
    const keyed = inference.targets.get((target as ts.IndexType).type);
    if (keyed) {
      atPriority(
        inference,
        InferencePriority.LiteralKeyof,
        () => addCandidate(inference, keyed, declaredSource),
      );
    }
    return;
  }
  if ((target.flags & ts.TypeFlags.TemplateLiteral) !== 0) {
    // A template literal infers strings.
    for (const type of (target as ts.TemplateLiteralType).types) {
      const named = inference.targets.get(type);
      if (named) addCandidate(inference, named, declaredSource);
    }
    return;
  }
  if ((target.flags & ts.TypeFlags.Object) === 0) return;
  if (
    ((target as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped) !== 0 &&
    inferToMappedType(inference, source, target)
  ) {
    return;
  }
  inferFromObjectType(inference, source, target as ts.ObjectType);
}

/**
 * Helper for `inferFromType()`, which reads the members of a union or an
 * intersection, as the checker's `inferToMultipleTypes()` does. A union member
 * the source closely matches, as an array matches `U[]`, takes it, and a type
 * parameter alone among the members takes the whole source at a lower
 * priority. Otherwise each other member the source could be is read, and a
 * single type parameter among the members takes the source at the current
 * priority where none of them took it, and at the lower priority where one
 * did or where there are several. An intersection's members are each read, and
 * a single type parameter among them takes the source at the lower priority.
 */
function inferToMembers(
  inference: Inference,
  source: Source,
  members: readonly ts.Type[],
  union: boolean,
) {
  const naked = members.filter((member) => inference.targets.has(member));
  const others = members.filter((member) => !inference.targets.has(member));
  const nakedAt = (priority: number) =>
    atPriority(inference, priority, () => {
      for (const member of naked) {
        addCandidate(inference, inference.targets.get(member)!, source);
      }
    });
  if (!union) {
    for (const member of others) inferFrom(inference, source, member);
    if (naked.length === 1) nakedAt(InferencePriority.NakedTypeVariable);
    return;
  }
  const type = source.type();
  const close = type && others.find((member) => closelyMatches(type, member));
  if (close) {
    inferFrom(inference, source, close);
    nakedAt(InferencePriority.NakedTypeVariable);
    return;
  }
  const before = inference.recorded;
  for (const member of others) {
    if (couldHold(inference.checker, source, member)) {
      inferFrom(inference, source, member);
    }
  }
  if (naked.length === 0) return;
  nakedAt(
    naked.length === 1 && inference.recorded === before
      ? 0
      : InferencePriority.NakedTypeVariable,
  );
}

/**
 * Whether the type `source` closely matches the union member `member`, as the
 * checker's `isTypeCloselyMatchedBy()` judges it: object types of one symbol,
 * or instances of one alias.
 */
function closelyMatches(source: ts.Type, member: ts.Type): boolean {
  return ((source.flags & member.flags & ts.TypeFlags.Object) !== 0 &&
    !!source.symbol && source.symbol === member.symbol) ||
    (!!source.aliasSymbol && !!source.aliasTypeArguments &&
      source.aliasSymbol === member.aliasSymbol);
}

/**
 * Whether a value `source` describes could be of the union member `member`,
 * judged by kind: an array or a tuple, a function, or another object.
 */
function couldHold(
  checker: ts.TypeChecker,
  source: Source,
  member: ts.Type,
): boolean {
  const type = source.type();
  if (!type) return true;
  const kinds = type.isUnion() ? type.types : [type];
  const arrayLike = (candidate: ts.Type) =>
    checker.isArrayType(candidate) || checker.isTupleType(candidate);
  if (arrayLike(member)) return kinds.some(arrayLike);
  if (member.getCallSignatures().length > 0) {
    return kinds.some((kind) => kind.getCallSignatures().length > 0);
  }
  return kinds.some((kind) =>
    (kind.flags & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive)) !== 0
  );
}

/**
 * Helper for `inferFromType()`, which reads a mapped type the checker infers
 * to: one whose keys are `keyof T` infers `T` from the source read backwards,
 * as `reverseMappedSource()` reads it; one whose keys are a type parameter
 * infers that parameter from the source's keys, which hold no `unknown`, and
 * its template from any of the source's parts. `false` for one written with
 * an `as` clause, which the checker reads as any other object type.
 */
function inferToMappedType(
  inference: Inference,
  source: Source,
  target: ts.Type,
): boolean {
  const { checker } = inference;
  const declaration = target.symbol?.declarations?.find(ts.isMappedTypeNode);
  if (!declaration || declaration.nameType) return false;
  // The mapped type's nodes name the type parameters of the alias that
  // writes it, which stand for the alias's arguments here.
  const alias = target.aliasSymbol?.declarations?.find(
    ts.isTypeAliasDeclaration,
  );
  const typeOf = (node: ts.TypeNode): ts.Type | undefined => {
    if (ts.isTypeReferenceNode(node)) {
      const parameter = typeParameterFor(node, checker);
      const index = parameter && alias?.typeParameters?.indexOf(parameter);
      if (index !== undefined && index >= 0) {
        return target.aliasTypeArguments?.[index];
      }
    }
    return alias ? undefined : checker.getTypeFromTypeNode(node);
  };
  const constraint = declaration.typeParameter.constraint;
  if (
    constraint && ts.isTypeOperatorNode(constraint) &&
    constraint.operator === ts.SyntaxKind.KeyOfKeyword
  ) {
    const object = typeOf(constraint.type);
    const reversed = declaration.type &&
      reverseMappedSource(inference, source, declaration, constraint.type);
    if (object && reversed) {
      atPriority(
        inference,
        InferencePriority.HomomorphicMappedType,
        () => inferFrom(inference, reversed, object),
      );
    }
    return true;
  }
  const keys = constraint && typeOf(constraint);
  const keyed = keys && inference.targets.get(keys);
  if (keyed) {
    atPriority(
      inference,
      InferencePriority.MappedTypeConstraint,
      () => addCandidate(inference, keyed, declaredSource),
    );
  }
  const template = declaration.type && typeOf(declaration.type);
  const values = source.anyPart();
  if (template && values) inferFrom(inference, values, template);
  return true;
}

/**
 * The value `T` stands for where `source` is of the homomorphic mapped type
 * `declaration`, whose keys are `keyof T` written `object`, as the checker's
 * `inferReverseMappedType()` reads it: each of the source's members is read
 * against the template, and the part of `T` under that key is what the
 * template's `T[K]` takes from it. A template that names no `T[K]` gives `T`
 * nothing.
 */
function reverseMappedSource(
  inference: Inference,
  source: Source,
  declaration: ts.MappedTypeNode,
  object: ts.TypeNode,
): Source | undefined {
  const { checker, reading } = inference;
  const key = declaration.typeParameter;
  const isObject = (node: ts.TypeNode) =>
    ts.isTypeReferenceNode(node) && ts.isTypeReferenceNode(object)
      ? typeParameterFor(node, checker) === typeParameterFor(object, checker)
      : checker.getTypeFromTypeNode(node) ===
        checker.getTypeFromTypeNode(object);
  const isAccess = (node: ts.Node): node is ts.IndexedAccessTypeNode =>
    ts.isIndexedAccessTypeNode(node) && isObject(node.objectType) &&
    ts.isTypeReferenceNode(node.indexType) &&
    typeParameterFor(node.indexType, checker) === key;
  const template = declaration.type!;
  console.error(
    ts.SyntaxKind[template.kind],
    !!ts.forEachChild(template, function f(n): boolean | undefined {
      return isAccess(n) || ts.forEachChild(n, f);
    }),
  );
  const find = (node: ts.Node): ts.IndexedAccessTypeNode | undefined =>
    isAccess(node) ? node : ts.forEachChild(node, find);
  const access = find(template);
  if (!access) return undefined;
  const target = checker.getTypeFromTypeNode(template);
  const accessType = checker.getTypeFromTypeNode(access);
  const read = (part: Source): Source => {
    const nested: Inference = {
      ...newInference([], checker, reading),
      targets: new Map([[accessType, key]]),
    };
    inferFrom(nested, part, target);
    const found = bestCandidates(nested, key);
    return found ? unionSource(found) : opaqueSource(() => false);
  };
  const members = new Map<string, Source>();
  const member = (name: string) => {
    let known = members.get(name);
    if (!known) members.set(name, known = read(source.member(name)));
    return known;
  };
  const any = () => {
    const part = source.anyPart();
    return part ? read(part) : declaredSource;
  };
  const keys = source.keys?.();
  return {
    ...opaqueSource(() => {
      if (!keys) {
        // A source that writes out no keys may hold any part under any key.
        const parts = any().positions();
        const each: [PositionKey, DeclaredPositions][] = [
          [UNNAMED_POSITIONS, parts],
          [ELEMENT_POSITIONS, parts],
        ];
        return new Map(each);
      }
      const parts = new Map<PositionKey, DeclaredPositions>(
        keys.map((name) => [name, member(name).positions()]),
      );
      return wholly(parts) ? true : parts;
    }),
    member,
  };
}

/**
 * Helper for `inferFromType()`, which reads an object type: an array's
 * elements; a tuple's slots, each from the source's slot, a rest slot from any
 * element; the type arguments of an instance of a class or an interface the
 * source instantiates too; and otherwise each property, inherited ones
 * included, from the source's part under its name, each call signature's
 * return type from what the source returns and its parameters, in the
 * opposite variance, from those the source writes, each construct signature
 * from what the source constructs, and each index signature from any of the
 * source's parts.
 */
function inferFromObjectType(
  inference: Inference,
  source: Source,
  target: ts.ObjectType,
) {
  const { checker } = inference;
  if (checker.isTupleType(target)) {
    // Slots before the first variable one are read from the start, and slots
    // after it from the end.
    const flags = ((target as ts.TypeReference).target as ts.TupleType)
      .elementFlags;
    const variable = flags.findIndex((flag) =>
      (flag & ts.ElementFlags.Variable) !== 0
    );
    checker.getTypeArguments(target as ts.TypeReference).forEach(
      (element, index) => {
        inferFrom(
          inference,
          variable < 0 || index < variable
            ? source.element(index)
            : index === variable ||
                (flags[index]! & ts.ElementFlags.Variable) !== 0
            ? source.element()
            : elementFromEnd(source, flags.length - 1 - index),
          element,
        );
      },
    );
    return;
  }
  // What an array or an iterable holds is its elements, which the checker
  // reaches through the iterator protocol.
  if (checker.isArrayType(target) || isIterable(target)) {
    const [element] = checker.getTypeArguments(target as ts.TypeReference);
    // A value known to hold no part supplies its elements no inference.
    if (element && source.anyPart() !== undefined) {
      inferFrom(inference, source.element(), element);
    }
    return;
  }
  if ((target.objectFlags & ts.ObjectFlags.Reference) !== 0) {
    const declaration = target.symbol?.declarations?.find((
      candidate,
    ): candidate is ts.ClassLikeDeclaration | ts.InterfaceDeclaration =>
      ts.isClassLike(candidate) || ts.isInterfaceDeclaration(candidate)
    );
    const instance = declaration && source.instance(declaration);
    if (declaration && instance) {
      const argumentTypes = checker.getTypeArguments(
        target as ts.TypeReference,
      );
      declaration.typeParameters?.forEach((parameter, index) => {
        const argument = instance.get(parameter);
        const argumentType = argumentTypes[index];
        if (argument && argumentType) {
          inferFrom(
            inference,
            argumentSource(argument, checker, inference.reading),
            argumentType,
          );
        }
      });
      return;
    }
  }
  // A library's object type is read by its type arguments and its signatures,
  // as above and below, and by the members the source writes out, and not by
  // its other members, whose types the program never needs resolved.
  const members = declaredInLibrary(target)
    ? (source.keys?.() ?? []).flatMap((key) => target.getProperty(key) ?? [])
    : checker.getPropertiesOfType(target);
  for (const property of members) {
    inferFrom(
      inference,
      source.member(property.name),
      withoutMissing(checker.getTypeOfSymbol(property), property),
    );
  }
  for (const signature of target.getCallSignatures()) {
    inferFrom(
      inference,
      source.returns(),
      checker.getReturnTypeOfSignature(signature),
    );
    signature.parameters.forEach((parameter, index) => {
      const written = source.parameter(index);
      if (!written) return;
      inverted(
        inference,
        () => inferFrom(inference, written, checker.getTypeOfSymbol(parameter)),
      );
    });
  }
  for (const signature of target.getConstructSignatures()) {
    inferFrom(
      inference,
      source.constructs(),
      checker.getReturnTypeOfSignature(signature),
    );
  }
  for (
    const index of declaredInLibrary(target)
      ? []
      : checker.getIndexInfosOfType(target)
  ) {
    const values = source.anyPart();
    if (values) inferFrom(inference, values, index.type);
  }
}

/**
 * `type` without the `undefined` an optional `property` adds to it, as the
 * checker reads an optional property's type for inference.
 */
function withoutMissing(type: ts.Type, property: ts.Symbol): ts.Type {
  if ((property.flags & ts.SymbolFlags.Optional) === 0 || !type.isUnion()) {
    return type;
  }
  const present = type.types.filter((member) =>
    (member.flags & ts.TypeFlags.Undefined) === 0
  );
  return present.length === 1 ? present[0]! : type;
}

/** Whether every declaration of `type` is in a declaration file. */
function declaredInLibrary(type: ts.Type): boolean {
  const declarations = type.symbol?.declarations;
  return !!declarations?.length &&
    declarations.every((declaration) =>
      declaration.getSourceFile().isDeclarationFile
    );
}

/** The library's types of a value that yields its elements. */
const ITERABLE_NAMES = new Set([
  "Iterable",
  "IterableIterator",
  "AsyncIterable",
  "ArrayLike",
]);

/** Whether `type` instantiates one of the library's iterable types. */
function isIterable(type: ts.ObjectType): boolean {
  return (type.objectFlags & ts.ObjectFlags.Reference) !== 0 &&
    !!type.symbol && ITERABLE_NAMES.has(type.symbol.name) &&
    !!type.symbol.declarations?.every((declaration) =>
      declaration.getSourceFile().isDeclarationFile
    );
}

/** Whether `type` is `NoInfer<T>`, which supplies no inference. */
function isNoInfer(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Substitution) !== 0 &&
    ((type as ts.SubstitutionType).constraint.flags & ts.TypeFlags.Unknown) !==
      0;
}

/**
 * Whether `type` names, anywhere in it, a type parameter `inference` infers.
 */
function mentionsTargets(inference: Inference, type: ts.Type): boolean {
  const known = inference.mentions.get(type);
  if (known !== undefined) return known;
  // A type that holds itself mentions what its other parts do.
  inference.mentions.set(type, false);
  const { checker } = inference;
  const any = (types: readonly ts.Type[] | undefined) =>
    !!types?.some((part) => mentionsTargets(inference, part));
  let mentions = inference.targets.has(type) || any(type.aliasTypeArguments);
  if (!mentions) {
    if (type.isUnionOrIntersection()) {
      mentions = any(type.types);
    } else if ((type.flags & ts.TypeFlags.Conditional) !== 0) {
      const conditional = type as ts.ConditionalType;
      mentions = any([
        conditional.checkType,
        conditional.extendsType,
        checker.getTypeFromTypeNode(conditional.root.node.trueType),
        checker.getTypeFromTypeNode(conditional.root.node.falseType),
      ]);
    } else if ((type.flags & ts.TypeFlags.Index) !== 0) {
      mentions = any([(type as ts.IndexType).type]);
    } else if ((type.flags & ts.TypeFlags.IndexedAccess) !== 0) {
      const access = type as ts.IndexedAccessType;
      mentions = any([access.objectType, access.indexType]);
    } else if ((type.flags & ts.TypeFlags.Substitution) !== 0) {
      mentions = any([(type as ts.SubstitutionType).baseType]);
    } else if ((type.flags & ts.TypeFlags.TemplateLiteral) !== 0) {
      mentions = any((type as ts.TemplateLiteralType).types);
    } else if ((type.flags & ts.TypeFlags.Object) !== 0) {
      const object = type as ts.ObjectType;
      if ((object.objectFlags & ts.ObjectFlags.Reference) !== 0) {
        mentions = any(checker.getTypeArguments(object as ts.TypeReference));
      } else if ((object.objectFlags & ts.ObjectFlags.Mapped) !== 0) {
        const declaration = object.symbol?.declarations?.find(
          ts.isMappedTypeNode,
        );
        mentions = !!declaration &&
          typeParametersIn(declaration, checker).some((named) =>
            !!named && [...inference.targets.values()].includes(named)
          );
      } else {
        // A library's object type names an inferred parameter only through its
        // type arguments, read above, or its signatures; reading its members
        // would instantiate types the program never needed.
        const members = declaredInLibrary(object)
          ? []
          : checker.getPropertiesOfType(object).map((property) =>
            checker.getTypeOfSymbol(property)
          );
        mentions = any(members) ||
          [...object.getCallSignatures(), ...object.getConstructSignatures()]
            .some((signature) =>
              any([
                checker.getReturnTypeOfSignature(signature),
                ...signature.parameters.map((parameter) =>
                  checker.getTypeOfSymbol(parameter)
                ),
              ])
            ) ||
          (!declaredInLibrary(object) &&
            any(
              checker.getIndexInfosOfType(object).map((index) => index.type),
            ));
      }
    }
  }
  inference.mentions.set(type, mentions);
  return mentions;
}

//
// Sources
//

/**
 * A value inference reads against a parameter's type, by its parts, as the
 * checker reads the value's type: each part followed to where it was written
 * where the value is written out, and read from the value's provenance
 * otherwise.
 */
interface Source {
  /** The provenance of the whole value. */
  positions(): DeclaredPositions;

  /** The value's static type, where it has one. */
  type(): ts.Type | undefined;

  /** The part under `key`. */
  member(key: string): Source;

  /** The element in slot `index`, or any element. */
  element(index?: number): Source;

  /**
   * The element `index` slots before the last, where the value knows the slots
   * it ends with; `elementFromEnd()` reads any element of one that does not.
   */
  elementFromEnd?(index: number): Source;

  /**
   * Any part: a member under any key, or any element, or `undefined` for a
   * value known to hold none, which supplies no inference.
   */
  anyPart(): Source | undefined;

  /**
   * The keys of the members the value writes out, as an object literal or a
   * type literal writes them, where it writes them out.
   */
  keys?(): readonly string[];

  /** What the value returns when called. */
  returns(): Source;

  /** What the value makes when constructed. */
  constructs(): Source;

  /** The type written for parameter `index` of a function the value is. */
  parameter(index: number): Source | undefined;

  /**
   * What the type parameters of `owner` stand for in the value, where it is an
   * instance of `owner` or of a declaration below it.
   */
  instance(
    owner: ts.ClassLikeDeclaration | ts.InterfaceDeclaration,
  ): Substitution | undefined;

  /**
   * The type the value is written as, where it is a type written out as a
   * field's or a type argument, whose `unknown` declares a reference.
   */
  readonly written?: {
    readonly node: ts.TypeNode;
    readonly substitution: Substitution;
  };
}

/** A value whose every position is declared, as a key or a string is. */
const declaredSource: Source = opaqueSource(() => true);

/**
 * A source known only by its provenance, read by `read` once when first asked
 * for: a part is the part of that provenance, and a function's result declares
 * nothing.
 */
function opaqueSource(
  read: () => DeclaredPositions,
  type?: () => ts.Type | undefined,
): Source {
  let known: DeclaredPositions | undefined;
  const positions = () => known ??= read();
  return {
    positions,
    type: () => type?.(),
    member: (key) => opaqueSource(() => below(positions(), key)),
    element: () => opaqueSource(() => below(positions(), ELEMENT_POSITIONS)),
    anyPart: () => opaqueSource(() => anyPart(positions())),
    returns: () => opaqueSource(() => false),
    constructs: () => opaqueSource(() => false),
    parameter: () => undefined,
    instance: () => undefined,
  };
}

/**
 * A source known by its provenance and its static `type`, read as
 * `opaqueSource()` reads one, except that a part takes the type of the member
 * under its key, the elements of an iterable that is no array, which its
 * provenance does not hold, are read from the type its iteration yields, as
 * inferred, and what a function returns is read from the declaration of its
 * type's one call signature, as `functionSource()` reads it with nothing bound,
 * so that a return type written there declares what it writes.
 */
function typedSource(
  read: () => DeclaredPositions,
  type: () => ts.Type | undefined,
  checker: ts.TypeChecker,
  reading: TypeReading,
): Source {
  const base = opaqueSource(read, type);
  return {
    ...base,
    element: (index) => {
      const value = type();
      const element = value && !checker.isArrayType(value) &&
          !checker.isTupleType(value)
        ? iteratedType(value, checker)
        : undefined;
      return element
        ? opaqueSource(
          () => readType(element, checker, "inferred", reading),
          () => element,
        )
        : base.element(index);
    },
    member: (key) =>
      typedSource(
        () => below(base.positions(), key),
        () => {
          const property = type()?.getProperty(key);
          return property && checker.getTypeOfSymbol(property);
        },
        checker,
        reading,
      ),
    returns: () => {
      const signatures = type()?.getCallSignatures() ?? [];
      const declaration = signatures.length === 1
        ? signatures[0]!.declaration
        : undefined;
      return declaration && !ts.isJSDocSignature(declaration)
        ? functionSource(declaration, new Map(), checker, reading).returns()
        : base.returns();
    },
  };
}

/** `source`, with its provenance read by `positions` instead. */
function withPositions(
  source: Source,
  positions: () => DeclaredPositions,
): Source {
  return { ...source, positions };
}

/**
 * A value that is any one of `sources`, each read as an alternative. With no
 * source it has no parts, so each is declared.
 */
function unionSource(sources: readonly Source[]): Source {
  if (sources.length === 0) return declaredSource;
  if (sources.length === 1) return sources[0]!;
  const each = (read: (source: Source) => Source) =>
    unionSource(sources.map(read));
  return {
    ...opaqueSource(() =>
      sources.map((source) => source.positions()).reduce(alternatives, true)
    ),
    member: (key) => each((source) => source.member(key)),
    element: (index) => each((source) => source.element(index)),
    elementFromEnd: (index) => each((source) => elementFromEnd(source, index)),
    keys:
      () => [...new Set(sources.flatMap((source) => source.keys?.() ?? []))],
    anyPart: () => {
      const parts = sources.flatMap((source) => source.anyPart() ?? []);
      return parts.length > 0 ? unionSource(parts) : undefined;
    },
    returns: () => each((source) => source.returns()),
    constructs: () => each((source) => source.constructs()),
  };
}

/**
 * The arguments a rest parameter collects, as a tuple of the `leading` slots,
 * then, where a spread of unknown length is passed, any number of `open`
 * elements, and the `trailing` slots after it.
 */
function tupleSource(
  leading: readonly Source[],
  open: Source | undefined,
  trailing: readonly Source[],
): Source {
  const all = [...leading, ...(open ? [open] : []), ...trailing];
  const any = () => unionSource(all);
  const base = opaqueSource(() =>
    new Map([[ELEMENT_POSITIONS, any().positions()]])
  );
  return {
    ...base,
    element: (index) =>
      index === undefined || (open && index >= leading.length)
        ? any()
        : leading[index] ?? declaredSource,
    elementFromEnd: (index) =>
      open
        ? index < trailing.length ? trailing.at(-1 - index)! : any()
        : leading.at(-1 - index) ?? declaredSource,
    // No argument collected supplies no element.
    anyPart: () => all.length > 0 ? any() : undefined,
  };
}

/**
 * The element `index` slots before the last of the value `source` describes,
 * or any of its elements where it does not know the slots it ends with.
 */
function elementFromEnd(source: Source, index: number): Source {
  return source.elementFromEnd?.(index) ?? source.element();
}

/** The source a type argument stands for. */
function argumentSource(
  argument: TypeArgument,
  checker: ts.TypeChecker,
  reading: TypeReading,
): Source {
  return argument.kind === "written"
    ? nodeSource(argument.node, argument.substitution, checker, reading, true)
    : opaqueSource(() => argument.positions);
}

/**
 * The value `expression` evaluates to, read under `substitution`, by its
 * parts: an object literal's members and an array literal's elements by slot,
 * a binding's annotation or its initializer where nothing reassigns it, a
 * member of a value it reads, a cast's type, a function's result and written
 * parameters, the arms of a conditional, and the type parameters an instance
 * a construction or a call makes takes. Its provenance is always
 * `typeProvenance()`'s.
 */
function valueSource(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  reading: TypeReading,
  substitution: Substitution = reading.substitution,
): Source {
  const under = <T>(read: () => T) =>
    withSubstitution(reading, substitution, read);
  const base = typedSource(
    () => under(() => typeProvenance(expression, checker, reading)),
    () => checker.getTypeAtLocation(expression),
    checker,
    reading,
  );
  const shaped = (source: Source) =>
    withPositions({ ...source, type: base.type }, base.positions);
  const follow = (inner: ts.Expression) =>
    valueSource(inner, checker, reading, substitution);
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return shaped(follow(expression.expression));
  }
  if (
    ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
  ) {
    return shaped(
      ts.isConstTypeReference(expression.type)
        ? follow(expression.expression)
        : nodeSource(expression.type, substitution, checker, reading),
    );
  }
  if (ts.isIdentifier(expression)) {
    const binding = bindingOf(valueSymbol(expression, checker), checker);
    const declaration = binding?.declaration;
    if (!binding || !declaration) return base;
    if (
      ts.isFunctionDeclaration(declaration) ||
      ts.isFunctionExpression(declaration) ||
      ts.isArrowFunction(declaration)
    ) {
      return shaped(
        functionSource(declaration, substitution, checker, reading),
      );
    }
    if (ts.isClassDeclaration(declaration)) {
      return {
        ...base,
        constructs: () =>
          opaqueSource(() =>
            classInstancePositions(declaration, checker, reading)
          ),
      };
    }
    if (
      (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) &&
      declaration.type
    ) {
      return shaped(
        nodeSource(declaration.type, substitution, checker, reading),
      );
    }
    if (
      ts.isVariableDeclaration(declaration) && declaration.initializer &&
      !reading.tracing.has(declaration)
    ) {
      if (!reassigned(binding.resolved, checker)) {
        return shaped(follow(declaration.initializer));
      }
      // A reassigned binding's elements are what its type declares of them,
      // or what its initializer's do, as `symbolProvenance()` reads it.
      const initial = follow(declaration.initializer);
      return {
        ...base,
        element: (index) => {
          const typed = base.element(index);
          const first = initial.element(index);
          return opaqueSource(
            () => eitherDeclares(typed.positions(), first.positions()),
            typed.type,
          );
        },
      };
    }
    return base;
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const parts = literalMembers(expression, checker, reading, substitution);
    return {
      ...base,
      member: (key) => {
        const part = parts.named.get(key);
        return part && !parts.unnamed ? part : base.member(key);
      },
      keys: () => [...parts.named.keys()],
      anyPart: () =>
        parts.unnamed
          ? base.anyPart()
          : parts.named.size > 0
          ? unionSource([...parts.named.values()])
          : undefined,
    };
  }
  if (ts.isArrayLiteralExpression(expression)) {
    const elements = expression.elements;
    const spread = elements.findIndex(ts.isSpreadElement);
    const plain = (spread < 0 ? elements : elements.slice(0, spread))
      .map((element) =>
        ts.isOmittedExpression(element) ? declaredSource : follow(element)
      );
    const every = () =>
      unionSource(
        elements.map((element) =>
          ts.isSpreadElement(element)
            ? follow(element.expression).element()
            : ts.isOmittedExpression(element)
            ? declaredSource
            : follow(element)
        ),
      );
    const after = elements.slice(
      elements.findLastIndex(ts.isSpreadElement) + 1,
    );
    return {
      ...base,
      element: (index) =>
        index !== undefined && index < plain.length ? plain[index]! : every(),
      elementFromEnd: (index) => {
        const element = index < after.length ? after.at(-1 - index) : undefined;
        return !element
          ? every()
          : ts.isOmittedExpression(element)
          ? declaredSource
          : follow(element);
      },
      // An array's elements, even none, are what its number index holds.
      anyPart: every,
    };
  }
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    return shaped(functionSource(expression, substitution, checker, reading));
  }
  if (ts.isConditionalExpression(expression)) {
    return shaped(
      unionSource([follow(expression.whenTrue), follow(expression.whenFalse)]),
    );
  }
  if (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) {
    const keys = accessedKeys(expression, checker);
    if (keys?.length !== 1) return base;
    return shaped(follow(expression.expression).member(keys[0]!));
  }
  if (ts.isNewExpression(expression)) {
    const constructed = definitionOf(expression.expression, checker);
    if (
      constructed &&
      (ts.isClassDeclaration(constructed) || ts.isClassExpression(constructed))
    ) {
      const owners = () =>
        heritageSubstitutions(
          [constructed],
          under(() =>
            constructionSubstitution(constructed, expression, checker, reading)
          ),
          checker,
        );
      const symbol = checker.getTypeAtLocation(expression).symbol;
      return {
        ...base,
        element: (index) =>
          (symbol && iteratedSource(symbol, owners(), checker, reading)) ??
            base.element(index),
        instance: (owner) => owners().get(owner) as Substitution | undefined,
      };
    }
    return shaped(
      resultSource(expression, base, checker, reading, substitution),
    );
  }
  if (ts.isCallExpression(expression)) {
    return shaped(
      resultSource(expression, base, checker, reading, substitution),
    );
  }
  return base;
}

/**
 * The members an object literal writes, by name, each read as `valueSource()`
 * reads its value, and whether it also holds parts under names it does not
 * write, through a spread or a computed key, which leave its parts to its
 * provenance.
 */
function literalMembers(
  literal: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
  reading: TypeReading,
  substitution: Substitution,
): { named: Map<string, Source>; unnamed: boolean } {
  const named = new Map<string, Source>();
  let unnamed = false;
  for (const property of literal.properties) {
    const key = property.name && !ts.isSpreadAssignment(property)
      ? getPropertyNameText(property.name, checker)
      : undefined;
    if (key === undefined) {
      unnamed = true;
      continue;
    }
    if (ts.isPropertyAssignment(property)) {
      named.set(
        key,
        valueSource(property.initializer, checker, reading, substitution),
      );
    } else if (ts.isShorthandPropertyAssignment(property)) {
      named.set(
        key,
        valueSource(property.name, checker, reading, substitution),
      );
    } else if (ts.isMethodDeclaration(property)) {
      named.set(
        key,
        functionSource(property, substitution, checker, reading),
      );
    } else if (ts.isGetAccessorDeclaration(property)) {
      named.set(
        key,
        opaqueSource(() =>
          withSubstitution(
            reading,
            substitution,
            () => returnProvenance(property, checker, reading) ?? false,
          )
        ),
      );
    }
  }
  return { named, unnamed };
}

/**
 * A function `declaration` declares, read under `substitution`: what it
 * returns, as `returnProvenance()` reads it, and its written parameters.
 */
function functionSource(
  declaration: ts.SignatureDeclaration,
  substitution: Substitution,
  checker: ts.TypeChecker,
  reading: TypeReading,
): Source {
  const base = opaqueSource(() => true);
  return {
    ...base,
    returns: () =>
      declaration.type
        ? nodeSource(declaration.type, substitution, checker, reading)
        : opaqueSource(() =>
          withSubstitution(
            reading,
            substitution,
            () => returnProvenance(declaration, checker, reading) ?? false,
          )
        ),
    parameter: (index) => {
      const written = declaration.parameters.filter((parameter) =>
        !(ts.isIdentifier(parameter.name) && parameter.name.text === "this")
      )[index]?.type;
      return written && nodeSource(written, substitution, checker, reading);
    },
  };
}

/**
 * The result of `call`, a call or a construction, read through the return type
 * its signature's declaration writes, with the call's type parameters bound,
 * or, where that type is inferred, as any of what the declaration's body
 * returns, or as `base` otherwise.
 */
function resultSource(
  call: ts.CallExpression | ts.NewExpression,
  base: Source,
  checker: ts.TypeChecker,
  reading: TypeReading,
  substitution: Substitution,
): Source {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (!declaration || ts.isJSDocSignature(declaration)) return base;
  const bound = () =>
    withSubstitution(
      reading,
      substitution,
      () =>
        ts.isCallExpression(call)
          ? callSubstitution(declaration, call, checker, reading)
          : constructSubstitution(declaration, call, checker, reading),
    );
  if (declaration.type) {
    let known: Source | undefined;
    const written = () =>
      known ??= nodeSource(declaration.type!, bound(), checker, reading);
    return {
      ...base,
      member: (key) => written().member(key),
      element: (index) => written().element(index),
      elementFromEnd: (index) => elementFromEnd(written(), index),
      anyPart: () => written().anyPart(),
      keys: () => written().keys?.() ?? [],
      returns: () => written().returns(),
      constructs: () => written().constructs(),
      instance: (owner) => written().instance(owner),
    };
  }
  const body = "body" in declaration ? declaration.body : undefined;
  if (!body || reading.tracing.has(declaration)) return base;
  const returned = () =>
    unionSource(
      returnedExpressions(body).map((expression) =>
        valueSource(expression, checker, reading, bound())
      ),
    );
  return {
    ...base,
    member: (key) => returned().member(key),
    element: (index) => returned().element(index),
    elementFromEnd: (index) => elementFromEnd(returned(), index),
    anyPart: () => returned().anyPart(),
    keys: () => returned().keys?.() ?? [],
    returns: () => returned().returns(),
    constructs: () => returned().constructs(),
    parameter: (index) => returned().parameter(index),
    instance: (owner) => returned().instance(owner),
  };
}

/**
 * What the type parameters of the construct signature `declaration` stand
 * for in `construction`, as `inferFromArguments()` finds them.
 */
function constructSubstitution(
  declaration: ts.SignatureDeclaration,
  construction: ts.NewExpression,
  checker: ts.TypeChecker,
  reading: TypeReading,
): Substitution {
  const own = declaration.typeParameters ?? [];
  if (construction.typeArguments?.length) {
    return new Map([
      ...reading.substitution,
      ...bindTypeArguments(
        own,
        construction.typeArguments,
        reading.substitution,
      ),
    ]);
  }
  const inference = newInference(own, checker, reading);
  inferFromArguments(
    inference,
    declaration,
    construction.arguments ?? [],
    undefined,
  );
  return new Map([
    ...reading.substitution,
    ...inferredSubstitution(own, inference),
  ]);
}

/**
 * The positions an instance of the class `declaration` declares when its type
 * parameters take what nothing supplies them: their defaults or constraints.
 */
function classInstancePositions(
  declaration: ts.ClassDeclaration,
  checker: ts.TypeChecker,
  reading: TypeReading,
): DeclaredPositions {
  const own = declaration.typeParameters ?? [];
  const symbol = declaration.name &&
    checker.getSymbolAtLocation(declaration.name);
  return symbol
    ? declaredMembers(
      checker.getDeclaredTypeOfSymbol(symbol),
      heritageSubstitutions(
        [declaration],
        inferredSubstitution(own, newInference(own, checker, reading)),
        checker,
      ),
      checker,
      reading,
    )
    : false;
}

/**
 * The value of the written type `node`, read under `substitution`, by its
 * parts: a type literal's members, an array's or a tuple's elements, a
 * function type's result and parameters, the members and the instance of the
 * interface or the class a reference names, read through its declaration
 * with its type parameters bound, the value `typeof` names, and what a type
 * parameter stands for. Its provenance is always `readTypeNode()`'s.
 */
function nodeSource(
  node: ts.TypeNode,
  substitution: Substitution,
  checker: ts.TypeChecker,
  reading: TypeReading,
  inField = false,
): Source {
  const base: Source = {
    ...opaqueSource(
      () => readTypeNode(node, substitution, inField, checker, reading),
      () => checker.getTypeFromTypeNode(node),
    ),
    written: inField ? { node, substitution } : undefined,
  };
  const shaped = (source: Source) =>
    withPositions({ ...source, type: base.type }, base.positions);
  const follow = (inner: ts.TypeNode, bound = substitution, field = inField) =>
    nodeSource(inner, bound, checker, reading, field);
  if (ts.isParenthesizedTypeNode(node)) return shaped(follow(node.type));
  if (
    ts.isTypeOperatorNode(node) &&
    node.operator === ts.SyntaxKind.ReadonlyKeyword
  ) {
    return shaped(follow(node.type));
  }
  if (ts.isUnionTypeNode(node)) {
    return shaped(
      lazySource(() => unionSource(node.types.map((member) => follow(member)))),
    );
  }
  if (ts.isTypeLiteralNode(node)) {
    return {
      ...base,
      ...membersSource(node.members, substitution, base, checker, reading),
    };
  }
  if (ts.isFunctionTypeNode(node)) {
    return {
      ...base,
      ...functionSource(node, substitution, checker, reading),
      positions: base.positions,
      type: base.type,
    };
  }
  if (ts.isConstructorTypeNode(node)) {
    return { ...base, constructs: () => follow(node.type) };
  }
  if (ts.isArrayTypeNode(node)) {
    return {
      ...base,
      element: () => follow(node.elementType),
      anyPart: () => follow(node.elementType),
    };
  }
  if (ts.isTupleTypeNode(node)) {
    const every = () =>
      unionSource(
        node.elements.map((element) => follow(tupleElementType(element))),
      );
    const variable = (element: ts.TypeNode) =>
      ts.isRestTypeNode(element) ||
      (ts.isNamedTupleMember(element) && !!element.dotDotDotToken);
    const fixed = (element: ts.TypeNode | undefined) =>
      element && !variable(element)
        ? follow(tupleElementType(element))
        : every();
    const after = node.elements.slice(
      node.elements.findLastIndex(variable) + 1,
    );
    return {
      ...base,
      element: (index) =>
        fixed(index === undefined ? undefined : node.elements[index]),
      elementFromEnd: (index) =>
        fixed(index < after.length ? after.at(-1 - index) : undefined),
      anyPart: every,
    };
  }
  if (ts.isTypeQueryNode(node) && ts.isIdentifier(node.exprName)) {
    return shaped(valueSource(node.exprName, checker, reading));
  }
  if (!ts.isTypeReferenceNode(node)) return base;
  // A type parameter stands for its type argument, which carries a written
  // type's reading on into the call that passes it again.
  const parameter = typeParameterFor(node, checker);
  if (parameter) {
    const argument = substitution.get(parameter);
    return argument ? shaped(argumentSource(argument, checker, reading)) : base;
  }
  const args = node.typeArguments ?? [];
  const type = checker.getTypeFromTypeNode(node);
  const [first] = args;
  if (first && args.length === 1 && wrapsPayload(type, checker)) {
    return shaped(follow(first));
  }
  if (first && args.length === 1 && checker.isArrayType(type)) {
    return {
      ...base,
      element: () => follow(first),
      anyPart: () => follow(first),
    };
  }
  const declaration = genericDeclaration(node, checker);
  if (!declaration) return base;
  const bound = bindTypeArguments(
    declaration.typeParameters ?? [],
    args,
    substitution,
  );
  const symbol = checker.getSymbolAtLocation(node.typeName);
  const resolved = symbol && resolveAlias(symbol, checker);
  if (ts.isTypeAliasDeclaration(declaration)) {
    return readsStructurally(declaration.type, checker)
      ? shaped(follow(declaration.type, bound))
      : base;
  }
  const owners = heritageSubstitutions(
    (resolved?.declarations ?? []).filter((candidate) =>
      ts.isInterfaceDeclaration(candidate) ||
      ts.isClassDeclaration(candidate) ||
      ts.isClassExpression(candidate)
    ) as (ts.InterfaceDeclaration | ts.ClassLikeDeclaration)[],
    bound,
    checker,
  );
  return {
    ...base,
    element: (index) =>
      (resolved && iteratedSource(resolved, owners, checker, reading)) ??
        base.element(index),
    member: (key) => {
      const property = type.getProperty(key);
      const declared = property?.valueDeclaration ??
        property?.declarations?.[0];
      const owner = declared && memberOwner(declared);
      const ownerSubstitution = owner && owners.get(owner);
      if (!declared || !ownerSubstitution) return base.member(key);
      if (
        ts.isMethodDeclaration(declared) || ts.isMethodSignature(declared)
      ) {
        return functionSource(declared, ownerSubstitution, checker, reading);
      }
      const written = memberTypeNode(property);
      return written
        ? follow(written, ownerSubstitution, true)
        : base.member(key);
    },
    instance: (owner) => owners.get(owner) as Substitution | undefined,
  };
}

/**
 * Helper for `nodeSource()`, which reads the parts a written object type's
 * `members` declare: a property's or a method's under its name, and an index
 * signature's under any other name and as any part. Each part is read when it
 * is first asked for, since a type may hold itself.
 */
function membersSource(
  members: readonly ts.TypeElement[],
  substitution: Substitution,
  base: Source,
  checker: ts.TypeChecker,
  reading: TypeReading,
): Pick<Source, "member" | "anyPart" | "keys"> {
  const named = new Map<string, () => Source>();
  const indexed: (() => Source)[] = [];
  for (const member of members) {
    if (ts.isIndexSignatureDeclaration(member)) {
      indexed.push(() =>
        nodeSource(member.type, substitution, checker, reading, true)
      );
      continue;
    }
    const key = member.name && getPropertyNameText(member.name, checker);
    const type = ts.isPropertySignature(member) ? member.type : undefined;
    if (key === undefined) continue;
    if (ts.isMethodSignature(member)) {
      named.set(
        key,
        () => functionSource(member, substitution, checker, reading),
      );
    } else if (type) {
      named.set(
        key,
        () => nodeSource(type, substitution, checker, reading, true),
      );
    }
  }
  const index = () => unionSource(indexed.map((read) => read()));
  return {
    member: (key) =>
      named.get(key)?.() ??
        (indexed.length > 0 ? index() : base.member(key)),
    keys: () => [...named.keys()],
    anyPart: () => {
      const all = [...named.values(), ...indexed];
      return all.length > 0
        ? unionSource(all.map((read) => read()))
        : undefined;
    },
  };
}

/**
 * A source made by `make` only when one of its parts is first asked for, so a
 * type that holds itself is read only as deep as a read goes.
 */
function lazySource(make: () => Source): Source {
  let made: Source | undefined;
  const source = () => made ??= make();
  return {
    positions: () => source().positions(),
    type: () => source().type(),
    member: (key) => source().member(key),
    element: (index) => source().element(index),
    elementFromEnd: (index) => elementFromEnd(source(), index),
    anyPart: () => source().anyPart(),
    keys: () => source().keys?.() ?? [],
    returns: () => source().returns(),
    constructs: () => source().constructs(),
    parameter: (index) => source().parameter(index),
    instance: (owner) => source().instance(owner),
    get written() {
      return source().written;
    },
  };
}

/**
 * The elements an instance of the interface or the class `symbol` yields when
 * iterated, where the substitutions `owners` holds bind the type parameters of
 * its declarations and of those it extends: the type argument, or the tuple of
 * type arguments, its iteration yields, or, for an element type that names no
 * type parameter of these, that type as written. An element the substitutions
 * do not bind declares nothing. `undefined` for a type that is not iterable.
 */
function iteratedSource(
  symbol: ts.Symbol,
  owners: ReadonlyMap<ts.Node, Substitution>,
  checker: ts.TypeChecker,
  reading: TypeReading,
): Source | undefined {
  const element = iteratedType(
    checker.getDeclaredTypeOfSymbol(symbol),
    checker,
  );
  if (!element) return undefined;
  const yielded = (type: ts.Type): Source => {
    if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
      const declarations = type.symbol?.declarations ?? [];
      for (
        const declaration of declarations.filter(ts.isTypeParameterDeclaration)
      ) {
        for (const substitution of owners.values()) {
          const argument = substitution.get(declaration);
          if (argument) return argumentSource(argument, checker, reading);
        }
      }
      return opaqueSource(() => false);
    }
    if (checker.isTupleType(type)) {
      return tupleSource(
        checker.getTypeArguments(type as ts.TypeReference).map(yielded),
        undefined,
        [],
      );
    }
    return opaqueSource(
      () => readType(type, checker, "written", reading),
      () => type,
    );
  };
  return yielded(element);
}

/**
 * The element type a value of `type` yields when iterated: the first type
 * argument of what its `[Symbol.iterator]()` method returns, which the
 * library's iterators all take as the type they yield. `undefined` for a type
 * with no such method.
 */
function iteratedType(
  type: ts.Type,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  // A member keyed by a well-known symbol is named `__@<name>@<id>`.
  const iterator = checker.getPropertiesOfType(type).find((property) =>
    String(property.escapedName).startsWith("__@iterator@")
  );
  const [signature] = iterator
    ? checker.getTypeOfSymbol(iterator).getCallSignatures()
    : [];
  const returned = signature && checker.getReturnTypeOfSignature(signature);
  return returned && (returned.flags & ts.TypeFlags.Object) !== 0 &&
      ((returned as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0
    ? checker.getTypeArguments(returned as ts.TypeReference)[0]
    : undefined;
}

/** The type a tuple element written `element` holds. */
function tupleElementType(element: ts.TypeNode): ts.TypeNode {
  const rest = ts.isRestTypeNode(element) ||
    (ts.isNamedTupleMember(element) && !!element.dotDotDotToken);
  const type =
    ts.isNamedTupleMember(element) || ts.isOptionalTypeNode(element) ||
      ts.isRestTypeNode(element)
      ? element.type
      : element;
  // A rest element written as an array type holds that array's elements.
  return rest && ts.isArrayTypeNode(type) ? type.elementType : type;
}

//
// Written types
//
// What a type written out declares, read from the nodes that write it, so that
// a type parameter it names is read as what the reading's substitution says it
// stands for, rather than as whatever the checker instantiated it with.
//

/**
 * The positions a value of the written type `node` declares, with each type
 * parameter it names standing for what `substitution` says: a written type
 * argument, read in its turn, or the provenance of what it was inferred from.
 * A type parameter `substitution` does not bind was inferred from nothing the
 * read knows, so it declares nothing. `unknown` declares a reference where
 * `inField` says the value is a field's. Literals, arrays, tuples, unions,
 * intersections, `typeof`, indexed access, the mapped types that keep or
 * repeat a type's parts, and references are read by their structure; any other
 * node is read through the type it denotes, as written where it names no type
 * parameter and no value's type, and as inferred otherwise.
 */
function readTypeNode(
  node: ts.TypeNode,
  substitution: Substitution,
  inField: boolean,
  checker: ts.TypeChecker,
  reading: TypeReading,
): DeclaredPositions {
  const read = (inner: ts.TypeNode, field = inField) =>
    readTypeNode(inner, substitution, field, checker, reading);
  if (ts.isParenthesizedTypeNode(node)) return read(node.type);
  if (ts.isTypeOperatorNode(node)) {
    return node.operator === ts.SyntaxKind.ReadonlyKeyword
      ? read(node.type)
      : true;
  }
  switch (node.kind) {
    case ts.SyntaxKind.UnknownKeyword:
      return inField;
    case ts.SyntaxKind.AnyKeyword:
    case ts.SyntaxKind.StringKeyword:
    case ts.SyntaxKind.NumberKeyword:
    case ts.SyntaxKind.BooleanKeyword:
    case ts.SyntaxKind.BigIntKeyword:
    case ts.SyntaxKind.SymbolKeyword:
    case ts.SyntaxKind.ObjectKeyword:
    case ts.SyntaxKind.UndefinedKeyword:
    case ts.SyntaxKind.NeverKeyword:
    case ts.SyntaxKind.VoidKeyword:
      return true;
  }
  if (
    ts.isLiteralTypeNode(node) || ts.isTemplateLiteralTypeNode(node) ||
    ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node)
  ) {
    return true;
  }
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    return node.types.reduce<DeclaredPositions>(
      (positions, member) => alternatives(positions, read(member)),
      true,
    );
  }
  if (ts.isArrayTypeNode(node)) {
    return new Map([[ELEMENT_POSITIONS, read(node.elementType)]]);
  }
  if (ts.isTupleTypeNode(node)) {
    return new Map([[
      ELEMENT_POSITIONS,
      node.elements.reduce<DeclaredPositions>(
        (positions, element) =>
          alternatives(positions, read(tupleElementType(element))),
        true,
      ),
    ]]);
  }
  if (ts.isTypeLiteralNode(node)) {
    const fields = new Map<PositionKey, DeclaredPositions>();
    for (const member of node.members) {
      if (ts.isIndexSignatureDeclaration(member)) {
        fields.set(
          UNNAMED_POSITIONS,
          alternatives(
            fields.get(UNNAMED_POSITIONS) ?? true,
            read(member.type, true),
          ),
        );
        continue;
      }
      if (!ts.isPropertySignature(member) || !member.name) continue;
      const key = getPropertyNameText(member.name, checker);
      const value = member.type ? read(member.type, true) : true;
      if (key === undefined) {
        fields.set(
          UNNAMED_POSITIONS,
          alternatives(fields.get(UNNAMED_POSITIONS) ?? true, value),
        );
      } else {
        fields.set(key, value);
      }
    }
    return wholly(fields) ? true : fields;
  }
  if (ts.isTypeQueryNode(node) && ts.isIdentifier(node.exprName)) {
    // A field written as the type of a value that is `unknown` as a whole
    // declares a reference, as a field written `unknown` does.
    if (
      inField &&
      (checker.getTypeFromTypeNode(node).flags & ts.TypeFlags.Unknown) !== 0
    ) {
      return true;
    }
    const symbol = checker.getSymbolAtLocation(node.exprName);
    const declaration = symbol && bindingOf(symbol, checker)?.declaration;
    // A type that holds itself through `typeof` declares what it declares.
    return declaration
      ? openDeclaration(
        declaration,
        new Map(),
        reading,
        () => symbolProvenance(symbol, checker, reading),
      )
      : false;
  }
  if (ts.isIndexedAccessTypeNode(node)) {
    // A key whose type is a literal, or a union of them, reads each part it
    // names; an array's index reads its elements; any other key, any part.
    const object = read(node.objectType);
    const keys = keyTypes(node.indexType, substitution, checker);
    if (keys) return partsAt(object, keys);
    if (typeof object === "boolean") return object;
    return object.get(ELEMENT_POSITIONS) ?? anyPart(object);
  }
  if (ts.isMappedTypeNode(node) && readsStructurally(node, checker)) {
    const key = node.typeParameter;
    const template = node.type!;
    // `{ [P in keyof T]: T[P] }`, as `Partial`, `Readonly`, and `Pick` write
    // it, keeps the parts of `T`.
    if (
      ts.isIndexedAccessTypeNode(template) &&
      ts.isTypeReferenceNode(template.indexType) &&
      typeParameterFor(template.indexType, checker) === key
    ) {
      return read(template.objectType);
    }
    // `{ [P in K]: V }`, as `Record` writes it, gives every key `V`.
    const value = read(template, true);
    return value === true ? true : new Map([[UNNAMED_POSITIONS, value]]);
  }
  if (ts.isTypeReferenceNode(node)) {
    const reference = referencePositions(
      node,
      substitution,
      inField,
      checker,
      reading,
    );
    if (reference !== undefined) return reference;
  }
  return readType(
    checker.getTypeFromTypeNode(node),
    checker,
    writesWholly(node, checker) ? inField ? "field" : "written" : "inferred",
    reading,
  );
}

/**
 * The keys the written key type `node` may be, read under `substitution`, as
 * `literalKeys()` reads them: a type parameter's are those of its written type
 * argument, or of each type it was inferred from; a union's, those of every
 * member; an intersection's, those each member it can read keys of allows.
 */
function keyTypes(
  node: ts.TypeNode,
  substitution: Substitution,
  checker: ts.TypeChecker,
): readonly string[] | undefined {
  if (ts.isParenthesizedTypeNode(node)) {
    return keyTypes(node.type, substitution, checker);
  }
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    const each = node.types.map((member) =>
      keyTypes(member, substitution, checker)
    );
    if (ts.isUnionTypeNode(node)) {
      return each.every((keys) => keys !== undefined) ? each.flat() : undefined;
    }
    const known = each.filter((keys) => keys !== undefined);
    return known.length > 0
      ? known.reduce((kept, keys) => kept.filter((key) => keys.includes(key)))
      : undefined;
  }
  const parameter = ts.isTypeReferenceNode(node)
    ? typeParameterFor(node, checker)
    : undefined;
  const argument = parameter && substitution.get(parameter);
  if (!argument) return literalKeys(checker.getTypeFromTypeNode(node));
  if (argument.kind === "written") {
    return keyTypes(argument.node, argument.substitution, checker);
  }
  const each = argument.types?.map(literalKeys);
  return each?.every((keys) => keys !== undefined) ? each.flat() : undefined;
}

/**
 * Whether `readTypeNode()` reads `node` by its structure rather than through
 * the type it denotes.
 */
function readsStructurally(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
): boolean {
  if (
    ts.isConditionalTypeNode(node) || ts.isInferTypeNode(node) ||
    ts.isImportTypeNode(node) || ts.isThisTypeNode(node) ||
    ts.isTypePredicateNode(node)
  ) {
    return false;
  }
  if (ts.isMappedTypeNode(node)) {
    const template = node.type;
    return !!template && !node.nameType &&
      ((ts.isIndexedAccessTypeNode(template) &&
        ts.isTypeReferenceNode(template.indexType) &&
        typeParameterFor(template.indexType, checker) === node.typeParameter) ||
        !typeParametersIn(template, checker).includes(node.typeParameter));
  }
  return true;
}

/**
 * Whether the type `node` denotes is written out in every part, naming no type
 * parameter, whose argument may have been inferred, and no value's type
 * through `typeof`, which may have been.
 */
function writesWholly(node: ts.TypeNode, checker: ts.TypeChecker): boolean {
  return !mentionsTypeParameter(node, checker) && !mentionsTypeQuery(node);
}

/** Whether `node` writes `typeof` anywhere within it. */
function mentionsTypeQuery(node: ts.Node): boolean {
  return ts.isTypeQueryNode(node) ||
    ts.forEachChild(node, mentionsTypeQuery) === true;
}

/**
 * The positions a value of the type the reference `node` names declares: what
 * a type parameter stands for, the payload of a reactive wrapper or the
 * elements of an array, what `ReturnType<typeof f>` names `f` returning, or
 * else the declaration the reference names, read with its type parameters
 * bound to the reference's type arguments. A type alias whose structure
 * `readTypeNode()` does not read is read through the argument it gives back,
 * where it gives one back, and otherwise through the type the reference
 * instantiates. `undefined` for a reference to no interface, class, or alias.
 */
function referencePositions(
  node: ts.TypeReferenceNode,
  substitution: Substitution,
  inField: boolean,
  checker: ts.TypeChecker,
  reading: TypeReading,
): DeclaredPositions | undefined {
  const parameter = typeParameterFor(node, checker);
  if (parameter) {
    const argument = substitution.get(parameter);
    if (!argument) return false;
    // What a type parameter stands for holds only for the reading binding it,
    // so nothing read through one is kept for reuse.
    reading.reachedOpen = -1;
    return argument.kind === "written"
      ? readTypeNode(
        argument.node,
        argument.substitution,
        inField,
        checker,
        reading,
      )
      : argument.positions;
  }
  const args = node.typeArguments ?? [];
  const symbol = checker.getSymbolAtLocation(node.typeName);
  const resolved = symbol && resolveAlias(symbol, checker);
  // `ReturnType<typeof f>`, as a library declares it, is what `f` returns.
  const [first] = args;
  if (
    resolved?.name === "ReturnType" && first && ts.isTypeQueryNode(first) &&
    ts.isIdentifier(first.exprName) &&
    resolved.declarations?.some((declaration) =>
      declaration.getSourceFile().isDeclarationFile
    )
  ) {
    return functionProvenance(first.exprName, checker, reading);
  }
  const type = checker.getTypeFromTypeNode(node);
  if (first && args.length === 1 && wrapsPayload(type, checker)) {
    return readTypeNode(first, substitution, inField, checker, reading);
  }
  if (first && args.length === 1 && checker.isArrayType(type)) {
    return new Map([[
      ELEMENT_POSITIONS,
      readTypeNode(first, substitution, inField, checker, reading),
    ]]);
  }
  const declaration = genericDeclaration(node, checker);
  if (!declaration) return undefined;
  if (
    ts.isTypeAliasDeclaration(declaration) &&
    !readsStructurally(declaration.type, checker)
  ) {
    // A computed alias, as a conditional one, that gives one of its arguments
    // back, as `Awaited<T>` does for a value that is not a promise, declares
    // what that argument does. Any other is read through the type this
    // reference instantiates, as written where its arguments are.
    const kept = args.find((argument) =>
      checker.getTypeFromTypeNode(argument) === type
    );
    if (kept) {
      return readTypeNode(kept, substitution, inField, checker, reading);
    }
    return readType(
      type,
      checker,
      args.every((argument) => writesWholly(argument, checker))
        ? inField ? "field" : "written"
        : "inferred",
      reading,
    );
  }
  const bound = bindTypeArguments(
    declaration.typeParameters ?? [],
    args,
    substitution,
  );
  return openDeclaration(
    declaration,
    bound,
    reading,
    () =>
      ts.isTypeAliasDeclaration(declaration)
        ? readTypeNode(declaration.type, bound, inField, checker, reading)
        : declaredMembers(
          type,
          heritageSubstitutions(
            (resolved?.declarations ?? []).filter((d) =>
              ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d) ||
              ts.isClassExpression(d)
            ) as (ts.InterfaceDeclaration | ts.ClassLikeDeclaration)[],
            bound,
            checker,
          ),
          checker,
          reading,
        ),
  );
}

/**
 * What `read` gives reading `declaration` once more, or `true` where the read
 * is already inside it with nothing bound, or `MAX_TYPE_NESTING` deep in it, as
 * a generic declaration instantiated in itself may be without end: a type that
 * holds itself declares what it declares.
 */
function openDeclaration(
  declaration: ts.Node,
  substitution: Substitution,
  reading: TypeReading,
  read: () => DeclaredPositions,
): DeclaredPositions {
  const open = reading.nodeOpen.get(declaration) ?? 0;
  if ((open > 0 && substitution.size === 0) || open >= MAX_TYPE_NESTING) {
    reading.reachedOpen = -1;
    return true;
  }
  reading.nodeOpen.set(declaration, open + 1);
  try {
    return read();
  } finally {
    if (open === 0) reading.nodeOpen.delete(declaration);
    else reading.nodeOpen.set(declaration, open);
  }
}

/**
 * Each of `declarations`, and each interface or class above them through an
 * `extends` clause, with the substitution its members are read with:
 * `substitution` for these, and for one above, its parameters bound to the
 * type arguments the clause writes, read with the substitution of the
 * declaration writing them.
 */
function heritageSubstitutions(
  declarations: readonly (ts.InterfaceDeclaration | ts.ClassLikeDeclaration)[],
  substitution: Substitution,
  checker: ts.TypeChecker,
  into = new Map<ts.Node, Substitution>(),
): Map<ts.Node, Substitution> {
  // A declaration reached twice, through two clauses, is read with the
  // substitution it was reached with first.
  for (const declaration of declarations.filter((d) => !into.has(d))) {
    into.set(declaration, substitution);
    const extended = (declaration.heritageClauses ?? []).filter((clause) =>
      clause.token === ts.SyntaxKind.ExtendsKeyword
    );
    for (const heritage of extended.flatMap((clause) => clause.types)) {
      for (
        const [base, args] of heritageBases(
          heritage.expression,
          heritage.typeArguments,
          checker,
        )
      ) {
        heritageSubstitutions(
          [base],
          bindTypeArguments(base.typeParameters ?? [], args, substitution),
          checker,
          into,
        );
      }
    }
  }
  return into;
}

/**
 * The interfaces and classes the `extends` clause naming `name` with `args`
 * reaches, each with the type arguments it is given: the class or the
 * interfaces it names, or, through an alias of a mapped type that keeps the
 * parts of one of its arguments, as `Pick` and `Partial` do, the declaration
 * that argument names.
 */
function heritageBases(
  name: ts.Node,
  args: readonly ts.TypeNode[] | undefined,
  checker: ts.TypeChecker,
): [ts.InterfaceDeclaration | ts.ClassLikeDeclaration, typeof args][] {
  const definition = ts.isExpression(name)
    ? definitionOf(name, checker)
    : undefined;
  if (
    definition &&
    (ts.isClassDeclaration(definition) || ts.isClassExpression(definition))
  ) {
    return [[definition, args]];
  }
  const symbol = checker.getSymbolAtLocation(name);
  const declarations = (symbol && resolveAlias(symbol, checker))
    ?.declarations ?? [];
  const bases = declarations.filter((declaration) =>
    ts.isInterfaceDeclaration(declaration) ||
    ts.isClassDeclaration(declaration)
  ) as (ts.InterfaceDeclaration | ts.ClassLikeDeclaration)[];
  if (bases.length > 0) return bases.map((base) => [base, args]);
  const alias = declarations.find(ts.isTypeAliasDeclaration);
  const template = alias && ts.isMappedTypeNode(alias.type)
    ? alias.type.type
    : undefined;
  const kept = template && ts.isIndexedAccessTypeNode(template) &&
      ts.isTypeReferenceNode(template.objectType)
    ? typeParameterFor(template.objectType, checker)
    : undefined;
  const argument = kept && args?.[alias!.typeParameters?.indexOf(kept) ?? -1];
  return argument && ts.isTypeReferenceNode(argument)
    ? heritageBases(argument.typeName, argument.typeArguments, checker)
    : [];
}

/**
 * The positions the members of a value of `type` declare, each read from the
 * type its declaration writes, with the substitution `owners` gives the
 * interface or class declaring it. A member whose declaration writes no type,
 * or that no declaration in `owners` declares, declares what its initializer's
 * provenance and `writtenPositions()` read of its type do.
 */
function declaredMembers(
  type: ts.Type,
  owners: ReadonlyMap<ts.Node, Substitution>,
  checker: ts.TypeChecker,
  reading: TypeReading,
): DeclaredPositions {
  const fields = new Map<PositionKey, DeclaredPositions>();
  for (const property of type.getProperties()) {
    const declaration = property.valueDeclaration ??
      property.declarations?.[0];
    const owner = declaration && memberOwner(declaration);
    const substitution = owner && owners.get(owner);
    const node = memberTypeNode(property);
    let positions: DeclaredPositions;
    if (substitution && node) {
      positions = readTypeNode(node, substitution, true, checker, reading);
    } else {
      positions = eitherDeclares(
        readType(
          checker.getTypeOfSymbol(property),
          checker,
          "inferred",
          reading,
        ),
        initializerProvenance(property, checker, reading),
      );
    }
    fields.set(property.name, positions);
  }
  for (const index of checker.getIndexInfosOfType(type)) {
    const declaration = index.declaration;
    const substitution = declaration && owners.get(declaration.parent);
    fields.set(
      UNNAMED_POSITIONS,
      alternatives(
        fields.get(UNNAMED_POSITIONS) ?? true,
        substitution && declaration
          ? readTypeNode(declaration.type, substitution, true, checker, reading)
          : readType(index.type, checker, "inferred", reading),
      ),
    );
  }
  return wholly(fields) ? true : fields;
}

/**
 * The interface, the class, or the type literal that declares the member
 * `declaration`.
 */
function memberOwner(declaration: ts.Declaration): ts.Node | undefined {
  if (ts.isParameter(declaration)) {
    return ts.isConstructorDeclaration(declaration.parent)
      ? declaration.parent.parent
      : undefined;
  }
  return declaration.parent;
}

/** The interface, class, or type alias the reference `node` names. */
function genericDeclaration(
  node: ts.TypeReferenceNode,
  checker: ts.TypeChecker,
):
  | ts.InterfaceDeclaration
  | ts.ClassLikeDeclaration
  | ts.TypeAliasDeclaration
  | undefined {
  const symbol = checker.getSymbolAtLocation(node.typeName);
  const resolved = symbol && resolveAlias(symbol, checker);
  return resolved?.declarations?.find((
    declaration,
  ): declaration is
    | ts.InterfaceDeclaration
    | ts.ClassLikeDeclaration
    | ts.TypeAliasDeclaration =>
    ts.isInterfaceDeclaration(declaration) ||
    ts.isClassDeclaration(declaration) ||
    ts.isClassExpression(declaration) ||
    ts.isTypeAliasDeclaration(declaration)
  );
}

/** The type parameter the reference `node` names, if it names one. */
function typeParameterFor(
  node: ts.TypeReferenceNode,
  checker: ts.TypeChecker,
): ts.TypeParameterDeclaration | undefined {
  const symbol = checker.getSymbolAtLocation(node.typeName);
  return symbol && (symbol.flags & ts.SymbolFlags.TypeParameter) !== 0
    ? symbol.declarations?.find(ts.isTypeParameterDeclaration)
    : undefined;
}

/**
 * Whether `type` is a reactive wrapper whose schema is its payload's. A union
 * is not one: unwrapping rebuilds it whether or not a member was a wrapper.
 */
function wrapsPayload(type: ts.Type, checker: ts.TypeChecker): boolean {
  const unwrapped = unwrapOpaqueLikeType(type, checker);
  return !type.isUnion() && unwrapped !== undefined && unwrapped !== type;
}

/**
 * The type parameters the type node `node` names, each by its declaration,
 * or `undefined` for one the checker gives no declaration for.
 */
function typeParametersIn(
  node: ts.Node,
  checker: ts.TypeChecker,
): (ts.TypeParameterDeclaration | undefined)[] {
  const named: (ts.TypeParameterDeclaration | undefined)[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isTypeReferenceNode(child)) {
      const type = checker.getTypeFromTypeNode(child);
      if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
        named.push(
          type.symbol?.declarations?.find(ts.isTypeParameterDeclaration),
        );
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return named;
}

/** Whether the type node `node` names a type parameter anywhere in it. */
function mentionsTypeParameter(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
): boolean {
  return typeParametersIn(node, checker).length > 0;
}

//
// Reassignment
//

/**
 * Whether some use of `symbol`, in the source file that declares it, assigns
 * it a new value. Only the declaring module can assign one: an import of it
 * cannot be assigned to.
 */
function reassigned(symbol: ts.Symbol, checker: ts.TypeChecker): boolean {
  const sourceFile = (symbol.valueDeclaration ?? symbol.declarations?.[0])
    ?.getSourceFile();
  if (!sourceFile || sourceFile.isDeclarationFile) return false;
  return (usesIn(sourceFile, checker).get(symbol) ?? []).some(isWriteTarget);
}

/**
 * Whether `node` is written to: the target of an assignment, an increment or
 * a decrement, or of a loop over the values or keys of something, or a part
 * of a destructuring assignment's target.
 */
function isWriteTarget(node: ts.Node): boolean {
  let current = node;
  let parent = current.parent;
  while (
    ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent) ||
    ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent) ||
    ts.isTypeAssertionExpression(parent)
  ) {
    current = parent;
    parent = current.parent;
  }
  if (ts.isBinaryExpression(parent)) {
    return parent.left === current &&
      isAssignmentOperator(parent.operatorToken.kind);
  }
  if (
    ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)
  ) {
    return parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken;
  }
  if (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) {
    return parent.initializer === current;
  }
  // A destructuring assignment writes each target its pattern names.
  if (ts.isShorthandPropertyAssignment(parent)) {
    return parent.name === current && isWriteTarget(parent.parent);
  }
  if (ts.isPropertyAssignment(parent)) {
    return parent.initializer === current && isWriteTarget(parent.parent);
  }
  if (
    ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent) ||
    ts.isArrayLiteralExpression(parent)
  ) {
    return isWriteTarget(
      ts.isArrayLiteralExpression(parent) ? parent : parent.parent,
    );
  }
  return false;
}

/** Whether `kind` is `=` or a compound assignment such as `+=`. */
function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment;
}

/** The uses of each binding in each source file, by the checker reading it. */
const usesCache = new WeakMap<
  ts.TypeChecker,
  WeakMap<ts.SourceFile, ReadonlyMap<ts.Symbol, readonly ts.Identifier[]>>
>();

/**
 * The identifiers in `sourceFile` that use a binding, by the binding they
 * use: every reference to it, other than the name that declares it.
 */
function usesIn(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): ReadonlyMap<ts.Symbol, readonly ts.Identifier[]> {
  let byFile = usesCache.get(checker);
  if (!byFile) {
    byFile = new WeakMap();
    usesCache.set(checker, byFile);
  }
  const cached = byFile.get(sourceFile);
  if (cached) return cached;

  const uses = new Map<ts.Symbol, ts.Identifier[]>();
  const visit = (node: ts.Node): void => {
    // A type mentions a binding without using its value.
    if (ts.isTypeNode(node)) return;
    if (ts.isIdentifier(node) && !namesSomething(node)) {
      const symbol = valueSymbol(node, checker);
      if (symbol) {
        const resolved = resolveAlias(symbol, checker);
        const list = uses.get(resolved);
        if (list) list.push(node);
        else uses.set(resolved, [node]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  byFile.set(sourceFile, uses);
  return uses;
}

/**
 * Whether `identifier` names something rather than using a binding: the name
 * a declaration gives, a property's name, or the name a member is read by.
 * The name in a shorthand property, and the name an export lists, use the
 * binding they name.
 */
function namesSomething(identifier: ts.Identifier): boolean {
  const { parent } = identifier;
  if (ts.isShorthandPropertyAssignment(parent)) return false;
  if (ts.isExportSpecifier(parent)) {
    return parent.propertyName !== undefined && parent.name === identifier;
  }
  if (
    (ts.isBindingElement(parent) || ts.isImportSpecifier(parent)) &&
    parent.propertyName === identifier
  ) {
    return true;
  }
  return "name" in parent && parent.name === identifier;
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
  readonly keys: readonly PositionKey[];
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
  const step = (
    position: SchemaPosition,
    label: string,
    key: PositionKey,
  ): SchemaPosition => ({
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
          walk(child, step(position, `[${index}]`, ELEMENT_POSITIONS));
          break;
        case "items":
          walk(
            child,
            step(
              position,
              prefixLength === undefined ? "[]" : `[${prefixLength}...]`,
              ELEMENT_POSITIONS,
            ),
          );
          break;
        case "additionalProperties":
          walk(child, step(position, `${dot}*`, UNNAMED_POSITIONS));
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
  keys: readonly PositionKey[],
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
