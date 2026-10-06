import ts from "typescript";

import {
  detectCallKind,
  getLiftAppliedInputAndCallback,
} from "../ast/call-kind.ts";
import { HelpersOnlyTransformer } from "../core/transformers.ts";
import type { TransformationContext } from "../core/context.ts";
import {
  guardOperandExposesAvailability,
  isDirectCompileResultSource,
  isDirectPartialResultSource,
  isDirectResultChannelAliasPosition,
  parseAvailabilityObservation,
  resolveAvailabilityObservation,
  unwrapAvailabilityExpression,
} from "./analysis.ts";
import { getStableConstAliasInitializer } from "../ast/stable-const-alias.ts";
import { parseAvailabilityCaptureExpression } from "./captures.ts";

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

function nearestFunctionBody(node: ts.Node): ts.ConciseBody | undefined {
  for (
    let current: ts.Node | undefined = node.parent;
    current;
    current = current.parent
  ) {
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      current.body
    ) {
      return current.body;
    }
  }
  return undefined;
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

function bindingPropertyName(
  element: ts.BindingElement,
): string | undefined {
  const name = element.propertyName ?? element.name;
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ||
      ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}

function resolveCompositeInput(
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
    ? resolveCompositeInput(declaration.initializer, context, seen)
    : current;
}

function typeMayIncludeNullish(
  type: ts.Type,
  checker: ts.TypeChecker,
  seen: Set<ts.Type> = new Set(),
): boolean {
  if (seen.has(type)) return false;
  seen.add(type);

  if (
    type.flags &
    (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Null |
      ts.TypeFlags.Undefined | ts.TypeFlags.Void)
  ) {
    return true;
  }
  if (type.isUnion()) {
    return type.types.some((member) =>
      typeMayIncludeNullish(member, checker, seen)
    );
  }
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type);
    return !constraint || constraint === type ||
      typeMayIncludeNullish(constraint, checker, seen);
  }
  return checker.getNonNullableType(type) !== type;
}

function objectInputProperty(
  input: ts.Expression,
  propertyName: string,
  context: TransformationContext,
): ts.Expression | undefined {
  const target = resolveCompositeInput(input, context);
  if (!ts.isObjectLiteralExpression(target)) return undefined;
  for (const property of target.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      if (property.name.text === propertyName) return property.name;
      continue;
    }
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    if (
      (ts.isIdentifier(name) || ts.isStringLiteralLike(name) ||
        ts.isNumericLiteral(name)) && name.text === propertyName
    ) {
      return property.initializer;
    }
  }
  return undefined;
}

function recordBindingObservation(
  binding: ts.BindingName,
  input: ts.Expression,
  context: TransformationContext,
): void {
  if (ts.isIdentifier(binding)) {
    const observation = resolveAvailabilityObservation(input, context);
    const symbol = context.checker.getSymbolAtLocation(binding);
    if (observation && symbol) {
      context.recordAvailabilityObservation(symbol, observation);
    }
    return;
  }

  if (ts.isObjectBindingPattern(binding)) {
    for (const element of binding.elements) {
      if (element.dotDotDotToken) continue;
      const propertyName = bindingPropertyName(element);
      if (!propertyName) continue;
      const propertyInput = objectInputProperty(input, propertyName, context);
      if (propertyInput) {
        recordBindingObservation(element.name, propertyInput, context);
      }
    }
    return;
  }

  const target = resolveCompositeInput(input, context);
  if (!ts.isArrayLiteralExpression(target)) return;
  binding.elements.forEach((element, index) => {
    if (!ts.isBindingElement(element)) return;
    const elementInput = target.elements[index];
    if (elementInput && ts.isExpression(elementInput)) {
      recordBindingObservation(element.name, elementInput, context);
    }
  });
}

function recordLiftAppliedParameterObservations(
  call: ts.CallExpression,
  context: TransformationContext,
): void {
  const resolved = getLiftAppliedInputAndCallback(call, context.checker);
  const parameter = resolved?.callback.parameters[0];
  if (!resolved || !parameter) return;
  recordBindingObservation(parameter.name, resolved.input, context);
}

export class AvailabilityAnalysisTransformer extends HelpersOnlyTransformer {
  override transform(context: TransformationContext): ts.SourceFile {
    const declarations: ts.VariableDeclaration[] = [];
    const liftAppliedCalls: ts.CallExpression[] = [];

    const collect = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callKind = detectCallKind(node, context.checker);
        if (callKind?.kind === "lift-applied") {
          liftAppliedCalls.push(node);
        }
        if (callKind?.kind === "availability-observer") {
          const observation = parseAvailabilityObservation(node, context, true);
          if (observation) {
            context.recordAvailabilityObservation(node, observation);
          }
        } else if (callKind?.kind === "availability-guard") {
          // Explicit computations bypass direct guard-capture collection, so
          // retain the predicate's semantic variant type while the authored
          // call and signature are still available.
          const signature = context.checker.getResolvedSignature(node);
          const predicateType = signature
            ? context.checker.getTypePredicateOfSignature(signature)?.type
            : undefined;
          if (predicateType) {
            context.recordAvailabilityVariantType(
              callKind.variantTypeName,
              predicateType,
            );
          }
        }
      } else if (ts.isVariableDeclaration(node)) {
        declarations.push(node);
      }
      ts.forEachChild(node, collect);
    };
    collect(context.sourceFile);

    const propagateVariableObservations = (): void => {
      let changed = true;
      while (changed) {
        changed = false;
        for (const declaration of declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
            continue;
          }
          const symbol = context.checker.getSymbolAtLocation(declaration.name);
          if (!symbol || context.lookupAvailabilityObservation(symbol)) {
            continue;
          }
          const observation = resolveAvailabilityObservation(
            declaration.initializer,
            context,
          );
          if (observation) {
            context.recordAvailabilityObservation(symbol, observation);
            changed = true;
          }
        }
      }
    };
    propagateVariableObservations();
    for (const call of liftAppliedCalls) {
      recordLiftAppliedParameterObservations(call, context);
    }
    // Parameter observation can unlock aliases declared inside the callback.
    propagateVariableObservations();

    const diagnose = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        const left = resolveCompositeInput(node.left, context);
        if (
          ts.isCallExpression(left) &&
          detectCallKind(left, context.checker)?.kind ===
            "availability-result" &&
          !typeMayIncludeNullish(
            context.checker.getTypeAtLocation(left),
            context.checker,
          )
        ) {
          context.reportDiagnosticOnce({
            type: "availability:dead-result-fallback",
            message:
              "A nullish fallback after resultOf() never handles unavailable data: the marker propagates and skips the surrounding computation. Guard the original AsyncResult for explicit states, or use latestComplete() to retain the last usable value.",
            node,
          });
        }
      } else if (ts.isCallExpression(node)) {
        const callKind = detectCallKind(node, context.checker);
        const reactiveContext = context.getReactiveContext(node);
        if (
          callKind?.kind === "compile-diagnostics" &&
          (reactiveContext.kind !== "pattern" ||
            !node.arguments[0] ||
            !isDirectCompileResultSource(node.arguments[0], context) ||
            !isDirectResultChannelAliasPosition(node))
        ) {
          context.reportDiagnosticOnce({
            type: "availability:unsupported-compile-diagnostics-source",
            message: reactiveContext.kind !== "pattern"
              ? "compileDiagnosticsOf() must be called in the pattern body before its value is captured by a reactive callback. Materialized results do not carry the diagnostics-channel association."
              : !isDirectResultChannelAliasPosition(node)
              ? "Bind compileDiagnosticsOf(request) to a standalone const before deriving values from it. Inline operations can move the accessor into a computation where the request has been materialized."
              : "compileDiagnosticsOf() requires the direct result of compileAndRun() (including stable const aliases). Export diagnostics separately when returning a compilation result from a subpattern.",
            node,
          });
        } else if (
          callKind?.kind === "partial-result" &&
          (reactiveContext.kind !== "pattern" ||
            !node.arguments[0] ||
            !isDirectPartialResultSource(node.arguments[0], context) ||
            !isDirectResultChannelAliasPosition(node))
        ) {
          context.reportDiagnosticOnce({
            type: "availability:unsupported-partial-result-source",
            message: reactiveContext.kind !== "pattern"
              ? "partialResultOf() must be called in the pattern body before its value is captured by computed(), lift(), action(), or handler(). Inside those boundaries the argument is the materialized final value and no longer carries the partial-channel association."
              : !isDirectResultChannelAliasPosition(node)
              ? "Bind partialResultOf(request) to a standalone const before deriving values from it. Inline operations can move the accessor into a computation where the request has been materialized."
              : "partialResultOf() currently requires the direct result of generateTextStream(), generateObjectStream(), or streamData() (including stable const aliases). A stream result returned by a subpattern no longer carries its partial-channel association.",
            node,
          });
        } else if (
          callKind?.kind === "availability-observer" &&
          reactiveContext.kind === "compute"
        ) {
          context.reportDiagnosticOnce({
            type: "availability:observation-inside-compute",
            message:
              "observeAvailability() must be outside the computed() or lift() callback whose input boundary it widens.",
            node,
          });
        } else if (
          callKind?.kind === "availability-guard" &&
          reactiveContext.kind === "compute"
        ) {
          const operand = node.arguments[0];
          const root = operand ? captureRootIdentifier(operand) : undefined;
          const rootSymbol = root
            ? context.checker.getSymbolAtLocation(root)
            : undefined;
          const rootDeclaration = rootSymbol?.valueDeclaration ??
            rootSymbol?.declarations?.[0];
          const functionBody = nearestFunctionBody(node);
          const rootReactiveContext = rootDeclaration
            ? context.getReactiveContext(rootDeclaration)
            : undefined;
          const aliasInitializer = getStableConstAliasInitializer(
            rootSymbol,
            context.factory,
          );
          if (
            rootDeclaration && functionBody &&
            rootReactiveContext?.kind === "compute" &&
            nodeIsWithin(rootDeclaration, functionBody) &&
            (!aliasInitializer ||
              !parseAvailabilityCaptureExpression(aliasInitializer))
          ) {
            context.reportDiagnosticOnce({
              type: "availability:unsupported-guard-operand",
              message:
                "Availability guards inside computed()/lift() can follow only stable const aliases. Use a const alias with a static property, element, or key() path.",
              node: operand ?? node,
            });
          }
          const observation = operand
            ? resolveAvailabilityObservation(operand, context)
            : undefined;
          const variantType = context.lookupAvailabilityVariantType(
            callKind.variantTypeName,
          );
          const visible = operand
            ? guardOperandExposesAvailability(operand, variantType, context)
            : false;
          if (
            !visible && !observation?.reasons.includes(callKind.reason)
          ) {
            context.reportDiagnosticOnce({
              type: "availability:unobserved-compute-guard",
              message:
                `${callKind.variantTypeName} observation inside a compute requires an AsyncResult containing that variant. Guard the original AsyncResult, or call ` +
                `observeAvailability(value, "${callKind.reason}") outside that compute and capture the widened alias.`,
              node,
            });
          }
        }
      }
      ts.forEachChild(node, diagnose);
    };
    diagnose(context.sourceFile);

    return context.sourceFile;
  }
}
