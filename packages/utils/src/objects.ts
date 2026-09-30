/**
 * Pure utility functions for asking what an object is: the shape of its
 * property keys, and the class it is an instance of.
 */

import type { ReadonlyRecord } from "./types.ts";
import { isObjectOrArray } from "./types.ts";

/**
 * Indicates whether the given value is an *inert* plain object -- a direct
 * instance of `Object`, every own property an enumerable
 * string-keyed *data* property -- which is what "plain object" means in this
 * system. Symbol keys and non-enumerable string keys cause rejection,
 * whether or not they carry data, because neither has any representation as
 * a property *name*: neither survives serialization, nor a name-driven copy
 * such as `Object.entries()` round-tripping. An accessor-backed (getter
 * and/or setter) property also causes rejection, even when its key is an
 * enumerable string, because it makes the object non-inert: an accessor is
 * live code, a read of which executes it and can answer differently every
 * time -- and freezing the object does not change that.
 *
 * "Direct instance" means the prototype is `Object.prototype` exactly, so a
 * null-prototype object is rejected along with every class instance. A
 * prototype is not part of what an object says as data: it has no
 * representation in any encoding, so a record that crosses a storage boundary
 * comes back `Object.prototype`-rooted whatever it went in as. Accepting a
 * null-prototype object would therefore mean carrying a distinction that
 * exists only in memory and stops existing at the first boundary. A caller
 * holding one and meaning to shed it can say so with
 * `shallowCleanPlainObject()`, which rebuilds the record `Object`-rooted.
 *
 * Anything that isn't a plain object is rejected, class instances and arrays
 * included, which also makes this function total: it answers rather than
 * throwing no matter what it is handed. A `Proxy` is the one exception, and
 * unavoidably so, since it can throw from its own traps.
 *
 * Inertness is a property of the object at the moment of the check, not of its
 * type: a property can be redefined as an accessor, or a symbol-keyed one
 * added, at any later point. So this predicate narrows only to
 * `ReadonlyRecord` -- true of the value forever after -- and never to anything
 * asserting the inertness itself, and it narrows in one direction only. A
 * `false` result means inertness was not established, which is weaker than its
 * negation, and `false`-branch narrowing is subtraction, which cannot express
 * that. Hence the overload pair, which keeps a caller already holding a record
 * type out of the subtraction; the header of the `types` module gives the full
 * account.
 *
 * @param value The value to check.
 * @returns `true` if the value is a plain object all of whose own properties
 *   are enumerable string-keyed data properties, `false` otherwise.
 */
export function isInertPlainObject(value: ReadonlyRecord): boolean;
export function isInertPlainObject(value: unknown): value is ReadonlyRecord;
export function isInertPlainObject(
  value: unknown,
): boolean {
  if (!isObjectOrArray(value)) {
    return false;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }

  // Three key reads settle the two *key* requirements. `Object.keys()` is the
  // enumerable string keys; `Object.getOwnPropertyNames()` is those plus the
  // non-enumerable ones, so equal lengths mean every string key is enumerable;
  // and no symbol keys means `Object.getOwnPropertySymbols()` is empty. This
  // sits on the hot write path, and each of the three has an engine fast path
  // that `Reflect.ownKeys()` -- which would answer both questions at once --
  // does not: the three together cost a fraction of the one.
  const keys = Object.keys(value);

  if (Object.getOwnPropertyNames(value).length !== keys.length) {
    return false;
  }

  if (Object.getOwnPropertySymbols(value).length !== 0) {
    return false;
  }

  // The remaining requirement is data-ness, which only a descriptor answers: an
  // accessor carries `get` / `set` where a data property carries `value`. The
  // keys walked here are every own key, the two reads above having established
  // that there are no others.
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor)) {
      return false;
    }
  }

  return true;
}

/**
 * Returns the constructor named by the given prototype -- the class an object
 * having it is an instance of -- or `undefined` where there is none to read: a
 * `null` prototype names no constructor, and an exotic one may have a
 * `constructor` that is not callable.
 *
 * This is the form for a caller that has the prototype in hand and wants
 * something else from it too, which is why the prototype is the parameter
 * rather than a local.
 *
 * @param proto The prototype whose constructor is wanted.
 */
export function constructorOfPrototype(
  proto: object | null,
): { prototype: unknown } | undefined {
  const ctor = (proto === null) ? undefined : proto.constructor;

  return (typeof ctor === "function") ? ctor : undefined;
}

/**
 * Returns the constructor the given object is an instance of -- the class it
 * already has, rather than anything derived from it -- or `undefined` where
 * there is none to read.
 *
 * The constructor is read from the object's _prototype_, deliberately, and not
 * from the object. What is being asked is which class the object is an
 * instance of, and that is a fact about its prototype; an own `constructor`
 * property is ordinary data that happens to share the name, and must not be
 * able to answer for it. Reading it off the object would let
 * `{constructor: Error}` -- a plain record -- pass for an `Error`, which is
 * exactly what a caller dispatching on the answer must not allow.
 *
 * @param value The object whose constructor is wanted.
 */
export function constructorOfObject(
  value: object,
): { prototype: unknown } | undefined {
  return constructorOfPrototype(Object.getPrototypeOf(value));
}
