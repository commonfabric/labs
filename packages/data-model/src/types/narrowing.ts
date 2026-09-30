/**
 * The narrowings that ask a shape question of a value already typed as a
 * `FabricValue`, and the container questions a structural walk asks of an
 * `unknown`. Whether a value belongs to the `FabricValue` type at all is
 * `validation.ts`'s question, and none of these asks it.
 *
 * The narrowings are looser than membership on purpose. Most are asked of a
 * value whose type already claims to be a `FabricValue`, and answer only
 * whether it may be read by name; where one accepts something membership
 * refuses, the difference is stated on that narrowing rather than here.
 *
 * The `isKeyable*` and `isWalkable*` pairs are the exception on both counts.
 * They take `unknown`, because a structural walk holds whatever its caller
 * passed -- a schema node, a pattern binding, a builder artifact -- and asking
 * it to prove membership first would be asking a different question than the
 * one it needs answered. Outside the `FabricValue` type they subtract nothing:
 * a `Date`, a `Map`, a `Cell` and a query-result proxy over one all still
 * return `true`, which is what leaves a walk's treatment of them where it
 * found it. Inside the type, a `FabricPrimitive` and any other special object
 * that is not a `FabricInstance` returns `false`, having no own properties to
 * read.
 *
 * The four differ on a `FabricInstance`, and nowhere else. `isKeyable*`
 * returns `false` for one, reporting that the asking walk cannot reach what it
 * holds; `isWalkable*` refuses one, for a walk that would carry a `false`
 * forward as an empty record. Each pair settles the array question in its
 * name.
 */

import {
  isObjectOrArray,
  isPlainObject,
  type ReadonlyRecord,
} from "@commonfabric/utils/types";

import {
  type FabricArray,
  type FabricContainerValue,
  FabricInstance,
  type FabricPlainObject,
  type FabricPrimitive,
  type FabricValue,
} from "@/interface.ts";
import { BaseFabricSpecialObject } from "@/fabric-bases/BaseFabricSpecialObject.ts";
import { refuseFabricInstance } from "./refuseFabricInstance.ts";

/**
 * Indicates whether a value's contents are reachable by property name: a
 * non-`null` object, an array included, that is not a `FabricSpecialObject`.
 *
 * This is the container question, and the question `isObjectOrArray()` gets
 * wrong. A special object keeps its state in private fields and has no own
 * properties at all, so `isObjectOrArray()` calls it a record and a walk then
 * works on an empty one: it merges to `{}`, compares vacuously equal, descends
 * and finds nothing, or grafts a property onto a frozen value. A `false`
 * result says the value has no keys to reach, which is the whole story for a
 * `FabricPrimitive` and any further subclass, and for a class extending the
 * runtime root `BaseFabricSpecialObject` directly.
 *
 * A `FabricInstance` returns `false` here as well, and that answer is
 * incomplete rather than wrong: an instance holds other `FabricValue`s, so a
 * path below one addresses something that exists and this reports it as
 * unreachable. Reach for this where that is the honest thing to report, and
 * record what it under-reports where the report lands -- a walk that decides
 * what a path finds, or what a change triggers, is reporting an absence rather
 * than handing back a wrong value. Reach for {@link isWalkableObjectOrArray}
 * instead where a `false` would make the walk hand back a wrong value rather
 * than report an absence; that one refuses an instance for exactly that
 * reason. The two differ on an instance and nowhere else.
 *
 * TODO(danfuzz): descend a `FabricInstance` by its codec contents, at which
 * point this returns `true` and a path below one stops reading as absent.
 *
 * `isFabricPlainContainer()` asks the container question of a value the type
 * system already says is a `FabricValue`; this takes `unknown`, which is what
 * a structural walk holds, and so still admits a `Date`, a `Map`, a `Cell` and
 * a query-result proxy over one.
 *
 * Like its `utils` counterparts, the name settles the array question, and the
 * sibling {@link isKeyableObjectNotArray} is the same test with arrays
 * removed. This is a structural predicate, so it narrows in one direction only
 * and is overloaded accordingly; see the header of `@commonfabric/utils/types`
 * for what that means. The narrowed type is read-only, these callers only
 * reading what they narrow.
 */
export function isKeyableObjectOrArray(value: ReadonlyRecord): boolean;
export function isKeyableObjectOrArray(
  value: unknown,
): value is ReadonlyRecord;
export function isKeyableObjectOrArray(value: unknown): boolean {
  return isObjectOrArray(value) &&
    !(value instanceof BaseFabricSpecialObject);
}

/**
 * Indicates whether a value's contents are reachable by property name and it
 * is not an array: {@link isKeyableObjectOrArray} with arrays removed, and
 * `isObjectNotArray()` with the fabric special objects removed.
 *
 * A walk asks this one where an array is not merely a different shape but
 * something it must not treat as a record -- a property merge, a
 * record-versus-array container reset.
 */
export function isKeyableObjectNotArray(value: ReadonlyRecord): boolean;
export function isKeyableObjectNotArray(
  value: unknown,
): value is ReadonlyRecord;
export function isKeyableObjectNotArray(value: unknown): boolean {
  return isKeyableObjectOrArray(value) && !Array.isArray(value);
}

/**
 * Indicates whether a value's contents are reachable by property name, with a
 * `FabricInstance` refused rather than reported as having none:
 * {@link isKeyableObjectOrArray} for every other value.
 *
 * This is the question a structural walk asks before it reads, rebuilds,
 * merges, or descends a value by its keys, and it differs from its sibling on
 * exactly the value where a `false` would be a claim rather than a report. An
 * instance is a container a walk is meant to descend, so a walk that takes
 * `false` for an answer carries it forward as an empty record and loses what
 * it holds. "Not yet" is not a boolean, and the refusal is what carries it.
 *
 * A walk that would merely fail to find something below an instance, and whose
 * own marker records that, wants {@link isKeyableObjectOrArray} instead. So
 * does a walk running where a throw cannot be delivered -- under a storage
 * subscription that has to keep delivering, say.
 *
 * The refusal is the one every other walk in the tree raises; "Flag-gated
 * tripwires" in `docs/development/EXPERIMENTAL_OPTIONS.md` governs them all.
 * Its strength here is de facto rather than by construction: no flag stands
 * between an instance and this predicate, and a `FabricError` is ungated and
 * exposed to pattern authors, so nothing but the absence of such a call keeps
 * it from firing.
 *
 * `docs/development/DEVELOPMENT.md` under "Walking or comparing a value" says
 * which of the four a walk reaches for, including where a caller with a better
 * answer than a throw tests for an instance ahead of this one.
 *
 * The walk-side half of admitting special objects is
 * {@link isKeyableObjectOrArray} and this disposition toward an instance; the
 * compare-side half is `fabricAwareEqual()`.
 *
 * @throws If given a `FabricInstance`.
 */
export function isWalkableObjectOrArray(value: ReadonlyRecord): boolean;
export function isWalkableObjectOrArray(
  value: unknown,
): value is ReadonlyRecord;
export function isWalkableObjectOrArray(value: unknown): boolean {
  // TODO(danfuzz): descend a `FabricInstance` by its codec contents, at which
  // point this becomes a walk rather than a refusal.
  if (value instanceof FabricInstance) {
    refuseFabricInstance(value, "in a structural walk");
  }

  return isKeyableObjectOrArray(value);
}

/**
 * Indicates whether a value's contents are reachable by property name and it
 * is not an array: {@link isWalkableObjectOrArray} with arrays removed.
 *
 * A walk asks this one where an array is not merely a different shape but
 * something it must not treat as a record. It refuses a `FabricInstance` for
 * the same reason its sibling does.
 *
 * @throws If given a `FabricInstance`.
 */
export function isWalkableObjectNotArray(value: ReadonlyRecord): boolean;
export function isWalkableObjectNotArray(
  value: unknown,
): value is ReadonlyRecord;
export function isWalkableObjectNotArray(value: unknown): boolean {
  return isWalkableObjectOrArray(value) && !Array.isArray(value);
}

/**
 * Narrows to `FabricSpecialObject` -- a `FabricPrimitive` or a
 * `FabricInstance` -- by one `instanceof` against the two classes' runtime
 * root, `BaseFabricSpecialObject`, which is not itself a type a caller names.
 *
 * The first signature takes a value already known to be one of the two, and
 * only reports; narrowing there would leave the `false` branch with nothing.
 *
 * **Type Validation Note:** A value this is handed is taken to honor the whole
 * `FabricValue` contract, which says more than its type does, and what this
 * returns for one that does not is best-effort. Asking `instanceof` is free,
 * and it is the only check made. Not checked, because nothing short of probing
 * an instance's private state tells them apart: a forged instance (an object
 * made over a fabric class's prototype without its constructor), and an
 * instance of a subclass that no codec knows.
 */
export function isFabricSpecialObject(
  value: FabricPrimitive | FabricInstance,
): boolean;
export function isFabricSpecialObject(
  value: unknown,
): value is FabricPrimitive | FabricInstance;
export function isFabricSpecialObject(value: unknown): boolean {
  return value instanceof BaseFabricSpecialObject;
}

/**
 * Narrows to the container arms of `FabricValue` -- a plain object, an array,
 * or a `FabricInstance` -- that is, the values that hold other `FabricValue`s.
 *
 * Contrast `isFabricObjectOrArray()`, which is one arm wider: it also accepts
 * a `FabricSpecialObject` that is not a `FabricInstance`, an object that is
 * not a container. The two are not interchangeable where the result decides a
 * descent.
 *
 * **Type Validation Note:** The argument is taken to honor the whole
 * `FabricValue` contract, which says more than its type does, and what this
 * returns for a value that does not is best-effort. The checks made are the
 * free ones: `Array.isArray()`, a record's prototype, and `instanceof`. The
 * rest are not made, because none is free. For a record: its property shapes
 * (accessors, symbol and non-enumerable keys), the reserved names `__proto__`
 * and `constructor`, and what its properties hold. For an array: its
 * prototype (an `Array` subclass passes), non-index properties,
 * accessor-backed indices, and what it holds. For a `FabricInstance`: nothing
 * past `instanceof`. An array's prototype read alone costs several times the
 * `Array.isArray()` it would join, and the rest take a probe per reserved name
 * or a walk over the keys.
 */
export function isFabricContainerValue(
  value: FabricValue,
): value is FabricContainerValue {
  return isFabricPlainContainer(value) || value instanceof FabricInstance;
}

/**
 * Narrows to the two *plain* container arms of `FabricValue` -- an array or a
 * plain object -- the values whose contents are reachable by index or property
 * name. This is the question to ask before addressing into a value by key. A
 * plain object here is what `isFabricPlainObject()` accepts, so a
 * null-prototype object is not one.
 *
 * Contrast `isFabricContainerValue()`, which is one arm wider: a
 * `FabricInstance` is a container, but it holds its contents privately, so a
 * key means nothing against one. Assigning through a value this rejects and
 * that one accepts puts an own property on an instance, which is a state no
 * `FabricInstance` has.
 *
 * **Type Validation Note:** The argument is taken to honor the whole
 * `FabricValue` contract, which says more than its type does, and what this
 * returns for a value that does not is best-effort. The checks made are the
 * free ones: `Array.isArray()` and a record's prototype. The rest are not made,
 * because none is free. For a record: its property shapes (accessors, symbol
 * and non-enumerable keys), the reserved names `__proto__` and `constructor`,
 * and what its properties hold. For an array: its prototype (an `Array`
 * subclass passes), non-index properties, accessor-backed indices, and what it
 * holds. An array's prototype read alone costs several times the
 * `Array.isArray()` it would join, and the rest take a probe per reserved name
 * or a walk over the keys.
 */
export function isFabricPlainContainer(
  value: FabricValue,
): value is FabricArray | FabricPlainObject {
  return Array.isArray(value) || isPlainObject(value, false);
}

/**
 * Narrows to the array arm of `FabricValue` (`FabricArray`).
 *
 * **Type Validation Note:** The argument is taken to honor the whole
 * `FabricValue` contract, which says more than its type does, and what this
 * returns for a value that does not is best-effort. `Array.isArray()` is the
 * only check made. Not made, because none is free: the array's prototype (an
 * `Array` subclass passes as readily as a direct instance), non-index
 * properties, accessor-backed indices, and what the array holds. The prototype
 * read alone costs several times the `Array.isArray()` it would join, and the
 * rest take a walk over the keys.
 */
export function isFabricArray(value: FabricValue): value is FabricArray {
  return Array.isArray(value);
}

/**
 * Indicates whether a `FabricValue` is a plain object, an array, or a
 * `FabricSpecialObject` -- everything a `typeof value === "object"` test
 * accepts, minus `null`. The name states the array case because "object" alone
 * reads as excluding it.
 *
 * The runtime behavior matches a bare `isObjectOrArray()` exactly. The
 * difference is static: `isObjectOrArray()` narrows to `Record<string,
 * unknown>`, which discards the fact that the value is a `FabricValue` -- so a
 * guarded value can no longer be handed to a `FabricValue` API. This keeps that
 * half.
 *
 * Contrast `isFabricPlainObject()`, which is strictly narrower at RUNTIME: it
 * accepts only plain objects, rejecting arrays and `FabricSpecialObject`s. The
 * two are not interchangeable. Between them sit
 * `isFabricContainerValue()`, which rejects every `FabricSpecialObject` that
 * is not a `FabricInstance`, and `isFabricPlainContainer()`, which rejects all
 * of them.
 *
 * **Type Validation Note:** The argument is taken to honor the whole
 * `FabricValue` contract, which says more than its type does, and what this
 * returns for a value that does not is best-effort. The `typeof` test is the
 * only check made, so an object of any shape passes, a class instance such as
 * a `Date` included. The narrower predicates named above are where the free
 * shape checks are made; the ones none of them makes are listed on each.
 */
export function isFabricObjectOrArray(
  value: FabricValue,
): value is FabricValue & object {
  return isObjectOrArray(value);
}

/**
 * Narrows to the plain-record arm of `FabricValue` (`FabricPlainObject`): an
 * object whose prototype is exactly `Object.prototype`. This rejects arrays,
 * `FabricSpecialObject`s, other class instances (`Date`, `Map`, …), and
 * null-prototype objects, none of which is a `FabricPlainObject`. Unlike a bare
 * `isObjectOrArray()` check, it preserves the value type —
 * `FabricPlainObject`'s string index of `FabricValue` keeps an indexed value
 * typed as a `FabricValue`.
 *
 * For the membership question asked of an `unknown`, see
 * `isValidFabricPlainObject()`.
 *
 * **Type Validation Note:** The argument is taken to honor the whole
 * `FabricValue` contract, which says more than its type does, and what this
 * returns for a value that does not is best-effort. The prototype is the only
 * check made, being free. Not made, because none is free: the record's
 * property shapes (accessors, symbol and non-enumerable keys), the reserved
 * names `__proto__` and `constructor`, and what its properties hold. Those take
 * a probe per reserved name or a walk over the keys.
 */
export function isFabricPlainObject(
  value: FabricValue,
): value is FabricPlainObject {
  return isPlainObject(value, false);
}
