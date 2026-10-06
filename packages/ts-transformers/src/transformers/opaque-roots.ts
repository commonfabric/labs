import ts from "typescript";

import { detectCallKind, isReactiveOriginExpression } from "../ast/mod.ts";
import type { TransformationContext } from "../core/mod.ts";
import {
  unwrapExpression,
  unwrapTransparentWrapperOnce,
} from "../utils/expression.ts";
import { getKnownComputedKeyExpression } from "../utils/reactive-keys.ts";
import type { PathSegment } from "./destructuring-lowering.ts";
import { isPatternFactoryCalleeExpression } from "./structural-reactive-factory.ts";

export interface OpaqueAccessInfo {
  root?: string;
  rootIdentifier?: ts.Identifier;
  path: PathSegment[];
  dynamic: boolean;
}

export type OpaquePathTerminalCallKind = "get" | "key";

export function classifyOpaquePathTerminalCall(
  call: ts.CallExpression,
): OpaquePathTerminalCallKind | undefined {
  const target = unwrapExpression(call.expression);

  if (ts.isPropertyAccessExpression(target)) {
    switch (target.name.text) {
      case "get":
      case "key":
        return target.name.text;
      default:
        return undefined;
    }
  }

  if (ts.isElementAccessExpression(target)) {
    const argument = target.argumentExpression;
    if (
      argument &&
      (ts.isStringLiteralLike(argument) ||
        ts.isNoSubstitutionTemplateLiteral(argument))
    ) {
      switch (argument.text) {
        case "get":
        case "key":
          return argument.text;
        default:
          return undefined;
      }
    }
  }

  return undefined;
}

export function getOpaqueAccessInfo(
  expr: ts.Expression,
  context: TransformationContext,
): OpaqueAccessInfo {
  const path: PathSegment[] = [];
  let current: ts.Expression = expr;
  let dynamic = false;

  while (true) {
    const unwrapped = unwrapTransparentWrapperOnce(current);
    if (unwrapped) {
      current = unwrapped;
      continue;
    }

    if (ts.isPropertyAccessExpression(current)) {
      path.unshift(current.name.text);
      current = current.expression;
      continue;
    }

    if (ts.isElementAccessExpression(current)) {
      const arg = current.argumentExpression;
      if (
        arg &&
        (ts.isStringLiteral(arg) ||
          ts.isNumericLiteral(arg) ||
          ts.isNoSubstitutionTemplateLiteral(arg))
      ) {
        path.unshift(arg.text);
      } else if (arg) {
        const knownKeyExpression = getKnownComputedKeyExpression(arg, context);
        if (knownKeyExpression) {
          path.unshift(knownKeyExpression);
        } else {
          dynamic = true;
        }
      } else {
        dynamic = true;
      }
      current = current.expression;
      continue;
    }

    break;
  }

  if (ts.isIdentifier(current)) {
    return { root: current.text, rootIdentifier: current, path, dynamic };
  }

  return { path, dynamic };
}

export function isTopmostMemberAccess(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return true;
  return !(
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
    parent.expression === node
  );
}

export function isOpaqueOriginCall(
  expression: ts.CallExpression | ts.NewExpression,
  context: TransformationContext,
): boolean {
  if (isReactiveOriginExpression(expression, context.checker)) return true;
  if (ts.isNewExpression(expression)) return false;
  if (detectCallKind(expression, context.checker)?.kind === "pattern-tool") {
    return true;
  }
  // User-authored pattern factories (callable values whose type has
  // `argumentSchema` + `resultSchema` and no `with`) return opaque-source
  // values by construction. Treat their invocations as opaque-origin so
  // bindings initialized from them (e.g. `const row = EntryRow({...})`)
  // participate in the same late `.key()` lowering as direct cell sources.
  return isPatternFactoryCalleeExpression(
    expression.expression,
    context.checker,
  );
}

/** Whether `root` names a local binding initialized from an opaque source. */
export function isLocalOpaqueOriginBindingReference(
  root: ts.Identifier,
  context: TransformationContext,
): boolean {
  const original = ts.getOriginalNode(root);
  const symbol = context.checker.getSymbolAtLocation(root) ??
    (ts.isIdentifier(original)
      ? context.checker.getSymbolAtLocation(original)
      : undefined);
  return symbol?.declarations?.some((declaration) =>
    ts.isVariableDeclaration(declaration) && declaration.initializer !==
      undefined &&
    isOpaqueSourceExpression(
      declaration.initializer,
      new Set(),
      new Set(),
      context,
    )
  ) ?? false;
}

export function isOpaqueRootInfo(
  info: OpaqueAccessInfo,
  opaqueRoots: ReadonlySet<string>,
  opaqueRootSymbols: ReadonlySet<ts.Symbol>,
  context: TransformationContext,
): boolean {
  const rootIdentifier = info.rootIdentifier;
  if (rootIdentifier) {
    const symbol = context.checker.getSymbolAtLocation(rootIdentifier);
    if (symbol && opaqueRootSymbols.has(symbol)) {
      return true;
    }
  }

  return !!info.root && opaqueRoots.has(info.root);
}

export function isOpaqueSourceExpression(
  expression: ts.Expression,
  opaqueRoots: ReadonlySet<string>,
  opaqueRootSymbols: ReadonlySet<ts.Symbol>,
  context: TransformationContext,
): boolean {
  const current = unwrapExpression(expression);
  const info = getOpaqueAccessInfo(current, context);
  if (isOpaqueRootInfo(info, opaqueRoots, opaqueRootSymbols, context)) {
    return true;
  }

  if (ts.isCallExpression(current)) {
    if (isOpaqueOriginCall(current, context)) {
      return true;
    }

    if (ts.isPropertyAccessExpression(current.expression)) {
      const methodName = current.expression.name.text;
      // `.key()` returns a navigated sibling; `.get()` returns the underlying
      // value (a proxy only in the rare `schema: true` case); `.for()`
      // returns the same cell (identity-preserving cause annotation, no-op
      // semantically). All preserve opaque-source provenance, so a chain
      // ending in one of these stays opaque iff its underlying receiver is
      // opaque.
      if (
        methodName === "key" || methodName === "get" || methodName === "for"
      ) {
        return isOpaqueSourceExpression(
          current.expression.expression,
          opaqueRoots,
          opaqueRootSymbols,
          context,
        );
      }
    }
  }

  if (ts.isNewExpression(current) && isOpaqueOriginCall(current, context)) {
    return true;
  }

  // Property/element access chains that bottom out on an opaque-origin
  // call (`wish(...).result`, `resultOf(fetchJson<Items>(...)).items`, etc.)
  // are also opaque sources — the chain navigates through reactive cells
  // before being read. The body-lowering pre-pass rewrites these into
  // destructure form, but consumers that examine the source AST before
  // that rewrite (e.g. `buildPatternScope` in pattern-callback-lowering)
  // still need to recognize the binding as opaque so closure captures
  // are wired up correctly.
  if (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    let inner: ts.Expression = current.expression;
    while (true) {
      const unwrapped = unwrapExpression(inner);
      if (
        ts.isPropertyAccessExpression(unwrapped) ||
        ts.isElementAccessExpression(unwrapped)
      ) {
        inner = unwrapped.expression;
        continue;
      }
      inner = unwrapped;
      break;
    }
    if (
      (ts.isCallExpression(inner) || ts.isNewExpression(inner)) &&
      isOpaqueOriginCall(inner, context)
    ) {
      return true;
    }
  }

  return false;
}

export function addBindingTargetSymbols(
  name: ts.BindingName,
  bucket: Set<ts.Symbol>,
  checker: ts.TypeChecker,
): void {
  if (ts.isIdentifier(name)) {
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol) {
      bucket.add(symbol);
    }
    return;
  }

  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    addBindingTargetSymbols(element.name, bucket, checker);
  }
}

export function collectLocalOpaqueRootSymbols(
  body: ts.Node,
  context: TransformationContext,
): Set<ts.Symbol> {
  const localOpaqueRootSymbols = new Set<ts.Symbol>();
  const scan = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;

    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      !isPureAvailabilityGuardOverExternalCapture(
        node.initializer,
        localOpaqueRootSymbols,
        context,
      ) &&
      isOpaqueSourceExpression(
        node.initializer,
        new Set(),
        localOpaqueRootSymbols,
        context,
      )
    ) {
      addBindingTargetSymbols(
        node.name,
        localOpaqueRootSymbols,
        context.checker,
      );
    }

    ts.forEachChild(node, scan);
  };

  scan(body);
  return localOpaqueRootSymbols;
}

/**
 * Availability guards are ordinary predicates once an existing compute/lift
 * callback is executing. They only remain a local reactive origin when their
 * operand itself creates (or aliases) a reactive value in that same callback.
 */
function isPureAvailabilityGuardOverExternalCapture(
  expression: ts.Expression,
  localOpaqueRootSymbols: ReadonlySet<ts.Symbol>,
  context: TransformationContext,
): boolean {
  const target = unwrapExpression(expression);
  if (
    !ts.isCallExpression(target) ||
    detectCallKind(target, context.checker)?.kind !== "availability-guard"
  ) {
    return false;
  }
  const operand = target.arguments[0];
  return !operand || !isOpaqueSourceExpression(
    operand,
    new Set(),
    localOpaqueRootSymbols,
    context,
  );
}
