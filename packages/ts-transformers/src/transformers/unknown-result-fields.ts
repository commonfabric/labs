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
 * what its type writes, as `typePositions()` reads it, whether it is taken
 * whole or destructured. Each return of `callback` is one alternative for the
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
  for (const parameter of authored.parameters) {
    bindParameter(
      parameter,
      typePositions(checker.getTypeAtLocation(parameter), checker),
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
    // type the value has and makes it literal, and a cast to a type naming a
    // type parameter, whose argument may have been inferred.
    return ts.isConstTypeReference(expression.type) ||
        mentionsTypeParameter(expression.type, checker)
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
    // A binding can change the structure of the literal it holds, and an
    // accessor that uses `this` can change the literal it belongs to.
    return scope.held === 0 || changesItself(expression)
      ? false
      : objectLiteralPositions(expression, scope);
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
  if (ts.isPropertyAccessExpression(expression)) {
    return memberPositions(
      expressionPositions(expression.expression, scope),
      expression.name.text,
      expression,
      scope,
    );
  }
  if (ts.isElementAccessExpression(expression)) {
    const object = expressionPositions(expression.expression, scope);
    // An index into an array reads one of its elements.
    const element = typeof object === "boolean"
      ? undefined
      : object.get(ELEMENT_POSITIONS);
    if (element !== undefined) return element;
    const argument = expression.argumentExpression;
    if (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument)) {
      return memberPositions(object, argument.text, expression, scope);
    }
    // A key the trace cannot read may name any part the value holds.
    return typeof object === "boolean"
      ? object
      : [...object.values()].reduce<DeclaredPositions>(alternatives, true);
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

/** `symbol`, or what it aliases when it is an import. */
function resolveAlias(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

/**
 * The declared positions of the value bound to `symbol`. A type written out
 * for the binding declares what it holds, which anything assigned to it or
 * changed through it must satisfy, and so does the binding's own type where
 * it is an object type an author wrote, however the binding came by it. A
 * binding something reassigns declares nothing more. One nothing reassigns
 * holds what the trace reads of its value with the binding holding it:
 * whatever is done through the binding can change that value's own structure,
 * so the structure declares nothing, while a written type or a reactive value
 * it holds still declares its parts.
 */
function symbolPositions(
  symbol: ts.Symbol | undefined,
  scope: TraceScope,
): DeclaredPositions {
  if (!symbol) return false;
  const { checker } = scope;
  const resolved = resolveAlias(symbol, checker);
  const declaration = resolved.valueDeclaration ?? resolved.declarations?.[0];
  if (!declaration) return false;
  // A function, a class, or an enum declares what its name holds.
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isClassDeclaration(declaration) ||
    ts.isEnumDeclaration(declaration) ||
    ts.isEnumMember(declaration)
  ) {
    return true;
  }
  const written = writtenBindingType(declaration, checker);
  if (written) {
    return typePositions(checker.getTypeFromTypeNode(written), checker);
  }
  // The binding's own type, where it is written out, declares what any value
  // it holds has under it.
  const ownType = writtenPositions(
    checker.getTypeOfSymbolAtLocation(resolved, declaration),
    checker,
  );
  if (reassigned(resolved, checker)) return ownType;
  if (ts.isBindingElement(declaration)) {
    // A destructured binding holds a field of the value it came from, which
    // the field's written type declares.
    const field = getDeclaredTypeNodeForBindingElement(declaration, checker);
    if (field && !mentionsTypeParameter(field, checker)) {
      return typePositions(checker.getTypeFromTypeNode(field), checker, true);
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
  return !wholly(positions) && wholly(ownType) ? true : positions;
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
  const path: ts.BindingElement[] = [element];
  let owner = element.parent.parent;
  while (ts.isBindingElement(owner)) {
    path.unshift(owner);
    owner = owner.parent.parent;
  }
  if (!ts.isVariableDeclaration(owner)) return false;
  const declaration = owner;
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
 * The declared positions of member `key` of a value with `object`, read by
 * `access`. A member of a value with nothing declared is still declared when
 * its own declaration writes its type out, or when the type of what it holds
 * is written out.
 */
function memberPositions(
  object: DeclaredPositions,
  key: string,
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  scope: TraceScope,
): DeclaredPositions {
  if (object !== false) return below(object, key);
  const { checker } = scope;
  const name = ts.isPropertyAccessExpression(access)
    ? access.name
    : access.argumentExpression;
  return writesOwnType(checker.getSymbolAtLocation(name), checker) ||
    writtenPositions(checker.getTypeAtLocation(access), checker);
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
 * class declares a field of its instances when the field's declaration writes
 * its type out; a field whose type is inferred from its initializer declares
 * nothing. A type naming a type parameter declares the field only where every
 * parameter it names is fixed in writing, by `typeParametersWritten()`.
 */
function instancePositions(
  construction: ts.NewExpression,
  scope: TraceScope,
): DeclaredPositions {
  const { checker } = scope;
  const constructed = definitionOf(construction.expression, checker);
  const written = constructed &&
      (ts.isClassDeclaration(constructed) || ts.isClassExpression(constructed))
    ? typeParametersWritten(
      constructed,
      !!construction.typeArguments?.length,
      checker,
    )
    : new Set<ts.TypeParameterDeclaration>();
  const positions = new Map<PositionKey, DeclaredPositions>();
  for (
    const member of checker.getTypeAtLocation(construction).getProperties()
  ) {
    const type = memberTypeNode(member);
    positions.set(
      member.name,
      !!type &&
        typeParametersIn(type, checker).every((parameter) =>
          parameter !== undefined && written.has(parameter)
        ),
    );
  }
  return positions;
}

/**
 * The type parameters of `constructed` and of the classes above it whose
 * arguments are written out for an instance of it: the class's own when
 * `argumentsWritten` at the construction, and an inherited one when the
 * `extends` clause that fixes it writes an argument, or the parameter's
 * declaration writes a default, naming only parameters already fixed so.
 */
function typeParametersWritten(
  constructed: ts.ClassLikeDeclaration,
  argumentsWritten: boolean,
  checker: ts.TypeChecker,
): ReadonlySet<ts.TypeParameterDeclaration> {
  const written = new Set<ts.TypeParameterDeclaration>(
    argumentsWritten ? constructed.typeParameters ?? [] : [],
  );
  const visited = new Set<ts.Node>();
  let current: ts.ClassLikeDeclaration = constructed;
  while (!visited.has(current)) {
    visited.add(current);
    const heritage = current.heritageClauses
      ?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
      ?.types[0];
    const base = heritage && definitionOf(heritage.expression, checker);
    if (
      !heritage || !base ||
      !(ts.isClassDeclaration(base) || ts.isClassExpression(base))
    ) {
      break;
    }
    base.typeParameters?.forEach((parameter, index) => {
      const argument = heritage.typeArguments?.[index] ?? parameter.default;
      if (
        argument &&
        typeParametersIn(argument, checker).every((named) =>
          named !== undefined && written.has(named)
        )
      ) {
        written.add(parameter);
      }
    });
    current = base;
  }
  return written;
}

/**
 * The declared positions of an object literal's value, by property. A part
 * under a key the trace cannot name, a computed key or a spread value's index
 * signature, may be under any name, so it is an alternative for every name
 * the literal held before it, and a name the literal writes after it replaces
 * it there. A spread value's own parts land in the literal as the spread
 * value holds them. A spread member the spread value may lack, being
 * optional, is an alternative to what the literal held under its name before
 * it, rather than a replacement for it.
 */
function objectLiteralPositions(
  literal: ts.ObjectLiteralExpression,
  scope: TraceScope,
): DeclaredPositions {
  const { checker } = scope;
  const propertyHeld = partHeld(scope.held);
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
      const spread = expressionPositions(property.expression, scope);
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
      value = heldAs(
        scope,
        propertyHeld,
        () => expressionPositions(property.initializer, scope),
      );
    } else if (ts.isShorthandPropertyAssignment(property)) {
      value = symbolPositions(
        checker.getShorthandAssignmentValueSymbol(property),
        scope,
      );
    } else if (ts.isGetAccessorDeclaration(property)) {
      value = heldAs(
        scope,
        propertyHeld,
        () => returnedPositions(property, scope),
      );
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
  // A type argument written out declares the fields of the result.
  if (call.typeArguments?.length) {
    return typePositions(checker.getTypeAtLocation(call), checker);
  }
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
  if (factory?.typeArguments?.length) {
    return typePositions(
      scope.checker.getTypeAtLocation(applied),
      scope.checker,
    );
  }
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
  if (!callback || scope.tracing.has(callback)) return false;
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
 * whose declaration writes its type declares what that type gives it:
 * `unknown` as a field's type, or as its array's elements, declares a
 * reference, while `unknown` as the whole value's type, or as its array's
 * elements, declares nothing there. A field whose type was inferred, as an
 * object literal's members' are, declares only what `writtenPositions()`
 * reads of its type, however the written type reaches it: through `typeof`,
 * `ReturnType<…>`, or `this`. Reactive wrappers are read through, as schema
 * generation reads them.
 */
function typePositions(
  type: ts.Type,
  checker: ts.TypeChecker,
  inField = false,
  reading: TypeReading = {
    open: new Map(),
    nested: new Map(),
    read: [new Map(), new Map()],
    reachedOpen: Infinity,
  },
): DeclaredPositions {
  const value = unwrapOpaqueLikeType(type, checker) ?? type;
  if ((value.flags & ts.TypeFlags.Unknown) !== 0) return inField;
  // A type still naming a type parameter is whatever its argument turns out to
  // be, which may have been inferred.
  if ((value.flags & ts.TypeFlags.Instantiable) !== 0) return false;
  const read = reading.read[inField ? 1 : 0];
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
        typePositions(member, checker, inField, reading),
      );
    }
  } else if (checker.isArrayType(value) || checker.isTupleType(value)) {
    let elements: DeclaredPositions = true;
    for (const element of checker.getTypeArguments(value as ts.TypeReference)) {
      elements = alternatives(
        elements,
        typePositions(element, checker, inField, reading),
      );
    }
    positions = new Map([[ELEMENT_POSITIONS, elements]]);
  } else if ((value.flags & ts.TypeFlags.Object) !== 0) {
    const fields = new Map<PositionKey, DeclaredPositions>();
    for (const property of value.getProperties()) {
      const type = checker.getTypeOfSymbol(property);
      fields.set(
        property.name,
        infersOwnType(property)
          ? writtenPositions(type, checker)
          : typePositions(type, checker, true, reading),
      );
    }
    positions = wholly(fields) ? true : fields;
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
 * How many instantiations of one declaration `typePositions()` reads nested in
 * one another before it takes the innermost for a recursion without end.
 */
const MAX_TYPE_NESTING = 3;

/**
 * What one read by `typePositions()` carries from part to part. A type that
 * holds itself is taken as declared where the read reaches it again, which
 * holds only on the path that reached it, so only a read that reaches no type
 * open above it is kept for reuse.
 */
interface TypeReading {
  /** The types being read, each by its depth in the read. */
  readonly open: Map<ts.Type, number>;

  /** The depths of the types being read, by the declaration each instantiates. */
  readonly nested: Map<ts.Symbol, readonly number[]>;

  /** The positions read so far, outside a field and inside one. */
  readonly read: readonly [
    Map<ts.Type, DeclaredPositions>,
    Map<ts.Type, DeclaredPositions>,
  ];

  /** The shallowest depth of an open type the read has reached again. */
  reachedOpen: number;
}

/**
 * The positions a value of `type`, inferred or written, declares by the parts
 * of `type` that are written out: an object type an author wrote, as an
 * interface or a type literal, declares its fields, whatever made the value.
 * An object type inferred from a literal, an instance of a class, and an
 * instance of a generic type, whose arguments may have been inferred, declare
 * nothing, and neither does `unknown`. An intersection declares only what every
 * one of its parts does.
 */
function writtenPositions(
  type: ts.Type,
  checker: ts.TypeChecker,
  seen = new Set<ts.Type>(),
): DeclaredPositions {
  const value = unwrapOpaqueLikeType(type, checker) ?? type;
  // A type still naming a type parameter is whatever its argument turns out to
  // be, which may have been inferred.
  if (
    (value.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Instantiable)) !== 0
  ) {
    return false;
  }
  if (seen.has(value)) return true;
  seen.add(value);
  let positions: DeclaredPositions = true;
  if (value.isUnion()) {
    for (const member of value.types) {
      positions = alternatives(
        positions,
        writtenPositions(member, checker, seen),
      );
    }
  } else if (checker.isArrayType(value) || checker.isTupleType(value)) {
    let elements: DeclaredPositions = true;
    for (const element of checker.getTypeArguments(value as ts.TypeReference)) {
      elements = alternatives(
        elements,
        writtenPositions(element, checker, seen),
      );
    }
    positions = new Map([[ELEMENT_POSITIONS, elements]]);
  } else if (value.isIntersection()) {
    // Every part of an intersection describes the same value.
    for (const part of value.types) {
      positions = alternatives(
        positions,
        writtenPositions(part, checker, seen),
      );
    }
  } else if ((value.flags & ts.TypeFlags.Object) !== 0) {
    positions = isWrittenObjectType(value, checker);
  }
  seen.delete(value);
  return positions;
}

/**
 * Whether the object type `type` is one an author wrote out, as a
 * non-generic interface, or as a type literal naming no type parameter. A
 * generic one may be instantiated with an inferred argument.
 */
function isWrittenObjectType(type: ts.Type, checker: ts.TypeChecker): boolean {
  if (type.aliasTypeArguments?.length) return false;
  const declarations = type.symbol?.declarations ?? [];
  return declarations.length > 0 &&
    declarations.every((declaration) =>
      (ts.isTypeLiteralNode(declaration) &&
        !mentionsTypeParameter(declaration, checker)) ||
      (ts.isInterfaceDeclaration(declaration) &&
        !declaration.typeParameters?.length)
    );
}

/**
 * The type parameters the type node `node` names, each by its declaration,
 * or `undefined` for one the checker gives no declaration for.
 */
function typeParametersIn(
  node: ts.TypeNode,
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
      const { parent } = node;
      const symbol = ts.isShorthandPropertyAssignment(parent)
        ? checker.getShorthandAssignmentValueSymbol(parent)
        : checker.getSymbolAtLocation(node);
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
