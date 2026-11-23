/**
 * The freeze of what the value code of a module binds at module scope
 * (`language-subset.md` §3.3, "Emitted code"): the crate emits a call of
 * `$rt.data` around the initializer of each constant of frozen data and a
 * call of `$rt.fn` for each authored function, and the executor answers
 * the two with the functions of this module.
 *
 * The check of the crate refuses a write through a module-scope constant
 * in a source. The freeze makes the same write throw in a text the check
 * did not see.
 */
import { FrozenMap, FrozenSet } from "@commonfabric/data-model/frozen-builtins";

/**
 * Freezes a function and the object its `prototype` names, so that no
 * property of either holds state between two calls. Returns the function.
 */
export const hardenFunction = <T>(made: T): T => {
  if (typeof made !== "function") return made;
  const prototype = (made as { prototype?: unknown }).prototype;
  if (typeof prototype === "object" && prototype !== null) {
    Object.freeze(prototype);
  }
  return Object.freeze(made);
};

/**
 * Freezes module data deeply and returns it. An array and a plain record
 * are frozen in place with what they hold. A `Map` and a `Set` are
 * replaced by a `FrozenMap` and a `FrozenSet` of the frozen entries, whose
 * mutators throw, since freezing a `Map` leaves `set` working. A function
 * is hardened. Any other object, such as a `RegExp` or an instance of a
 * class of the runtime, is frozen itself and not entered.
 */
export const freezeModuleData = <T>(value: T): T =>
  frozen(value, new Map()) as T;

const frozen = (value: unknown, done: Map<object, unknown>): unknown => {
  if (typeof value === "function") return hardenFunction(value);
  if (typeof value !== "object" || value === null) return value;
  const known = done.get(value);
  if (known !== undefined) return known;
  if (value instanceof FrozenMap || value instanceof FrozenSet) return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Map.prototype) {
    const entries: [unknown, unknown][] = [];
    for (const [key, member] of value as Map<unknown, unknown>) {
      entries.push([frozen(key, done), frozen(member, done)]);
    }
    const made = new FrozenMap(entries);
    done.set(value, made);
    return made;
  }
  if (prototype === Set.prototype) {
    const members: unknown[] = [];
    for (const member of value as Set<unknown>) {
      members.push(frozen(member, done));
    }
    const made = new FrozenSet(members);
    done.set(value, made);
    return made;
  }
  done.set(value, value);
  if (
    Array.isArray(value) || prototype === Object.prototype ||
    prototype === null
  ) {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) continue;
      const member = frozen(descriptor.value, done);
      // A `Map` or a `Set` in a container that is frozen already stays.
      if (member !== descriptor.value && descriptor.writable) {
        (value as Record<PropertyKey, unknown>)[key] = member;
      }
    }
  }
  return Object.freeze(value);
};
