import { deepEqual } from "@commonfabric/utils/deep-equal";

import { isFabricSpecialObject } from "@/types";
import { valueEqual } from "./valueEqual.ts";

/**
 * Compares two values of unknown type for logical equality, the way
 * `deepEqual()` does, with every `FabricSpecialObject` the walk reaches
 * decided by `valueEqual()` rather than by its properties.
 *
 * This is the comparison for an operand allowed to hold a `FabricValue`
 * without being known to be one: a schema `const` against a stored value, a
 * schema default against a materialized one, a write against the value it
 * replaces, a request against the snapshot a policy was checked over. A
 * special object -- a byte sequence, a temporal value, a content hash, a
 * regular expression, an error, a link, a map, a set -- keeps its state in
 * private fields and has no enumerable own properties, so `deepEqual()` on its
 * own reads two distinct same-class ones as equal. `valueEqual()` is defined
 * over `FabricValue`s and throws on any other class instance, which these
 * operands still carry -- a `Cell`, a query-result proxy.
 *
 * Operands arrive unwrapped. A special object is recognized by `instanceof`,
 * which a proxy decides rather than the value behind it, so a proxy that does
 * not forward the test hides the special object from this comparison and two
 * distinct ones read as equal -- the answer this function exists to prevent.
 * One that does forward it reaches `valueEqual()`, which reads a private field
 * through the proxy and throws. `data-model` sits below whatever built the
 * proxy and cannot unwrap one, so this is the caller's to do.
 *
 * So the walk is the frame, and the model decides the values only it can
 * decide. A special object is one of those, whatever it sits inside: two of
 * one class are compared by content hash, and one paired with anything else is
 * unequal.
 *
 * The model is not asked about a container. `valueEqual()` decides a record or
 * an array by hashing it whole, and `hashStringOf()` refuses one kind of value
 * the `FabricValue` type admits: one holding a class whose codec is still a
 * stub. That returns here where the walk finds what settles it before
 * descending that far. Comparing `{ v: aFabricMap }` against `{ v: 5 }`
 * returns `false`, on the ground that a `FabricMap` is not `5`. A cycle the two
 * operands reach at one shared reference stops at that reference. This walk
 * carries no cycle tracking of its own, so two separate cyclic graphs exhaust
 * the stack here.
 *
 * TODO(danfuzz): decide a container through the model as well, once the stub
 * codecs are written, at which point this becomes a hash comparison with the
 * walk beneath it rather than the other way round. The order costs rather than
 * decides: `valueEqual()` compares deep-frozen operands by a content hash
 * cached on identity, where the walk pays for every level each time.
 *
 * A pair of one class that class cannot yet hash still throws, from
 * `valueEqual()`. `FabricMap` and `FabricSet` carry stub codecs, and a stub
 * naming itself is the answer that names the work.
 *
 * Where both this and `valueEqual()` return, they return the same result
 * except for an array with non-index properties, which `valueEqual()` ignores,
 * as content hashing does, and this walk compares. A null-prototype object is
 * one `valueEqual()` refuses, not being a `FabricValue`; this walk compares it
 * by its contents, and separates it from a plain record on their
 * constructors.
 *
 * This is the compare-side half of admitting special objects; the walk-side
 * half is `isKeyableObjectOrArray()`, with `isWalkableObjectOrArray()` the
 * same question for a walk that must refuse a `FabricInstance` rather than
 * report one as unreachable.
 */
export function fabricAwareEqual(a: unknown, b: unknown): boolean {
  return deepEqual(a, b, specialObjectEqual);
}

/**
 * Helper for {@link fabricAwareEqual}, deciding the object pairs in which
 * either side is a `FabricSpecialObject` and declining the rest.
 */
function specialObjectEqual(a: object, b: object): boolean | undefined {
  const aIsSpecial = isFabricSpecialObject(a);
  const bIsSpecial = isFabricSpecialObject(b);

  if (!(aIsSpecial || bIsSpecial)) return undefined;
  if (!(aIsSpecial && bIsSpecial)) return false;

  // Two classes settle the pair without either one's contents, and so without
  // asking a codec about either, including classes with stub codecs.
  if (a.constructor !== b.constructor) return false;

  return valueEqual(a, b);
}
