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
    flow: new ValueFlow(checker, authored),
    bindings: new Map(),
    inputs: new Set(),
    tracing: new Set(),
    sealed: false,
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
  for (const symbol of scope.bindings.keys()) scope.inputs.add(symbol);
  return returnedPositions(authored, scope);
}

/** What the trace reads a name through. */
interface NameContext {
  /** The checker every symbol is resolved through. */
  readonly checker: ts.TypeChecker;

  /** Where the values the program's bindings hold can reach. */
  readonly flow: ValueFlow;
}

/** What a trace of declared positions carries from one expression to the next. */
interface TraceScope extends NameContext {
  /** Declared positions of the values bound to callback parameters. */
  readonly bindings: Map<ts.Symbol, DeclaredPositions>;

  /**
   * The bindings of the pattern's input, whose written type declares their
   * positions whatever is done with them.
   */
  readonly inputs: Set<ts.Symbol>;

  /** The declarations being traced, so a trace never re-enters one. */
  readonly tracing: Set<ts.Declaration>;

  /**
   * Whether the value being traced may have been changed through a binding
   * that holds it, so that only what holds whatever is done through the
   * binding still declares anything: a written type, which every change must
   * satisfy, or a reactive value, which only the runtime recomputes. A
   * literal's structure, or the result of a plain array method, then declares
   * nothing.
   */
  sealed: boolean;
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
    return scope.sealed ? false : objectLiteralPositions(expression, scope);
  }
  if (ts.isArrayLiteralExpression(expression)) {
    if (scope.sealed) return false;
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
          : expressionPositions(element, scope),
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
      expression.name,
      scope,
    );
  }
  if (ts.isElementAccessExpression(expression)) {
    const object = expressionPositions(expression.expression, scope);
    if (typeof object === "boolean") return object;
    // An index into an array reads one of its elements.
    const element = object.get(ELEMENT_POSITIONS);
    if (element !== undefined) return element;
    const argument = expression.argumentExpression;
    // A key the trace cannot read may name any part the value holds.
    return ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument)
      ? memberPositions(object, argument.text, argument, scope)
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

/** `symbol`, or what it aliases when it is an import. */
function resolveAlias(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

/**
 * The declared positions of the value bound to `symbol`. A binding holds what
 * the trace read it as holding only while `ValueFlow` finds nothing that could
 * change it. One that may have changed still holds what its written type
 * declares, which whatever changed it had to satisfy.
 */
function symbolPositions(
  symbol: ts.Symbol | undefined,
  scope: TraceScope,
): DeclaredPositions {
  if (!symbol) return false;
  const { checker, flow } = scope;
  const resolved = resolveAlias(symbol, checker);
  const bound = scope.bindings.get(resolved);
  if (
    bound !== undefined &&
    (scope.inputs.has(resolved) || !flow.escapes(resolved))
  ) {
    return bound;
  }
  const declaration = resolved.valueDeclaration ?? resolved.declarations?.[0];
  if (!declaration) return false;
  if (ts.isVariableDeclaration(declaration)) {
    if (declaration.type) {
      return typePositions(
        checker.getTypeFromTypeNode(declaration.type),
        checker,
      );
    }
    if (flow.rebound(resolved)) return false;
    return sealedAs(
      scope,
      flow.escapes(resolved),
      () => traced(declaration, declaration.initializer, scope),
    );
  }
  if (ts.isBindingElement(declaration)) {
    // A destructured binding holds a field of the value it came from,
    // declared by that field's written type or by the value's own declared
    // positions.
    const declared = getDeclaredTypeNodeForBindingElement(declaration, checker);
    if (flow.rebound(resolved)) return false;
    return sealedAs(scope, flow.escapes(resolved), () => {
      const positions = declared && !mentionsTypeParameter(declared, checker)
        ? true
        : destructuredPositions(declaration, scope);
      return declaration.initializer
        ? alternatives(
          positions,
          expressionPositions(declaration.initializer, scope),
        )
        : positions;
    });
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
 * What `read` returns with `scope` tracing a value that may (`sealed`) or may
 * not have been changed through a binding that holds it.
 */
function sealedAs<T>(scope: TraceScope, sealed: boolean, read: () => T): T {
  const outer = scope.sealed;
  scope.sealed = sealed;
  try {
    return read();
  } finally {
    scope.sealed = outer;
  }
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
  const typeParametersWritten = !!construction.typeArguments?.length ||
    !constructsGenericClass(construction, checker);
  const positions = new Map<PositionKey, DeclaredPositions>();
  for (
    const member of checker.getTypeAtLocation(construction).getProperties()
  ) {
    positions.set(
      member.name,
      writesOwnType(member, typeParametersWritten, checker),
    );
  }
  return positions;
}

/**
 * Whether `construction` builds a class that declares type parameters of its
 * own, whose arguments it may leave to inference. A class that declares none
 * fixes every type parameter it inherits in the `extends` clauses written
 * above it. A constructor the trace finds no class for counts as generic.
 */
function constructsGenericClass(
  construction: ts.NewExpression,
  checker: ts.TypeChecker,
): boolean {
  const symbol = checker.getSymbolAtLocation(construction.expression);
  const classes = (symbol && resolveAlias(symbol, checker).declarations)
    ?.filter((declaration) =>
      ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)
    ) ?? [];
  return classes.length === 0 ||
    classes.some((declaration) => !!declaration.typeParameters?.length);
}

/**
 * Whether the declaration of `member` writes its type out: a property's type,
 * a parameter property's, or a getter's return type. A type naming a type
 * parameter counts only when `typeParametersWritten`, since otherwise the
 * parameter's argument may have been inferred.
 */
function writesOwnType(
  member: ts.Symbol | undefined,
  typeParametersWritten: boolean,
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
    (typeParametersWritten || !mentionsTypeParameter(type, checker));
}

/**
 * The declared positions of an object literal's value, by property. A part
 * under a key the trace cannot name, a computed key or a spread value's index
 * signature, may be under any name, so it is an alternative for every name
 * the literal held before it, and a name the literal writes after it replaces
 * it there. A spread member the spread value may lack, being optional, is an
 * alternative to what the literal held under its name before it, rather than
 * a replacement for it.
 */
function objectLiteralPositions(
  literal: ts.ObjectLiteralExpression,
  scope: TraceScope,
): DeclaredPositions {
  const { checker } = scope;
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
      for (const member of type.getProperties()) {
        supply(
          member.name,
          below(spread, member.name),
          (member.flags & ts.SymbolFlags.Optional) !== 0,
        );
      }
      if (checker.getIndexInfosOfType(type).length > 0) {
        supplyUnnamed(below(spread, UNNAMED_POSITIONS));
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
    if (key === undefined) supplyUnnamed(value);
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
      if (arrayMethodName(call, checker) === undefined) {
        return signaturePositions(call, scope);
      }
      // A plain array method makes a plain array, which a change through
      // the binding holding it may reach.
      return scope.sealed ? false : arrayMethodPositions(call, scope);
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
  context: NameContext,
): ts.CallExpression | undefined {
  const definition = definitionOf(callee, context);
  if (!definition || !ts.isCallExpression(definition)) return undefined;
  const kind = detectCallKind(definition, context.checker);
  return kind?.kind === "builder" && kind.builderName === "lift"
    ? definition
    : undefined;
}

/**
 * What `expression` denotes, read through the names it is spelled with: the
 * function a name declares, or what a binding nothing reassigns was
 * initialized with, read in turn. A name the trace cannot follow, or one it
 * reaches a second time, denotes nothing.
 */
function definitionOf(
  expression: ts.Expression,
  context: NameContext,
): ts.Node | undefined {
  const followed = new Set<ts.Symbol>();
  let current = unwrapCallee(expression);
  while (ts.isIdentifier(current)) {
    const symbol = context.checker.getSymbolAtLocation(current);
    const resolved = symbol && resolveAlias(symbol, context.checker);
    if (
      !resolved || followed.has(resolved) || context.flow.rebound(resolved)
    ) {
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

/**
 * The name of the method `call` calls, when it calls one on an array,
 * reactive or not, spelled as a member or by a literal key.
 */
function arrayMethodName(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): string | undefined {
  const callee = call.expression;
  const name = ts.isPropertyAccessExpression(callee)
    ? callee.name.text
    : ts.isElementAccessExpression(callee) &&
        ts.isStringLiteralLike(callee.argumentExpression)
    ? callee.argumentExpression.text
    : undefined;
  if (name === undefined) return undefined;
  const receiver = checker.getTypeAtLocation(
    (callee as ts.PropertyAccessExpression | ts.ElementAccessExpression)
      .expression,
  );
  const value = unwrapOpaqueLikeType(receiver, checker) ?? receiver;
  return checker.isArrayType(value) || checker.isTupleType(value)
    ? name
    : undefined;
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
  context: NameContext,
): ts.SignatureDeclaration | undefined {
  const definition = expression && definitionOf(expression, context);
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
  // A traced value reaches a callback only through a computed, a lift, or a
  // method of an array, and a sealed trace only through one the runtime
  // recomputes, which gives what its callback returns whatever is done to the
  // value through a binding that holds it.
  const positions = sealedAs(scope, false, () => {
    const parameter = callback.parameters[0];
    if (parameter) bindParameter(parameter, argument, scope);
    return returnedPositions(callback, scope);
  });
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
    positions = new Map([[ELEMENT_POSITIONS, elements]]);
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
// Value flow
//

/**
 * The array methods that read the array they are called on and leave it as it
 * was, provided every function passed to them does too. `true` marks one
 * whose result can hold the array's elements, or what its callback returns,
 * so that where its result goes matters as well.
 */
const ARRAY_READS: ReadonlyMap<string, boolean> = new Map([
  ["at", true],
  ["concat", true],
  ["entries", true],
  ["every", false],
  ["filter", true],
  ["find", true],
  ["findIndex", false],
  ["findLast", true],
  ["findLastIndex", false],
  ["flat", true],
  ["flatMap", true],
  ["forEach", false],
  ["includes", false],
  ["indexOf", false],
  ["join", false],
  ["keys", false],
  ["lastIndexOf", false],
  ["map", true],
  ["reduce", true],
  ["reduceRight", true],
  ["slice", true],
  ["some", false],
  ["toReversed", true],
  ["toSorted", true],
  ["toSpliced", true],
  ["values", true],
  ["with", true],
]);

/**
 * The array methods in `ARRAY_READS` whose result can hold a value passed to
 * them, rather than only being compared with it.
 */
const ARGUMENT_KEPT: ReadonlySet<string> = new Set([
  "concat",
  "reduce",
  "reduceRight",
  "toSpliced",
  "with",
]);

/**
 * The array methods in `ARRAY_READS` whose result holds what their callback
 * returns. The others test it, or discard it.
 */
const CALLBACK_RESULT_KEPT: ReadonlySet<string> = new Set([
  "flatMap",
  "map",
  "reduce",
  "reduceRight",
]);

/** The type flags of the values that hold no reference to anything. */
const PRIMITIVE_FLAGS = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike |
  ts.TypeFlags.BigIntLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.EnumLike |
  ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Undefined | ts.TypeFlags.Null |
  ts.TypeFlags.Void | ts.TypeFlags.Never;

/**
 * Where the values a program's bindings hold can reach, which decides whether
 * a binding still holds what the trace read it as holding. A value holds what
 * it was built with only while nothing can change it, and nothing can when
 * every use of the binding is one of the reads `#reachesOnlyReads()` admits.
 * Any other use, such as passing the value to a function, storing it, or
 * calling a method that is not a known read, may change it, and then the
 * binding escapes. The uses of a binding are read from the source file that
 * declares it, so an exported binding, which other files can reach, escapes
 * too.
 */
class ValueFlow {
  readonly #checker: ts.TypeChecker;
  readonly #root: ts.SignatureDeclaration;
  readonly #names: NameContext;
  readonly #escaping = new Map<ts.Symbol, boolean>();
  readonly #analyzing = new Set<ts.Symbol>();

  /**
   * Constructs an instance reading through `checker`, for a trace of what
   * `root`, a pattern's callback, returns.
   */
  constructor(checker: ts.TypeChecker, root: ts.SignatureDeclaration) {
    this.#checker = checker;
    this.#root = root;
    this.#names = { checker, flow: this };
  }

  /** Whether some use of `symbol` assigns it a new value. */
  rebound(symbol: ts.Symbol): boolean {
    return this.#uses(symbol).some(isWriteTarget);
  }

  /**
   * Whether the value `symbol` holds may reach something that could change
   * it, or `symbol` may be assigned another.
   */
  escapes(symbol: ts.Symbol): boolean {
    const known = this.#escaping.get(symbol);
    if (known !== undefined) return known;
    // A binding met again while its own uses are being read is taken not to
    // escape; any use that does escape decides the question where it is read.
    if (this.#analyzing.has(symbol)) return false;
    const declaration = symbol.valueDeclaration;
    this.#analyzing.add(symbol);
    const escapes = !declaration ||
      (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export) !==
        0 ||
      this.#uses(symbol).some((use) => !this.#reachesOnlyReads(use, symbol));
    this.#analyzing.delete(symbol);
    // An answer that took another binding not to escape holds only once the
    // question about that binding is settled, at the outermost question.
    if (escapes || this.#analyzing.size === 0) {
      this.#escaping.set(symbol, escapes);
    }
    return escapes;
  }

  /**
   * The identifiers that use `symbol` in the source file declaring it, which
   * a declaration file, holding no code, has none of.
   */
  #uses(symbol: ts.Symbol): readonly ts.Identifier[] {
    const sourceFile = (symbol.valueDeclaration ?? symbol.declarations?.[0])
      ?.getSourceFile();
    if (!sourceFile || sourceFile.isDeclarationFile) return [];
    return usesIn(sourceFile, this.#checker).get(symbol) ?? [];
  }

  /**
   * Whether the value `start` evaluates to, which is `subject`'s value or
   * holds a part of it, reaches only reads. A read uses the value without
   * changing it or keeping it where something else could: it is a part of the
   * traced result; it takes from the value a primitive, or a part that reaches
   * only reads in turn; it calls a method of an array that reads it; it passes
   * the value where its recognized receiver reads it; or it binds the value
   * to a name whose own uses are reads.
   */
  #reachesOnlyReads(start: ts.Expression, subject: ts.Symbol): boolean {
    let current = start;
    for (;;) {
      // A write into the value, or to the binding, changes what it holds.
      if (isWriteTarget(current)) return false;
      // No part of a value reaches past a primitive read from it.
      if (isPrimitive(this.#checker.getTypeAtLocation(current))) return true;
      const parent = current.parent;
      if (
        ts.isParenthesizedExpression(parent) ||
        ts.isNonNullExpression(parent) || ts.isAsExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isTypeAssertionExpression(parent) || ts.isAwaitExpression(parent) ||
        ts.isArrayLiteralExpression(parent)
      ) {
        current = parent;
        continue;
      }
      if (ts.isSpreadElement(parent)) {
        if (ts.isArrayLiteralExpression(parent.parent)) {
          current = parent.parent;
          continue;
        }
        return false;
      }
      if (
        ts.isPropertyAssignment(parent) ||
        ts.isShorthandPropertyAssignment(parent) ||
        ts.isSpreadAssignment(parent)
      ) {
        current = parent.parent;
        continue;
      }
      if (ts.isConditionalExpression(parent)) {
        if (parent.condition === current) return true;
        current = parent;
        continue;
      }
      if (ts.isBinaryExpression(parent)) {
        const operator = parent.operatorToken.kind;
        if (
          operator === ts.SyntaxKind.QuestionQuestionToken ||
          operator === ts.SyntaxKind.BarBarToken ||
          operator === ts.SyntaxKind.AmpersandAmpersandToken ||
          (operator === ts.SyntaxKind.CommaToken && parent.right === current)
        ) {
          current = parent;
          continue;
        }
        // An assignment keeps the value somewhere else. Comparison,
        // arithmetic, `in`, `instanceof`, and a discarded left operand read it.
        return !isAssignmentOperator(operator);
      }
      if (
        ts.isPropertyAccessExpression(parent) ||
        ts.isElementAccessExpression(parent)
      ) {
        const call = parent.parent;
        if (ts.isCallExpression(call) && call.expression === parent) {
          return this.#methodReads(call, subject);
        }
        // A part read from the value may be an object inside it.
        current = parent;
        continue;
      }
      if (ts.isCallExpression(parent)) {
        // Calling the value changes nothing it holds.
        return parent.expression === current ||
          this.#argumentReads(parent, subject);
      }
      if (
        ts.isReturnStatement(parent) ||
        (ts.isArrowFunction(parent) && parent.body === current)
      ) {
        const fn = ts.isArrowFunction(parent)
          ? parent
          : ts.findAncestor(parent, ts.isFunctionLike);
        return fn !== undefined && this.#returnReads(fn, subject);
      }
      if (
        (ts.isVariableDeclaration(parent) || ts.isParameter(parent) ||
          ts.isBindingElement(parent)) && parent.initializer === current
      ) {
        return this.#bindingsRead(parent.name);
      }
      if (ts.isForOfStatement(parent) && parent.expression === current) {
        const { initializer } = parent;
        return ts.isVariableDeclarationList(initializer) &&
          initializer.declarations.every((declaration) =>
            this.#bindingsRead(declaration.name)
          );
      }
      return readsInPlace(current, parent);
    }
  }

  /**
   * Whether calling the method `call` names on a value holding `subject`'s
   * reaches only reads: a method of an array that reads it, passed only
   * callbacks whose parameters, which receive its elements, reach only reads,
   * and whose result, where it holds the elements, reaches only reads.
   */
  #methodReads(call: ts.CallExpression, subject: ts.Symbol): boolean {
    const name = arrayMethodName(call, this.#checker);
    const keepsElements = name === undefined
      ? undefined
      : ARRAY_READS.get(name);
    if (keepsElements === undefined) return false;
    if (!call.arguments.every((argument) => this.#callbackReads(argument))) {
      return false;
    }
    return !keepsElements || this.#reachesOnlyReads(call, subject);
  }

  /**
   * Whether passing a value holding `subject`'s to `call` reaches only reads:
   * to another pattern, as its input; to `ifElse()`, `when()` or `unless()`,
   * whose result may be it; to a lift, whose callback's parameters receive it
   * and whose result may hold it; or to a method of an array that only
   * compares it, or keeps it in a result that reaches only reads.
   */
  #argumentReads(call: ts.CallExpression, subject: ts.Symbol): boolean {
    const checker = this.#checker;
    if (isPatternFactoryCalleeExpression(call.expression, checker)) return true;
    const kind = detectCallKind(call, checker);
    switch (kind?.kind) {
      case "ifElse":
      case "when":
      case "unless":
        return this.#reachesOnlyReads(call, subject);
      case "lift-applied":
        return this.#liftReads(getLiftAppliedInnerCall(call), call, subject);
      case "builder":
        return kind.builderName === "lift" &&
          this.#liftReads(
            liftFactoryCall(call.expression, this.#names),
            call,
            subject,
          );
      default: {
        const name = arrayMethodName(call, checker);
        if (name === undefined || !ARRAY_READS.has(name)) return false;
        return !ARGUMENT_KEPT.has(name) ||
          this.#reachesOnlyReads(call, subject);
      }
    }
  }

  /**
   * Whether a value holding `subject`'s, passed to `applied`, an application
   * of the lift `factory` makes, reaches only reads there and in what
   * `applied` returns.
   */
  #liftReads(
    factory: ts.CallExpression | undefined,
    applied: ts.CallExpression,
    subject: ts.Symbol,
  ): boolean {
    const callback = factory &&
      resolveCallback(factory.arguments[0], this.#names);
    return callback !== undefined &&
      callback.parameters.every((parameter) =>
        this.#bindingsRead(parameter.name)
      ) &&
      this.#reachesOnlyReads(applied, subject);
  }

  /**
   * Whether `argument`, passed to a method of an array, reads the elements
   * it is given: a value that is not a function, or a function the trace
   * finds whose parameters reach only reads.
   */
  #callbackReads(argument: ts.Expression): boolean {
    const callback = resolveCallback(argument, this.#names);
    if (callback) {
      return callback.parameters.every((parameter) =>
        this.#bindingsRead(parameter.name)
      );
    }
    return this.#checker.getTypeAtLocation(argument).getCallSignatures()
      .length === 0;
  }

  /**
   * Whether a value holding `subject`'s, returned by `fn`, reaches only reads.
   * What the pattern's callback returns is the result. A binding `fn` itself
   * declares holds what each call gives it, so the call the trace follows
   * decides where that goes. A value from outside `fn` outlives the call, so
   * where `fn`'s result goes decides it, which the trace knows for a callback
   * written into a `computed()`, another pattern, or a method of an array it
   * recognizes.
   */
  #returnReads(fn: ts.SignatureDeclaration, subject: ts.Symbol): boolean {
    const declaration = subject.valueDeclaration;
    if (
      fn === this.#root ||
      (declaration !== undefined &&
        ts.findAncestor(declaration, (node) => node === fn) !== undefined)
    ) {
      return true;
    }
    const site = fn.parent;
    if (!ts.isCallExpression(site) || !site.arguments.some((a) => a === fn)) {
      return false;
    }
    const kind = detectCallKind(site, this.#checker);
    if (kind?.kind === "builder") {
      return kind.builderName === "pattern" ||
        (kind.builderName === "computed" &&
          this.#reachesOnlyReads(site, subject));
    }
    const name = arrayMethodName(site, this.#checker);
    if (name === undefined || !ARRAY_READS.has(name)) return false;
    return !CALLBACK_RESULT_KEPT.has(name) ||
      this.#reachesOnlyReads(site, subject);
  }

  /** Whether every name `name` binds reaches only reads. */
  #bindingsRead(name: ts.BindingName): boolean {
    if (ts.isIdentifier(name)) {
      const symbol = this.#checker.getSymbolAtLocation(name);
      return symbol !== undefined && !this.escapes(symbol);
    }
    return name.elements.every((element) =>
      ts.isOmittedExpression(element) || this.#bindingsRead(element.name)
    );
  }
}

/**
 * Whether the value `current` evaluates to is only read where its parent
 * `parent` uses it, without being passed further: as a computed key, or under
 * `!`, `typeof`, `void` or `delete`; as a statement whose value is discarded,
 * or what an `if`, a `while`, a `do`, a `switch` or a `case` tests;
 * interpolated into a string, or rendered as JSX by an attribute that does not
 * bind it.
 */
function readsInPlace(current: ts.Expression, parent: ts.Node): boolean {
  if (
    ts.isComputedPropertyName(parent) || ts.isPrefixUnaryExpression(parent) ||
    ts.isTypeOfExpression(parent) || ts.isVoidExpression(parent) ||
    ts.isDeleteExpression(parent) || ts.isExpressionStatement(parent) ||
    ts.isJsxSpreadAttribute(parent)
  ) {
    return true;
  }
  if (
    ts.isIfStatement(parent) || ts.isWhileStatement(parent) ||
    ts.isDoStatement(parent) || ts.isSwitchStatement(parent) ||
    ts.isCaseClause(parent)
  ) {
    return parent.expression === current;
  }
  if (ts.isForInStatement(parent)) return parent.expression === current;
  // A tag receives the values interpolated into its template.
  if (ts.isTemplateSpan(parent)) {
    return !ts.isTaggedTemplateExpression(parent.parent.parent);
  }
  if (ts.isJsxExpression(parent)) {
    const attribute = parent.parent;
    return !ts.isJsxAttribute(attribute) ||
      !(ts.isIdentifier(attribute.name) &&
        attribute.name.text.startsWith("$"));
  }
  return false;
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

/** Whether every value of `type` is a primitive, which holds no reference. */
function isPrimitive(type: ts.Type): boolean {
  return type.isUnion()
    ? type.types.every(isPrimitive)
    : (type.flags & PRIMITIVE_FLAGS) !== 0;
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
