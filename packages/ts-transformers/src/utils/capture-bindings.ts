/** Symbol-scoped capture bindings with independent serialized property names. */
import ts from "typescript";

import {
  getIdentifierValueSymbol,
  unwrapOpaqueLikeType,
  visitEachChildWithJsx,
} from "../ast/mod.ts";
import type { TransformationContext } from "../core/mod.ts";
import { getCellKind } from "../transformers/cell-type.ts";
import { parseCaptureExpression } from "./capture-tree.ts";
import { collectBindingNames, reserveIdentifier } from "./identifiers.ts";

/** The serialized property, callback binding, and source identity of a capture. */
export interface CaptureBinding {
  readonly propertyName: string;
  readonly bindingName: string;
  readonly symbol: ts.Symbol | undefined;
  readonly type: ts.Type | undefined;
  readonly opaque: boolean;
}

/** Reserves local declarations and non-capture value references. */
export function collectCaptureBindingNames(
  body: ts.Node,
  captureSymbols: ReadonlySet<ts.Symbol | undefined>,
  context: TransformationContext,
): Set<string> {
  const used = collectBindingNames(body);
  const collect = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) return;
    if (ts.isIdentifier(node)) {
      const symbol = getIdentifierValueSymbol(node, context.checker);
      if (
        symbol && !captureSymbols.has(symbol) &&
        (symbol.flags &
          (ts.SymbolFlags.Variable | ts.SymbolFlags.Function |
            ts.SymbolFlags.Class | ts.SymbolFlags.Enum | ts.SymbolFlags.Alias |
            ts.SymbolFlags.ValueModule))
      ) used.add(node.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(body);
  return used;
}

/** Plans callback names once, reserving bindings in every nested scope. */
export function planCaptureBindings(
  expressions: Iterable<ts.Expression>,
  body: ts.Node,
  propertyNames: ReadonlyMap<string, string>,
  context: TransformationContext,
  captureSite: ts.Node = body,
): ReadonlyMap<string, CaptureBinding> {
  const roots = new Map<
    string,
    { symbol: ts.Symbol | undefined; type?: ts.Type; opaque: boolean }
  >();
  for (const expression of expressions) {
    const path = parseCaptureExpression(expression);
    if (!path) continue;
    const originalNode = ts.getOriginalNode(expression);
    const original = ts.isExpression(originalNode)
      ? parseCaptureExpression(originalNode)
      : undefined;
    const entry = roots.get(path.root) ?? {
      symbol: getIdentifierValueSymbol(path.rootIdentifier, context.checker) ??
        (original
          ? getIdentifierValueSymbol(original.rootIdentifier, context.checker)
          : undefined) ??
        context.checker.resolveName(
          path.root,
          ts.getOriginalNode(captureSite),
          ts.SymbolFlags.Value,
          false,
        ),
      opaque: false,
    };
    if (path.path.length === 0) {
      const type = context.checker.getTypeAtLocation(path.rootIdentifier);
      entry.opaque = getCellKind(type, context.checker) === "opaque";
      entry.type = unwrapOpaqueLikeType(type, context.checker);
    }
    roots.set(path.root, entry);
  }
  const rootSymbols = new Set([...roots.values()].map((entry) => entry.symbol));
  const used = collectCaptureBindingNames(body, rootSymbols, context);
  const bindings = new Map<string, CaptureBinding>();
  for (const [root, entry] of roots) {
    const propertyName = propertyNames.get(root) ?? root;
    const reserved = new Set(used);
    for (const other of propertyNames.values()) {
      if (other !== propertyName) reserved.add(other);
    }
    const bindingName =
      reserveIdentifier(propertyName, reserved, context.factory).text;
    used.add(bindingName);
    if (!entry.symbol && bindingName !== propertyName) {
      context.reportDiagnostic({
        severity: "error",
        type: "pattern-context:computation",
        message:
          "Cannot preserve a shadowed capture without its source binding.",
        node: body,
      });
    }
    bindings.set(root, {
      ...entry,
      type: entry.type,
      propertyName,
      bindingName,
    });
  }
  return bindings;
}

/** Registers opaque capture value types without touching same-named locals. */
export function registerCaptureBindingTypes(
  body: ts.Node,
  bindings: ReadonlyMap<string, CaptureBinding>,
  context: TransformationContext,
): void {
  const types = new Map(
    [...bindings.values()].filter((entry) =>
      entry.symbol && entry.opaque && entry.type
    ).map((entry) => [entry.symbol!, entry.type!]),
  );
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const symbol = getIdentifierValueSymbol(node, context.checker);
      const type = symbol && types.get(symbol);
      if (type) context.state.typeRegistry.set(node, type);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
}

/** Rewrites only references to a planned capture's original value symbol. */
export function rewriteCaptureBindingReferences<T extends ts.Node>(
  body: T,
  bindings: ReadonlyMap<string, CaptureBinding>,
  context: TransformationContext,
  registerCaptureTypes = false,
): T {
  const bySymbol = new Map(
    [...bindings.values()].filter((entry) => entry.symbol).map((
      entry,
    ) => [entry.symbol!, entry]),
  );
  const replacement = (
    identifier: ts.Identifier,
  ): ts.Identifier | undefined => {
    const symbol = getIdentifierValueSymbol(identifier, context.checker);
    const entry = symbol && bySymbol.get(symbol);
    if (!entry) return undefined;
    const type = registerCaptureTypes
      ? entry.type
      : context.state.typeRegistry.get(identifier);
    if (!registerCaptureTypes && identifier.text === entry.bindingName) {
      if (type) context.state.typeRegistry.set(identifier, type);
      return identifier;
    }
    const fresh = context.factory.createIdentifier(entry.bindingName);
    const renamed = registerCaptureTypes
      ? fresh
      : context.cfHelpers.preserveNodeSourceMap(fresh, identifier, identifier);
    if (type) context.state.typeRegistry.set(renamed, type);
    return renamed;
  };
  const visitor = (node: ts.Node): ts.Node => {
    if (context.state.printedFrom(node)) return node;
    if (ts.isShorthandPropertyAssignment(node)) {
      const renamed = replacement(node.name);
      return renamed
        ? context.factory.createPropertyAssignment(node.name, renamed)
        : node;
    }
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      if (
        parent &&
        ((ts.isPropertyAccessExpression(parent) ||
          ts.isPropertyAssignment(parent) || ts.isBindingElement(parent)) &&
          parent.name === node)
      ) return node;
      return replacement(node) ?? node;
    }
    return visitEachChildWithJsx(node, visitor, context.tsContext);
  };
  return ts.visitNode(body, visitor) as T;
}
