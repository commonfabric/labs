import ts from "typescript";
import { resolvesToCommonFabricSymbol } from "../core/common-fabric-symbols.ts";
import type { TransformationContext } from "../core/mod.ts";
import type { CaptureTreeNode } from "../utils/capture-tree.ts";
import { createPropertyName } from "../utils/identifiers.ts";
import { getCallArgumentPosition } from "./call-arguments.ts";
import { detectDirectBuilderCall } from "./call-kind.ts";
import {
  ensureTypeNodeRegistered,
  inferWidenedTypeFromExpression,
  isUnknownType,
  unwrapCellLikeType,
} from "./type-inference.ts";
import {
  getExpressionText,
  isOptionalMemberSymbol,
  isOptionalSymbol,
  setParentPointers,
} from "./utils.ts";

/**
 * Rewrite commonfabric type references in a TypeNode tree to the canonical
 * `__cfHelpers.X` qualified form, so synthesized annotations are always
 * resolvable regardless of which symbols the user has imported.
 *
 * Detection is semantic, not name-based: each TypeReferenceNode is matched
 * against its corresponding `ts.Type` (walked in lockstep with the TypeNode
 * tree, starting from the root `rootType`). When the Type's symbol or
 * aliasSymbol has a parent that is the `"commonfabric"` module symbol, the
 * node is rewritten — the symbol's `name` becomes the leaf of the new
 * qualified name. The runner exposes `__cfHelpers` as a self-reference to
 * the commonfabric namespace (see runner/src/builder/factory.ts:228), so
 * every commonfabric export is reachable as `__cfHelpers.X`.
 *
 * Lockstep walking is necessary because synthetic TypeNodes have no source
 * position and `checker.getSymbolAtLocation` returns nothing for them;
 * `getTypeFromTypeNodeWithFallback` also widens nested synthetic refs to
 * `any` because the inner identifiers have no scope to resolve against.
 * The root Type passed in carries full symbol info; walking the Type tree
 * and TypeNode tree in parallel propagates that info to every nested ref.
 *
 * Also handles the `import("commonfabric").X<...>` `ImportTypeNode` form
 * (TS emits this when no in-scope alias exists). This case is syntactically
 * unambiguous and is rewritten without needing the paired Type.
 *
 * The original TypeNode is preserved when no rewrite is needed; only
 * subtrees that change are rebuilt via `factory.create*`.
 */
export function qualifyCommonFabricTypeRefs(
  typeNode: ts.TypeNode,
  rootType: ts.Type | undefined,
  context: {
    readonly checker: ts.TypeChecker;
    readonly factory: ts.NodeFactory;
    readonly typeRegistry?: WeakMap<ts.Node, ts.Type>;
    readonly tsContext?: ts.TransformationContext;
  },
): ts.TypeNode {
  const { factory } = context;

  // Module symbol names are stored with surrounding double quotes for
  // external modules (e.g. `"commonfabric"`). Match either form.
  const isCommonFabricModuleName = (name: string | undefined): boolean =>
    name === "commonfabric" || name === '"commonfabric"';

  const buildHelperQualifiedName = (leafName: string): ts.QualifiedName =>
    factory.createQualifiedName(
      factory.createIdentifier("__cfHelpers"),
      factory.createIdentifier(leafName),
    );

  const isCommonFabricSymbol = (sym: ts.Symbol | undefined): boolean => {
    if (!sym) return false;
    const parent = (sym as unknown as { parent?: ts.Symbol }).parent;
    return isCommonFabricModuleName(parent?.name) && !!sym.name;
  };

  // From a Type, find the export name in commonfabric (if any).
  //
  // Prefer `aliasSymbol`: when the user writes `Writable<X>` and `Writable` is
  // itself a commonfabric alias for `Cell`, the Type's `symbol` is the
  // underlying `Cell` constructor while `aliasSymbol` points at `Writable` —
  // we want to keep `Writable`.
  //
  // Crucially, if `aliasSymbol` is a USER alias (NOT a commonfabric export),
  // the user has already named this type completely and resolvably (e.g.
  // `type SharedMessagesCell = Writable<Foo>`). We must NOT fall through to
  // `type.symbol` and rewrite to the bare underlying commonfabric name: the
  // alias-reference node carries no type arguments (they're hidden inside the
  // alias), so rewriting `SharedMessagesCell` -> `__cfHelpers.Cell` would drop
  // the `<Foo>` entirely, degrading the type to `Cell<unknown>` and breaking
  // runtime cell materialization. Leave user aliases alone.
  const commonFabricExportName = (
    type: ts.Type | undefined,
  ): string | undefined => {
    if (!type) return undefined;
    if (type.aliasSymbol) {
      return isCommonFabricSymbol(type.aliasSymbol)
        ? type.aliasSymbol.name
        : undefined;
    }
    return isCommonFabricSymbol(type.symbol) ? type.symbol.name : undefined;
  };

  // For a union/intersection member TypeNode, find the constituent Type to
  // pair it with. Matches by commonfabric export name (order-independent):
  // a bare member ref `X` is paired with the constituent whose CF export name
  // is `X`. Returns undefined when there's no constituent info or no match —
  // in which case the member is walked with no paired Type (safe: it can only
  // be rewritten via the syntactic Import-form branch, never misattributed).
  const pairedConstituentForMember = (
    member: ts.TypeNode,
    unionOrIntersectionType: ts.Type | undefined,
  ): ts.Type | undefined => {
    if (!unionOrIntersectionType) return undefined;
    const constituents =
      (unionOrIntersectionType as ts.UnionOrIntersectionType).types;
    if (!constituents) return undefined;

    // Only bare identifier refs can be name-matched (the case the printer
    // emits for in-scope/aliasable commonfabric types inside unions).
    if (!ts.isTypeReferenceNode(member) || !ts.isIdentifier(member.typeName)) {
      return undefined;
    }
    const memberName = member.typeName.text;
    // Require an UNAMBIGUOUS match. If two constituents share a commonfabric
    // export name but differ in their type arguments (e.g. `Cell<A> | Cell<B>`,
    // both printed as bare `Cell<...>`), name-matching alone can't tell which
    // member pairs with which constituent. Picking the first would walk the
    // member's nested type args against the wrong constituent's args and could
    // mis-rewrite a nested generic. On ambiguity, return undefined: the member
    // is left unpaired (un-normalized) rather than risk a wrong rewrite — the
    // safe degradation this helper already documents.
    const matches = constituents.filter(
      (constituent) => commonFabricExportName(constituent) === memberName,
    );
    return matches.length === 1 ? matches[0] : undefined;
  };

  // Pair a printed alias with its own arguments before consulting the
  // arguments of the reference it instantiates.
  const getTypeArgumentAt = (
    type: ts.Type | undefined,
    index: number,
  ): ts.Type | undefined => {
    if (!type) return undefined;
    // Printed aliases carry their own arguments, which can differ from the
    // arguments of the reference they instantiate.
    if (type.aliasTypeArguments) return type.aliasTypeArguments[index];
    const asReference = type as ts.TypeReference;
    if (asReference.typeArguments) {
      return asReference.typeArguments[index];
    }
    return undefined;
  };

  // For a TypeLiteral / Object Type, get the Type of a named property.
  const getPropertyType = (
    type: ts.Type | undefined,
    propertyName: string,
  ): ts.Type | undefined => {
    if (!type) return undefined;
    const property = type.getProperty(propertyName);
    if (!property) return undefined;
    const decl = property.valueDeclaration ?? property.declarations?.[0];
    if (!decl) {
      // Property has no declaration we can locate (anonymous object). Use the
      // generic getTypeOfSymbol via a SourceFile fallback if available.
      const ofSym = (context.checker as unknown as {
        getTypeOfSymbol?: (sym: ts.Symbol) => ts.Type;
      }).getTypeOfSymbol;
      return ofSym ? ofSym.call(context.checker, property) : undefined;
    }
    return context.checker.getTypeOfSymbolAtLocation(property, decl);
  };

  // For an array Type (T[] or Array<T>), get its element Type.
  const getArrayElementType = (
    type: ts.Type | undefined,
  ): ts.Type | undefined => {
    if (!type) return undefined;
    return context.checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  };

  // The walker takes a TypeNode and the Type it represents, and returns a
  // (possibly-rewritten) TypeNode. The Type may be undefined when the
  // paired info isn't available — in that case nested ImportType
  // recognition still works (it's purely syntactic), but bare-identifier
  // commonfabric-ref detection is skipped (no false-positive risk).
  const walk = (
    node: ts.TypeNode,
    pairedType: ts.Type | undefined,
  ): ts.TypeNode => {
    // `import("commonfabric").X<...>` → `__cfHelpers.X<...>` (syntactic).
    if (ts.isImportTypeNode(node) && !node.isTypeOf) {
      const arg = node.argument;
      if (
        ts.isLiteralTypeNode(arg) &&
        ts.isStringLiteral(arg.literal) &&
        arg.literal.text === "commonfabric" &&
        node.qualifier
      ) {
        const leafName = ts.isIdentifier(node.qualifier)
          ? node.qualifier.text
          : node.qualifier.right.text;
        const visitedTypeArgs = node.typeArguments
          ? factory.createNodeArray(
            node.typeArguments.map((arg, i) =>
              walk(arg, getTypeArgumentAt(pairedType, i))
            ),
          )
          : undefined;
        return factory.createTypeReferenceNode(
          buildHelperQualifiedName(leafName),
          visitedTypeArgs,
        );
      }
    }

    // `X<...>` where X resolves to a commonfabric export → `__cfHelpers.X<...>`.
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      if (node.typeName.text !== "__cfHelpers") {
        const exportName = commonFabricExportName(pairedType);
        if (exportName) {
          const visitedTypeArgs = node.typeArguments
            ? factory.createNodeArray(
              node.typeArguments.map((arg, i) =>
                walk(arg, getTypeArgumentAt(pairedType, i))
              ),
            )
            : undefined;
          return factory.createTypeReferenceNode(
            buildHelperQualifiedName(exportName),
            visitedTypeArgs,
          );
        }
        // Not a commonfabric ref — recurse into type args with their
        // corresponding paired sub-types.
        if (node.typeArguments) {
          const rewritten = node.typeArguments.map((arg, i) =>
            walk(arg, getTypeArgumentAt(pairedType, i))
          );
          const changed = rewritten.some((arg, i) =>
            arg !== node.typeArguments![i]
          );
          if (changed) {
            return factory.updateTypeReferenceNode(
              node,
              node.typeName,
              factory.createNodeArray(rewritten),
            );
          }
        }
        return node;
      }
    }

    // TypeLiteral: walk each member, pairing with the Type's property type.
    if (ts.isTypeLiteralNode(node)) {
      const rewrittenMembers = node.members.map((member) => {
        if (
          ts.isPropertySignature(member) && member.name && member.type &&
          (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
        ) {
          const propertyName = member.name.text;
          const propertyType = getPropertyType(pairedType, propertyName);
          const rewrittenType = walk(member.type, propertyType);
          if (rewrittenType === member.type) return member;
          return factory.updatePropertySignature(
            member,
            member.modifiers,
            member.name,
            member.questionToken,
            rewrittenType,
          );
        }
        return member;
      });
      const changed = rewrittenMembers.some((m, i) => m !== node.members[i]);
      return changed
        ? factory.updateTypeLiteralNode(
          node,
          factory.createNodeArray(rewrittenMembers),
        )
        : node;
    }

    // ArrayTypeNode: element Type paired with the array's numeric-index Type.
    if (ts.isArrayTypeNode(node)) {
      const elementType = getArrayElementType(pairedType);
      const rewritten = walk(node.elementType, elementType);
      return rewritten === node.elementType
        ? node
        : factory.updateArrayTypeNode(node, rewritten);
    }

    // Union / Intersection: walk each member, pairing it with the constituent
    // Type that matches by commonfabric export name. Index-pairing TypeNode
    // members to constituent Types is brittle (TS doesn't guarantee matching
    // order), so we match by NAME instead: for a bare member ref, find the
    // constituent whose commonfabric export name equals the ref's identifier.
    // This is order-independent and only ever supplies a paired Type that
    // would make the member rewrite to that same name — a non-CF member finds
    // no match and passes through unchanged. The Import-form (ImportTypeNode)
    // members are still handled syntactically without needing a paired Type.
    if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
      const rewritten = node.types.map((t) =>
        walk(t, pairedConstituentForMember(t, pairedType))
      );
      const changed = rewritten.some((t, i) => t !== node.types[i]);
      if (!changed) return node;
      return ts.isUnionTypeNode(node)
        ? factory.updateUnionTypeNode(node, factory.createNodeArray(rewritten))
        : factory.updateIntersectionTypeNode(
          node,
          factory.createNodeArray(rewritten),
        );
    }

    // ParenthesizedType, TypeOperator: unwrap and walk inner.
    if (ts.isParenthesizedTypeNode(node)) {
      const rewritten = walk(node.type, pairedType);
      return rewritten === node.type
        ? node
        : factory.updateParenthesizedType(node, rewritten);
    }
    if (ts.isTypeOperatorNode(node)) {
      const rewritten = walk(node.type, pairedType);
      return rewritten === node.type
        ? node
        : factory.updateTypeOperatorNode(node, rewritten);
    }

    return node;
  };

  const result = walk(typeNode, rootType);

  // Carry the registry association forward. The walk returns a fresh node when
  // it rewrites anything, which would otherwise orphan the original node's
  // typeRegistry entry — downstream consumers (e.g. the SchemaGenerator) look
  // the emitted node up by identity, and a missing entry silently degrades the
  // generated schema (e.g. a precise JSXElement schema collapses to `true`).
  // Registering here means callers that hand an already-built node to the
  // normalizer can't forget to re-register it.
  if (result !== typeNode && rootType && context.typeRegistry) {
    context.typeRegistry.set(result, rootType);
  }

  return result;
}

/**
 * Common flags for type-to-typenode conversion.
 * NoTruncation: Prevents type strings from being truncated
 * UseStructuralFallback: Falls back to structural types when nominal types aren't available
 * UseAliasDefinedOutsideCurrentScope: Prefer existing aliases (e.g. `Cell<T>`
 *   imported at module scope) over their canonical qualified forms (e.g.
 *   `import("commonfabric").Cell<T>`). Without this flag, type-arg
 *   annotations on synthesized helper calls print the import-qualified form
 *   even when an alias is in scope (CT-1615 Berni review on PR #3676).
 */
export const DEFAULT_TYPE_NODE_FLAGS = ts.NodeBuilderFlags.NoTruncation |
  ts.NodeBuilderFlags.UseStructuralFallback |
  ts.NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope;

export interface TypeLiteralRegistrationContext {
  readonly factory: ts.NodeFactory;
  readonly checker: ts.TypeChecker;
  readonly typeRegistry?: WeakMap<ts.Node, ts.Type>;
}

/**
 * Converts a Type to a TypeNode, optionally registering it in the type registry.
 * Provides a central place for type-to-typenode conversion with consistent flags.
 */
export function typeToTypeNodeWithRegistry(
  type: ts.Type,
  context: {
    checker: ts.TypeChecker;
    factory: ts.NodeFactory;
    sourceFile: ts.SourceFile;
  },
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
  flags = DEFAULT_TYPE_NODE_FLAGS,
): ts.TypeNode {
  const rawNode =
    context.checker.typeToTypeNode(type, context.sourceFile, flags) ??
      context.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

  // Rewrite commonfabric type references to the always-resolvable
  // `__cfHelpers.X` qualified form. The printer's natural output references
  // commonfabric symbols that may not be imported in the user's source
  // (especially when `UseAliasDefinedOutsideCurrentScope` is on), so the
  // emitted annotation wouldn't typecheck. `__cfHelpers` is always injected
  // by the transformer and re-exports the entire commonfabric namespace
  // (see runner/src/builder/factory.ts:228), so the qualified form is
  // unconditionally valid.
  //
  // We pass the root `type` in so the rewriter can walk Type and TypeNode
  // trees in lockstep — synthetic inner TypeNodes carry no source position
  // and their symbols can't be recovered via `getSymbolAtLocation`, so
  // pairing each ref with its corresponding Type from the input is the
  // only reliable way to detect nested commonfabric refs.
  const node = qualifyCommonFabricTypeRefs(rawNode, type, {
    checker: context.checker,
    factory: context.factory,
    typeRegistry,
  });

  if (typeRegistry) {
    typeRegistry.set(node, type);
  }

  return node;
}

export function createRegisteredTypeLiteral(
  members: readonly ts.TypeElement[],
  context: TypeLiteralRegistrationContext,
): ts.TypeLiteralNode {
  const typeNode = context.factory.createTypeLiteralNode([...members]);
  ensureTypeNodeRegistered(
    typeNode,
    context.checker,
    context.typeRegistry,
  );
  return typeNode;
}

/**
 * Converts an expression to a TypeNode by getting its type at that location.
 * Automatically widens literal types (e.g., `5` → `number`) for more flexible schemas.
 * Automatically registers in the type registry if available.
 */
export function expressionToTypeNode(
  expr: ts.Expression,
  context: TransformationContext,
): ts.TypeNode {
  const symbol = ts.isIdentifier(expr)
    ? context.checker.getSymbolAtLocation(expr)
    : undefined;
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  const preserved = declaration && ts.isBindingElement(declaration)
    ? getPreservedTypeForBindingElement(
      declaration,
      context.checker,
      context.state.typeRegistry,
    )
    : undefined;
  if (preserved) {
    return preserved.typeNode;
  }

  // Use inferWidenedTypeFromExpression to widen literal types
  // This ensures `const x = 5` produces `number`, not `5`
  const type = inferWidenedTypeFromExpression(
    expr,
    context.checker,
    context.state.typeRegistry,
  );
  return typeToTypeNodeWithRegistry(
    type,
    context,
    context.state.typeRegistry,
  );
}

export function getDeclaredTypeNodeForBindingElement(
  declaration: ts.BindingElement,
  checker: ts.TypeChecker,
): ts.TypeNode | undefined {
  const parentPattern = declaration.parent;
  if (!ts.isObjectBindingPattern(parentPattern)) {
    return undefined;
  }

  const key = getBindingElementPropertyKey(declaration);
  if (key === undefined) {
    return undefined;
  }

  const parentType = checker.getTypeAtLocation(parentPattern);
  const prop = parentType.getProperty(key);
  const propDeclaration = prop?.valueDeclaration ??
    (prop?.declarations?.[0] as ts.Declaration | undefined);

  if (
    propDeclaration &&
    (ts.isPropertySignature(propDeclaration) ||
      ts.isPropertyDeclaration(propDeclaration)) &&
    propDeclaration.type
  ) {
    return propDeclaration.type;
  }

  return undefined;
}

/**
 * Returns the type node and type to emit for a destructured binding whose
 * declared type carries a wrapper, or `undefined` when its inferred type loses
 * nothing.
 *
 * A property of a generic input is declared in terms of the input's type
 * parameters, which mean nothing where the binding is emitted. Each one is
 * replaced by the caller's type argument, where it sits in a union, an
 * intersection, parentheses, or a wrapper, and where that argument prints as a
 * node that reads the same anywhere. Every other generic binding is emitted as
 * its instantiated declared type, which keeps the wrapper and the complete
 * value type, and spells a default's value as one more member of the union.
 */
export function getPreservedTypeForBindingElement(
  declaration: ts.BindingElement,
  checker: ts.TypeChecker,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): { typeNode: ts.TypeNode; type: ts.Type } | undefined {
  const declared = getDeclaredTypeNodeForBindingElement(declaration, checker);
  const preserved = declared && getPreservedBindingTypeNode(declared, checker);
  if (!declared || !preserved) return undefined;

  const parameters = new Set<ts.Type>();
  let everyParameterReplaceable = true;
  const findParameters = (node: ts.Node, replaceable: boolean) => {
    if (ts.isTypeReferenceNode(node)) {
      const type = checker.getTypeFromTypeNode(node);
      if (type.flags & ts.TypeFlags.TypeParameter) {
        parameters.add(type);
        everyParameterReplaceable &&= replaceable;
      }
    }
    // A parameter inside any other type expression, such as `Box<T>` or
    // `T[K]`, is read through that expression's own generic declaration, so a
    // node put in its place there changes nothing.
    const through = ts.isUnionTypeNode(node) ||
      ts.isIntersectionTypeNode(node) ||
      ts.isParenthesizedTypeNode(node) ||
      (ts.isTypeReferenceNode(node) &&
        shouldPreserveBindingDeclaredTypeNode(node, checker));
    ts.forEachChild(
      node,
      (child) => findParameters(child, replaceable && through),
    );
  };
  findParameters(preserved, true);

  if (parameters.size === 0) {
    return registerForEmission(
      preserved,
      checker.getTypeFromTypeNode(declared),
      typeRegistry,
    );
  }

  const instantiated = getInstantiatedBindingType(declaration, checker);
  if (!instantiated) return undefined;
  const substituted = everyParameterReplaceable
    ? substituteTypeParameters(
      preserved,
      parameters,
      instantiated.substitutions,
      declaration,
      checker,
      typeRegistry,
    )
    : undefined;
  if (substituted) {
    return registerForEmission(substituted, instantiated.type, typeRegistry);
  }

  // The instantiated declared type still carries the wrapper. The binding's
  // type inside the pattern body does not, and with `Default<{}>` stripped
  // from `T | {}` that union reduces to `{}`, so returning `undefined` here
  // would emit a value type without `T`.
  const typeNode = typeToTypeNodeWithRegistry(
    instantiated.type,
    { checker, factory: ts.factory, sourceFile: declaration.getSourceFile() },
    typeRegistry,
  );
  return { typeNode, type: instantiated.type };
}

/**
 * Helper for `getPreservedTypeForBindingElement()`, which registers `type` for
 * a clone of `typeNode` that carries no source positions. The node may come
 * from an alias declared in another module, and the printer reads a positioned
 * node's text out of the module it is printing.
 */
function registerForEmission(
  typeNode: ts.TypeNode,
  type: ts.Type,
  typeRegistry: WeakMap<ts.Node, ts.Type> | undefined,
): { typeNode: ts.TypeNode; type: ts.Type } {
  const cloned = cloneTypeNodeDeepForEmission(typeNode, typeRegistry);
  typeRegistry?.set(cloned, type);
  return { typeNode: cloned, type };
}

/**
 * Helper for `getPreservedTypeForBindingElement()`, which replaces each
 * reference to one of `parameters` in `typeNode` with a node printed from its
 * type argument. Returns `undefined` when an argument is missing, or prints as
 * a node that schema generation would read differently where it is emitted.
 */
function substituteTypeParameters(
  typeNode: ts.TypeNode,
  parameters: ReadonlySet<ts.Type>,
  substitutions: ReadonlyMap<ts.Type, ts.Type>,
  declaration: ts.BindingElement,
  checker: ts.TypeChecker,
  typeRegistry: WeakMap<ts.Node, ts.Type> | undefined,
): ts.TypeNode | undefined {
  const replacements = new Map<ts.Type, ts.TypeNode>();
  for (const parameter of parameters) {
    const argument = substitutions.get(parameter);
    if (!argument) return undefined;
    const replacement = typeToTypeNodeWithRegistry(
      argument,
      { checker, factory: ts.factory, sourceFile: declaration.getSourceFile() },
      typeRegistry,
      DEFAULT_TYPE_NODE_FLAGS | ts.NodeBuilderFlags.InTypeAlias,
    );
    if (!readsTheSameWhereEmitted(replacement, declaration, checker)) {
      return undefined;
    }
    replacements.set(parameter, replacement);
  }

  const result = ts.transform(typeNode, [(context) => {
    const substitute = (node: ts.Node): ts.Node => {
      if (ts.isTypeReferenceNode(node)) {
        const replacement = replacements.get(checker.getTypeFromTypeNode(node));
        if (replacement) return replacement;
      }
      return ts.visitEachChild(node, substitute, context);
    };
    return (node) => ts.visitNode(node, substitute, ts.isTypeNode)!;
  }]);
  const substituted = result.transformed[0]!;
  result.dispose();
  return substituted;
}

/**
 * Helper for `substituteTypeParameters()`, which returns `true` for a printed
 * type node that schema generation reads as the type it was printed from. Three
 * forms are not: a reference with type arguments, whose members are read from
 * its generic declaration with their parameters unresolved; `import("…").T`
 * and `typeof x`, which name what the emitting module may not hold; and a name
 * that is out of scope where the binding is declared.
 */
function readsTheSameWhereEmitted(
  typeNode: ts.TypeNode,
  declaration: ts.BindingElement,
  checker: ts.TypeChecker,
): boolean {
  let inScope: Set<string> | undefined;
  const reads = (node: ts.Node): boolean => {
    if (ts.isImportTypeNode(node) || ts.isTypeQueryNode(node)) return false;
    if (ts.isTypeReferenceNode(node)) {
      if (node.typeArguments?.length || !ts.isIdentifier(node.typeName)) {
        return false;
      }
      inScope ??= new Set(
        checker.getSymbolsInScope(declaration, ts.SymbolFlags.Type)
          .map((symbol) => symbol.name),
      );
      if (!inScope.has(node.typeName.text)) return false;
    }
    return ts.forEachChild(node, (child) => !reads(child)) !== true;
  };
  return reads(typeNode);
}

/** Resolves a destructuring path against its input type and collects generic arguments. */
function getInstantiatedBindingType(
  declaration: ts.BindingElement,
  checker: ts.TypeChecker,
): { type: ts.Type; substitutions: Map<ts.Type, ts.Type> } | undefined {
  const path: string[] = [];
  let binding = declaration;
  while (true) {
    const key = getBindingElementPropertyKey(binding);
    if (key === undefined || !ts.isObjectBindingPattern(binding.parent)) {
      return undefined;
    }
    path.unshift(key);
    const parent = binding.parent.parent;
    if (!ts.isBindingElement(parent)) break;
    binding = parent;
  }

  const root = binding.parent.parent;
  let input = checker.getTypeAtLocation(binding.parent);
  if (ts.isParameter(root)) {
    const callback = root.parent;
    const position = getCallArgumentPosition(callback);
    const call = position?.call;
    if (
      (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
      callback.parameters[0] === root && position?.index === 0 &&
      call?.typeArguments?.[0] &&
      detectDirectBuilderCall(call, checker)?.builderName === "pattern"
    ) {
      // The callback's contextual type has already stripped defaults and
      // scopes. The builder's input retains them and the caller's arguments.
      input = checker.getTypeFromTypeNode(call.typeArguments[0]);
    }
  }

  const substitutions = new Map<ts.Type, ts.Type>();
  const visited = new Set<ts.Type>();
  const collect = (type: ts.Type) => {
    if (visited.has(type)) return;
    visited.add(type);
    if (type.aliasTypeArguments) {
      const alias = type.aliasSymbol?.declarations?.find(
        ts.isTypeAliasDeclaration,
      );
      alias?.typeParameters?.forEach((parameter, index) => {
        const argument = type.aliasTypeArguments![index];
        if (argument) {
          substitutions.set(checker.getTypeAtLocation(parameter), argument);
        }
      });
    }
    if (type.isUnionOrIntersection()) type.types.forEach(collect);
    if (type.flags & ts.TypeFlags.Object) {
      const object = type as ts.ObjectType;
      if (object.objectFlags & ts.ObjectFlags.Reference) {
        const reference = object as ts.TypeReference;
        const arguments_ = checker.getTypeArguments(reference);
        reference.target.typeParameters?.forEach((parameter, index) => {
          const argument = arguments_[index];
          if (argument) substitutions.set(parameter, argument);
        });
        reference.getBaseTypes()?.forEach(collect);
      }
    }
  };

  for (const key of path) {
    collect(input);
    const property = input.getProperty(key);
    if (!property) return undefined;
    input = checker.getTypeOfSymbolAtLocation(property, declaration);
  }
  return { type: input, substitutions };
}

function getBindingElementPropertyKey(
  declaration: ts.BindingElement,
): string | undefined {
  const propertyName = declaration.propertyName;
  if (!propertyName) {
    return ts.isIdentifier(declaration.name)
      ? declaration.name.text
      : undefined;
  }
  if (ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName)) {
    return propertyName.text;
  }
  if (ts.isNumericLiteral(propertyName)) {
    return propertyName.text;
  }
  if (ts.isComputedPropertyName(propertyName)) {
    const expression = propertyName.expression;
    if (
      ts.isStringLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression) ||
      ts.isNumericLiteral(expression)
    ) {
      return expression.text;
    }
  }
  return undefined;
}

/**
 * Returns the type node to emit for a destructured binding in place of its
 * inferred type, or `undefined` when the inferred type loses nothing. Inside a
 * pattern body a binding's type has its `Default` and scope wrappers stripped,
 * so a binding whose declared type carries one is emitted from what its author
 * wrote. A wrapper reached through a type alias counts the same as one written
 * in place, and is emitted as the type the alias names.
 */
export function getPreservedBindingTypeNode(
  declaredTypeNode: ts.TypeNode,
  checker: ts.TypeChecker,
): ts.TypeNode | undefined {
  const authored = resolveTypeAliasReferences(declaredTypeNode, checker);
  return shouldPreserveBindingDeclaredTypeNode(authored, checker)
    ? authored
    : undefined;
}

/**
 * Helper for `getPreservedBindingTypeNode()`, which replaces each reference to
 * a type alias that names a wrapper-carrying type with the type node the alias
 * names, at the positions `shouldPreserveBindingDeclaredTypeNode()` inspects:
 * the node itself, a member of a union or an intersection, and an argument of
 * `Writable`. Returns the node it was given when none of those is such a
 * reference.
 *
 * Two kinds of reference stay as written. One names a type that carries no
 * wrapper: nothing in it needs the authored spelling, so the alias keeps its
 * name. The other names a generic alias, whose type is spelled in terms of the
 * alias's own type parameters.
 */
function resolveTypeAliasReferences(
  typeNode: ts.TypeNode,
  checker: ts.TypeChecker,
  resolving: ReadonlySet<ts.TypeNode> = new Set(),
): ts.TypeNode {
  const resolve = (node: ts.TypeNode) =>
    resolveTypeAliasReferences(node, checker, resolving);
  const resolveAll = (nodes: ts.NodeArray<ts.TypeNode>) => {
    const resolved = nodes.map(resolve);
    return resolved.some((node, index) => node !== nodes[index])
      ? resolved
      : undefined;
  };

  if (ts.isParenthesizedTypeNode(typeNode)) {
    const inner = resolve(typeNode.type);
    return inner === typeNode.type
      ? typeNode
      : ts.factory.updateParenthesizedType(typeNode, inner);
  }

  if (ts.isUnionTypeNode(typeNode)) {
    const members = resolveAll(typeNode.types);
    // A member that named a union contributes that union's members, so the
    // result stays one flat union.
    return members
      ? ts.factory.updateUnionTypeNode(
        typeNode,
        ts.factory.createNodeArray(
          members.flatMap((member) =>
            ts.isUnionTypeNode(member) ? [...member.types] : [member]
          ),
        ),
      )
      : typeNode;
  }

  if (ts.isIntersectionTypeNode(typeNode)) {
    const members = resolveAll(typeNode.types);
    return members
      ? ts.factory.updateIntersectionTypeNode(
        typeNode,
        ts.factory.createNodeArray(members),
      )
      : typeNode;
  }

  if (!ts.isTypeReferenceNode(typeNode)) {
    return typeNode;
  }

  if (typeNode.typeArguments) {
    const typeArguments = getWrapperName(typeNode, checker) === "Writable"
      ? resolveAll(typeNode.typeArguments)
      : undefined;
    return typeArguments
      ? ts.factory.updateTypeReferenceNode(
        typeNode,
        typeNode.typeName,
        ts.factory.createNodeArray(typeArguments),
      )
      : typeNode;
  }

  const aliased = getAliasedTypeNode(typeNode, checker);
  // An alias already being resolved names itself; its reference stays.
  if (!aliased || resolving.has(aliased)) {
    return typeNode;
  }
  const named = resolveTypeAliasReferences(
    aliased,
    checker,
    new Set([...resolving, aliased]),
  );
  return shouldPreserveBindingDeclaredTypeNode(named, checker)
    ? named
    : typeNode;
}

/**
 * Helper for `resolveTypeAliasReferences()`, which returns the type node a
 * reference to a non-generic type alias names, or `undefined` for a reference
 * to anything else.
 */
function getAliasedTypeNode(
  reference: ts.TypeReferenceNode,
  checker: ts.TypeChecker,
): ts.TypeNode | undefined {
  const name = ts.isIdentifier(reference.typeName)
    ? reference.typeName
    : reference.typeName.right;
  let symbol = checker.getSymbolAtLocation(name);
  // An imported alias resolves to its import binding first.
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  const declaration = symbol?.declarations?.find(ts.isTypeAliasDeclaration);
  return declaration && !declaration.typeParameters?.length
    ? declaration.type
    : undefined;
}

/**
 * The wrappers a pattern body's view of a binding strips from its type.
 */
const BODY_STRIPPED_WRAPPER_NAMES: ReadonlySet<string> = new Set([
  "Default",
  "PerAny",
  "PerSession",
  "PerSpace",
  "PerUser",
]);

/**
 * Returns the name of the wrapper `reference` names — `Writable`, or one of
 * the wrappers a pattern body strips — and `undefined` for a reference to
 * anything else. A type of the author's own that shares a wrapper's name is
 * something else: the name counts only where it resolves to the declaration
 * `commonfabric` exports. Given no checker, or a node the checker cannot
 * resolve, as a synthesized one is, the spelling alone decides.
 */
function getWrapperName(
  reference: ts.TypeReferenceNode,
  checker: ts.TypeChecker | undefined,
): string | undefined {
  const identifier = ts.isIdentifier(reference.typeName)
    ? reference.typeName
    : reference.typeName.right;
  const name = identifier.text;
  if (name !== "Writable" && !BODY_STRIPPED_WRAPPER_NAMES.has(name)) {
    return undefined;
  }
  const symbol = checker?.getSymbolAtLocation(identifier);
  return !checker || !symbol ||
      resolvesToCommonFabricSymbol(symbol, checker, name)
    ? name
    : undefined;
}

/**
 * Returns `true` for a declared type that carries a wrapper the pattern body's
 * view of a binding strips: as the type itself, as a member of a union or an
 * intersection, or as the argument of `Writable`.
 */
export function shouldPreserveBindingDeclaredTypeNode(
  typeNode: ts.TypeNode,
  checker?: ts.TypeChecker,
): boolean {
  const unwrapped = unwrapParenthesizedTypeNode(typeNode);
  const carries = (node: ts.TypeNode) =>
    shouldPreserveBindingDeclaredTypeNode(node, checker);

  if (ts.isTypeReferenceNode(unwrapped)) {
    const name = getWrapperName(unwrapped, checker);
    return name === "Writable"
      ? unwrapped.typeArguments?.some(carries) ?? false
      : name !== undefined;
  }

  if (ts.isUnionTypeNode(unwrapped) || ts.isIntersectionTypeNode(unwrapped)) {
    return unwrapped.types.some(carries);
  }

  return false;
}

function unwrapParenthesizedTypeNode(typeNode: ts.TypeNode): ts.TypeNode {
  let current = typeNode;
  while (ts.isParenthesizedTypeNode(current)) {
    current = current.type;
  }
  return current;
}

/**
 * Deep-clones a TypeNode for emission, stripping source positions throughout.
 *
 * An authored declaration's type node may live in a different source file
 * than the one being emitted (e.g. a pattern destructuring an interface
 * imported from a sibling module). The printer extracts literal text (the
 * `"n/a"` in `Default<string, "n/a">`) by source position from the file it
 * is currently printing, so reusing such nodes verbatim emits garbage tokens
 * sliced from the wrong file. A position-free deep clone makes every node
 * synthetic, forcing the printer to print structurally (literals fall back
 * to their `.text`).
 *
 * Pass `typeRegistry` to carry each node's registered Type onto its clone.
 *
 * (Mirrors the helper of the same name on the lift-capture-shrink branch,
 * #4078 — whichever lands second keeps one copy.)
 */
export function cloneTypeNodeDeepForEmission<T extends ts.TypeNode>(
  typeNode: T,
  typeRegistry?: WeakMap<ts.Node, ts.Type>,
): T {
  const nullContext = (ts as typeof ts & {
    nullTransformationContext?: ts.TransformationContext;
  }).nullTransformationContext;
  if (!nullContext) return typeNode;
  const cloneShallow = (ts.factory as typeof ts.factory & {
    cloneNode<TNode extends ts.Node>(node: TNode): TNode;
  }).cloneNode;

  const visit = <N extends ts.Node>(node: N): N => {
    // Post-order: children first, so leaf nodes (identifiers, literals,
    // keywords) get cloned explicitly while composite nodes are recreated by
    // visitEachChild's update calls when any child changed.
    let result = ts.visitEachChild(
      node,
      (child) => visit(child),
      nullContext,
    ) as N;
    if (result === node) {
      result = cloneShallow(node);
    }
    // update* calls copy the original's text range for source maps; strip it
    // so the printer treats the node as synthesized everywhere.
    ts.setTextRange(result, { pos: -1, end: -1 });
    const registered = typeRegistry?.get(node);
    if (registered) {
      typeRegistry!.set(result, registered);
    }
    return result;
  };

  return visit(typeNode);
}

/**
 * Reports when a reactive value consumed across a boundary has inferred type
 * `unknown`. That type lowers to `{ type: "unknown" }`, which marks a
 * reference the runner does not materialize: it reads back as an opaque
 * value that answers presence and identity and carries no properties (see
 * `runner/src/traverse.ts`, where a `TypeValidity.Unknown` position is
 * answered without descending). `any` lowers to a permissive `true` schema
 * and materializes, so it is not flagged.
 *
 * Both reactive-input sites share this: closure-captured inputs (the capture
 * leaves below — `computed`/`lift`, `handler`/`action`, reactive array methods,
 * `patternTool`) and the condition of `ifElse`/`when`/`unless` (checked where
 * their schemas are built). `reportDiagnosticOnce` keeps the same value from
 * being reported twice when more than one stage walks it.
 */
export function reportUnknownReactiveType(
  context: TransformationContext,
  expression: ts.Expression,
  type: ts.Type | undefined,
  label: string,
): void {
  if (!isUnknownType(unwrapCellLikeType(type, context.checker))) {
    return;
  }
  context.reportDiagnosticOnce({
    severity: "error",
    type: "reactive-capture:unknown-type",
    message:
      `Reactive value \`${describeCapture(expression, label)}\` has inferred ` +
      `type \`unknown\`, so its schema is \`{ type: "unknown" }\`, which the ` +
      `runner does not materialize: it reads back as an opaque reference ` +
      `carrying none of the value's properties. Add an explicit type so it ` +
      `can be inferred (e.g. \`fetchJson<{ /* result shape */ }>({ ... })\`).`,
    node: expression,
  });
}

/** Single-line rendering of a reactive value for the message; falls back to the
 * given label when there is no usable text. Uses getExpressionText, which
 * prints synthetic nodes safely — `getText()` throws on them. */
function describeCapture(expression: ts.Expression, fallback: string): string {
  const text = getExpressionText(expression).replace(/\s+/g, " ").trim();
  if (!text) {
    return fallback;
  }
  return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}

/**
 * Builds TypeScript type elements from a capture tree structure.
 * Works for both nested properties within a tree node and root-level entries.
 * Recursively builds nested type literals for hierarchical captures.
 *
 * @param entries - Iterable of [name, CaptureTreeNode] pairs
 * @param context - Transformation context for factory and type checking
 * @param parentExpr - Optional parent expression to reconstruct property access chains
 * @param parentType - Optional parent Type for checking property optionality on synthetic nodes
 * @returns Array of TypeScript property signatures
 */
export function buildTypeElementsFromCaptureTree(
  entries: Iterable<[string, CaptureTreeNode]>,
  context: TransformationContext,
  parentExpr?: ts.Expression,
  parentType?: ts.Type,
): ts.TypeElement[] {
  const { factory, checker } = context;
  const properties: ts.TypeElement[] = [];

  for (const [propName, childNode] of entries) {
    let typeNode: ts.TypeNode;
    let questionToken: ts.QuestionToken | undefined = undefined;
    let currentType: ts.Type | undefined = undefined;

    // Reconstruct property access for this property (for parent pointer consistency)
    const currentExpr = parentExpr
      ? factory.createPropertyAccessExpression(parentExpr, propName)
      : factory.createIdentifier(propName);

    // Set parent pointers if we created a synthetic node
    if (!currentExpr.getSourceFile()) {
      setParentPointers(currentExpr);
    }

    // Determine optionality and get Type for this property
    if (childNode.expression) {
      // Leaf node with source expression - use it directly
      typeNode = expressionToTypeNode(childNode.expression, context);

      // Judge unknown-ness from the type that drives the emitted schema — the
      // same one expressionToTypeNode uses. A bare getTypeAtLocation would skip
      // the typeRegistry lookup and initializer fallback; literal widening here
      // can't change whether the type is unknown.
      reportUnknownReactiveType(
        context,
        childNode.expression,
        inferWidenedTypeFromExpression(
          childNode.expression,
          checker,
          context.state.typeRegistry,
        ),
        propName,
      );

      // Check optionality from source expression
      if (ts.isPropertyAccessExpression(childNode.expression)) {
        if (
          childNode.expression &&
          isOptionalMemberSymbol(childNode.expression, checker)
        ) {
          questionToken = factory.createToken(ts.SyntaxKind.QuestionToken);
        }
      } else if (
        ts.isIdentifier(childNode.expression) &&
        childNode.expression.getSourceFile()
      ) {
        // A bare-identifier capture (e.g. a field destructured from the
        // pattern's typed parameter). Determine optionality the standard-TS way
        // — the `?` flag on the SOURCE PROPERTY of the destructured aggregate,
        // mirroring the intermediate-node branch below. The capture's own symbol
        // doesn't carry it: a `{ x }` shorthand resolves to a value symbol, and
        // the destructured binding element doesn't inherit `SymbolFlags.Optional`
        // from the aggregate's property. So resolve to the binding element, then
        // read the aggregate property's flag. A field declared `x?: T` is
        // optional; `x: T | undefined` (no `?`) stays required (a required key
        // whose value may be undefined), faithful to TS.
        let symbol = checker.getSymbolAtLocation(childNode.expression);
        if (
          symbol?.valueDeclaration &&
          ts.isShorthandPropertyAssignment(symbol.valueDeclaration)
        ) {
          symbol = checker.getShorthandAssignmentValueSymbol(
            symbol.valueDeclaration,
          ) ??
            symbol;
        }
        const binding = symbol?.valueDeclaration;
        if (
          binding && ts.isBindingElement(binding) &&
          ts.isObjectBindingPattern(binding.parent)
        ) {
          const host = binding.parent.parent;
          const aggregateType = ts.isParameter(host)
            ? checker.getTypeAtLocation(host)
            : ts.isVariableDeclaration(host) && host.initializer
            ? checker.getTypeAtLocation(host.initializer)
            : undefined;
          // For a renamed binding (`{ source: local }`) the optionality lives on
          // the SOURCE property, not the local capture name. The source key may
          // be an identifier, string, or numeric literal (`{ "k": local }`,
          // `{ 0: local }`); computed keys (`{ [expr]: local }`) aren't
          // statically resolvable and fall back to the local name.
          const sourceName = binding.propertyName &&
              (ts.isIdentifier(binding.propertyName) ||
                ts.isStringLiteralLike(binding.propertyName) ||
                ts.isNumericLiteral(binding.propertyName))
            ? binding.propertyName.text
            : propName;
          const sourceProp = aggregateType?.getProperty(sourceName);
          if (sourceProp && isOptionalSymbol(sourceProp)) {
            questionToken = factory.createToken(ts.SyntaxKind.QuestionToken);
          }
        }
      }
    } else {
      // Intermediate node - need to get type to check optionality. Every node
      // from groupCapturesByRoot carries an expression or at least one child,
      // so a node without an expression is an intermediate node.
      if (childNode.properties.size <= 0) {
        throw new Error(
          "Invariant violated: child node has neither expression nor child",
        );
      }
      if (parentType) {
        // We have a parent type - look up this property
        const propSymbol = parentType.getProperty(propName);
        if (propSymbol) {
          // Get Type for this property to pass to children
          currentType = checker.getTypeOfSymbol(propSymbol);

          // Check optionality from the source property's `?` flag
          // (SymbolFlags.Optional). This is the standard-TS distinction:
          // `x?: T` is optional; `x: T | undefined` (no `?`) stays required.
          if (isOptionalSymbol(propSymbol)) {
            questionToken = factory.createToken(ts.SyntaxKind.QuestionToken);
          }
        }
      } else {
        // Root level - try to get type from the identifier
        // Look for a descendant expression to get the type context
        const findDescendantExpression = (
          node: CaptureTreeNode,
        ): ts.Expression | undefined => {
          if (node.expression) return node.expression;
          for (const child of node.properties.values()) {
            const found = findDescendantExpression(child);
            if (found) return found;
          }
          return undefined;
        };

        const descendantExpr = findDescendantExpression(childNode);
        if (descendantExpr) {
          // Walk up to find the root identifier's type
          let rootExpr: ts.Expression = descendantExpr;
          while (ts.isPropertyAccessExpression(rootExpr)) {
            rootExpr = rootExpr.expression;
          }
          if (ts.isIdentifier(rootExpr)) {
            currentType = checker.getTypeAtLocation(rootExpr);
          }
        }
      }

      // Build nested type literal for objects (including array property access like .length)
      const nested = buildTypeElementsFromCaptureTree(
        childNode.properties,
        context,
        currentExpr,
        currentType,
      );
      typeNode = createRegisteredTypeLiteral(
        nested,
        {
          factory,
          checker,
          typeRegistry: context.state.typeRegistry,
        },
      );
    }

    properties.push(
      factory.createPropertySignature(
        undefined,
        createPropertyName(propName, factory),
        questionToken,
        typeNode,
      ),
    );
  }

  return properties;
}

export function buildCaptureTypeElements(
  captureTree: Iterable<[string, CaptureTreeNode]>,
  context: TransformationContext,
  renameMap?: ReadonlyMap<string, string>,
): ts.TypeElement[] {
  const elements = buildTypeElementsFromCaptureTree(captureTree, context);
  if (!renameMap || renameMap.size === 0) {
    return elements;
  }

  return elements.map((element) => {
    if (
      !ts.isPropertySignature(element) || !ts.isIdentifier(element.name)
    ) {
      return element;
    }

    const renamedName = renameMap.get(element.name.text);
    if (!renamedName || renamedName === element.name.text) {
      return element;
    }

    return context.factory.createPropertySignature(
      element.modifiers,
      context.factory.createIdentifier(renamedName),
      element.questionToken,
      element.type,
    );
  });
}
