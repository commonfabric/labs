/**
 * Reads a type node the way its author wrote it, through the two forms that
 * stand for another type node and denote the same type: parentheses, and a
 * reference, by name, to a type alias that takes no type parameters. A reader
 * asking what structure a node has — whether it is a union, which wrapper a
 * reference names, what that wrapper's argument is — asks it of the node these
 * forms stand for.
 *
 * The set is read in three forms, so that each shape of reader has a
 * definition to reach for: {@link unwrapTypeParentheses} for a reader that
 * must keep an alias's name, {@link readAuthoredTypeNodeOnce} for one that
 * walks the chain a step at a time, and {@link readAuthoredTypeNode} for one
 * that wants the node at the end of it.
 *
 * A reference to a generic alias is not in the set. The node such an alias
 * names is written in terms of its own type parameters, and denotes what the
 * reference denotes only once each is replaced by the reference's argument; a
 * reader that needs to see through one substitutes for itself. Nor is
 * `readonly`, which changes the type a node denotes; a reader to which that
 * change is invisible strips it on top of these, and says so where it does.
 *
 * `unwrapExpression()` in ts-transformers' `utils/expression.ts` is the
 * counterpart for expressions. Its set is transparent for the value an
 * expression denotes, and includes wrappers — `as`, `!` — that change the
 * type, so the two are not one set.
 */

import ts from "typescript";

import { resolveAliasedSymbol } from "./literal-value.ts";

/**
 * Returns `node` with every pair of parentheses around it removed.
 * Parentheses never change the type a node denotes, so removing them loses
 * only syntax, and the node returned is one `node` holds.
 */
export function unwrapTypeParentheses(node: ts.TypeNode): ts.TypeNode {
  let current = node;
  while (ts.isParenthesizedTypeNode(current)) {
    current = current.type;
  }
  return current;
}

/**
 * Returns the declaration of the type alias that `reference` names, through
 * any import binding, or `undefined` for a reference to anything else. The
 * alias may be generic, in which case the node it declares is written in its
 * own type parameters and does not denote what the reference denotes until
 * each is replaced by the reference's argument, which a caller that reads
 * through the alias does for itself. A
 * reference the checker cannot resolve, such as one built by the transformer,
 * names no declaration here.
 */
export function getTypeAliasDeclaration(
  reference: ts.TypeReferenceNode,
  checker: ts.TypeChecker,
): ts.TypeAliasDeclaration | undefined {
  const name = ts.isIdentifier(reference.typeName)
    ? reference.typeName
    : reference.typeName.right;
  const symbol = checker.getSymbolAtLocation(name);
  return symbol &&
    resolveAliasedSymbol(symbol, checker).declarations?.find(
      ts.isTypeAliasDeclaration,
    );
}

/**
 * Returns the type node that `node` stands for, one step in: the node a pair
 * of parentheses holds, or the node a type alias names where `node` refers to
 * that alias by name, through any import binding, and neither the reference
 * nor the alias has type parameters. Returns `undefined` for any other node.
 *
 * The node the alias names belongs to the alias's declaration, which may be in
 * another module. A caller that emits it into this one clones it first, since
 * the printer reads a positioned node's text out of the module it is
 * printing. A node the checker cannot resolve, such as one built by the
 * transformer, has only its parentheses read.
 */
export function readAuthoredTypeNodeOnce(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
): ts.TypeNode | undefined {
  if (ts.isParenthesizedTypeNode(node)) return node.type;
  if (!ts.isTypeReferenceNode(node) || node.typeArguments?.length) {
    return undefined;
  }
  const declaration = getTypeAliasDeclaration(node, checker);
  return declaration && !declaration.typeParameters?.length
    ? declaration.type
    : undefined;
}

/**
 * Returns the type node that `node` stands for, reached by repeating
 * {@link readAuthoredTypeNodeOnce} until it returns `undefined`; returns
 * `node` itself when that is at once. An alias that names itself, directly or
 * through others, ends the walk at the reference that closes the cycle.
 *
 * Only the node itself is read through, never the nodes it holds: the members
 * of a union returned here are as their author wrote them, and a reader
 * descending into them reads each in turn.
 */
export function readAuthoredTypeNode(
  node: ts.TypeNode,
  checker: ts.TypeChecker,
): ts.TypeNode {
  const visited = new Set<ts.TypeNode>([node]);
  let current = node;
  while (true) {
    const next = readAuthoredTypeNodeOnce(current, checker);
    if (!next || visited.has(next)) return current;
    visited.add(next);
    current = next;
  }
}

/**
 * Returns the annotation written on `member`'s declaration when it denotes
 * exactly `type`, the member's type where it is read, apart from the
 * `undefined` that an optional member's `?` adds. Returns `undefined` for a
 * member declared without one, and for an annotation that denotes something
 * else there, such as a type parameter that an instantiation of a generic
 * declaration has replaced.
 *
 * Through this, a reader that has only a type reads what the member's author
 * wrote, and so what only syntax says: which binding a `typeof` names, for
 * one. The checker does the same when it prints a type, putting a member's
 * annotation into the print in place of printing its type. The annotation
 * denotes the type; it does not say that a reader can evaluate it, so a
 * reader pairs the two and reads the type where it cannot read the syntax.
 */
export function readMemberAnnotation(
  member: ts.Symbol,
  type: ts.Type,
  checker: ts.TypeChecker,
): ts.TypeNode | undefined {
  const declaration = member.valueDeclaration;
  const annotation = declaration &&
      (ts.isPropertySignature(declaration) ||
        ts.isPropertyDeclaration(declaration))
    ? declaration.type
    : undefined;
  if (!annotation) return undefined;
  const annotated = checker.getTypeFromTypeNode(annotation);
  if (annotated === type) return annotation;
  const optional = (member.flags & ts.SymbolFlags.Optional) !== 0;
  return optional && sameBesidesUndefined(annotated, type)
    ? annotation
    : undefined;
}

/** Whether `a` and `b` are unions of the same types once `undefined` is set aside. */
function sameBesidesUndefined(a: ts.Type, b: ts.Type): boolean {
  const parts = (type: ts.Type) =>
    new Set(
      (type.isUnion() ? type.types : [type]).filter((part) =>
        (part.flags & ts.TypeFlags.Undefined) === 0
      ),
    );
  const aParts = parts(a);
  const bParts = parts(b);
  return aParts.size === bParts.size &&
    [...aParts].every((part) => bParts.has(part));
}
