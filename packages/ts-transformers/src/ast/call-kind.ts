/**
 * Call Kind Detection
 *
 * This module identifies compiler-significant call families. Most are
 * Common Fabric-specific calls (lift, ifElse, pattern, etc.), but array-method
 * families are also classified because they establish callback/container
 * boundaries relevant to analysis and lowering.
 *
 * ## Detection Strategy
 *
 * Detection is provenance-first for Common Fabric calls:
 *
 * 1. **Symbol resolution**: Resolve the callee symbol and verify it comes from
 *    Common Fabric declarations or imports.
 *
 * 2. **Alias following**: Follow stable const aliases and call signatures to
 *    preserve detection for `const alias = lift` and `declare const alias:
 *    typeof ifElse` style code.
 *
 * 3. **Synthetic helper support**: Recognize internal `__cfHelpers.*` calls
 *    introduced by the transformer pipeline when symbol resolution is not
 *    available on synthetic nodes.
 *
 * ## Narrow Exceptions
 *
 * The remaining syntactic fallback is intentionally limited to synthetic
 * `__cfHelpers.*` calls, unresolved bare builder identifiers, and explicit
 * reactive array-method receiver checks. Plain array methods share the same
 * syntax family but require separate ownership classification; consumers
 * should use `classifyArrayMethodCallSite(...)` when that distinction matters.
 */

import ts from "typescript";

import { isCommonFabricSymbol } from "@commonfabric/schema-generator/common-fabric-symbols";
import { spellingsWhere } from "@commonfabric/schema-generator/wrapper-names";
import { TwoLevelWeakCache } from "@commonfabric/utils/two-level-weak-cache";
import { CF_HELPERS_IDENTIFIER } from "../core/cf-helpers.ts";
import { isTransparentWrapper, unwrapExpression } from "../utils/expression.ts";
import { getCallArgumentPosition } from "./call-arguments.ts";
import { getEnclosingFunctionLikeDeclaration } from "./function-predicates.ts";
import {
  builderNameForExportName,
  COMMONFABRIC_BUILDER_EXPORT_NAMES,
  COMMONFABRIC_CALL_EXPORT_NAMES,
  COMMONFABRIC_REACTIVE_ORIGIN_BUILDER_NAMES,
  COMMONFABRIC_REACTIVE_ORIGIN_CALL_EXPORT_NAMES,
  COMMONFABRIC_RUNTIME_EXPORTS_BY_NAME,
} from "../core/commonfabric-runtime-registry.ts";
import { getCellKind, isBrandedCellType } from "../transformers/cell-type.ts";
import { classifyOpaquePathTerminalCall } from "../transformers/opaque-roots.ts";
import {
  getTypeAtLocationWithFallback,
  getVariableInitializer,
  isSyntheticNode,
} from "./utils.ts";
import { isCollectionType } from "./type-inference.ts";

const BUILDER_SYMBOL_NAMES = COMMONFABRIC_BUILDER_EXPORT_NAMES;

const ARRAY_OWNER_NAMES = new Set([
  "Array",
  "ReadonlyArray",
]);

// Wrapper spellings whose method calls classify as cell-like (get/set/etc.).
const CELL_LIKE_CLASSES = spellingsWhere({
  Cell: true,
  Writable: true,
  OpaqueCell: true,
  Stream: true,
  ComparableCell: true,
  ReadonlyCell: true,
  WriteonlyCell: true,
  CellTypeConstructor: true,
  ScopedCellTypeConstructor: true,
  SqliteDb: false,
  Reactive: false,
});

const CELL_FACTORY_NAMES = new Set(["of"]);
const CELL_FOR_NAMES = new Set(["for"]);
const CELL_SCOPED_CONSTRUCTOR_NAMES = new Set([
  "perSpace",
  "perUser",
  "perSession",
]);
const COMMONFABRIC_CALL_NAMES = COMMONFABRIC_CALL_EXPORT_NAMES;
const WILDCARD_OBJECT_METHOD_NAMES = new Set(["keys", "values", "entries"]);
export const FUNCTION_HARDENING_HELPER_PREFIX = "__cfHardenFn";

/**
 * Prefix for the module-scope const a hoisted `lift(...)` call is bound to
 * (CT-1644, Phase 2 of derive→lift→selfcontained). The whole lift call —
 * schemas + callback — is hoisted to `const __cfLift_N = __cfHelpers.lift(...)`
 * and the original site becomes `__cfLift_N(captures)`.
 */
export const SYNTHETIC_LIFT_HOIST_PREFIX = "__cfLift";

/**
 * Prefix for the module-scope const a hoisted `handler(...)` call is bound to
 * (CT-1655, extending CT-1644's whole-call hoisting to handler). The handler is
 * emitted in the lift-applied shape `__cfHelpers.handler(eventSchema,
 * stateSchema, cb)(captures)`; the inner `handler(...)` call is hoisted to
 * `const __cfHandler_N = __cfHelpers.handler(...)` and the original site becomes
 * `__cfHandler_N(captures)`. Mechanically identical to lift hoisting, but the
 * applied call keeps classifying as `{ kind: "builder", builderName: "handler" }`
 * (NOT `lift-applied`) so existing handler-specific dispatchers are unaffected.
 */
export const SYNTHETIC_HANDLER_HOIST_PREFIX = "__cfHandler";

/**
 * Prefix for the module-scope const a hoisted `pattern(...)` call is bound to
 * (CT-1655). Pattern's hoist differs from lift/handler: the bare
 * `__cfHelpers.pattern(cb, inputSchema, outputSchema)` call sits in the FIRST
 * argument of an enclosing `receiver.mapWithPattern(pattern(...), { params })`
 * call (per-instance captures flow through the params object, the second
 * argument). The bare pattern call is hoisted to
 * `const __cfPattern_N = __cfHelpers.pattern(...)` and the `*WithPattern` call's
 * first argument is rewritten to `__cfPattern_N`. The top-level
 * `export default pattern(...)` is a direct call (not a `*WithPattern`
 * argument) and is NOT hoisted.
 */
export const SYNTHETIC_PATTERN_HOIST_PREFIX = "__cfPattern";

export type ArrayMethodFamilyName =
  | "map"
  | "filter"
  | "flatMap"
  | "count"
  | "minBy"
  | "maxBy"
  | "groupBy"
  | "keyBy";

export interface ArrayMethodAccessKind {
  readonly family: ArrayMethodFamilyName;
  readonly lowered: boolean;
}

const ARRAY_METHOD_ACCESS_BY_NAME = new Map<string, ArrayMethodAccessKind>([
  ["map", { family: "map", lowered: false }],
  ["mapWithPattern", { family: "map", lowered: true }],
  ["filter", { family: "filter", lowered: false }],
  ["filterWithPattern", { family: "filter", lowered: true }],
  ["flatMap", { family: "flatMap", lowered: false }],
  ["flatMapWithPattern", { family: "flatMap", lowered: true }],
  ["count", { family: "count", lowered: false }],
  ["countWithPattern", { family: "count", lowered: true }],
  ["minBy", { family: "minBy", lowered: false }],
  ["minByWithPattern", { family: "minBy", lowered: true }],
  ["maxBy", { family: "maxBy", lowered: false }],
  ["maxByWithPattern", { family: "maxBy", lowered: true }],
  ["groupBy", { family: "groupBy", lowered: false }],
  ["groupByWithPattern", { family: "groupBy", lowered: true }],
  ["keyBy", { family: "keyBy", lowered: false }],
  ["keyByWithPattern", { family: "keyBy", lowered: true }],
]);

function getArrayMethodAccessKindByName(
  name: string,
): ArrayMethodAccessKind | undefined {
  return ARRAY_METHOD_ACCESS_BY_NAME.get(name);
}

function isKnownArrayMethodName(name: string): boolean {
  return ARRAY_METHOD_ACCESS_BY_NAME.has(name);
}

export type ArrayMethodOwnership = "plain" | "reactive";

export interface ArrayMethodCallSiteInfo extends ArrayMethodAccessKind {
  readonly ownership: ArrayMethodOwnership;
}

export interface ReactiveCollectionProvenanceOptions {
  readonly allowTypeBasedRoot?: boolean;
  readonly allowImplicitReactiveParameters?: boolean;
  readonly allowReactiveArrayCallbackParameters?: boolean;
  readonly sameScope?: ts.FunctionLikeDeclaration;
  readonly typeRegistry?: WeakMap<ts.Node, ts.Type>;
  readonly syntheticReactiveCollectionRegistry?: WeakSet<ts.Symbol>;

  /**
   * True once the walk has descended into a variable declaration's initializer
   * (CT-1778). The derived-reactive-collection-call recognition is gated on this
   * because only a `const x = helper(reactiveArgs)` *binding* is lift-wrapped into
   * a reactive collection; the same call used inline as a `.map` receiver
   * (`helper(reactiveArgs).map(...)`) is NOT wrapped and stays a plain array, so
   * lowering its `.map` would emit a `.mapWithPattern` the runtime value lacks.
   */
  readonly viaVariableInitializer?: boolean;
}

export type ArrayCallbackContainerCallKind =
  | "reactive-array-method"
  | "plain-array-value"
  | "plain-array-void";

type ImplicitReactiveParameterContextKind =
  | "builder"
  | "reactive-array-method";

export interface ArrayMethodResultSinkCallInfo {
  readonly sink: "join";
  readonly receiverFamily: ArrayMethodFamilyName;
  readonly receiverLowered: boolean;
}

export interface ArrayMethodResultSinkReceiverChainCallInfo {
  readonly sinkCall: ArrayMethodResultSinkCallInfo;
  readonly depth: number;
}

export type CallKind =
  | { kind: "ifElse"; symbol?: ts.Symbol }
  | { kind: "when"; symbol?: ts.Symbol }
  | { kind: "unless"; symbol?: ts.Symbol }
  | { kind: "builder"; symbol?: ts.Symbol; builderName: string }
  | { kind: "array-method"; symbol?: ts.Symbol }
  // "lift-applied" labels a __cfHelpers.lift(...)(input) call shape — the
  // canonical lowered form for reactive lifted-function computations,
  // established by CT-1615. The historic discriminator was "derive" (the
  // builder name the transformer used to emit before Phase 1); the
  // discriminator was renamed in the mechanical rename step of CT-1615.
  // detectCallKind also classifies an unapplied __cfHelpers.lift(...) call
  // (no curry) as { kind: "builder", builderName: "lift" }, so the two
  // are distinguishable at dispatch.
  | { kind: "lift-applied"; symbol?: ts.Symbol }
  | { kind: "cell-factory"; symbol?: ts.Symbol; factoryName: string }
  | { kind: "cell-for"; symbol?: ts.Symbol }
  | { kind: "wish"; symbol?: ts.Symbol }
  | { kind: "generate-text"; symbol?: ts.Symbol }
  | { kind: "generate-object"; symbol?: ts.Symbol }
  | { kind: "pattern-tool"; symbol?: ts.Symbol }
  | {
    kind: "runtime-call";
    symbol?: ts.Symbol;
    exportName: string;
    reactiveOrigin: boolean;
  };

export type WildcardTraversalCallKind =
  | "object-wildcard-traversal"
  | "json-stringify";

type ExpressionCache<T> = TwoLevelWeakCache<ts.TypeChecker, ts.Expression, T>;

const callKindCache: ExpressionCache<CallKind | null> = new TwoLevelWeakCache();
const directBuilderKindCache: ExpressionCache<
  Extract<CallKind, { kind: "builder" }> | null
> = new TwoLevelWeakCache();
const reactiveValueCache: ExpressionCache<boolean> = new TwoLevelWeakCache();
const reactiveCollectionProvenanceCache: ExpressionCache<boolean> =
  new TwoLevelWeakCache();

function usesDefaultReactiveCollectionProvenanceOptions(
  options: ReactiveCollectionProvenanceOptions,
): boolean {
  return options.allowTypeBasedRoot === undefined &&
    options.allowImplicitReactiveParameters === undefined &&
    options.allowReactiveArrayCallbackParameters === undefined &&
    options.sameScope === undefined &&
    options.typeRegistry === undefined &&
    options.syntheticReactiveCollectionRegistry === undefined &&
    options.viaVariableInitializer === undefined;
}

export function detectCallKind(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): CallKind | undefined {
  return resolveExpressionKind(call.expression, checker, new Set());
}

export function detectNewExpressionKind(
  node: ts.NewExpression,
  checker: ts.TypeChecker,
): Extract<CallKind, { kind: "cell-factory" }> | undefined {
  const factoryName = detectCellConstructorExpressionName(
    node.expression,
    checker,
    new Set(),
  );
  if (!factoryName) return undefined;
  return { kind: "cell-factory", factoryName };
}

export function detectDirectBuilderCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): Extract<CallKind, { kind: "builder" }> | undefined {
  return resolveBuilderExpressionKind(
    call.expression,
    checker,
    new Set(),
    { followFactoryResults: false },
  );
}

export function isPatternBuilderCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const builderKind = detectDirectBuilderCall(call, checker);
  if (builderKind?.builderName === "pattern") {
    return true;
  }

  const target = stripWrappers(call.expression);
  return ts.isPropertyAccessExpression(target) &&
    target.name.text === "pattern";
}

export function getPatternBuilderCallbackArgument(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  if (!isPatternBuilderCall(call, checker)) {
    return undefined;
  }

  const callbackArg = call.arguments[0];
  return callbackArg
    ? resolveCallbackFunctionExpression(callbackArg, checker)
    : undefined;
}

export function getPatternToolCallbackArgument(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  const callKind = detectCallKind(call, checker);
  if (callKind?.kind !== "pattern-tool") {
    const target = stripWrappers(call.expression);
    if (
      !ts.isPropertyAccessExpression(target) ||
      target.name.text !== "patternTool"
    ) {
      return undefined;
    }
  }

  const callbackArg = call.arguments[0];
  return callbackArg
    ? resolveCallbackFunctionExpression(callbackArg, checker)
    : undefined;
}

/**
 * If `call` is a lowered reactive array-method call in the `*WithPattern`
 * family — `mapWithPattern` / `filterWithPattern` / `flatMapWithPattern`, and
 * any future lowered array method registered with `lowered: true` — whose FIRST
 * argument is a bare `pattern(...)` builder call, return that inner pattern call
 * (the hoistable unit). Otherwise return undefined. Recognition keys on the
 * array-method family's `lowered` flag, not a hardcoded method name, so new
 * `*WithPattern` lowerings are picked up automatically. The canonical shape is
 * `receiver.mapWithPattern(pattern(...), { params })`.
 *
 * This is how the hoisting stage finds the pattern call to relocate (CT-1655):
 * unlike lift/handler, the pattern call is not *applied* — it sits in the first
 * argument position of the enclosing `*WithPattern` call, with per-instance
 * captures threaded through that call's SECOND argument (the params object).
 * So the bare `pattern(...)` is capture-free and safe to evaluate once at
 * module scope. The top-level `export default pattern(...)` is a direct call,
 * not a `*WithPattern` argument, so it is naturally excluded.
 */
export function getWithPatternHoistablePatternCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): ts.CallExpression | undefined {
  const callee = stripWrappers(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || !isSyntheticNode(callee)) {
    return undefined;
  }
  const accessKind = getArrayMethodAccessKindByName(callee.name.text);
  if (!accessKind?.lowered) {
    return undefined;
  }
  const firstArg = call.arguments[0];
  if (!firstArg) {
    return undefined;
  }
  const patternCall = stripWrappers(firstArg);
  if (
    !ts.isCallExpression(patternCall) ||
    !isPatternBuilderCall(patternCall, checker)
  ) {
    return undefined;
  }
  return patternCall;
}

/**
 * If `call` is a `patternTool(pattern(...), extraParams?)` call whose FIRST
 * argument is a bare `pattern(...)` builder call, return that inner pattern call
 * (the hoistable unit). Otherwise return undefined.
 *
 * Sibling of {@link getWithPatternHoistablePatternCall}: same hoist mechanic
 * (relocate the bare pattern call sitting in argument 0, leaving the enclosing
 * call's callee and remaining arguments intact), different enclosing call shape.
 * Per-instance values flow through patternTool's SECOND argument (`extraParams`)
 * and module-scoped reactive reads are absorbed by the pattern itself, so the
 * bare `pattern(...)` is capture-free and safe to evaluate once at module scope.
 * As of CT-1655 patternTool's first argument must be a pattern (enforced by
 * PatternContextValidation), so this recognizer covers every reactive
 * patternTool.
 */
export function getPatternToolHoistablePatternCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): ts.CallExpression | undefined {
  if (detectCallKind(call, checker)?.kind !== "pattern-tool") {
    return undefined;
  }
  const firstArg = call.arguments[0];
  if (!firstArg) {
    return undefined;
  }
  const patternCall = stripWrappers(firstArg);
  if (
    !ts.isCallExpression(patternCall) ||
    !isPatternBuilderCall(patternCall, checker)
  ) {
    return undefined;
  }
  return patternCall;
}

/** The verb builders, and the type-argument slot each names its result in. */
const VERB_RESULT_TYPE_ARG_SLOT = {
  action: 1,
  handler: 2,
} as const;

/** A builder whose call may declare a verb result. */
export type VerbBuilderName = keyof typeof VERB_RESULT_TYPE_ARG_SLOT;

/**
 * The type node naming a verb's declared result, or undefined when the verb
 * declares none.
 *
 * A result is opt-in by explicit type argument — `action<Event, Result>` /
 * `handler<Event, State, Result>` (api `ActionFunction` / `HandlerFunction`) —
 * and never inferred: the `=> any` overloads absorb every callback first, so a
 * concise arrow body whose completion value happens to be a cell declares
 * nothing. An absent type-argument list, a short one, and an explicit `void`
 * all name the value-less verb.
 */
export function declaredVerbResultTypeNode(
  call: ts.CallExpression,
  builderName: VerbBuilderName,
): ts.TypeNode | undefined {
  const typeArg = call.typeArguments?.[VERB_RESULT_TYPE_ARG_SLOT[builderName]];
  if (!typeArg) return undefined;
  return typeArg.kind === ts.SyntaxKind.VoidKeyword ? undefined : typeArg;
}

export function getCapabilitySummaryCallbackArgument(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  const callKind = detectCallKind(call, checker);
  if (!callKind) return undefined;

  let callbackArg: ts.Expression | undefined;
  if (callKind.kind === "lift-applied") {
    // Lift is function-first: `lift(cb, argSchema?, resultSchema?, options?)`.
    // Schemas and scheduler options may trail the callback on the inner call.
    callbackArg = getLiftAppliedInnerCall(call)?.arguments[0];
  } else if (
    callKind.kind === "builder" &&
    (
      callKind.builderName === "lift" ||
      callKind.builderName === "handler" ||
      callKind.builderName === "computed" ||
      callKind.builderName === "action"
    )
  ) {
    callbackArg = call.arguments[0];
  }

  return callbackArg
    ? resolveCallbackFunctionExpression(callbackArg, checker)
    : undefined;
}

/**
 * For a lift-applied call (`__cfHelpers.lift(...)(input)`), return the inner
 * lift CallExpression — i.e. the `__cfHelpers.lift(...)` that builds the
 * module factory before it's applied to the input object. Returns undefined
 * if `call` doesn't have the lift-applied shape (no inner call expression).
 *
 * Uses `stripWrappers` so a parenthesized or as-cast callee is still
 * recognized, matching how `getLiftAppliedInputAndCallback` reads the same
 * shape. Use this in preference to bare `ts.isCallExpression(call.expression)`
 * at all sites that need the inner call — TS rarely emits parens around
 * synthesized calls today, but routing through one helper makes any future
 * wrapper additions handled consistently across the pipeline.
 */
export function getLiftAppliedInnerCall(
  call: ts.CallExpression,
): ts.CallExpression | undefined {
  const stripped = stripWrappers(call.expression);
  return ts.isCallExpression(stripped) ? stripped : undefined;
}

/**
 * True iff `call` is a handler in its applied shape
 * `__cfHelpers.handler(eventSchema, stateSchema, cb)(captures)` — an outer
 * application whose callee is itself the inner `handler(...)` call.
 *
 * Structurally this is the same single-application shape as lift-applied, but
 * we deliberately keep it OUT of the `lift-applied` CallKind (CT-1655): a
 * handler-applied call continues to classify as `{ kind: "builder",
 * builderName: "handler" }` so handler-specific dispatchers (stream causes in
 * ReactiveVariableFor, capture-schema injection, write-authorization, etc.) are
 * unaffected. This predicate exists solely so the hoisting stage can recognize
 * the unit to relocate without minting a new kind or widening the lift-applied
 * gate.
 *
 * Guards against multi-application chains (`handler(cb)(x)(y)`) the same way
 * lift-applied recognition does — only the single-application form is the
 * canonical lowered handler shape.
 */
export function isHandlerAppliedCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const target = stripWrappers(call.expression);
  if (!ts.isCallExpression(target) || isMultiApplicationChain(call)) {
    return false;
  }
  const builderKind = resolveBuilderExpressionKind(target, checker, new Set(), {
    followFactoryResults: true,
  });
  return builderKind?.builderName === "handler";
}

/**
 * For a handler-applied call (`__cfHelpers.handler(...)(captures)`), return the
 * inner `handler(...)` CallExpression — the unit the hoisting stage relocates
 * to a module-scope const. Returns undefined if `call` is not the applied
 * shape. Mirrors {@link getLiftAppliedInnerCall}; routes through `stripWrappers`
 * for the same forward-compatibility reasons.
 */
export function getHandlerAppliedInnerCall(
  call: ts.CallExpression,
): ts.CallExpression | undefined {
  const stripped = stripWrappers(call.expression);
  return ts.isCallExpression(stripped) ? stripped : undefined;
}

export function getLiftAppliedInputAndCallback(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): {
  input: ts.Expression;
  callback: ts.ArrowFunction | ts.FunctionExpression;
} | undefined {
  const callKind = detectCallKind(call, checker);
  if (callKind?.kind !== "lift-applied") {
    return undefined;
  }

  // The lift-applied shape `__cfHelpers.lift(...)(input)` always has the outer
  // call's callee as a CallExpression (the inner `lift(...)` factory). That is
  // the only way detectCallKind produces kind:"lift-applied" — see its
  // recognition in resolveExpressionKind (requires ts.isCallExpression(target)).
  // Lift is function-first, so the callback is inner argument zero even after
  // schema injection or scheduler options; the applied input is outer arg zero.
  // detectCallKind's lift-applied result proves this structural invariant.
  const innerCallee = getLiftAppliedInnerCall(call)!;
  const callbackArg = innerCallee.arguments[0];
  const callback = callbackArg
    ? resolveCallbackFunctionExpression(callbackArg, checker)
    : undefined;
  if (!callback) {
    return undefined;
  }

  const input = call.arguments[0];
  if (!input) {
    return undefined;
  }

  return { input, callback };
}

export function isReactiveOriginCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const callKind = detectCallKind(call, checker);
  return !!callKind && isReactiveOriginKind(callKind);
}

export function isReactiveOriginExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  if (ts.isCallExpression(expression)) {
    return isReactiveOriginCall(expression, checker);
  }
  if (ts.isNewExpression(expression)) {
    const callKind = detectNewExpressionKind(expression, checker);
    return !!callKind && isReactiveOriginKind(callKind);
  }
  return false;
}

// A tagged template `str`...`` is semantically a call to its tag, but it is a
// TaggedTemplateExpression in the AST — not a CallExpression — so detectCallKind
// (keyed on CallExpression) does not classify it. This resolves the tag the same
// way detectCallKind resolves a callee and reports whether it is a reactive-origin
// commonfabric runtime call (e.g. str/llm). Scoped helper: a fuller unification of
// tagged templates into detectCallKind is tracked as a follow-up.
export function isReactiveOriginTaggedTemplate(
  expression: ts.TaggedTemplateExpression,
  checker: ts.TypeChecker,
): boolean {
  const tagKind = resolveExpressionKind(expression.tag, checker, new Set());
  return !!tagKind && isReactiveOriginKind(tagKind);
}

export function classifyWildcardTraversalCall(
  call: ts.CallExpression,
  checker?: ts.TypeChecker,
): WildcardTraversalCallKind | undefined {
  const target = stripWrappers(call.expression);
  if (!ts.isPropertyAccessExpression(target)) {
    return undefined;
  }

  if (checker) {
    const symbol = checker.getSymbolAtLocation(target.name);
    const resolved = symbol
      ? (resolveAlias(symbol, checker, new Set()) ?? symbol)
      : undefined;

    for (const declaration of resolved?.getDeclarations() ?? []) {
      if (!hasIdentifierName(declaration)) continue;

      const owner = findOwnerName(declaration);
      if (!owner) continue;

      const name = declaration.name.text;
      if (
        owner === "ObjectConstructor" &&
        WILDCARD_OBJECT_METHOD_NAMES.has(name)
      ) {
        return "object-wildcard-traversal";
      }

      if (owner === "JSON" && name === "stringify") {
        return "json-stringify";
      }
    }
  }

  if (
    ts.isIdentifier(target.expression) &&
    target.expression.text === "Object" &&
    WILDCARD_OBJECT_METHOD_NAMES.has(target.name.text)
  ) {
    return "object-wildcard-traversal";
  }

  if (
    ts.isIdentifier(target.expression) &&
    target.expression.text === "JSON" &&
    target.name.text === "stringify"
  ) {
    return "json-stringify";
  }

  return undefined;
}

function isCallbackFunctionExpression(
  expression: ts.Expression,
): expression is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression);
}

/**
 * The function-like expression `expression` resolves to, following wrapper
 * strips, the hardening helper, and — unlike schema-injection's local
 * direct-only resolver — an identifier to its variable initializer through
 * the checker. The resolver a caller wants when "is this argument the
 * callback?" must answer the same for `handler(es, ss, cb)` and
 * `handler(es, ss, myCb)`.
 */
export function resolveCallbackFunctionExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Node>(),
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  const target = stripWrappers(expression);
  if (seen.has(target)) {
    return undefined;
  }
  seen.add(target);

  if (isCallbackFunctionExpression(target)) {
    return target;
  }

  const hardened = unwrapHardenedCallbackExpression(target);
  if (hardened) {
    return resolveCallbackFunctionExpression(hardened, checker, seen);
  }

  if (!ts.isIdentifier(target)) {
    return undefined;
  }

  const initializer = getVariableInitializer(target, checker);
  return initializer
    ? resolveCallbackFunctionExpression(initializer, checker, seen)
    : undefined;
}

function unwrapHardenedCallbackExpression(
  expression: ts.Expression,
): ts.Expression | undefined {
  if (!ts.isCallExpression(expression) || expression.arguments.length !== 1) {
    return undefined;
  }

  const callee = stripWrappers(expression.expression);
  if (
    !ts.isIdentifier(callee) ||
    !callee.text.startsWith(FUNCTION_HARDENING_HELPER_PREFIX)
  ) {
    return undefined;
  }

  return expression.arguments[0];
}

/**
 * Whether `expression` names a callback. Recognizes the schema-first `handler`
 * form, keeps the trailing-options check from spread-replacing a callback with
 * the injected result options, anchors a builder artifact whose callback is
 * reached indirectly, and gates which argument the indirect-callback
 * validation stage judges.
 *
 * Callback-ness is SEMANTIC — the checker's call signatures — never a
 * whitelist of spellings. Inline arrows, const references, function
 * declarations, and property accesses can all denote callbacks, so asking the
 * type covers the family. Two backstops cover missing type information rather
 * than a spelling: the syntactic resolver catches a local `any`-typed callback
 * (no call signatures to ask), and the declaration fallback catches an
 * imported one — the resolver cannot cross modules, but the aliased symbol's
 * declaration still says what the value is.
 */
export function isCallbackReference(
  expression: ts.Expression | undefined,
  checker: ts.TypeChecker,
): boolean {
  if (!expression) return false;
  if (resolveCallbackFunctionExpression(expression, checker)) return true;
  const unwrapped = unwrapExpression(expression);
  const type = checker.getTypeAtLocation(unwrapped);
  if (type.getCallSignatures().length > 0) return true;
  if (!ts.isIdentifier(unwrapped)) return false;
  let symbol = checker.getSymbolAtLocation(unwrapped);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (declaration === undefined) return false;
  if (ts.isFunctionDeclaration(declaration)) return true;
  // The initializer goes through the wrapper-stripping resolver rather than
  // a node-kind test: an assertion (`as any`), parentheses, or the hardening
  // helper around the function must not hide it. The resolver works on a
  // foreign file's node — the checker is program-wide.
  return ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined &&
    resolveCallbackFunctionExpression(declaration.initializer, checker) !==
      undefined;
}

export function isWildcardTraversalCall(
  call: ts.CallExpression,
  checker?: ts.TypeChecker,
): boolean {
  return !!classifyWildcardTraversalCall(call, checker);
}

export function classifyArrayMethodAccess(
  expression: ts.Expression,
): ArrayMethodAccessKind | undefined {
  const target = stripWrappers(expression);

  let methodName: string | undefined;
  if (ts.isPropertyAccessExpression(target)) {
    methodName = target.name.text;
  } else if (ts.isElementAccessExpression(target)) {
    const argument = target.argumentExpression;
    if (
      argument &&
      (ts.isStringLiteralLike(argument) ||
        ts.isNoSubstitutionTemplateLiteral(argument))
    ) {
      methodName = argument.text;
    }
  }

  return methodName ? getArrayMethodAccessKindByName(methodName) : undefined;
}

export function classifyArrayMethodCall(
  call: ts.CallExpression,
): ArrayMethodAccessKind | undefined {
  return classifyArrayMethodAccess(call.expression);
}

export function getLoweredArrayMethodName(
  family: ArrayMethodFamilyName,
): string {
  return `${family}WithPattern`;
}

/**
 * The `options` reach the receiver's provenance walk. Passing
 * `syntheticReactiveCollectionRegistry` is how a stage that runs after the
 * closure stage sees the collections that stage created rather than derived —
 * a local whose initializer is site-lifted has no structural provenance to
 * walk, so without the registry its ownership reads "plain" and the caller
 * re-lowers a call the closure stage already rewrote. Callers that must NOT
 * see those registrations — standalone-function validation, where the eager
 * `<cell>.get().filter(...)` idiom is the supported spelling — stay on the
 * bare form deliberately.
 */
export function classifyArrayMethodCallSite(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  options: ReactiveCollectionProvenanceOptions = {},
): ArrayMethodCallSiteInfo | undefined {
  const access = classifyArrayMethodCall(call);
  if (!access) {
    return undefined;
  }

  const target = stripWrappers(call.expression);
  if (
    !ts.isPropertyAccessExpression(target) &&
    !ts.isElementAccessExpression(target)
  ) {
    return { ...access, ownership: "plain" };
  }

  return {
    ...access,
    ownership: hasReactiveCollectionProvenance(
        target.expression,
        checker,
        options,
      )
      ? "reactive"
      : "plain",
  };
}

export function classifyArrayCallbackContainerCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): ArrayCallbackContainerCallKind | undefined {
  const arrayMethodCallSite = classifyArrayMethodCallSite(call, checker);
  if (arrayMethodCallSite?.ownership === "reactive") {
    if (isConsumedByTerminalChainCall(call)) {
      return "plain-array-value";
    }
    return "reactive-array-method";
  }

  if (
    arrayMethodCallSite?.ownership === "plain" &&
    !arrayMethodCallSite.lowered
  ) {
    return "plain-array-value";
  }

  const signature = checker.getResolvedSignature(call);
  const declaration = signature?.declaration;
  if (!signature || !declaration) {
    return undefined;
  }

  const owner = findOwnerName(declaration);
  if (!owner || !ARRAY_OWNER_NAMES.has(owner)) {
    return undefined;
  }

  const returnType = checker.getReturnTypeOfSignature(signature);
  return (returnType.flags & ts.TypeFlags.Void) === 0
    ? "plain-array-value"
    : "plain-array-void";
}

/**
 * Array methods that merely collect what the callback returns. `map` stores
 * each result in the output array without reading it, so a result that is a
 * reactive cell stays a reactive cell.
 *
 * The other callback-taking Array methods interpret the result while they run:
 * `filter`, `find`, `some`, and `every` read it as a boolean, `sort` reads it
 * as a number, `flatMap` asks whether it is an array, and `reduce` feeds it
 * back as the next accumulator. A cell reaching any of those is an object, so
 * the method's own semantics change.
 */
const COLLECTING_ARRAY_METHOD_NAMES = new Set(["map"]);

/**
 * True when `callback` is the callback of an ordinary eager Array method that
 * collects results rather than interpreting them — the one shape whose body may
 * carry pattern-owned wrapper sites, because a lifted callback-local can be
 * returned from it without changing what the method does.
 *
 * Three things must hold, and each rules out a shape that would otherwise slip
 * through method-name matching alone: the callback is argument zero, so a
 * comparator or an `initialValue` in another position does not qualify; the
 * resolved owner symbol includes the configured default-library
 * `Array`/`ReadonlyArray` declaration, so a same-named source or ambient type
 * and a `map` of some other type do not qualify; and the receiver is a plain
 * array that no reactive lowering owns, so the reactive collection operators
 * keep their own structural treatment.
 */
export function isCollectingPlainArrayMethodCallback(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
  isSourceFileDefaultLibrary: (sourceFile: ts.SourceFile) => boolean,
): boolean {
  const position = getCallArgumentPosition(callback);
  if (!position || position.index !== 0) {
    return false;
  }

  const call = position.call;
  const callSite = classifyArrayMethodCallSite(call, checker);
  if (!callSite || callSite.ownership !== "plain" || callSite.lowered) {
    return false;
  }

  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (!declaration) {
    return false;
  }

  const owner = findOwnerDeclaration(declaration);
  if (!owner?.name || !ARRAY_OWNER_NAMES.has(owner.name.text)) {
    return false;
  }

  const ownerSymbol = checker.getSymbolAtLocation(owner.name);
  if (
    !ownerSymbol ||
    !(ownerSymbol.declarations ?? []).some((candidate) =>
      isSourceFileDefaultLibrary(candidate.getSourceFile())
    )
  ) {
    return false;
  }

  const { name } = declaration as { readonly name?: ts.Node };
  return !!name && ts.isIdentifier(name) &&
    COLLECTING_ARRAY_METHOD_NAMES.has(name.text);
}

export function classifyArrayMethodResultSinkCall(
  call: ts.CallExpression,
  checker?: ts.TypeChecker,
): ArrayMethodResultSinkCallInfo | undefined {
  const target = stripWrappers(call.expression);
  if (!ts.isPropertyAccessExpression(target)) {
    return undefined;
  }

  const receiver = stripWrappers(target.expression);
  if (!ts.isCallExpression(receiver)) {
    return undefined;
  }

  const receiverMethod = classifyArrayMethodCall(receiver);
  if (!receiverMethod) {
    return undefined;
  }

  if (checker) {
    const symbol = checker.getSymbolAtLocation(target.name);
    const resolved = symbol
      ? (resolveAlias(symbol, checker, new Set()) ?? symbol)
      : undefined;
    const declarations = resolved?.getDeclarations() ?? [];

    for (const declaration of declarations) {
      if (!hasIdentifierName(declaration)) continue;

      const owner = findOwnerName(declaration);
      if (!owner) continue;

      if (
        ARRAY_OWNER_NAMES.has(owner) &&
        declaration.name.text === "join"
      ) {
        return {
          sink: "join",
          receiverFamily: receiverMethod.family,
          receiverLowered: receiverMethod.lowered,
        };
      }
    }

    if (declarations.length > 0) {
      return undefined;
    }
  }

  if (target.name.text === "join") {
    return {
      sink: "join",
      receiverFamily: receiverMethod.family,
      receiverLowered: receiverMethod.lowered,
    };
  }

  return undefined;
}

export function classifyArrayMethodResultSinkReceiverChainCall(
  call: ts.CallExpression,
  checker?: ts.TypeChecker,
): ArrayMethodResultSinkReceiverChainCallInfo | undefined {
  const target = stripWrappers(call.expression);
  if (!ts.isPropertyAccessExpression(target)) {
    return undefined;
  }

  const receiver = stripWrappers(target.expression);
  if (!ts.isCallExpression(receiver)) {
    return undefined;
  }

  const sinkCall = classifyArrayMethodResultSinkCall(receiver, checker);
  if (!sinkCall) {
    const receiverChain = classifyArrayMethodResultSinkReceiverChainCall(
      receiver,
      checker,
    );
    if (!receiverChain) {
      return undefined;
    }

    return {
      sinkCall: receiverChain.sinkCall,
      depth: receiverChain.depth + 1,
    };
  }

  return {
    sinkCall,
    depth: 1,
  };
}

function isReactiveOriginKind(callKind: CallKind): boolean {
  switch (callKind.kind) {
    case "builder":
      return COMMONFABRIC_REACTIVE_ORIGIN_BUILDER_NAMES.has(
        callKind.builderName,
      );
    case "cell-factory":
    case "cell-for":
      return true;
    case "lift-applied":
      // The lift-applied shape `lift(fn)(input)` (which `computed` also lowers to,
      // and which `derive` used to produce) is inherently a reactive origin.
      // Previously this checked `.has("derive")` — effectively always true, since
      // derive was a registered reactive-origin call; that coupling broke when
      // derive was removed from the registry. The shape is reactive regardless.
      return true;
    case "ifElse":
      return COMMONFABRIC_REACTIVE_ORIGIN_CALL_EXPORT_NAMES.has("ifElse");
    case "when":
      return COMMONFABRIC_REACTIVE_ORIGIN_CALL_EXPORT_NAMES.has("when");
    case "unless":
      return COMMONFABRIC_REACTIVE_ORIGIN_CALL_EXPORT_NAMES.has("unless");
    case "wish":
      return COMMONFABRIC_REACTIVE_ORIGIN_CALL_EXPORT_NAMES.has("wish");
    case "generate-text":
      return COMMONFABRIC_REACTIVE_ORIGIN_CALL_EXPORT_NAMES.has("generateText");
    case "generate-object":
      return COMMONFABRIC_REACTIVE_ORIGIN_CALL_EXPORT_NAMES.has(
        "generateObject",
      );
    case "runtime-call":
      return callKind.reactiveOrigin;
    default:
      return false;
  }
}

export function isReactiveValueSymbol(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): boolean {
  return hasImplicitReactiveParameterContext(symbol, checker) ||
    isVariableFromReactiveCallSymbol(symbol, checker);
}

export function isReactiveValueExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  return reactiveValueCache.memoize(
    checker,
    expression,
    () => {
      const target = stripWrappers(expression);

      try {
        const type = checker.getTypeAtLocation(target);
        if (isBrandedCellType(type, checker)) {
          return true;
        }
      } catch {
        // Fall through to structural analysis.
      }

      if (ts.isIdentifier(target)) {
        return isReactiveValueSymbol(
          checker.getSymbolAtLocation(target),
          checker,
        );
      }

      if (
        ts.isPropertyAccessExpression(target) ||
        ts.isElementAccessExpression(target)
      ) {
        return isReactiveValueExpression(target.expression, checker);
      }

      if (ts.isCallExpression(target)) {
        if (classifyOpaquePathTerminalCall(target) === "key") {
          return true;
        }
        if (isReactiveOriginCall(target, checker)) {
          return true;
        }
        return isLoweredReactiveArrayMethodCall(target, checker);
      }

      if (ts.isNewExpression(target)) {
        return !!detectNewExpressionKind(target, checker);
      }

      return false;
    },
  );
}

export function hasReactiveCollectionProvenance(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  options: ReactiveCollectionProvenanceOptions = {},
): boolean {
  if (usesDefaultReactiveCollectionProvenanceOptions(options)) {
    return reactiveCollectionProvenanceCache.memoize(
      checker,
      expression,
      () =>
        hasReactiveCollectionProvenanceInternal(
          expression,
          checker,
          options,
          new Set(),
        ),
    );
  }

  return hasReactiveCollectionProvenanceInternal(
    expression,
    checker,
    options,
    new Set(),
  );
}

export function isSimpleReactiveAccessExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  const target = stripWrappers(expression);

  if (ts.isIdentifier(target)) {
    return isReactiveValueExpression(target, checker);
  }

  if (ts.isPropertyAccessExpression(target)) {
    return isSimpleReactiveAccessExpression(target.expression, checker);
  }

  if (ts.isElementAccessExpression(target)) {
    const argument = target.argumentExpression;
    return !!argument &&
      (
        ts.isLiteralExpression(argument) ||
        ts.isNoSubstitutionTemplateLiteral(argument)
      ) &&
      isSimpleReactiveAccessExpression(target.expression, checker);
  }

  return false;
}

function hasReactiveCollectionProvenanceInternal(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  options: ReactiveCollectionProvenanceOptions,
  seenSymbols: Set<ts.Symbol>,
): boolean {
  const target = stripWrappers(expression);
  if (options.allowTypeBasedRoot !== false) {
    const type = getTypeAtLocationWithFallback(
      target,
      checker,
      options.typeRegistry,
    );
    if (type && isBrandedCellType(type, checker)) {
      return true;
    }
  }

  if (
    ts.isPropertyAccessExpression(target) ||
    ts.isElementAccessExpression(target)
  ) {
    return hasReactiveCollectionProvenanceInternal(
      target.expression,
      checker,
      options,
      seenSymbols,
    );
  }

  if (
    ts.isBinaryExpression(target) &&
    (
      target.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      target.operatorToken.kind === ts.SyntaxKind.BarBarToken
    )
  ) {
    return hasReactiveCollectionProvenanceInternal(
      target.left,
      checker,
      options,
      seenSymbols,
    ) || hasReactiveCollectionProvenanceInternal(
      target.right,
      checker,
      options,
      seenSymbols,
    );
  }

  if (ts.isCallExpression(target)) {
    if (classifyOpaquePathTerminalCall(target) === "key") {
      return true;
    }

    const arrayMethodCall = classifyArrayMethodCall(target);
    if (
      arrayMethodCall &&
      (
        ts.isPropertyAccessExpression(target.expression) ||
        ts.isElementAccessExpression(target.expression)
      )
    ) {
      return hasReactiveCollectionProvenanceInternal(
        target.expression.expression,
        checker,
        options,
        seenSymbols,
      );
    }

    if (isReactiveOriginCall(target, checker)) {
      return true;
    }

    // CT-1778: a non-reactive-origin call that reads a pattern-level reactive value
    // and returns a collection — e.g. `tallyOptions(options, votes): OptionTally[]`,
    // where `options`/`votes` are the pattern's reactive parameters — is lift-wrapped
    // by the transformer into a reactive collection (`const ranked = __cfLift_N(...)`).
    // That wrap, and the symbol's registration in syntheticReactiveCollectionRegistry,
    // happen in a later pass than the array-method lowering decision, so a nested
    // `.map`/`.filter` over the result's elements would otherwise race the registration
    // and be emitted raw (-> "Reactive.map(fn) is no longer supported" at runtime).
    // Recognizing the shape structurally here makes the receiver provably reactive at
    // decision time, exactly as the inline `options.map(...)` form already is.
    //
    // Gated on an argument that is reactive via a PARAMETER BINDING or a DERIVATION
    // from one — recursing through the same provenance walk with
    // `allowTypeBasedRoot: false`. Dropping the type root is what excludes values that
    // are reactive only by static type: a reactive-typed parameter of a standalone
    // (hardened) function is reactive-typed but is neither an implicit reactive
    // parameter nor has a reactive initializer to walk, so it is rejected — which keeps
    // this from firing inside standalone functions, where `helper(x).map(...)` is an
    // eager, non-reactive map that PatternContextValidation (correctly) forbids from
    // lowering. The same recursion also covers chained derivations, e.g.
    // `const a = tallyOptions(options); const b = enrich(a); b.map(t => t.x.map(...))`.
    // Only when reached through a variable initializer (`const x = call(...)`),
    // never for a call used inline as a `.map` receiver — see
    // `viaVariableInitializer` above. `viaVariableInitializer: false` on the
    // argument recursion keeps the same restriction for chained args: a const
    // argument re-establishes it through its own initializer walk, while an inline
    // call argument does not.
    if (
      options.viaVariableInitializer &&
      target.arguments.some((arg) =>
        hasReactiveCollectionProvenanceInternal(
          stripWrappers(arg),
          checker,
          {
            ...options,
            allowTypeBasedRoot: false,
            viaVariableInitializer: false,
          },
          seenSymbols,
        )
      )
    ) {
      const resultType = getTypeAtLocationWithFallback(
        target,
        checker,
        options.typeRegistry,
      );
      if (isCollectionType(resultType, checker)) {
        return true;
      }
    }

    const directBuilder = detectDirectBuilderCall(target, checker);
    return !!directBuilder &&
      COMMONFABRIC_REACTIVE_ORIGIN_BUILDER_NAMES.has(directBuilder.builderName);
  }

  if (!ts.isIdentifier(target)) {
    return false;
  }

  const originalTarget = ts.getOriginalNode(target);
  const symbol = checker.getSymbolAtLocation(target) ??
    (
      originalTarget !== target && ts.isIdentifier(originalTarget)
        ? checker.getSymbolAtLocation(originalTarget)
        : undefined
    );
  if (!symbol || seenSymbols.has(symbol)) {
    return false;
  }
  seenSymbols.add(symbol);

  if (
    options.allowImplicitReactiveParameters !== false &&
    isSymbolDeclaredInScope(symbol, options.sameScope)
  ) {
    const implicitContext = getImplicitReactiveParameterContextKind(
      symbol,
      checker,
    );
    if (
      implicitContext === "builder" ||
      (
        options.allowReactiveArrayCallbackParameters !== false &&
        implicitContext === "reactive-array-method"
      )
    ) {
      return true;
    }
  }

  for (const declaration of symbol.getDeclarations() ?? []) {
    if (!isDeclarationInScope(declaration, options.sameScope)) {
      continue;
    }

    if (options.syntheticReactiveCollectionRegistry?.has(symbol)) {
      return true;
    }

    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      if (
        hasReactiveCollectionProvenanceInternal(
          declaration.initializer,
          checker,
          { ...options, viaVariableInitializer: true },
          seenSymbols,
        )
      ) {
        return true;
      }
      continue;
    }

    if (!ts.isBindingElement(declaration)) {
      continue;
    }

    let parent: ts.Node = declaration;
    while (
      ts.isBindingElement(parent) ||
      ts.isObjectBindingPattern(parent) ||
      ts.isArrayBindingPattern(parent)
    ) {
      parent = parent.parent;
    }

    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer &&
      hasReactiveCollectionProvenanceInternal(
        parent.initializer,
        checker,
        { ...options, viaVariableInitializer: true },
        seenSymbols,
      )
    ) {
      return true;
    }
  }

  return false;
}

function resolveExpressionKind(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): CallKind | undefined {
  const cache = callKindCache.groupFor(checker);
  if (cache.has(expression)) {
    return cache.get(expression) ?? undefined;
  }

  const target = stripWrappers(expression);

  const builderKind = resolveBuilderExpressionKind(target, checker, new Set(), {
    followFactoryResults: true,
  });
  if (builderKind) {
    // Lift-applied recognition: when the callee is itself a call to lift
    // (e.g. __cfHelpers.lift(cb)({})), the *outer* call applies the lift
    // factory to inputs and is the canonical lowered form of a reactive
    // lifted-function computation (e.g. from computed()). Return
    // kind:"lift-applied" so downstream dispatchers handle it.
    //
    // The plain unapplied builder case (e.g. __cfHelpers.lift(cb) on its
    // own, or a pattern() call) has `target` not as a CallExpression.
    //
    // Guard against multi-application chains like `lift(cb)(x)(y)`: only
    // the SINGLE-application form is canonical lift-applied. If the
    // outer-outer call's inner expression (`target.expression`) is itself
    // a call AND that inner call's expression (`target.expression.expression`)
    // is ALSO a call, we have an over-application and should NOT classify
    // as lift-applied — even if the chain happens to resolve through a
    // lift symbol via factory-following. (CT-1615 Berni review §2.2.)
    if (
      builderKind.builderName === "lift" &&
      ts.isCallExpression(target) &&
      !isMultiApplicationChain(target)
    ) {
      const liftAppliedKind: CallKind = {
        kind: "lift-applied",
        symbol: builderKind.symbol,
      };
      cache.set(expression, liftAppliedKind);
      return liftAppliedKind;
    }
    cache.set(expression, builderKind);
    return builderKind;
  }

  const syntheticHelperKind = getSyntheticHelperCallKind(target);
  if (syntheticHelperKind) {
    cache.set(expression, syntheticHelperKind);
    return syntheticHelperKind;
  }

  if (ts.isCallExpression(target)) {
    const result = resolveExpressionKind(target.expression, checker, seen);
    cache.set(expression, result ?? null);
    return result;
  }

  let symbol: ts.Symbol | undefined;
  if (ts.isPropertyAccessExpression(target)) {
    symbol = checker.getSymbolAtLocation(target.name);
  } else if (ts.isElementAccessExpression(target)) {
    const argument = target.argumentExpression;
    if (argument && ts.isExpression(argument)) {
      symbol = checker.getSymbolAtLocation(argument);
    }
  } else if (ts.isIdentifier(target)) {
    symbol = checker.getSymbolAtLocation(target);
  } else {
    symbol = checker.getSymbolAtLocation(target);
  }

  if (symbol) {
    const kind = resolveSymbolKind(symbol, checker, seen);
    if (kind) {
      cache.set(expression, kind);
      return kind;
    }
  }

  if (ts.isPropertyAccessExpression(target)) {
    const name = target.name.text;
    if (isKnownArrayMethodName(name)) {
      // Fallback path: when symbol resolution doesn't already identify the
      // array-method family. A synthetic, symbol-less `*WithPattern`
      // spelling needs no receiver check: the closure stage emits these
      // calls against receivers whose static type is still the plain array
      // type, so the method never resolves to a symbol and provenance walks
      // see a plain binding — the emitted spelling itself testifies to the
      // provenance the rewritten tree can no longer show structurally. The
      // synthetic-node requirement is what scopes that testimony to calls
      // the transformer actually produced: an AUTHORED `*WithPattern`
      // spelling keeps its author's semantics whether its method resolves
      // (their own declaration) or not (an untyped receiver). Authored
      // spellings of every family stay gated on reactive receivers — a
      // `.map`-named call whose symbol did not resolve is otherwise not
      // evidence of the family.
      if (
        (
          !symbol && isSyntheticNode(target) &&
          getArrayMethodAccessKindByName(name)?.lowered
        ) ||
        isReactiveArrayMethodReceiverExpression(target.expression, checker)
      ) {
        const result = { kind: "array-method" } as const;
        cache.set(expression, result);
        return result;
      }
    }
    // `db.query<Row>(...)` on a SqliteDb receiver — reuse the `sqliteQuery`
    // runtime-call kind so the existing schema-injection branch lowers `<Row>`
    // to `rowSchema`. The receiver-type check (brand `"sqlite"`) is what
    // distinguishes this from any other `.query` method.
    if (name === "query") {
      const receiverType = checker.getTypeAtLocation(target.expression);
      if (getCellKind(receiverType, checker) === "sqlite") {
        const result = {
          kind: "runtime-call",
          exportName: "sqliteQuery",
          reactiveOrigin: true,
        } as const;
        cache.set(expression, result);
        return result;
      }
    }
  }

  const type = checker.getTypeAtLocation(target);
  const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  for (const signature of signatures) {
    const signatureSymbol = getSignatureSymbol(signature);
    if (!signatureSymbol) continue;
    const kind = resolveSymbolKind(signatureSymbol, checker, seen);
    if (kind) {
      cache.set(expression, kind);
      return kind;
    }
  }

  cache.set(expression, null);
  return undefined;
}

/**
 * For a lift-applied candidate `outerCall` (already known to be a
 * CallExpression whose builder resolution points at lift), return true if
 * the call is part of a multi-application chain like `lift(cb)(x)(y)` —
 * i.e. the inner call's *own* callee is also a CallExpression.
 *
 * Canonical lift-applied is exactly one application: `lift(cb)(input)`.
 * Anything deeper is not a Phase-1 lowered shape and should not be
 * classified as `kind: "lift-applied"`. (CT-1615 Berni review §2.2.)
 */
function isMultiApplicationChain(outerCall: ts.CallExpression): boolean {
  const innerCallee = stripWrappers(outerCall.expression);
  if (!ts.isCallExpression(innerCallee)) return false;
  const innerCalleeCallee = stripWrappers(innerCallee.expression);
  return ts.isCallExpression(innerCalleeCallee);
}

/**
 * Peels the non-semantic wrappers that can stand between a call site and the
 * expression it is really about — parentheses, `as T`, `<T>x`, `satisfies T`,
 * and `!`. Classification asks what an expression *is*, and none of these
 * change that, so all of them come off before any node-kind test runs.
 *
 * Delegates to the shared {@link unwrapExpression} so the wrapper list has a
 * single definition and a wrapper spelling cannot be handled in one resolver
 * and missed in another. It takes that helper's full wrapper set, including
 * PartiallyEmittedExpression: the pipeline runs over authored source through
 * `ts.transform`, never as part of TypeScript's emit, so a partially emitted
 * node cannot reach classification and there is nothing here for a narrower
 * set to protect.
 */
function stripWrappers(expression: ts.Expression): ts.Expression {
  return unwrapExpression(expression);
}

function stripInitializerAccess(expression: ts.Expression): ts.Expression {
  let current = stripWrappers(expression);

  while (true) {
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
    ) {
      current = stripWrappers(current.expression);
      continue;
    }
    break;
  }

  return current;
}

export function isConsumedByTerminalChainCall(
  call: ts.CallExpression,
): boolean {
  let current: ts.Expression = call;

  while (true) {
    const parent = current.parent;
    if (!parent) {
      return false;
    }

    if (isTransparentWrapper(parent)) {
      current = parent;
      continue;
    }

    if (
      ts.isPropertyAccessExpression(parent) && parent.expression === current
    ) {
      const memberName = parent.name.text;
      if (isKnownArrayMethodName(memberName)) {
        const callParent = parent.parent;
        if (
          callParent &&
          ts.isCallExpression(callParent) &&
          callParent.expression === parent
        ) {
          current = callParent;
          continue;
        }
      }
      return true;
    }

    if (ts.isElementAccessExpression(parent) && parent.expression === current) {
      return true;
    }

    if (ts.isCallExpression(parent) && parent.expression === current) {
      return true;
    }

    return false;
  }
}

function isLoweredReactiveArrayMethodCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const callSite = classifyArrayMethodCallSite(call, checker);
  return !!callSite &&
    callSite.lowered &&
    callSite.ownership === "reactive";
}

function hasImplicitReactiveParameterContext(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): boolean {
  return !!getImplicitReactiveParameterContextKind(symbol, checker);
}

function getImplicitReactiveParameterContextKind(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): ImplicitReactiveParameterContextKind | undefined {
  if (!symbol) return undefined;
  const declarations = symbol.getDeclarations();
  if (!declarations) return undefined;

  for (const declaration of declarations) {
    let paramNode: ts.Node = declaration;
    while (
      ts.isBindingElement(paramNode) ||
      ts.isObjectBindingPattern(paramNode) ||
      ts.isArrayBindingPattern(paramNode)
    ) {
      paramNode = paramNode.parent;
    }
    if (!ts.isParameter(paramNode)) continue;

    let functionNode: ts.Node | undefined = paramNode.parent;
    while (functionNode && !ts.isFunctionLike(functionNode)) {
      functionNode = functionNode.parent;
    }
    if (!functionNode) continue;

    let candidate: ts.Node | undefined = functionNode.parent;
    while (candidate && !ts.isCallExpression(candidate)) {
      candidate = candidate.parent;
    }
    if (!candidate) continue;

    const call = candidate as ts.CallExpression;
    const callKind = detectCallKind(call, checker);
    if (callKind?.kind === "builder") {
      return "builder";
    }

    if (
      classifyArrayCallbackContainerCall(call, checker) ===
        "reactive-array-method"
    ) {
      return "reactive-array-method";
    }
  }

  return undefined;
}

function isReactiveArrayMethodReceiverExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  return hasReactiveCollectionProvenance(expression, checker);
}

function isVariableFromReactiveCallSymbol(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): boolean {
  if (!symbol) return false;
  const declarations = symbol.getDeclarations();
  if (!declarations) return false;

  for (const decl of declarations) {
    let initExpr: ts.Expression | undefined;
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      initExpr = decl.initializer;
    } else if (ts.isBindingElement(decl)) {
      let parent: ts.Node = decl;
      while (
        ts.isBindingElement(parent) ||
        ts.isObjectBindingPattern(parent) ||
        ts.isArrayBindingPattern(parent)
      ) {
        parent = parent.parent;
      }
      if (ts.isVariableDeclaration(parent) && parent.initializer) {
        initExpr = parent.initializer;
      }
    }
    if (!initExpr) continue;

    const current = stripInitializerAccess(initExpr);
    if (!ts.isCallExpression(current)) continue;

    if (
      isReactiveOriginCall(current, checker) ||
      isLoweredReactiveArrayMethodCall(current, checker)
    ) {
      return true;
    }
  }

  return false;
}

function isDeclarationInScope(
  declaration: ts.Declaration,
  scope: ts.FunctionLikeDeclaration | undefined,
): boolean {
  if (!scope) {
    return true;
  }

  return getEnclosingFunctionLikeDeclaration(declaration) === scope;
}

function isSymbolDeclaredInScope(
  symbol: ts.Symbol,
  scope: ts.FunctionLikeDeclaration | undefined,
): boolean {
  if (!scope) {
    return true;
  }

  return (symbol.getDeclarations() ?? []).some((declaration) =>
    isDeclarationInScope(declaration, scope)
  );
}

function resolveBuilderExpressionKind(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
  options: { followFactoryResults: boolean },
): Extract<CallKind, { kind: "builder" }> | undefined {
  const cache = options.followFactoryResults
    ? undefined
    : directBuilderKindCache.groupFor(checker);
  if (cache?.has(expression)) {
    return cache.get(expression) ?? undefined;
  }

  const target = stripWrappers(expression);

  if (ts.isCallExpression(target)) {
    if (!options.followFactoryResults) {
      cache?.set(expression, null);
      return undefined;
    }
    return resolveBuilderExpressionKind(
      target.expression,
      checker,
      seen,
      options,
    );
  }

  const symbol = getExpressionSymbol(target, checker);
  if (symbol) {
    const kind = resolveBuilderSymbolKind(symbol, checker, seen, options);
    if (kind) {
      cache?.set(expression, kind);
      return kind;
    }
  } else {
    const fallbackName = getDirectBuilderName(target);
    if (fallbackName) {
      const result = {
        kind: "builder",
        builderName: builderNameForExportName(fallbackName),
      } as const;
      cache?.set(expression, result);
      return result;
    }
  }

  // Hoisted-builder fallback (CT-1644 lift; CT-1655 handler): a `lift(...)` or
  // `handler(...)` call hoisted to a module-scope const leaves a synthetic
  // `__cfLift_N(captures)` / `__cfHandler_N(captures)` site whose callee
  // identifier the checker can't resolve to its const initializer (synthetic
  // nodes have no symbol). The hoisting stage records the hoisted inner call as
  // the identifier's original node; resolve the builder kind through it so the
  // application still classifies as the right builder (lift-applied for lift,
  // `builderName: "handler"` for handler) for downstream stages — notably
  // ReactiveVariableFor's `.for(...)` / stream-cause attachment, which runs
  // after hoisting and sees only the synthetic site. Gated on
  // `followFactoryResults` (matches the applied-call recognition path) and on
  // the hoist prefixes (so only our hoisted sites take this path), and only
  // consulted after symbol/name resolution has failed.
  if (
    options.followFactoryResults &&
    ts.isIdentifier(target) &&
    (target.text.startsWith(SYNTHETIC_LIFT_HOIST_PREFIX) ||
      target.text.startsWith(SYNTHETIC_HANDLER_HOIST_PREFIX))
  ) {
    const original = ts.getOriginalNode(target);
    if (original !== target && ts.isCallExpression(original)) {
      const kind = resolveBuilderExpressionKind(
        original.expression,
        checker,
        seen,
        options,
      );
      if (kind) {
        return kind;
      }
    }
  }

  if (!symbol || canUseBuilderSignatureFallback(symbol)) {
    const type = checker.getTypeAtLocation(target);
    const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
    for (const signature of signatures) {
      const signatureSymbol = getSignatureSymbol(signature);
      if (!signatureSymbol) continue;
      const kind = resolveBuilderSymbolKind(
        signatureSymbol,
        checker,
        seen,
        options,
      );
      if (kind) {
        cache?.set(expression, kind);
        return kind;
      }
    }
  }

  cache?.set(expression, null);
  return undefined;
}

function getExpressionSymbol(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    return checker.getSymbolAtLocation(expression.name);
  }
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    if (argument && ts.isExpression(argument)) {
      return checker.getSymbolAtLocation(argument);
    }
  }
  return checker.getSymbolAtLocation(expression);
}

function getDirectBuilderName(expression: ts.Expression): string | undefined {
  if (
    ts.isIdentifier(expression) && BUILDER_SYMBOL_NAMES.has(expression.text)
  ) {
    return expression.text;
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === CF_HELPERS_IDENTIFIER &&
    BUILDER_SYMBOL_NAMES.has(expression.name.text)
  ) {
    return expression.name.text;
  }
  return undefined;
}

function getSyntheticHelperCallKind(
  expression: ts.Expression,
):
  | Exclude<CallKind, { kind: "builder" | "array-method" | "cell-for" }>
  | undefined {
  if (!ts.isPropertyAccessExpression(expression)) {
    return undefined;
  }
  if (
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== CF_HELPERS_IDENTIFIER
  ) {
    return undefined;
  }
  return createNamedCallKind(expression.name.text);
}

function resolveBuilderSymbolKind(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
  options: { followFactoryResults: boolean },
): Extract<CallKind, { kind: "builder" }> | undefined {
  const importedBuilderName = getImportedCommonFabricNamedExport(
    symbol,
    BUILDER_SYMBOL_NAMES,
  );
  if (importedBuilderName) {
    return {
      kind: "builder",
      symbol,
      builderName: builderNameForExportName(importedBuilderName),
    };
  }

  const resolved = resolveAlias(symbol, checker, seen);
  if (!resolved) return undefined;
  if (seen.has(resolved)) return undefined;
  seen.add(resolved);

  // Three ways to be one of our builders: declared in the CommonFabric
  // declarations, imported from them, or ambient. They differ only in how the
  // symbol got here, not in what it is.
  const name = resolved.getName();
  if (
    BUILDER_SYMBOL_NAMES.has(name) &&
    (isCommonFabricSymbol(resolved) || isImportedFromCommonFabric(resolved) ||
      isAmbientSymbol(resolved))
  ) {
    return {
      kind: "builder",
      symbol: resolved,
      builderName: builderNameForExportName(name),
    };
  }

  for (const declaration of resolved.declarations ?? []) {
    if (
      ts.isVariableDeclaration(declaration) &&
      isConstVariableDeclaration(declaration) &&
      declaration.initializer &&
      shouldFollowBuilderInitializer(declaration.initializer, options)
    ) {
      const nested = resolveBuilderExpressionKind(
        declaration.initializer,
        checker,
        seen,
        options,
      );
      if (nested) return nested;
    }
  }

  return undefined;
}

function isConstVariableDeclaration(
  declaration: ts.VariableDeclaration,
): boolean {
  return (
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

function shouldFollowBuilderInitializer(
  initializer: ts.Expression,
  options: { followFactoryResults: boolean },
): boolean {
  const target = stripWrappers(initializer);
  return ts.isIdentifier(target) ||
    ts.isPropertyAccessExpression(target) ||
    ts.isElementAccessExpression(target) ||
    (options.followFactoryResults && ts.isCallExpression(target));
}

function canUseBuilderSignatureFallback(symbol: ts.Symbol): boolean {
  const declarations = symbol.declarations ?? [];
  if (declarations.length === 0) return true;

  return declarations.every((declaration) =>
    !ts.isVariableDeclaration(declaration) ||
    (isConstVariableDeclaration(declaration) && !declaration.initializer)
  );
}

function isImportedFromCommonFabric(symbol: ts.Symbol): boolean {
  return (symbol.declarations ?? []).some((declaration) => {
    let current: ts.Node | undefined = declaration;
    while (current) {
      if (ts.isImportDeclaration(current)) {
        return ts.isStringLiteral(current.moduleSpecifier) &&
          (current.moduleSpecifier.text === "commonfabric" ||
            current.moduleSpecifier.text === "@commonfabric/common");
      }
      current = current.parent;
    }
    return false;
  });
}

function getImportedCommonFabricNamedExport(
  symbol: ts.Symbol,
  allowedNames: ReadonlySet<string>,
): string | undefined {
  for (const declaration of symbol.declarations ?? []) {
    if (!ts.isImportSpecifier(declaration)) continue;
    let current: ts.Node | undefined = declaration;
    while (current && !ts.isImportDeclaration(current)) {
      current = current.parent;
    }
    if (
      !current ||
      !ts.isImportDeclaration(current) ||
      !ts.isStringLiteral(current.moduleSpecifier) ||
      (current.moduleSpecifier.text !== "commonfabric" &&
        current.moduleSpecifier.text !== "@commonfabric/common")
    ) {
      continue;
    }

    const importedName = declaration.propertyName?.text ??
      declaration.name.text;
    if (allowedNames.has(importedName)) {
      return importedName;
    }
  }
  return undefined;
}

function isAmbientSymbol(symbol: ts.Symbol): boolean {
  const declarations = symbol.declarations ?? [];
  return declarations.length > 0 &&
    declarations.every((declaration) =>
      declaration.getSourceFile().isDeclarationFile ||
      (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient) !==
        0
    );
}

function resolveSymbolKind(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): CallKind | undefined {
  const importedName = getImportedCommonFabricNamedExport(
    symbol,
    COMMONFABRIC_CALL_NAMES,
  );
  if (importedName) {
    return createNamedCallKind(importedName, symbol);
  }

  const resolved = resolveAlias(symbol, checker, seen);
  if (!resolved) return undefined;
  if (seen.has(resolved)) return undefined;
  seen.add(resolved);

  const declarations = resolved.declarations ?? [];
  const name = resolved.getName();

  for (const declaration of declarations) {
    const cellKind = detectCellMethodFromDeclaration(resolved, declaration);
    if (cellKind) return cellKind;

    if (isArrayMethodDeclaration(declaration)) {
      return { kind: "array-method", symbol: resolved };
    }
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      ts.isExpression(declaration.initializer)
    ) {
      const nested = resolveExpressionKind(
        declaration.initializer,
        checker,
        seen,
      );
      if (!nested) continue;
      if (
        nested.kind === "builder" &&
        !isConstVariableDeclaration(declaration)
      ) {
        continue;
      }
      return nested;
    }
  }

  const namedCallKind = createNamedCallKind(name, resolved);
  if (
    namedCallKind &&
    (
      isCommonFabricSymbol(resolved) ||
      isImportedFromCommonFabric(resolved) ||
      isAmbientSymbol(resolved)
    )
  ) {
    return namedCallKind;
  }

  return undefined;
}

function createNamedCallKind(
  name: string,
  symbol?: ts.Symbol,
):
  | Exclude<CallKind, { kind: "builder" | "array-method" | "cell-for" }>
  | undefined {
  const spec = COMMONFABRIC_RUNTIME_EXPORTS_BY_NAME.get(name);
  if (!spec || spec.category !== "call") {
    return undefined;
  }

  switch (spec.callKind) {
    case "lift-applied":
      return symbol
        ? { kind: "lift-applied", symbol }
        : { kind: "lift-applied" };
    case "ifElse":
      return symbol ? { kind: "ifElse", symbol } : { kind: "ifElse" };
    case "when":
      return symbol ? { kind: "when", symbol } : { kind: "when" };
    case "unless":
      return symbol ? { kind: "unless", symbol } : { kind: "unless" };
    case "cell-factory":
      return symbol
        ? { kind: "cell-factory", symbol, factoryName: name }
        : { kind: "cell-factory", factoryName: name };
    case "wish":
      return symbol ? { kind: "wish", symbol } : { kind: "wish" };
    case "generate-text":
      return symbol
        ? { kind: "generate-text", symbol }
        : { kind: "generate-text" };
    case "generate-object":
      return symbol
        ? { kind: "generate-object", symbol }
        : { kind: "generate-object" };
    case "pattern-tool":
      return symbol
        ? { kind: "pattern-tool", symbol }
        : { kind: "pattern-tool" };
    case "runtime-call":
      return symbol
        ? {
          kind: "runtime-call",
          symbol,
          exportName: name,
          reactiveOrigin: spec.reactiveOrigin,
        }
        : {
          kind: "runtime-call",
          exportName: name,
          reactiveOrigin: spec.reactiveOrigin,
        };
  }
}

function resolveAlias(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): ts.Symbol | undefined {
  let current = symbol;
  while (true) {
    if (seen.has(current)) return current;
    if (!(current.flags & ts.SymbolFlags.Alias)) break;
    const aliased = checker.getAliasedSymbol(current);
    if (!aliased) break;
    current = aliased;
  }
  return current;
}

function detectCellMethodFromDeclaration(
  symbol: ts.Symbol,
  declaration: ts.Declaration,
): CallKind | undefined {
  if (!hasIdentifierName(declaration)) return undefined;

  const name = declaration.name.text;

  // Check for static methods on Cell-like classes
  const owner = findOwnerName(declaration);
  if (owner && CELL_LIKE_CLASSES.has(owner)) {
    if (CELL_FACTORY_NAMES.has(name)) {
      return { kind: "cell-factory", symbol, factoryName: name };
    }
    if (CELL_FOR_NAMES.has(name)) {
      return { kind: "cell-for", symbol };
    }
  }

  return undefined;
}

function detectCellConstructorExpressionName(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): string | undefined {
  const target = stripWrappers(expression);

  if (
    ts.isPropertyAccessExpression(target) &&
    CELL_SCOPED_CONSTRUCTOR_NAMES.has(target.name.text)
  ) {
    return detectCellConstructorExpressionName(
      target.expression,
      checker,
      seen,
    );
  }

  if (!ts.isIdentifier(target) && !ts.isPropertyAccessExpression(target)) {
    return undefined;
  }

  const symbol = checker.getSymbolAtLocation(
    ts.isIdentifier(target) ? target : target.name,
  );
  if (!symbol) return undefined;
  if (seen.has(symbol)) return undefined;
  seen.add(symbol);

  const importedName = getImportedCommonFabricNamedExport(
    symbol,
    CELL_LIKE_CLASSES,
  );
  if (importedName) return importedName;

  const resolved = resolveAlias(symbol, checker, new Set());
  if (!resolved) return undefined;

  const name = resolved.getName();
  if (
    CELL_LIKE_CLASSES.has(name) &&
    (isCommonFabricSymbol(resolved) || isImportedFromCommonFabric(resolved))
  ) {
    return name;
  }

  for (const declaration of resolved.declarations ?? []) {
    if (
      ts.isVariableDeclaration(declaration) &&
      isConstVariableDeclaration(declaration) &&
      declaration.initializer &&
      shouldFollowConstructorInitializer(declaration.initializer)
    ) {
      const nested = detectCellConstructorExpressionName(
        declaration.initializer,
        checker,
        seen,
      );
      if (nested) return nested;
    }
  }

  return undefined;
}

function shouldFollowConstructorInitializer(
  initializer: ts.Expression,
): boolean {
  const target = stripWrappers(initializer);
  return ts.isIdentifier(target) ||
    ts.isPropertyAccessExpression(target) ||
    ts.isElementAccessExpression(target);
}

function isArrayMethodDeclaration(declaration: ts.Declaration): boolean {
  return isMethodDeclarationOwnedBy(
    declaration,
    isKnownArrayMethodName,
    ARRAY_OWNER_NAMES,
  );
}

function isMethodDeclarationOwnedBy(
  declaration: ts.Declaration,
  hasMethodName: (name: string) => boolean,
  ownerNames: ReadonlySet<string>,
): boolean {
  if (!hasIdentifierName(declaration)) return false;
  if (!hasMethodName(declaration.name.text)) return false;

  const owner = findOwnerName(declaration);
  return !!owner && ownerNames.has(owner);
}

/** Finds the nearest named type declaration containing `node`. */
function findOwnerDeclaration(
  node: ts.Node,
):
  | ts.InterfaceDeclaration
  | ts.ClassDeclaration
  | ts.TypeAliasDeclaration
  | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isInterfaceDeclaration(current) ||
      ts.isClassDeclaration(current) ||
      ts.isTypeAliasDeclaration(current)
    ) {
      return current;
    }
    if (ts.isSourceFile(current)) break;
    current = current.parent;
  }
  return undefined;
}

function findOwnerName(node: ts.Node): string | undefined {
  return findOwnerDeclaration(node)?.name?.text;
}

function hasIdentifierName(
  declaration: ts.Declaration,
): declaration is ts.Declaration & { readonly name: ts.Identifier } {
  const { name } = declaration as { name?: ts.Node };
  return !!name && ts.isIdentifier(name);
}

function getSignatureSymbol(signature: ts.Signature): ts.Symbol | undefined {
  // deno-lint-ignore no-explicit-any
  const sigWithSymbol = signature as any;
  if (sigWithSymbol.symbol) {
    return sigWithSymbol.symbol as ts.Symbol;
  }
  const declaration = signature.declaration;
  if (!declaration) return undefined;
  // deno-lint-ignore no-explicit-any
  const declWithSymbol = declaration as any;
  return declWithSymbol.symbol as ts.Symbol | undefined;
}
