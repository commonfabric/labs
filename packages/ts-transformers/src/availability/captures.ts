import ts from "typescript";

import { detectCallKind } from "../ast/call-kind.ts";
import { getStableConstAliasInitializer } from "../ast/stable-const-alias.ts";
import { getTypeAtLocationWithFallback } from "../ast/utils.ts";
import type { TransformationContext } from "../core/context.ts";
import { parseCaptureExpression } from "../utils/capture-tree.ts";
import {
  guardOperandExposesAvailability,
  resolveAvailabilityObservation,
  typeContainsAvailabilityVariant,
  unwrapAvailabilityExpression,
} from "./analysis.ts";
import type { AvailabilityObservation, AvailabilityReason } from "./types.ts";

export interface AvailabilityVariantType {
  readonly name:
    | "IsPending"
    | "HasError"
    | "IsSyncing"
    | "HasSchemaMismatch";
  readonly type?: ts.Type;
}

export interface AvailabilityCaptureOverride {
  readonly path: readonly string[];
  /** The pre-cast expression whose ordinary data type forms the union base. */
  readonly source?: ts.Expression;
  readonly reasons: readonly AvailabilityReason[];
  readonly variants: readonly AvailabilityVariantType[];
}

const VARIANT_NAME_BY_REASON = {
  pending: "IsPending",
  error: "HasError",
  syncing: "IsSyncing",
  "schemaMismatch": "HasSchemaMismatch",
} as const satisfies Record<
  AvailabilityReason,
  AvailabilityVariantType["name"]
>;

export function availabilityPathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

export function parseAvailabilityCaptureExpression(
  expression: ts.Expression,
): ReturnType<typeof parseCaptureExpression> {
  const parsed = parseCaptureExpression(expression);
  if (parsed) return parsed;

  const target = unwrapAvailabilityExpression(expression);
  if (!ts.isElementAccessExpression(target)) return undefined;
  const argument = unwrapAvailabilityExpression(target.argumentExpression);
  if (!ts.isStringLiteralLike(argument) && !ts.isNumericLiteral(argument)) {
    return undefined;
  }
  const receiver = parseAvailabilityCaptureExpression(target.expression);
  return receiver
    ? {
      root: receiver.root,
      path: [...receiver.path, argument.text],
      expression,
    }
    : undefined;
}

function captureRootIdentifier(
  expression: ts.Expression,
): ts.Identifier | undefined {
  let current = unwrapAvailabilityExpression(expression);
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current) ||
    (ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === "key")
  ) {
    if (ts.isCallExpression(current)) {
      const callee = current.expression as ts.PropertyAccessExpression;
      current = unwrapAvailabilityExpression(callee.expression);
    } else {
      current = unwrapAvailabilityExpression(current.expression);
    }
  }
  return ts.isIdentifier(current) ? current : undefined;
}

/** Read a capture's declared type before control-flow narrowing inside a compute. */
function captureTypeSource(
  expression: ts.Expression,
  context: TransformationContext,
  boundary?: ts.Node,
): ts.Expression {
  const root = captureRootIdentifier(expression);
  const capture = parseAvailabilityCaptureExpression(expression);
  if (!root || !capture) return expression;
  const symbol = context.checker.getSymbolAtLocation(root);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (
    !declaration ||
    !(ts.isVariableDeclaration(declaration) || ts.isParameter(declaration) ||
      ts.isBindingElement(declaration)) ||
    !ts.isIdentifier(declaration.name)
  ) return expression;
  const initializer = boundary && nodeIsWithin(declaration, boundary)
    ? getStableConstAliasInitializer(symbol, context.factory)
    : undefined;
  const rootSource = initializer
    ? captureTypeSource(initializer, context, boundary)
    : declaration.name;
  if (capture.path.length === 0) return rootSource;
  let type = getTypeAtLocationWithFallback(
    rootSource,
    context.checker,
    context.state.typeRegistry,
  );
  for (const segment of capture.path) {
    if (!type) return expression;
    const property = context.checker.getPropertyOfType(type, segment);
    type = property
      ? context.checker.getTypeOfSymbolAtLocation(property, declaration)
      : /^(0|[1-9]\d*)$/.test(segment)
      ? context.checker.getIndexTypeOfType(type, ts.IndexKind.Number)
      : undefined;
  }
  if (!type) return expression;
  const source = context.factory.createParenthesizedExpression(expression);
  context.state.typeRegistry.set(source, type);
  return source;
}

function nodeIsWithin(node: ts.Node, boundary: ts.Node): boolean {
  for (
    let current: ts.Node | undefined = node;
    current;
    current = current.parent
  ) {
    if (current === boundary) return true;
  }
  return false;
}

/**
 * Resolve aliases declared inside an explicit compute back to the closure
 * capture which initializes them. Those locals are not fields of the emitted
 * lift input, so policy paths must not use the local binding name.
 */
function parseExplicitAvailabilityCaptureExpression(
  expression: ts.Expression,
  boundary: ts.Expression | ts.Block,
  context: TransformationContext,
  seen: Set<ts.Symbol> = new Set(),
  diagnosticNode: ts.Expression = expression,
): ReturnType<typeof parseCaptureExpression> {
  const reportUnsupported = (): void => {
    context.reportDiagnosticOnce({
      type: "availability:unsupported-guard-operand",
      message:
        "Availability guards inside computed()/lift() can follow only stable const aliases. Use a const alias with a static property, element, or key() path.",
      node: diagnosticNode,
    });
  };
  const parsed = parseAvailabilityCaptureExpression(expression);
  if (!parsed) {
    reportUnsupported();
    return undefined;
  }
  const root = captureRootIdentifier(expression);
  if (!root) return parsed;
  const symbol = context.checker.getSymbolAtLocation(root);
  if (!symbol || seen.has(symbol)) return parsed;
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration || !nodeIsWithin(declaration, boundary)) {
    return parsed;
  }
  const initializer = getStableConstAliasInitializer(
    symbol,
    context.factory,
  );
  if (!initializer) {
    reportUnsupported();
    return undefined;
  }
  seen.add(symbol);
  const source = parseExplicitAvailabilityCaptureExpression(
    initializer,
    boundary,
    context,
    seen,
    diagnosticNode,
  );
  return source
    ? {
      root: source.root,
      path: [...source.path, ...parsed.path],
      expression,
    }
    : undefined;
}

function predicateTypeForCall(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  const signature = checker.getResolvedSignature(call);
  if (!signature) return undefined;
  return checker.getTypePredicateOfSignature(signature)?.type;
}

function availabilityVariantsForReasons(
  reasons: readonly AvailabilityReason[],
  context: TransformationContext,
): readonly AvailabilityVariantType[] {
  return reasons.map((reason) => {
    const name = VARIANT_NAME_BY_REASON[reason];
    const type = context.lookupAvailabilityVariantType(name);
    return { name, ...(type ? { type } : {}) };
  });
}

export function availabilityOverrideForObservation(
  path: readonly string[],
  observation: AvailabilityObservation,
  context: TransformationContext,
): AvailabilityCaptureOverride {
  return {
    path,
    source: observation.source,
    reasons: observation.reasons,
    variants: availabilityVariantsForReasons(observation.reasons, context),
  };
}

/**
 * Resolve observation provenance on closure captures. Paths remain in their
 * authored, pre-collision-renaming form so capture type construction can match
 * the capture tree exactly.
 */
export function collectObservedAvailabilityCaptures(
  captures: Iterable<ts.Expression>,
  context: TransformationContext,
): readonly AvailabilityCaptureOverride[] {
  const entries = new Map<string, AvailabilityCaptureOverride>();
  for (const captureExpression of captures) {
    let observation = resolveAvailabilityObservation(
      captureExpression,
      context,
    );
    let capture = parseAvailabilityCaptureExpression(captureExpression);
    if (!observation) {
      const root = captureRootIdentifier(captureExpression);
      if (root) {
        observation = resolveAvailabilityObservation(root, context);
        if (observation) capture = parseAvailabilityCaptureExpression(root);
      }
    }
    if (!observation) continue;
    if (!capture) continue;
    const path = [capture.root, ...capture.path];
    entries.set(
      availabilityPathKey(path),
      availabilityOverrideForObservation(path, observation, context),
    );
  }
  return [...entries.values()];
}

function unwrapObservedInputExpression(
  expression: ts.Expression,
  context: TransformationContext,
  seen: Set<ts.Symbol> = new Set(),
): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  if (!ts.isIdentifier(current)) return current;
  const symbol = context.checker.getSymbolAtLocation(current);
  if (!symbol || seen.has(symbol)) return current;
  seen.add(symbol);
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  return declaration && ts.isVariableDeclaration(declaration) &&
      declaration.initializer
    ? unwrapObservedInputExpression(declaration.initializer, context, seen)
    : current;
}

function propertyNameText(
  name: ts.PropertyName | ts.BindingName | undefined,
): string | undefined {
  if (!name) return undefined;
  if (
    ts.isIdentifier(name) || ts.isStringLiteralLike(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

/**
 * Find observed leaves inside an applied lift input. Object/array literals are
 * traversed because destructured callbacks expose those leaves as independent
 * exact policy paths.
 */
export function collectObservedAvailabilityInputPaths(
  expression: ts.Expression,
  context: TransformationContext,
  path: readonly string[] = [],
): readonly AvailabilityCaptureOverride[] {
  const observation = resolveAvailabilityObservation(expression, context);
  if (observation) {
    return [availabilityOverrideForObservation(path, observation, context)];
  }

  const target = unwrapObservedInputExpression(expression, context);
  if (ts.isObjectLiteralExpression(target)) {
    const entries: AvailabilityCaptureOverride[] = [];
    for (const property of target.properties) {
      if (ts.isPropertyAssignment(property)) {
        const segment = propertyNameText(property.name);
        if (segment !== undefined) {
          for (
            const entry of collectObservedAvailabilityInputPaths(
              property.initializer,
              context,
              [...path, segment],
            )
          ) entries.push(entry);
        }
      } else if (ts.isShorthandPropertyAssignment(property)) {
        for (
          const entry of collectObservedAvailabilityInputPaths(
            property.name,
            context,
            [...path, property.name.text],
          )
        ) entries.push(entry);
      }
    }
    return entries;
  }

  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.flatMap((element, index) =>
      ts.isExpression(element)
        ? collectObservedAvailabilityInputPaths(
          element,
          context,
          [...path, String(index)],
        )
        : []
    );
  }
  return [];
}

/** Map authored capture roots to their collision-safe emitted names. */
export function renameAvailabilityCapturePaths(
  entries: readonly AvailabilityCaptureOverride[],
  renameMap: ReadonlyMap<string, string>,
): readonly AvailabilityCaptureOverride[] {
  return entries.map((entry) => {
    const [root, ...rest] = entry.path;
    if (!root) return entry;
    return {
      ...entry,
      path: [renameMap.get(root) ?? root, ...rest],
    };
  });
}

export function collectAvailabilityGuardCaptures(
  expression: ts.Expression,
  context: TransformationContext,
): readonly AvailabilityCaptureOverride[] {
  const byPath = new Map<string, {
    path: readonly string[];
    reasons: AvailabilityReason[];
    variants: AvailabilityVariantType[];
  }>();

  const visit = (node: ts.Node): void => {
    if (node !== expression && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const callKind = detectCallKind(node, context.checker);
      if (callKind?.kind === "availability-guard") {
        const operand = node.arguments[0];
        const capture = operand
          ? parseAvailabilityCaptureExpression(operand)
          : undefined;
        if (!capture) {
          context.reportDiagnosticOnce({
            type: "availability:unsupported-guard-operand",
            message:
              "Availability guards in pattern context require a direct reactive capture path.",
            node,
          });
        } else {
          const path = [capture.root, ...capture.path];
          const key = availabilityPathKey(path);
          let entry = byPath.get(key);
          if (!entry) {
            entry = { path, reasons: [], variants: [] };
            byPath.set(key, entry);
          }
          if (!entry.reasons.includes(callKind.reason)) {
            entry.reasons.push(callKind.reason);
          }
          if (
            !entry.variants.some((variant) =>
              variant.name === callKind.variantTypeName
            )
          ) {
            const predicateType = predicateTypeForCall(node, context.checker);
            if (predicateType) {
              context.recordAvailabilityVariantType(
                callKind.variantTypeName,
                predicateType,
              );
            }
            entry.variants.push({
              name: callKind.variantTypeName,
              ...(predicateType ? { type: predicateType } : {}),
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);

  return [...byPath.values()];
}

type AvailabilityAnalyzableFunction =
  & (
    | ts.ArrowFunction
    | ts.FunctionExpression
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
  )
  & { readonly body: ts.ConciseBody };

function localAvailabilityHelperForCall(
  call: ts.CallExpression,
  context: TransformationContext,
): AvailabilityAnalyzableFunction | undefined {
  const declaration = context.checker.getResolvedSignature(call)?.declaration;
  if (
    !declaration ||
    declaration.getSourceFile().fileName !== context.sourceFile.fileName ||
    !(
      ts.isArrowFunction(declaration) ||
      ts.isFunctionExpression(declaration) ||
      ts.isFunctionDeclaration(declaration) ||
      ts.isMethodDeclaration(declaration)
    ) || !declaration.body
  ) {
    return undefined;
  }
  return declaration as AvailabilityAnalyzableFunction;
}

function helperGuardEntryAtCallSite(
  entry: AvailabilityCaptureOverride,
  helper: AvailabilityAnalyzableFunction,
  call: ts.CallExpression,
  context: TransformationContext,
): AvailabilityCaptureOverride | undefined {
  const [root, ...rest] = entry.path;
  if (!root) return entry;

  for (let index = 0; index < helper.parameters.length; index++) {
    const parameter = helper.parameters[index];
    const argument = call.arguments[index];
    if (!parameter || !argument) continue;
    const binding = bindingPathForIdentifier(
      ts.factory.createIdentifier(root),
      parameter.name,
    );
    if (binding === undefined) continue;

    const reportUnstableCallerPath = (): void => {
      context.reportDiagnosticOnce({
        type: "availability:unobserved-compute-guard",
        message:
          "An availability guard reached through a helper requires a stable caller capture path. Hoist dynamically selected values outside computed(), then pass the stable alias to the helper.",
        node: call,
      });
    };
    const capture = parseAvailabilityCaptureExpression(argument);
    if (!capture) {
      reportUnstableCallerPath();
      return undefined;
    }
    const relativePath = applyBindingPath(binding, rest);
    if (!relativePath) {
      reportUnstableCallerPath();
      return undefined;
    }
    let relativeType = getTypeAtLocationWithFallback(
      argument,
      context.checker,
      context.options.state?.typeRegistry,
    );
    for (const segment of relativePath) {
      if (!relativeType) break;
      const property = context.checker.getPropertyOfType(relativeType, segment);
      if (property) {
        const declaration = property.valueDeclaration ??
          property.declarations?.[0];
        relativeType = context.checker.getTypeOfSymbolAtLocation(
          property,
          declaration ?? argument,
        );
      } else if (/^(0|[1-9]\d*)$/.test(segment)) {
        relativeType = context.checker.getIndexTypeOfType(
          relativeType,
          ts.IndexKind.Number,
        );
      } else {
        relativeType = undefined;
      }
    }
    const observation = resolveAvailabilityObservation(argument, context);
    const acceptedReasons = entry.reasons.filter((reason) => {
      const variantName = VARIANT_NAME_BY_REASON[reason];
      const variantType = context.lookupAvailabilityVariantType(variantName);
      const exposesAtPath = relativePath.length === 0
        ? guardOperandExposesAvailability(
          argument,
          variantType,
          context,
        )
        : !!relativeType && !!variantType && typeContainsAvailabilityVariant(
          relativeType,
          variantType,
          context.checker,
        );
      return exposesAtPath || observation?.reasons.includes(reason);
    });
    if (acceptedReasons.length !== entry.reasons.length) {
      context.reportDiagnosticOnce({
        type: "availability:unobserved-compute-guard",
        message:
          "An availability guard reached through a helper requires the caller input to expose the same unavailable variant. Guard the original AsyncResult, or widen the caller value with observeAvailability() outside the compute.",
        node: call,
      });
    }
    if (acceptedReasons.length === 0) return undefined;
    return {
      ...entry,
      path: [capture.root, ...capture.path, ...relativePath],
      reasons: acceptedReasons,
      source: relativePath.length === 0
        ? captureTypeSource(argument, context)
        : undefined,
    };
  }

  // The helper guard refers to a closure capture rather than one of its
  // parameters, so its path is already relative to the owning computation.
  return entry;
}

/**
 * Guard policy for an existing compute boundary. Unlike direct pattern guard
 * lowering, this never widens a plain capture: the operand must already expose
 * the requested variant (including retained async provenance for `any`). The
 * existing capture type therefore supplies the schema arm and `variants` stays
 * empty; only exact-path policy is added here.
 */
export function collectExplicitAvailabilityGuardCaptures(
  expression: ts.Expression | ts.Block,
  context: TransformationContext,
): readonly AvailabilityCaptureOverride[] {
  return collectExplicitAvailabilityGuardCapturesInternal(
    expression,
    context,
    new Set(),
  );
}

function collectExplicitAvailabilityGuardCapturesInternal(
  expression: ts.Expression | ts.Block,
  context: TransformationContext,
  helpersInProgress: Set<AvailabilityAnalyzableFunction>,
): readonly AvailabilityCaptureOverride[] {
  const byPath = new Map<string, {
    path: readonly string[];
    reasons: AvailabilityReason[];
    source?: ts.Expression;
  }>();

  const record = (
    path: readonly string[],
    reasons: readonly AvailabilityReason[],
    source?: ts.Expression,
  ): void => {
    const key = availabilityPathKey(path);
    const entry = byPath.get(key) ?? { path, reasons: [] };
    for (const reason of reasons) {
      if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
    }
    entry.source ??= source;
    byPath.set(key, entry);
  };

  const visit = (node: ts.Node): void => {
    if (node !== expression && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const callKind = detectCallKind(node, context.checker);
      if (callKind?.kind === "availability-guard") {
        const operand = node.arguments[0];
        const predicateType = predicateTypeForCall(node, context.checker) ??
          context.lookupAvailabilityVariantType(callKind.variantTypeName);
        if (
          operand &&
          guardOperandExposesAvailability(operand, predicateType, context)
        ) {
          if (predicateType) {
            context.recordAvailabilityVariantType(
              callKind.variantTypeName,
              predicateType,
            );
          }
          const capture = parseExplicitAvailabilityCaptureExpression(
            operand,
            expression,
            context,
          );
          if (capture) {
            const path = [capture.root, ...capture.path];
            record(
              path,
              [callKind.reason],
              captureTypeSource(operand, context, expression),
            );
          }
        }
      } else {
        const helper = localAvailabilityHelperForCall(node, context);
        if (helper && !helpersInProgress.has(helper)) {
          helpersInProgress.add(helper);
          const helperEntries =
            collectExplicitAvailabilityGuardCapturesInternal(
              helper.body,
              context,
              helpersInProgress,
            );
          helpersInProgress.delete(helper);
          for (const helperEntry of helperEntries) {
            const mapped = helperGuardEntryAtCallSite(
              helperEntry,
              helper,
              node,
              context,
            );
            if (mapped) record(mapped.path, mapped.reasons, mapped.source);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);

  return [...byPath.values()].map((entry) => ({
    ...entry,
    variants: [],
  }));
}

/** Merge policy/type overrides which target the same exact capture path. */
export function mergeAvailabilityCaptureOverrides(
  entries: readonly AvailabilityCaptureOverride[],
): readonly AvailabilityCaptureOverride[] {
  const merged = new Map<string, AvailabilityCaptureOverride>();
  for (const entry of entries) {
    const key = availabilityPathKey(entry.path);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, entry);
      continue;
    }
    merged.set(key, {
      path: existing.path,
      source: existing.source ?? entry.source,
      reasons: [
        ...existing.reasons,
        ...entry.reasons.filter((reason) => !existing.reasons.includes(reason)),
      ],
      variants: [
        ...existing.variants,
        ...entry.variants.filter((variant) =>
          !existing.variants.some((item) => item.name === variant.name)
        ),
      ],
    });
  }
  return [...merged.values()];
}

interface BindingPath {
  readonly path: readonly string[];
  readonly arrayRestOffset?: number;
}

function applyBindingPath(
  binding: BindingPath,
  tail: readonly string[],
): readonly string[] | undefined {
  if (binding.arrayRestOffset === undefined) {
    return [...binding.path, ...tail];
  }
  const [index, ...rest] = tail;
  if (index === undefined || !/^(0|[1-9]\d*)$/.test(index)) {
    return undefined;
  }
  return [
    ...binding.path,
    String(binding.arrayRestOffset + Number(index)),
    ...rest,
  ];
}

function bindingPathForIdentifier(
  identifier: ts.Identifier,
  binding: ts.BindingName,
  path: readonly string[] = [],
): BindingPath | undefined {
  if (ts.isIdentifier(binding)) {
    return binding.text === identifier.text ? { path } : undefined;
  }
  const elements = ts.isObjectBindingPattern(binding)
    ? binding.elements
    : binding.elements.filter(ts.isBindingElement);
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index];
    if (!element || !ts.isBindingElement(element)) continue;
    const isObjectBinding = ts.isObjectBindingPattern(binding);
    const segment = isObjectBinding
      ? propertyNameText(element.propertyName ?? element.name)
      : String(index);
    if (segment === undefined) continue;
    // An object rest binding names the remaining source object, not a real
    // property called after the local binding. A later `rest.foo` therefore
    // maps to the source's `foo`, while ordinary `{ foo: local }` bindings
    // retain the authored `foo` segment. Array rest similarly names a slice;
    // its local index is translated back by the source offset below.
    const isRest = !!element.dotDotDotToken;
    const nestedPath = isRest ? path : [...path, segment];
    const nested = bindingPathForIdentifier(
      identifier,
      element.name,
      nestedPath,
    );
    if (nested) {
      return !isObjectBinding && isRest
        ? { ...nested, arrayRestOffset: index }
        : nested;
    }
  }
  return undefined;
}

export interface PartitionedCallbackGuardCaptures {
  /** Guard paths rooted in the callback's first parameter. */
  readonly callbackInput: readonly AvailabilityCaptureOverride[];
  /** Guard paths rooted in closure captures rather than the callback input. */
  readonly captures: readonly AvailabilityCaptureOverride[];
}

/** Separate callback-input guard paths from closure-capture guard paths. */
export function partitionGuardCapturesByCallbackInput(
  entries: readonly AvailabilityCaptureOverride[],
  callback: ts.ArrowFunction | ts.FunctionExpression,
): PartitionedCallbackGuardCaptures {
  const parameter = callback.parameters[0];
  if (!parameter) {
    return { callbackInput: [], captures: entries };
  }

  const callbackInput: AvailabilityCaptureOverride[] = [];
  const captures: AvailabilityCaptureOverride[] = [];
  for (const entry of entries) {
    const [root, ...rest] = entry.path;
    if (!root) {
      callbackInput.push(entry);
      continue;
    }
    const binding = bindingPathForIdentifier(
      ts.factory.createIdentifier(root),
      parameter.name,
    );
    if (binding === undefined) {
      captures.push(entry);
    } else {
      const path = applyBindingPath(binding, rest);
      if (!path) {
        captures.push(entry);
        continue;
      }
      callbackInput.push({
        ...entry,
        path,
      });
    }
  }
  return { callbackInput, captures };
}

/** Translate guard paths rooted at a callback parameter to module-input paths. */
export function mapGuardCapturesToCallbackInput(
  entries: readonly AvailabilityCaptureOverride[],
  callback: ts.ArrowFunction | ts.FunctionExpression,
): readonly AvailabilityCaptureOverride[] {
  const partitioned = partitionGuardCapturesByCallbackInput(entries, callback);
  return [...partitioned.callbackInput, ...partitioned.captures];
}

export function availabilityOverridesByPath(
  overrides: readonly AvailabilityCaptureOverride[],
): ReadonlyMap<string, AvailabilityCaptureOverride> {
  return new Map(overrides.map((override) => [
    availabilityPathKey(override.path),
    override,
  ]));
}

export function createUnavailableInputPolicyOptions(
  entries: readonly AvailabilityCaptureOverride[],
  factory: ts.NodeFactory,
  additionalProperties: readonly ts.ObjectLiteralElementLike[] = [],
): ts.ObjectLiteralExpression | undefined {
  if (entries.length === 0 && additionalProperties.length === 0) {
    return undefined;
  }

  const properties: ts.ObjectLiteralElementLike[] = [...additionalProperties];
  if (entries.length > 0) {
    properties.push(
      factory.createPropertyAssignment(
        "unavailableInputPolicy",
        factory.createArrayLiteralExpression(
          entries.map((entry) =>
            factory.createObjectLiteralExpression([
              factory.createPropertyAssignment(
                "path",
                factory.createArrayLiteralExpression(
                  entry.path.map((segment) =>
                    factory.createStringLiteral(segment)
                  ),
                  false,
                ),
              ),
              factory.createPropertyAssignment(
                "reasons",
                factory.createArrayLiteralExpression(
                  entry.reasons.map((reason) =>
                    factory.createStringLiteral(reason)
                  ),
                  false,
                ),
              ),
            ], false)
          ),
          false,
        ),
      ),
    );
  }
  return factory.createObjectLiteralExpression(properties, false);
}
