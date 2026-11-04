/**
 * Pure utility functions for checking array-index property names and
 * array index-only-ness.
 */

/** Character code for digit `0`. */
const CHAR_CODE_0 = "0".charCodeAt(0);

/**
 * Indicates whether the given string to be used as a property name (for an
 * object or array) is syntactically valid as an array index per se.
 *
 * @param name - The property name to check
 * @returns `true` if `name` when used on an array would access an indexed
 *   element of that array.
 */
export function isArrayIndexPropertyName(name: string): boolean {
  switch (name[0]) {
    case undefined: {
      // Empty string.
      return false;
    }
    case "0": {
      // Only valid if the string is `0` per se.
      return (name === "0");
    }
    case "1":
    case "2":
    case "3":
    case "4":
    case "5":
    case "6":
    case "7":
    case "8":
    case "9": {
      // `break` for more detailed check below.
      break;
    }
    default: {
      return false;
    }
  }

  const length = name.length;

  if (length > 10) {
    // Don't bother with anything more if the name is too long to possibly be a
    // valid index.
    return false;
  }

  // Check that all characters are (normal) digits, and parse it for a final
  // range check. (NB: Benchmarking shows that doing it this way is
  // significantly faster than using a regex test and a final `parseInt()` for
  // the range check.
  let num = 0;
  for (let i = 0; i < length; i++) {
    const digit = name.charCodeAt(i) - CHAR_CODE_0;
    if ((digit < 0) || (digit > 9)) {
      return false;
    }
    num = (num * 10) + digit;
  }

  // Only accept in-range values: 0 to 0xFFFFFFFE (2^32 - 2) per the
  // ECMAScript spec. The value 0xFFFFFFFF (2^32 - 1) is reserved as
  // `array.length` for a max-length array and is not a valid index.
  return (num <= 0xFFFFFFFE);
}

/**
 * Indicates whether every one of the given array's own properties is an array
 * index, `length` aside. Named (string-keyed) properties and symbol-keyed
 * properties alike cause rejection, whether or not they are enumerable, because
 * none of them have any representation as array content. Returns `true` for
 * sparse arrays, whose holes are simply absent properties.
 *
 * Anything that isn't actually an array is rejected, including an array-_like_
 * object and one whose prototype is `Array.prototype`. Such a value can
 * perfectly well name `length` as its final own property, so the key-order
 * reasoning below says nothing about it. Ordinary values are all answered
 * rather than thrown on, `null`, `undefined`, and primitives included.
 *
 * A `Proxy` is the exception, and unavoidably so: it can throw from its own
 * traps, and such an error propagates rather than being reported as `false`.
 * A revoked proxy makes `Array.isArray()` itself throw, and a live one can
 * throw from `ownKeys()`. Reporting `false` there would mean reading "this is
 * not an index-only array" into what is actually a failure to find out.
 *
 * **Note:** This function relies on the given array producing
 * `Reflect.ownKeys()` output which agrees with the JavaScript spec with
 * regards to key ordering, namely index keys in ascending numeric order, then
 * the remaining string keys in property-creation order, then symbol keys in
 * property-creation order.
 * Built-in arrays of course do this, but it's possible for a `Proxy` to (a)
 * effectively purport to be an array, and yet (b) have an `ownKeys()` trap that
 * diverges from the behavior of built-in arrays. In such cases, this function
 * can return an incorrect answer, exactly because it depends on the
 * spec-defined ordering. The rationale for this implementation is that it's
 * reasonable to expect proxied arrays to implement `ownKeys()` in agreement
 * with the standard array order (even though the spec _does_ allow leeway with
 * regards to what `Proxy`s actually do), _and_ by making this assumption, this
 * function avoids having to inspect _every_ key.
 *
 * This is a structural predicate, so it narrows in one direction only, and is
 * overloaded accordingly; the header of the `types` module gives the full
 * account. The short of it: a `false` result reports that index-only-ness could
 * not be established, which is weaker than the negation, and TypeScript's
 * `false`-branch narrowing is subtraction and so cannot express the difference.
 * The first overload keeps callers who already hold an array type out of that
 * subtraction entirely.
 *
 * @param array The value to check.
 * @returns `true` if the array has only index properties, `false` otherwise.
 */
export function isArrayWithOnlyIndexProperties(
  array: readonly unknown[],
): boolean;
export function isArrayWithOnlyIndexProperties(
  array: unknown,
): array is readonly unknown[];
export function isArrayWithOnlyIndexProperties(array: unknown): boolean {
  // `Array.isArray()` sees through a `Proxy` to its target, so a proxied array
  // is still recognized as one here.
  if (!Array.isArray(array)) {
    return false;
  }

  // Given the key ordering described above, `length` -- which is created along
  // with the array itself, and so precedes every later-created string key --
  // is the last own key exactly when there is no other non-index key at all:
  // a named property would sort after it, and a symbol key after that.
  return Reflect.ownKeys(array).at(-1) === "length";
}

/**
 * Indicates whether the given array is an _inert_ array: a direct instance of
 * `Array`, every own property of which is an array index holding a _data_
 * property, `length` aside -- which is what a well-formed array means in this
 * system. Beyond the index-only requirement of
 * {@link isArrayWithOnlyIndexProperties} (which this check subsumes; there is
 * no need to call both), an accessor-backed (getter and/or setter) index
 * causes rejection, because it makes the array non-inert: an accessor is live
 * code, a read of which executes it and can answer differently every time --
 * and freezing the array does not change that. Index _enumerability_ is not
 * required, only data-ness: array contents are reached by index, not by
 * enumeration-driven copying, so an index's enumerability has no bearing on
 * the array's inertness.
 *
 * "Direct instance" means the prototype is `Array.prototype` exactly. An
 * `Array` subclass instance is rejected, because its prototype is live code
 * just as much as an accessor is: an overridden `Symbol.iterator` (or `at()`,
 * or `values()`) makes iteration answer differently than the indices say, and
 * again freezing changes nothing. An array whose prototype has been severed
 * (`null`) is rejected too, as is an array from another realm, whose prototype
 * is a different `Array.prototype` carrying whatever that realm did to it.
 * None of those prototypes are part of what an array says as data, so
 * accepting one would mean carrying an alien prototype along in defiance of
 * the type, or silently dropping it.
 *
 * The array-recognition, `Proxy`, and key-ordering caveats described on
 * {@link isArrayWithOnlyIndexProperties} apply here as well. A `Proxy` over a
 * direct `Array` passes: absent a `getPrototypeOf()` trap, the prototype
 * question forwards to the target, and a trap that answers otherwise is the
 * proxy's own bug to own.
 *
 * Inertness is a property of the array at the moment of the check, not of its
 * type: an index can be redefined as an accessor, or a named property added, at
 * any later point. So this predicate narrows only to `readonly unknown[]` --
 * true of the value forever after -- and never to anything asserting the
 * inertness itself, and it narrows in one direction only. A `false` result
 * means inertness was not established, which is weaker than its negation, and
 * `false`-branch narrowing is subtraction, which cannot express that. Hence the
 * overload pair, which keeps a caller already holding an array type out of the
 * subtraction; the header of the `types` module gives the full account.
 *
 * @param array The value to check.
 * @returns `true` if the array is an inert array, `false` otherwise.
 */
export function isInertArray(array: readonly unknown[]): boolean;
export function isInertArray(array: unknown): array is readonly unknown[];
export function isInertArray(array: unknown): boolean {
  // `Array.isArray()` sees through a `Proxy` to its target, so a proxied array
  // is still recognized as one here, and -- absent a `getPrototypeOf()` trap --
  // answers its target's prototype as well. `Array.isArray()` is deliberately
  // realm-agnostic, so the prototype comparison is what makes this the local
  // `Array` and not merely something array-shaped.
  if (
    !Array.isArray(array) ||
    (Object.getPrototypeOf(array) !== Array.prototype)
  ) {
    return false;
  }

  // Given the spec-defined key ordering, `length` -- which is created along
  // with the array itself, and so precedes every later-created string key --
  // is the last own key exactly when there is no other non-index key at all:
  // a named property would sort after it, and a symbol key after that.
  const keys = Reflect.ownKeys(array);
  if (keys.at(-1) !== "length") {
    return false;
  }

  // Every index (each key before `length`, given the check above) must also
  // hold a data property; an accessor carries `get` / `set` in its descriptor
  // and has no `value`. (`length` itself is always a data property.) The
  // non-null assertion trusts the object to return a descriptor for a key it
  // itself reported; a proxy that disavows one is buggy (this is a
  // best-effort system with regards to proxies), and the resulting
  // `TypeError` is its to own.
  for (let i = 0; i < keys.length - 1; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(array, keys[i]!)!;
    if (!("value" in descriptor)) {
      return false;
    }
  }

  return true;
}
