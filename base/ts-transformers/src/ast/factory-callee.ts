import ts from "typescript";
import {
  detectTrustedFactoryType,
  type FactoryTypeInfo,
} from "@commonfabric/schema-generator";

import { detectCallKind } from "./call-kind.ts";
import { getCallbackBoundarySemantics } from "../policy/callback-boundary.ts";
import { unwrapExpression } from "../utils/expression.ts";

export type FactoryValueOrigin =
  | "live"
  | "symbolic"
  | "runtime-materialized"
  | "unknown";

export type FactoryCallExposure =
  | "symbolic"
  | "runtime-materialized"
  | "mixed"
  | "unknown";

type ScheduledCallback =
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.FunctionDeclaration;

const referencedFunctionExposureCache = new WeakMap<
  ts.TypeChecker,
  WeakMap<ScheduledCallback, FactoryCallExposure | "unreferenced">
>();

export interface FactoryCalleeClassification {
  readonly members: readonly FactoryTypeInfo[];
  readonly hasNonFactoryMember: boolean;
  readonly origin: FactoryValueOrigin;
}

export type FactoryCallTargetClassification =
  | {
    readonly kind: "invocation" | "ambiguous" | "derivation";
    readonly factory: FactoryCalleeClassification;
  }
  | { readonly kind: "not-factory" };

/** The only public calls that derive a factory rather than invoke one. */
export function isFactoryModifierAccess(
  expression: ts.Expression,
): expression is ts.PropertyAccessExpression {
  return ts.isPropertyAccessExpression(expression) &&
    (expression.name.text === "asScope" || expression.name.text === "inSpace");
}

/**
 * Give every transformer one answer for whether a call invokes a factory,
 * derives a factory, is an ambiguous callable union, or is unrelated.
 */
export function classifyFactoryCallTarget(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): FactoryCallTargetClassification {
  const callee = unwrapExpression(call.expression);
  if (isFactoryModifierAccess(callee)) {
    const derived = classifyFactoryCallee(call, checker) ??
      classifyFactoryCallee(callee.expression, checker);
    if (derived) return { kind: "derivation", factory: derived };
  }

  const invoked = classifyFactoryCallee(callee, checker);
  if (!invoked) return { kind: "not-factory" };
  return {
    kind: invoked.hasNonFactoryMember ? "ambiguous" : "invocation",
    factory: invoked,
  };
}

/**
 * Classify a callable factory independently along its two relevant axes:
 * public factory contract and execution origin. A factory type does not by
 * itself say whether calling the value is safe: eager pattern roots carry a
 * symbolic Cell/link binding, while scheduled callbacks receive a
 * runner-materialized callable.
 */
export function classifyFactoryCallee(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): FactoryCalleeClassification | undefined {
  const target = unwrapExpression(expression);
  let type: ts.Type;
  try {
    type = checker.getTypeAtLocation(target);
  } catch {
    return undefined;
  }

  const memberTypes = type.isUnion() ? type.types : [type];
  const members: FactoryTypeInfo[] = [];
  let hasNonFactoryMember = false;
  for (const memberType of memberTypes) {
    if (
      (memberType.flags &
        (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never)) !== 0
    ) {
      continue;
    }
    const member = detectTrustedFactoryType(memberType, checker);
    if (member) {
      members.push(member);
    } else {
      hasNonFactoryMember = true;
    }
  }
  if (members.length === 0) return undefined;

  return {
    members,
    hasNonFactoryMember,
    origin: classifyFactoryValueOrigin(target, checker, new Set()),
  };
}

/**
 * A lexical capture from an eager root becomes an explicit scheduled input
 * when ClosureTransformer lowers a lift/computed/handler/action callback. The
 * runner materializes that input before authored code runs, so the call stays
 * direct even though its pre-lowering lexical origin was symbolic.
 */
export function isInsideFactoryMaterializationBoundary(
  node: ts.Node,
  checker: ts.TypeChecker,
): boolean {
  return classifyFactoryCallExposure(node, checker) === "runtime-materialized";
}

/** Return the nearest execution boundary that decides factory exposure. */
export function classifyFactoryCallExposure(
  node: ts.Node,
  checker: ts.TypeChecker,
): FactoryCallExposure | undefined {
  return classifyFactoryCallExposureInternal(node, checker, new Set());
}

function classifyFactoryCallExposureInternal(
  node: ts.Node,
  checker: ts.TypeChecker,
  activeCallbacks: Set<ScheduledCallback>,
): FactoryCallExposure | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isArrowFunction(current) || ts.isFunctionExpression(current) ||
      ts.isFunctionDeclaration(current)
    ) {
      const semantics = ts.isFunctionDeclaration(current)
        ? undefined
        : getCallbackBoundarySemantics(current, checker);
      if (semantics?.decision.kind === "supported") {
        switch (semantics.decision.boundaryKind) {
          case "lift-builder":
          case "lift-applied":
          case "computed-builder":
          case "handler-builder":
          case "action-builder":
          case "event-handler":
            return "runtime-materialized";
          case "pattern-builder":
          case "render-builder":
            return "symbolic";
          case "reactive-array-method":
            // Array callbacks do not decide how a captured factory is
            // delivered. Keep walking: an enclosing computed/lift/handler
            // materializes it before this callback runs, while an enclosing
            // eager pattern root leaves it symbolic.
            break;
          default:
            break;
        }
      }
      const referenced = classifyReferencedFunctionExposure(
        current,
        checker,
        activeCallbacks,
      );
      if (referenced) return referenced;
      if (
        ts.isFunctionDeclaration(current) ||
        isStableFunctionInitializer(current)
      ) {
        // A stable helper with no locally provable entry site may be exported
        // or called from another source file. Do not guess one exposure mode.
        return "unknown";
      }
    }
    current = current.parent;
  }
  return undefined;
}

function classifyFactoryValueOrigin(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seenSymbols: Set<ts.Symbol>,
): FactoryValueOrigin {
  const target = unwrapExpression(expression);

  if (ts.isPropertyAccessExpression(target)) {
    return classifyFactoryValueOrigin(target.expression, checker, seenSymbols);
  }
  if (ts.isElementAccessExpression(target)) {
    return classifyFactoryValueOrigin(target.expression, checker, seenSymbols);
  }
  if (ts.isConditionalExpression(target)) {
    return combineOrigins(
      classifyFactoryValueOrigin(
        target.whenTrue,
        checker,
        new Set(seenSymbols),
      ),
      classifyFactoryValueOrigin(
        target.whenFalse,
        checker,
        new Set(seenSymbols),
      ),
    );
  }
  if (ts.isCallExpression(target)) {
    const callKind = detectCallKind(target, checker);
    if (callKind?.kind === "builder") return "live";

    const callee = unwrapExpression(target.expression);
    if (
      ts.isPropertyAccessExpression(callee) &&
      (callee.name.text === "asScope" || callee.name.text === "inSpace")
    ) {
      return classifyFactoryValueOrigin(
        callee.expression,
        checker,
        seenSymbols,
      );
    }
    return "unknown";
  }
  if (!ts.isIdentifier(target)) return "unknown";

  let symbol: ts.Symbol | undefined;
  try {
    symbol = checker.getSymbolAtLocation(target) ?? undefined;
  } catch {
    return "unknown";
  }
  if (!symbol) return "unknown";

  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    return "live";
  }
  if (seenSymbols.has(symbol)) return "unknown";
  seenSymbols.add(symbol);

  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration) return "unknown";

  if (
    ts.isImportSpecifier(declaration) ||
    ts.isImportClause(declaration) ||
    ts.isNamespaceImport(declaration) ||
    ts.isImportEqualsDeclaration(declaration)
  ) {
    return "live";
  }

  const parameter = findOwningParameter(declaration);
  if (parameter) return classifyParameterOrigin(parameter, checker);

  if (ts.isVariableDeclaration(declaration)) {
    if (isModuleScopedDeclaration(declaration)) return "live";
    if (crossesSymbolicCallbackBoundary(target, declaration, checker)) {
      return "symbolic";
    }
    if (isConstVariableDeclaration(declaration) && declaration.initializer) {
      return classifyFactoryValueOrigin(
        declaration.initializer,
        checker,
        seenSymbols,
      );
    }
    return "unknown";
  }

  if (ts.isBindingElement(declaration)) {
    const variable = findOwningVariableDeclaration(declaration);
    if (!variable?.initializer) return "unknown";
    if (isModuleScopedDeclaration(variable)) return "live";
    if (!isConstVariableDeclaration(variable)) return "unknown";
    return classifyFactoryValueOrigin(
      variable.initializer,
      checker,
      seenSymbols,
    );
  }

  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isClassDeclaration(declaration) ||
    ts.isEnumDeclaration(declaration)
  ) {
    return "live";
  }

  return "unknown";
}

/**
 * Closure conversion moves a local binding captured by a deeper eager pattern
 * callback into that callback's private argument-1 record. Even when the
 * binding was initialized by a live builder call, its use inside the deeper
 * callback is therefore a symbolic factory input until the runner
 * materializes that pattern generation.
 */
function crossesSymbolicCallbackBoundary(
  useSite: ts.Node,
  declaration: ts.Declaration,
  checker: ts.TypeChecker,
): boolean {
  let current: ts.Node | undefined = useSite.parent;
  while (current) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const semantics = getCallbackBoundarySemantics(current, checker);
      if (
        semantics.decision.kind === "supported" &&
        (semantics.decision.boundaryKind === "pattern-builder" ||
          semantics.decision.boundaryKind === "render-builder")
      ) {
        return !isDescendantOf(declaration, current);
      }
    }
    current = current.parent;
  }
  return false;
}

function isDescendantOf(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function classifyParameterOrigin(
  parameter: ts.ParameterDeclaration,
  checker: ts.TypeChecker,
): FactoryValueOrigin {
  const owner = parameter.parent;
  if (
    !ts.isArrowFunction(owner) && !ts.isFunctionExpression(owner) &&
    !ts.isFunctionDeclaration(owner)
  ) {
    return "unknown";
  }
  const referenced = classifyReferencedFunctionExposure(
    owner,
    checker,
    new Set(),
  );
  if (referenced === "runtime-materialized") return referenced;
  if (referenced === "symbolic") return referenced;
  if (referenced === "mixed" || referenced === "unknown") return "unknown";
  if (ts.isFunctionDeclaration(owner)) return "unknown";
  const semantics = getCallbackBoundarySemantics(owner, checker);
  if (semantics.decision.kind !== "supported") return "unknown";

  switch (semantics.decision.boundaryKind) {
    case "pattern-builder":
    case "render-builder":
      return owner.parameters.indexOf(parameter) <= 1 ? "symbolic" : "unknown";
    case "lift-builder":
    case "lift-applied":
    case "computed-builder":
    case "handler-builder":
    case "action-builder":
    case "event-handler":
      return "runtime-materialized";
    default:
      return "unknown";
  }
}

/**
 * Referenced callbacks and helpers are not syntactically nested in their call
 * sites, so ordinary ancestor-based policy cannot see their execution mode.
 * Resolve stable local references and combine every external entry site. A
 * helper used from both eager and scheduled code is deliberately "mixed": its
 * body cannot choose one lowering without specialization.
 */
function classifyReferencedFunctionExposure(
  callback: ScheduledCallback,
  checker: ts.TypeChecker,
  activeCallbacks: Set<ScheduledCallback>,
): FactoryCallExposure | undefined {
  let checkerCache = referencedFunctionExposureCache.get(checker);
  if (!checkerCache) {
    checkerCache = new WeakMap();
    referencedFunctionExposureCache.set(checker, checkerCache);
  }
  const cached = checkerCache.get(callback);
  if (cached !== undefined) {
    return cached === "unreferenced" ? undefined : cached;
  }
  if (activeCallbacks.has(callback)) return "unknown";
  activeCallbacks.add(callback);

  let scheduled = false;
  let symbolic = false;
  let unknown = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callKind = detectCallKind(node, checker);
      if (
        callKind?.kind === "builder" &&
        (callKind.builderName === "lift" ||
          callKind.builderName === "handler" ||
          callKind.builderName === "computed" ||
          callKind.builderName === "action" ||
          callKind.builderName === "pattern" ||
          callKind.builderName === "render")
      ) {
        const ownsCallback = node.arguments.some((argument) =>
          resolveCallbackReference(argument, checker, new Set()) === callback
        );
        if (ownsCallback) {
          if (
            callKind.builderName === "pattern" ||
            callKind.builderName === "render"
          ) {
            symbolic = true;
          } else {
            scheduled = true;
          }
        }
      }

      const called = resolveCallbackReference(
        node.expression,
        checker,
        new Set(),
      );
      if (
        called && sameCallback(called, callback) &&
        !isDescendantOf(node, callback)
      ) {
        const exposure = classifyFactoryCallExposureInternal(
          node,
          checker,
          activeCallbacks,
        );
        switch (exposure) {
          case "runtime-materialized":
            scheduled = true;
            break;
          case "symbolic":
            symbolic = true;
            break;
          case "mixed":
            scheduled = true;
            symbolic = true;
            break;
          case "unknown":
          case undefined:
            unknown = true;
            break;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  try {
    visit(callback.getSourceFile());
  } finally {
    activeCallbacks.delete(callback);
  }

  const exposure: FactoryCallExposure | "unreferenced" = scheduled && symbolic
    ? "mixed"
    : unknown
    ? "unknown"
    : scheduled
    ? "runtime-materialized"
    : symbolic
    ? "symbolic"
    : "unreferenced";
  checkerCache.set(callback, exposure);
  return exposure === "unreferenced" ? undefined : exposure;
}

function isStableFunctionInitializer(callback: ScheduledCallback): boolean {
  return !ts.isFunctionDeclaration(callback) &&
    ts.isVariableDeclaration(callback.parent) &&
    callback.parent.initializer === callback;
}

function sameCallback(
  left: ScheduledCallback,
  right: ScheduledCallback,
): boolean {
  return left === right ||
    ts.getOriginalNode(left) === ts.getOriginalNode(right);
}

function resolveCallbackReference(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Node>,
): ScheduledCallback | undefined {
  const target = unwrapExpression(expression);
  if (seen.has(target)) return undefined;
  seen.add(target);

  if (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) {
    return target;
  }
  if (
    ts.isCallExpression(target) && target.arguments.length === 1 &&
    ts.isIdentifier(unwrapExpression(target.expression)) &&
    (unwrapExpression(target.expression) as ts.Identifier).text.startsWith(
      "__cfHardenFn",
    )
  ) {
    return resolveCallbackReference(target.arguments[0]!, checker, seen);
  }
  if (!ts.isIdentifier(target)) return undefined;

  let symbol = checker.getSymbolAtLocation(target);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      symbol = checker.getAliasedSymbol(symbol);
    } catch {
      return undefined;
    }
  }
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (declaration && ts.isFunctionDeclaration(declaration)) {
    return declaration;
  }
  if (
    declaration && ts.isVariableDeclaration(declaration) &&
    declaration.initializer
  ) {
    return resolveCallbackReference(declaration.initializer, checker, seen);
  }
  return undefined;
}

function findOwningParameter(
  declaration: ts.Declaration,
): ts.ParameterDeclaration | undefined {
  let current: ts.Node | undefined = declaration;
  while (current && !ts.isFunctionLike(current)) {
    if (ts.isParameter(current)) return current;
    if (
      !ts.isBindingElement(current) &&
      !ts.isObjectBindingPattern(current) &&
      !ts.isArrayBindingPattern(current)
    ) {
      return undefined;
    }
    current = current.parent;
  }
  return undefined;
}

function findOwningVariableDeclaration(
  declaration: ts.BindingElement,
): ts.VariableDeclaration | undefined {
  let current: ts.Node | undefined = declaration.parent;
  while (current) {
    if (ts.isVariableDeclaration(current)) return current;
    if (
      !ts.isBindingElement(current) &&
      !ts.isObjectBindingPattern(current) &&
      !ts.isArrayBindingPattern(current)
    ) {
      return undefined;
    }
    current = current.parent;
  }
  return undefined;
}

function isConstVariableDeclaration(
  declaration: ts.VariableDeclaration,
): boolean {
  return ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
}

function isModuleScopedDeclaration(
  declaration: ts.VariableDeclaration,
): boolean {
  const statement = declaration.parent.parent;
  return !!statement && statement.parent?.kind === ts.SyntaxKind.SourceFile;
}

function combineOrigins(
  left: FactoryValueOrigin,
  right: FactoryValueOrigin,
): FactoryValueOrigin {
  return left === right ? left : "unknown";
}
