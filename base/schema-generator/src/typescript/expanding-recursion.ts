/**
 * Finds a recursion that instantiates its declaration without end, as
 * `Nest<T[]>` inside `Nest<T>` does, for a reading that writes out what it
 * reads: the schema generator's reading of a type under no type parameter
 * bindings. Such a reading ends a recursion where it meets a type it has read
 * already, which this one never does: each level is a new instantiation. It keeps the types it is read within and asks
 * `cutsExpansion()` before it descends further. Every reading made inside a
 * recursion of its own declaration spends one budget, which a reading under
 * bindings, whose recursion the generator ends by its shape, spends too
 * (`exhaustsBudget()`).
 *
 * What these readings read, they write out, so the cut counts instantiations
 * of one declaration rather than every type: a bound on depth alone writes out
 * every level up to it. A finite chain that recurses through one declaration
 * more than the cut allows is cut too. The schema generator reports what it
 * leaves unread, and refuses nothing. The writer-policy reading (`writer-policy.ts`) writes
 * nothing out and can refuse a schema on its answer, so it is bounded by depth
 * and by count instead.
 */

import ts from "typescript";
import { maxOf } from "@commonfabric/utils/math";

/**
 * How many readings of one declaration, each instantiated with arguments at
 * least as large as those of the one it is read inside (`expansionDepth()`),
 * may nest before the innermost is taken for a recursion that
 * instantiates the declaration without end (`cutsExpansion()`), unless a
 * reading passes its own. The checker takes three for a recursion where its
 * answer is only "maybe"; this is set past the depth a finite chain written in
 * a pattern's types reaches, as a tuple of a dozen elements a recursive alias
 * walks one at a time.
 */
export const MAX_EXPANDING_NESTING = 32;

/**
 * How many readings in all, each made inside a recursion of its own
 * declaration, one reading may make before it cuts every further one
 * (`exhaustsBudget()`). A recursion that branches, as one through two of its
 * members does, reaches the per-declaration cut along every path, which is
 * exponentially many readings; this bounds them all.
 */
export const MAX_EXPANDING_READINGS = 1000;

/**
 * The readings a reading has made inside a recursion of their own
 * declaration, toward `MAX_EXPANDING_READINGS`.
 */
export type ExpansionBudget = { readingsInside: number };

/**
 * Spends from `budget` a reading made inside a recursion of its own
 * declaration, and whether the budget had run out
 * (`MAX_EXPANDING_READINGS`), so that the reading is cut.
 */
export const exhaustsBudget = (budget: ExpansionBudget): boolean =>
  ++budget.readingsInside > MAX_EXPANDING_READINGS;

/**
 * How deeply `type`, read inside `path`, the types it is read within,
 * outermost first, nests in instantiations of one declaration: the most
 * readings of any declaration it instantiates, itself among them, each
 * instantiated with arguments at least as large as the last's
 * (`argumentSize()`), as `Nest<T[]>` inside `Nest<T>` is. A nesting its
 * author wrote out, `Pair<Pair<Pair<string>>>`, shrinks from the outside in,
 * so its readings are not counted. The checker counts by the order it
 * created the types in (`isDeeplyNestedType`), which depends on the rest of
 * the program; their arguments do not.
 */
export const expansionDepth = (
  type: ts.Type,
  path: readonly ts.Type[],
  checker: ts.TypeChecker,
): number =>
  Math.max(
    0,
    maxOf(
      recursionIdentities(type, checker).map((identity) => {
        let count = 0;
        let lastSize = -1;
        for (const outer of [...path, type]) {
          if (!recursionIdentities(outer, checker).includes(identity)) continue;
          const size = argumentSize(outer);
          if (size >= lastSize) count++;
          lastSize = size;
        }
        return count;
      }),
    ),
  );

/**
 * The sizes `argumentSize()` has found, by type. A type's size is read only
 * from what the checker gave it on creating it, which never changes, so it
 * is found once.
 */
const argumentSizes = new WeakMap<ts.Type, number>();

/**
 * How large the arguments `type` was instantiated with are: one for the type,
 * and the sizes of its arguments, an argument written twice counted twice,
 * up to `Number.MAX_SAFE_INTEGER`, past which sizes compare as equal. It
 * reads only the arguments the checker gave the type on creating it: an
 * alias's instantiation's alias arguments, or a reference's own, except a
 * deferred reference's, which are resolved only when something asks for
 * them. A type's arguments are created before it, so none is the type
 * itself or holds it, and each type's size is found once
 * (`argumentSizes`), as `Dup<[T, T]>`'s two shared arguments need.
 */
const argumentSize = (type: ts.Type): number => {
  const known = argumentSizes.get(type);
  if (known !== undefined) return known;
  const reference = type as ts.Type & {
    readonly node?: ts.Node;
    readonly resolvedTypeArguments?: readonly ts.Type[];
  };
  const isReference = ((type as ts.ObjectType).objectFlags &
    ts.ObjectFlags.Reference) !== 0;
  const args = type.aliasTypeArguments ??
    (isReference && reference.node === undefined
      ? reference.resolvedTypeArguments
      : undefined) ??
    [];
  let size = 1;
  for (const arg of args) {
    size = Math.min(size + argumentSize(arg), Number.MAX_SAFE_INTEGER);
  }
  argumentSizes.set(type, size);
  return size;
};

/**
 * Whether a reading cuts `type`, read inside `path`, as a recursion that
 * instantiates its declaration without end, as `Nest<T[]>` inside `Nest<T>`
 * does: where it nests one declaration `max` deep (`expansionDepth()`), or
 * where it is read inside a recursion of its own declaration after `budget`
 * has run out (`exhaustsBudget()`).
 */
export const cutsExpansion = (
  type: ts.Type,
  path: readonly ts.Type[],
  budget: ExpansionBudget,
  checker: ts.TypeChecker,
  max: number = MAX_EXPANDING_NESTING,
): boolean => {
  const depth = expansionDepth(type, path, checker);
  if (depth >= max) return true;
  return depth >= 2 && exhaustsBudget(budget);
};

/**
 * Whether `type` is a deferred reference: an array or a tuple a type alias
 * writes in its own recursion, as `[T, Tup<T[]>?]` in `type Tup<T> = …`,
 * which the checker instantiates from the node that writes it.
 */
export const isDeferredReference = (type: ts.Type): boolean =>
  ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0 &&
  (type as ObjectTypeWithInternals).node !== undefined;

/** A mapped type as the checker holds it once it resolves its members. */
type MappedTypeWithInternals = ts.ObjectType & {
  readonly modifiersType?: ts.Type;
};

/** An object type as the checker holds it: a deferred reference's node. */
type ObjectTypeWithInternals = ts.ObjectType & { readonly node?: ts.Node };

/**
 * The declarations `type`, an object type, is a reading of, as the checker
 * names them to find a recursion (`getRecursionIdentity`): an instantiated
 * mapped type reads the type it maps over where that type has a declaration
 * (`getMappedTargetWithSymbol`), so `DeepReadonly<T[K]>` inside
 * `DeepReadonly<T>` is a reading of `T[K]`, not of the mapped type again; a
 * deferred reference, as the tuple `[T, Tup<T[]>?]` an alias writes, reads the
 * node that writes it; and a type with a symbol reads its symbol. Each member
 * of an intersection is a reading of its own declarations. Any other array or
 * tuple is a reading of none: it recurses without end only through a
 * declaration or a deferred reference of its own, which is counted, and data
 * nests arrays of objects deeper than the cut.
 */
const recursionIdentities = (
  type: ts.Type,
  checker: ts.TypeChecker,
): readonly object[] => {
  const instantiatedMapped = ts.ObjectFlags.Mapped |
    ts.ObjectFlags.Instantiated;
  let read = type;
  while (
    ((read as ts.ObjectType).objectFlags & instantiatedMapped) ===
      instantiatedMapped
  ) {
    if (!(read as MappedTypeWithInternals).modifiersType) {
      checker.getPropertiesOfType(read);
    }
    const target = (read as MappedTypeWithInternals).modifiersType;
    if (
      !target ||
      !(target.symbol ||
        (target.isIntersection() && target.types.some((part) => part.symbol)))
    ) {
      break;
    }
    read = target;
  }
  if (read.isIntersection()) {
    return read.types.flatMap((part) => recursionIdentities(part, checker));
  }
  const objectFlags = (read as ts.ObjectType).objectFlags ?? 0;
  if (
    (read.flags & ts.TypeFlags.Object) === 0 ||
    (objectFlags & (ts.ObjectFlags.ObjectLiteral | ts.ObjectFlags.ArrayLiteral))
  ) {
    return [read];
  }
  const node = (read as ObjectTypeWithInternals).node;
  if ((objectFlags & ts.ObjectFlags.Reference) && node) return [node];
  if (checker.isArrayType(read) || checker.isTupleType(read)) return [];
  if (
    read.symbol &&
    !((objectFlags & ts.ObjectFlags.Anonymous) &&
      (read.symbol.flags & ts.SymbolFlags.Class))
  ) {
    return [read.symbol];
  }
  return [read];
};
