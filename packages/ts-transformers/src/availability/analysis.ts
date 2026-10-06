import ts from "typescript";

import { detectCallKind } from "../ast/call-kind.ts";
import { getStableConstAliasInitializer } from "../ast/stable-const-alias.ts";
import { getTypeAtLocationWithFallback } from "../ast/utils.ts";
import { isCommonFabricSymbol } from "@commonfabric/schema-generator/common-fabric-symbols";
import { isCommonFabricAvailabilityType } from "@commonfabric/schema-generator/availability-brand";
import type { TransformationContext } from "../core/context.ts";
import {
  AVAILABILITY_REASONS,
  type AvailabilityObservation,
  type AvailabilityReason,
  isAvailabilityReason,
} from "./types.ts";

export function unwrapAvailabilityExpression(
  expression: ts.Expression,
): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isPartiallyEmittedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function valueSymbolAtIdentifier(
  identifier: ts.Identifier,
  context: TransformationContext,
): ts.Symbol | undefined {
  const parent = identifier.parent;
  if (
    parent && ts.isShorthandPropertyAssignment(parent) &&
    parent.name === identifier
  ) {
    return context.checker.getShorthandAssignmentValueSymbol(parent) ??
      context.checker.getSymbolAtLocation(identifier);
  }
  return context.checker.getSymbolAtLocation(identifier);
}

export type AvailabilityValueProvenance =
  | { readonly kind: "async-result"; readonly source: ts.Expression }
  | { readonly kind: "result-projection"; readonly source: ts.Expression };

const ASYNC_RUNTIME_EXPORTS = new Set([
  "compileAndRun",
  "fetchBinary",
  "fetchText",
  "fetchJson",
  "fetchJsonUnchecked",
  "fetchProgram",
  "generateTextStream",
  "sqliteQuery",
  "streamData",
]);

export function isDirectPartialResultSource(
  expression: ts.Expression,
  context: TransformationContext,
  seenSymbols: Set<ts.Symbol> = new Set(),
): boolean {
  const target = unwrapAvailabilityExpression(expression);
  if (ts.isCallExpression(target)) {
    const callKind = detectCallKind(target, context.checker);
    return (
      callKind?.kind === "runtime-call" &&
      (callKind.exportName === "generateTextStream" ||
        callKind.exportName === "streamData")
    ) || (
      callKind?.kind === "generate-object" &&
      callKind.exportName === "generateObjectStream"
    );
  }
  if (!ts.isIdentifier(target)) return false;
  const symbol = valueSymbolAtIdentifier(target, context);
  if (!symbol || seenSymbols.has(symbol)) return false;
  seenSymbols.add(symbol);
  const initializer = constInitializer(target, context);
  return !!initializer &&
    isDirectPartialResultSource(initializer, context, seenSymbols);
}

/** Finds direct compilation requests through stable const aliases. */
export function isDirectCompileResultSource(
  expression: ts.Expression,
  context: TransformationContext,
  seenSymbols: Set<ts.Symbol> = new Set(),
): boolean {
  const target = unwrapAvailabilityExpression(expression);
  if (ts.isCallExpression(target)) {
    const callKind = detectCallKind(target, context.checker);
    return callKind?.kind === "runtime-call" &&
      callKind.exportName === "compileAndRun";
  }
  if (!ts.isIdentifier(target)) return false;
  const symbol = valueSymbolAtIdentifier(target, context);
  if (!symbol || seenSymbols.has(symbol)) return false;
  seenSymbols.add(symbol);
  const initializer = constInitializer(target, context);
  return !!initializer &&
    isDirectCompileResultSource(initializer, context, seenSymbols);
}

/** Finds alias positions that remain outside implicitly lifted computations. */
export function isDirectResultChannelAliasPosition(
  node: ts.Expression,
): boolean {
  let current: ts.Node = node;
  while (current.parent) {
    const parent = current.parent;
    if (
      ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isPartiallyEmittedExpression(parent) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === current) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isArrayLiteralExpression(parent)
    ) {
      current = parent;
      continue;
    }
    return (ts.isVariableDeclaration(parent) &&
      parent.initializer === current) ||
      (ts.isReturnStatement(parent) && parent.expression === current) ||
      (ts.isArrowFunction(parent) && parent.body === current);
  }
  return false;
}

function isAvailabilityResultStateProducer(
  expression: ts.Expression,
  context: TransformationContext,
  seenSymbols: Set<ts.Symbol>,
): boolean {
  if (
    isDirectPartialResultSource(
      expression,
      context,
      new Set(seenSymbols),
    )
  ) {
    return true;
  }
  const target = unwrapAvailabilityExpression(expression);
  if (ts.isCallExpression(target)) {
    const callKind = detectCallKind(target, context.checker);
    return callKind?.kind === "wish" || callKind?.kind === "llm-dialog";
  }
  if (!ts.isIdentifier(target)) return false;
  const symbol = valueSymbolAtIdentifier(target, context);
  if (!symbol || seenSymbols.has(symbol)) return false;
  seenSymbols.add(symbol);
  const initializer = constInitializer(target, context);
  return !!initializer &&
    isAvailabilityResultStateProducer(initializer, context, seenSymbols);
}

function constInitializer(
  identifier: ts.Identifier,
  context: TransformationContext,
): ts.Expression | undefined {
  const symbol = valueSymbolAtIdentifier(identifier, context);
  return getStableConstAliasInitializer(symbol, context.factory);
}

/**
 * Resolve the async-result origin which TypeScript can erase for `any` and
 * `unknown`. A resultOf projection deliberately retains its source while
 * marking that the static usable view no longer exposes unavailable variants.
 */
export function resolveAvailabilityValueProvenance(
  expression: ts.Expression,
  context: TransformationContext,
  seenSymbols: Set<ts.Symbol> = new Set(),
): AvailabilityValueProvenance | undefined {
  const target = unwrapAvailabilityExpression(expression);

  if (ts.isCallExpression(target)) {
    const callKind = detectCallKind(target, context.checker);
    if (callKind?.kind === "availability-result") {
      const source = target.arguments[0];
      if (!source) return undefined;
      const nested = resolveAvailabilityValueProvenance(
        source,
        context,
        seenSymbols,
      );
      return {
        kind: "result-projection",
        source: nested?.source ?? source,
      };
    }
    if (callKind?.kind === "partial-result") {
      return { kind: "result-projection", source: target };
    }
    if (callKind?.kind === "generate-text") {
      return { kind: "async-result", source: target };
    }
    if (callKind?.kind === "generate-object") {
      return { kind: "async-result", source: target };
    }
    if (
      callKind?.kind === "runtime-call" &&
      ASYNC_RUNTIME_EXPORTS.has(callKind.exportName)
    ) {
      return { kind: "async-result", source: target };
    }
  }

  if (ts.isPropertyAccessExpression(target) && target.name.text === "result") {
    if (
      isAvailabilityResultStateProducer(
        target.expression,
        context,
        new Set(seenSymbols),
      )
    ) {
      return { kind: "async-result", source: target };
    }
  }

  if (!ts.isIdentifier(target)) return undefined;
  const symbol = valueSymbolAtIdentifier(target, context);
  if (!symbol || seenSymbols.has(symbol)) return undefined;
  seenSymbols.add(symbol);
  const initializer = constInitializer(target, context);
  return initializer
    ? resolveAvailabilityValueProvenance(initializer, context, seenSymbols)
    : undefined;
}

/** The authored successful type argument of an async producer. */
export function authoredAvailabilitySuccess(
  expression: ts.Expression,
  context: TransformationContext,
  seen: Set<ts.Symbol> = new Set(),
): ts.TypeNode | undefined {
  const target = unwrapAvailabilityExpression(expression);
  if (ts.isPropertyAccessExpression(target) && target.name.text === "result") {
    return authoredAvailabilitySuccess(target.expression, context, seen);
  }
  if (ts.isCallExpression(target)) {
    const kind = detectCallKind(target, context.checker)?.kind;
    if (kind === "availability-result" && target.arguments[0]) {
      return authoredAvailabilitySuccess(target.arguments[0], context, seen);
    }
    if (kind === "wish") return target.typeArguments?.[0];
  }
  if (ts.isIdentifier(target)) {
    const symbol = valueSymbolAtIdentifier(target, context);
    if (!symbol || seen.has(symbol)) return undefined;
    seen.add(symbol);
    const initializer = constInitializer(target, context);
    return initializer &&
      authoredAvailabilitySuccess(initializer, context, seen);
  }
  return undefined;
}

/** Return the source behind a const initialized from resultOf(), if any. */
export function resolveResultOfSource(
  expression: ts.Expression,
  context: TransformationContext,
  seenSymbols: Set<ts.Symbol> = new Set(),
): ts.Expression | undefined {
  const target = unwrapAvailabilityExpression(expression);
  if (ts.isCallExpression(target)) {
    if (
      detectCallKind(target, context.checker)?.kind === "availability-result"
    ) {
      const source = target.arguments[0];
      return source
        ? resolveResultOfSource(source, context, seenSymbols) ?? source
        : undefined;
    }
    return undefined;
  }
  if (!ts.isIdentifier(target)) return undefined;
  const symbol = valueSymbolAtIdentifier(target, context);
  if (!symbol || seenSymbols.has(symbol)) return undefined;
  seenSymbols.add(symbol);
  const initializer = constInitializer(target, context);
  return initializer
    ? resolveResultOfSource(initializer, context, seenSymbols)
    : undefined;
}

function captureRootIdentifier(
  expression: ts.Expression,
): ts.Identifier | undefined {
  let current = unwrapAvailabilityExpression(expression);
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    current = unwrapAvailabilityExpression(current.expression);
  }
  return ts.isIdentifier(current) ? current : undefined;
}

interface StableCaptureIdentity {
  readonly root: ts.Symbol;
  readonly path: readonly string[];
}

/**
 * Resolve const aliases while retaining the physical reactive path they name.
 * Calls and dynamic element accesses deliberately stop the walk: only a stable
 * path can safely share one serialized lift input.
 */
function stableCaptureIdentity(
  expression: ts.Expression,
  context: TransformationContext,
  seenSymbols: Set<ts.Symbol> = new Set(),
): StableCaptureIdentity | undefined {
  const target = unwrapAvailabilityExpression(expression);
  if (ts.isIdentifier(target)) {
    const symbol = valueSymbolAtIdentifier(target, context);
    if (!symbol) return undefined;
    if (!seenSymbols.has(symbol)) {
      seenSymbols.add(symbol);
      const initializer = constInitializer(target, context);
      const initialized = initializer
        ? stableCaptureIdentity(initializer, context, seenSymbols)
        : undefined;
      if (initialized) return initialized;
    }
    return { root: symbol, path: [] };
  }
  if (ts.isPropertyAccessExpression(target)) {
    const parent = stableCaptureIdentity(
      target.expression,
      context,
      seenSymbols,
    );
    return parent
      ? { root: parent.root, path: [...parent.path, target.name.text] }
      : undefined;
  }
  if (ts.isElementAccessExpression(target)) {
    const argument = unwrapAvailabilityExpression(target.argumentExpression);
    if (!ts.isStringLiteralLike(argument) && !ts.isNumericLiteral(argument)) {
      return undefined;
    }
    const parent = stableCaptureIdentity(
      target.expression,
      context,
      seenSymbols,
    );
    return parent
      ? { root: parent.root, path: [...parent.path, argument.text] }
      : undefined;
  }
  return undefined;
}

function sameStableCapture(
  left: StableCaptureIdentity | undefined,
  right: StableCaptureIdentity | undefined,
): boolean {
  return !!left && !!right && left.root === right.root &&
    left.path.length === right.path.length &&
    left.path.every((segment, index) => segment === right.path[index]);
}

export interface CanonicalResultOfCaptures {
  readonly captures: Set<ts.Expression>;
  /** Captured alias symbol -> its one physical resultOf reactive source. */
  readonly aliases: ReadonlyMap<ts.Symbol, ts.Expression>;
}

/**
 * Collapse captured reads through `const usable = resultOf(source)` onto the
 * source itself. The whole source is captured rather than a projected child so
 * a marker stored at the source root reaches runner preflight unchanged.
 */
export function canonicalizeResultOfCaptures(
  captures: Iterable<ts.Expression>,
  context: TransformationContext,
): CanonicalResultOfCaptures {
  const authoredCaptures = [...captures];
  const canonical = new Set<ts.Expression>();
  const aliases = new Map<ts.Symbol, ts.Expression>();
  const resultSources: Array<{
    source: ts.Expression;
    identity: StableCaptureIdentity | undefined;
    projectionType: ts.Type | undefined;
    capture?: ts.Expression;
  }> = [];

  for (const capture of authoredCaptures) {
    const root = captureRootIdentifier(capture);
    if (!root) continue;
    const source = resolveResultOfSource(root, context);
    if (!source) continue;
    const identity = stableCaptureIdentity(source, context);
    if (
      !resultSources.some((entry) =>
        sameStableCapture(entry.identity, identity)
      )
    ) {
      resultSources.push({
        source,
        identity,
        projectionType: getTypeAtLocationWithFallback(
          root,
          context.checker,
          context.options.state?.typeRegistry,
        ),
      });
    }
  }

  for (const capture of authoredCaptures) {
    const root = captureRootIdentifier(capture);
    const symbol = root ? valueSymbolAtIdentifier(root, context) : undefined;
    const resultSource = root
      ? resolveResultOfSource(root, context)
      : undefined;
    const identity = resultSource
      ? stableCaptureIdentity(resultSource, context)
      : root
      ? stableCaptureIdentity(root, context)
      : undefined;
    const shared = resultSources.find((entry) =>
      sameStableCapture(entry.identity, identity)
    );
    if (symbol && shared) {
      if (!shared.capture) {
        shared.capture = cloneSourceExpression(shared.source, context.factory);
        const sourceType = getTypeAtLocationWithFallback(
          shared.source,
          context.checker,
          context.state.typeRegistry,
        );
        if (sourceType) {
          context.state.recordAvailabilityCapture(
            shared.capture,
            sourceType,
            authoredAvailabilitySuccess(shared.source, context),
          );
        }
        if (shared.projectionType) {
          context.options.state?.typeRegistry.set(
            shared.capture,
            shared.projectionType,
          );
        }
      }
      const sourceRoot = captureRootIdentifier(shared.source);
      const sourceSymbol = sourceRoot
        ? valueSymbolAtIdentifier(sourceRoot, context)
        : undefined;
      if (symbol !== sourceSymbol || resultSource) {
        aliases.set(symbol, shared.capture);
      }
      canonical.add(shared.capture);
      continue;
    }
    canonical.add(capture);
  }
  return { captures: canonical, aliases };
}

function cloneSourceExpression(
  expression: ts.Expression,
  factory: ts.NodeFactory,
): ts.Expression {
  const target = unwrapAvailabilityExpression(expression);
  if (ts.isIdentifier(target)) {
    const clone = factory.createIdentifier(target.text);
    ts.setOriginalNode(clone, target);
    return clone;
  }
  if (ts.isPropertyAccessExpression(target)) {
    const receiver = cloneSourceExpression(target.expression, factory);
    return ts.isPropertyAccessChain(target)
      ? factory.createPropertyAccessChain(
        receiver,
        target.questionDotToken,
        target.name,
      )
      : factory.createPropertyAccessExpression(receiver, target.name);
  }
  if (ts.isElementAccessExpression(target)) {
    const receiver = cloneSourceExpression(target.expression, factory);
    return ts.isElementAccessChain(target)
      ? factory.createElementAccessChain(
        receiver,
        target.questionDotToken,
        target.argumentExpression,
      )
      : factory.createElementAccessExpression(
        receiver,
        target.argumentExpression,
      );
  }
  // Complex direct producer calls are already captured by dataflow analysis;
  // resultOf alias canonicalization is intentionally limited to stable capture
  // paths so we never duplicate an effectful factory call inside a callback.
  return target;
}

/** Rewrite resultOf alias references in a generated callback to their source. */
export function rewriteResultOfAliasReferences<T extends ts.Node>(
  node: T,
  aliases: ReadonlyMap<ts.Symbol, ts.Expression>,
  context: TransformationContext,
  transformation: ts.TransformationContext,
): T {
  if (aliases.size === 0) return node;
  const replacementFor = (
    identifier: ts.Identifier,
  ): ts.Expression | undefined => {
    const symbol = valueSymbolAtIdentifier(identifier, context);
    const source = symbol ? aliases.get(symbol) : undefined;
    if (!source) return undefined;
    const replacement = cloneSourceExpression(source, context.factory);
    // The emitted expression names the physical AsyncResult source, while
    // this occurrence still has the usable type selected by resultOf(). That
    // distinction keeps Cell capabilities and structural reads in the input
    // schema without duplicating the source or hiding its root marker from
    // runner preflight.
    const projectionType = getTypeAtLocationWithFallback(
      identifier,
      context.checker,
      context.options.state?.typeRegistry,
    );
    if (projectionType) {
      context.options.state?.typeRegistry.set(replacement, projectionType);
    }
    return replacement;
  };
  const visit: ts.Visitor = (current) => {
    if (ts.isShorthandPropertyAssignment(current)) {
      const replacement = replacementFor(current.name);
      if (replacement) {
        // Preserve the authored output key: `{ result }` becomes
        // `{ result: request }`, not `{ request }`.
        return context.factory.createPropertyAssignment(
          current.name,
          replacement,
        );
      }
    }
    if (ts.isIdentifier(current)) {
      return replacementFor(current) ?? current;
    }
    return ts.visitEachChild(current, visit, transformation);
  };
  return ts.visitNode(node, visit) as T;
}

const COMMONFABRIC_AVAILABILITY_CONTAINER_NAMES = new Set([
  "AsyncResult",
  "FabricUnavailable",
  "UnavailableVariant",
]);

function isCommonFabricAvailabilityContainer(type: ts.Type): boolean {
  const symbols = [type.aliasSymbol, type.getSymbol()].filter(
    (symbol): symbol is ts.Symbol => !!symbol,
  );
  return symbols.some((symbol) =>
    COMMONFABRIC_AVAILABILITY_CONTAINER_NAMES.has(symbol.getName()) &&
    isCommonFabricSymbol(symbol)
  );
}

function isCommonFabricDataUnavailableBase(type: ts.Type): boolean {
  const symbols = [type.aliasSymbol, type.getSymbol()].filter(
    (symbol): symbol is ts.Symbol => !!symbol,
  );
  return symbols.some((symbol) =>
    symbol.getName() === "FabricUnavailable" && isCommonFabricSymbol(symbol)
  );
}

export function typeContainsAvailabilityVariant(
  type: ts.Type,
  variant: ts.Type,
  checker: ts.TypeChecker,
  seen: Set<ts.Type> = new Set(),
): boolean {
  if (seen.has(type)) return false;
  seen.add(type);

  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    return false;
  }

  // Branded stream results distribute the type-only association across each
  // concrete availability arm. Those arms are strict subtypes of the public
  // guard variant, so one-way assignability is the membership test we want.
  if (checker.isTypeAssignableTo(type, variant)) {
    return true;
  }
  // A terminal error channel admits its more specific error-kind guards.
  // Nominal recognition prevents a structural lookalike from opting in.
  if (
    isCommonFabricAvailabilityType(type, undefined) &&
    checker.isTypeAssignableTo(variant, type)
  ) return true;

  if (isCommonFabricAvailabilityContainer(type)) {
    return true;
  }

  if (type.flags & ts.TypeFlags.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type);
    return !!constraint && constraint !== type &&
      typeContainsAvailabilityVariant(constraint, variant, checker, seen);
  }

  if (type.isUnion()) {
    return type.types.some((member) =>
      typeContainsAvailabilityVariant(member, variant, checker, seen)
    );
  }

  if (type.isIntersection()) {
    return type.types.some((member) =>
      !isCommonFabricDataUnavailableBase(member) &&
      typeContainsAvailabilityVariant(member, variant, checker, seen)
    );
  }

  return false;
}

/**
 * Whether a guard may authorize its reason at an explicit compute boundary.
 * Concrete unions use semantic type membership. `any`/`unknown` require a
 * retained async-producer origin so an arbitrary plain value is not silently
 * treated as an availability channel.
 */
export function guardOperandExposesAvailability(
  operand: ts.Expression,
  variant: ts.Type | undefined,
  context: TransformationContext,
): boolean {
  const type = getTypeAtLocationWithFallback(
    operand,
    context.checker,
    context.options.state?.typeRegistry,
  );
  if (!type) return false;

  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    return resolveAvailabilityValueProvenance(operand, context)?.kind ===
      "async-result";
  }
  return !!variant &&
    typeContainsAvailabilityVariant(type, variant, context.checker);
}

export function parseAvailabilityObservation(
  call: ts.CallExpression,
  context: TransformationContext,
  reportInvalid = false,
): AvailabilityObservation | undefined {
  if (detectCallKind(call, context.checker)?.kind !== "availability-observer") {
    return undefined;
  }

  const source = call.arguments[0];
  if (!source) {
    if (reportInvalid) {
      context.reportDiagnosticOnce({
        type: "availability:invalid-observation",
        message: "observeAvailability() requires a value to observe.",
        node: call,
      });
    }
    return undefined;
  }

  if (call.arguments.length === 1) {
    return { source, reasons: AVAILABILITY_REASONS };
  }

  const reasons: AvailabilityReason[] = [];
  for (const argument of call.arguments.slice(1)) {
    if (
      !ts.isStringLiteralLike(argument) ||
      !isAvailabilityReason(argument.text)
    ) {
      if (reportInvalid) {
        context.reportDiagnosticOnce({
          type: "availability:invalid-observation",
          message:
            "observeAvailability() reasons must be literal pending, error, syncing, or schemaMismatch values.",
          node: argument,
        });
      }
      return undefined;
    }
    if (!reasons.includes(argument.text)) {
      reasons.push(argument.text);
    }
  }

  return { source, reasons };
}

export function resolveAvailabilityObservation(
  expression: ts.Expression,
  context: TransformationContext,
  seenSymbols: Set<ts.Symbol> = new Set(),
): AvailabilityObservation | undefined {
  const target = unwrapAvailabilityExpression(expression);
  const recorded = context.lookupAvailabilityObservation(target);
  if (recorded) return recorded;

  if (ts.isCallExpression(target)) {
    return parseAvailabilityObservation(target, context);
  }

  if (!ts.isIdentifier(target)) return undefined;
  const symbol = valueSymbolAtIdentifier(target, context);
  if (!symbol || seenSymbols.has(symbol)) return undefined;
  seenSymbols.add(symbol);

  const symbolObservation = context.lookupAvailabilityObservation(symbol);
  if (symbolObservation) return symbolObservation;

  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer
  ) {
    return resolveAvailabilityObservation(
      declaration.initializer,
      context,
      seenSymbols,
    );
  }

  return undefined;
}
