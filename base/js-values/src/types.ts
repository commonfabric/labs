/**
 * Type predicates over the general shape of a value.
 *
 * The predicates here come in two kinds, and the difference is visible at the
 * call site. One kind tests an exact `typeof` class -- `isString()`,
 * `isNumber()`, `isFunction()` -- and says everything there is to say about the
 * value, so its `false` branch is exactly as trustworthy as its `true` branch.
 *
 * The other kind is *structural*: `isObjectNotArray()`, `isPlainObject()` and
 * `isPlainContainer()` here, and `isInertArray()`,
 * `isArrayWithOnlyIndexProperties()`, and `isInertPlainObject()` in the sibling
 * `arrays` and `objects` modules. Each of
 * those checks strictly more than the type it narrows to can express, and
 * deliberately so: each narrows to the weakest type that stays true however the
 * value is treated afterwards, never to the property it actually checks. A
 * prototype can be reassigned and a property redefined, so "is `Object`-rooted"
 * or "is inert" describes an instant rather than a type, and a narrowed type
 * that claimed it would go on claiming it after it stopped being so.
 *
 * The narrowed types are read-only for the same reason. A frozen value is the
 * ordinary case here, and a predicate narrowing to a mutable `unknown[]` would
 * hand a caller holding `unknown` a writable view of one, there being no
 * `readonly` on the declared type for the result to inherit.
 * `isPlainContainer()` is the deliberate exception on both counts: it narrows
 * to mutable types, which claim more than it checks, because its callers are
 * the ones that go on to write through the result. The residual hazard is its
 * own: a caller passing `unknown` gets a writable view of what may be a frozen
 * container, with nothing at compile time to say so.
 *
 * A structural predicate is therefore *one-directional*: its `false` branch
 * means "not established", not "the negation holds". TypeScript cannot be told
 * this, because narrowing a `false` branch is subtraction and the language has
 * no negated types. Left to itself it would subtract the narrowed type from the
 * declared one, so a caller already holding a type at least as specific as what
 * the predicate narrows to would find the `false` branch reduced to `never` --
 * a value the check rejected, for a reason the type system never recorded.
 *
 * Each structural predicate heads this off with a pair of overloads. A caller
 * who already knows the broad shape gets a plain `boolean` and keeps both
 * branches; a caller holding `unknown` or `object`, who has no such type to
 * lose, gets the narrowing. Keeping the `false` branch usable is the whole of
 * what the first overload buys, and the only reason it is there. It is not what
 * protects a `readonly` declaration; the read-only narrow targets do that
 * unaided. A declared type that is already read-only is assignable to such a
 * target, so narrowing keeps it exactly as it was -- element and property types
 * included -- and it goes on rejecting writes. Against a *mutable* target it
 * would not be assignable, and TypeScript would intersect the two instead: the
 * resulting `readonly number[] & unknown[]` accepts writes, which is how a
 * mutable target launders `readonly` away.
 *
 * ## Every object-shape predicate answers the array question in its name
 *
 * `typeof [] === "object"`, so a predicate named only for "object" leaves a
 * reader guessing whether an array passes it, and a reader who guesses wrong
 * writes the wrong branch. Each name below settles the question in its own
 * final word. They are listed loosest test first, each accepting a subset of
 * what the one above it accepts:
 *
 * * `isObjectOrArray()` -- any non-`null` value whose `typeof` is `"object"`.
 *   Arrays, `Date`s, `Map`s, other class instances, and null-prototype objects
 *   all pass.
 * * `isObjectNotArray()` -- the same question with arrays removed. Class
 *   instances still pass.
 * * `isPlainObject()` -- rooted at `Object.prototype`, or at `null` unless the
 *   caller asks for the narrower question. Class instances do not pass.
 * * `isInertPlainObject()`, in the sibling `objects` module -- rooted at
 *   `Object.prototype` exactly, with every own property an enumerable
 *   string-keyed data property.
 *
 * Two more sit outside that chain. `isPlainContainer()` is `isPlainObject()`
 * widened to admit arrays again, for a caller whose next move is member access
 * by property name or by array index. `isInstance()` is the complement of the
 * plain objects among the non-array ones: a prototype that is neither
 * `Object.prototype` nor `null`.
 *
 * What a predicate narrows to is a separate matter from what its name says.
 * `isObjectOrArray()` narrows to `Record<string, unknown>`, and an array
 * satisfies that as far as reading a property by name goes. The name is what
 * tells a caller an array can be the thing it is now holding; the type does
 * not.
 *
 * `@commonfabric/data-model` asks the first of these questions of a value the
 * type system already says is a `FabricValue`, and spells it
 * `isFabricObjectOrArray()` for the same reason. It spells the third
 * `isFabricPlainObject()`, which narrows to `FabricPlainObject` and so keeps
 * an indexed value typed as a `FabricValue`.
 *
 * `typeOfIncludingNull()` is the one function here that is not a predicate.
 * It returns a value's `typeof` tag, with `null` given a tag of its own, for
 * a caller that dispatches on the tag rather than testing for one type.
 */

/**
 * The type of a class object, a/k/a constructor function: a class, abstract or
 * concrete, whose instances are `T`. The `prototype` property is part of the
 * shape so that a read of it is typed `T`; the `Function` interface alone
 * would type it `any`.
 */
export type Constructor<T = unknown> =
  & (abstract new (...args: any[]) => T)
  & { prototype: T };

/**
 * Whether `A` and `B` are the same type, by the identity the compiler applies
 * when it compares two generic signatures. This is the stricter of the two
 * type comparisons here. Where `Same` matches, this tells `any` in a type
 * argument from every other argument, a `readonly` property from a mutable
 * one, and a union from a type each of its members is assignable to. Reach for
 * it when how a type is written is the claim.
 */
export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;

/** Helper type to recursively add `readonly` properties to type `T`. */
export type Immutable<T> = T extends ReadonlyArray<infer U>
  ? ReadonlyArray<Immutable<U>>
  : T extends object ? ({ readonly [P in keyof T]: Immutable<T[P]> })
  : T;

/**
 * Whether `T` is a union of more than one member: `true` for such a union, and
 * `false` for a single type. Members are told apart by assignability, which
 * bounds that in three ways. A union whose members are all mutually assignable,
 * `Error | TypeError` among them, yields `false`. A union with a member that
 * every other member is assignable to, and not the other way round, yields
 * `boolean`: that member reports `false` and the rest `true`. And `never`, the
 * union of no members, yields `never`, which `MustBeTrue` accepts vacuously.
 * Compare the result with `Equal` where one of those can arise.
 */
export type IsUnion<T> = IsUnionOf<T, T>;

/**
 * Helper for `IsUnion`, which distributes over `Member` while holding the
 * union it came from intact in `Whole`.
 */
type IsUnionOf<Member, Whole> = Member extends unknown
  ? ([Whole] extends [Member] ? false : true)
  : never;

/**
 * The tag `typeOfIncludingNull()` returns: the result of `typeof`, plus
 * `null` for the value `null`, which `typeof` files under `object`.
 */
export type JsTypeTagIncludingNull =
  | "bigint"
  | "boolean"
  | "function"
  | "null"
  | "number"
  | "object"
  | "string"
  | "symbol"
  | "undefined";

/** Helper type to recursively remove `readonly` properties from type `T`. */
export type Mutable<T> = T extends ReadonlyArray<infer U> ? Mutable<U>[]
  : T extends object ? ({ -readonly [P in keyof T]: Mutable<T[P]> })
  : T;

/**
 * Compiles only when `T` is `true`: the assertion form of `Same` and `Equal`,
 * for a type alias that states a fact the compiler holds. `never` satisfies
 * the constraint, so a comparison that yields `never` rather than `false` on a
 * mismatch passes here vacuously; `Same` and `Equal` yield `false`.
 */
export type MustBeTrue<T extends true> = T;

/** The union of all primitive JavaScript types. */
export type Primitive =
  | bigint
  | boolean
  | null
  | number
  | string
  | symbol
  | undefined;

/**
 * A record whose string keys can be read but not assigned through this type.
 */
export type ReadonlyRecord = Readonly<Record<string, unknown>>;

/**
 * Whether `A` and `B` are mutually assignable. This is the looser of the two
 * type comparisons here: `any` in a type argument matches any argument,
 * `Map<any, any>` and `Map<string, number>` among them; a `readonly` property
 * matches a mutable one; and a union matches a type each of its members is
 * assignable to, so `Error | TypeError` matches `Error`. `Equal` tells each
 * of those apart.
 */
export type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false)
  : false;

// TODO(danfuzz): The wire formats accept a plain object with any keys, that
// being the rule a cross-language format has to hold to. This implementation
// refuses these names instead. Closing that gap means carrying such records
// rather than refusing them, and code that does will read this list too, to
// know which names need the care. `unsafeObjectKeyIn()` below states what
// makes each name awkward.
//
// `then` is deliberately absent, and belongs here less than it looks. A
// callable `then` is adopted by promise resolution, and a layer that answers a
// property with a function can make a data key callable -- which is why the
// value proxies in `runner` guard the name. But JSON Schema uses `if` / `then`
// / `else`, and this system's schemas are themselves `FabricValue`s, so
// reserving the name would stop an ordinary schema being one. The hazard is
// real and is handled where a property becomes callable, not here.
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor"]);

/**
 * Indicates whether a value is a non-`null` value whose `typeof` is `"object"`.
 * This is the loosest of the object-shape questions: an array passes, as does
 * any class instance and any null-prototype object.
 *
 * The narrowed type is mutable, and is a string-keyed record because reading a
 * property by name is what callers do with the result. An array reaching such a
 * caller is read the same way, its indices being property names like any other.
 *
 * @param value - The value to check
 * @returns True if the value is a non-`null` object, array included
 */
export function isObjectOrArray(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The `isObjectOrArray()` question asked on behalf of a caller that only reads:
 * the same test, narrowing to a read-only record so a frozen value keeps its
 * protection.
 * @param value - The value to check
 * @returns True if the value is a non-`null` object, array included
 */
export function isReadonlyObjectOrArray(
  value: unknown,
): value is ReadonlyRecord {
  return typeof value === "object" && value !== null;
}

/**
 * Predicate for narrowing a `function` type.
 * @param value - The value to check
 * @returns True if the value is a function
 */
export function isFunction(
  value: unknown,
): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

/**
 * Indicates whether the value is a non-`null`, non-plain, non-array `object`.
 * @param value - The value to check
 * @returns True if the value is an instance
 */
export function isInstance(value: unknown): boolean {
  if (!isObjectNotArray(value)) return false;

  const proto = Object.getPrototypeOf(value);

  return (proto !== null) && (proto !== Object.prototype);
}

/**
 * Indicates whether a value is a non-`null` value whose `typeof` is `"object"`
 * and which is not an array. Class instances pass; for the narrower question
 * that rejects those, see `isPlainObject()`.
 *
 * This is a structural predicate, so it narrows in one direction only, and is
 * overloaded accordingly; see the module header for what that means and why.
 * A `false` result means the value was not established to be a non-array
 * object, which is weaker than saying it is one of the things the check
 * rejects.
 *
 * @param value - The value to check
 * @returns True if the value is a non-`null` object other than an array
 */
export function isObjectNotArray(value: ReadonlyRecord): boolean;
export function isObjectNotArray(value: unknown): value is ReadonlyRecord;
export function isObjectNotArray(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Predicate for narrowing a `number` type.
 * @param value - The value to check
 * @returns True if the value is a number
 */
export function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

/**
 * Indicates whether a value is a finite number.
 * @param value - The value to check
 * @returns True if the value is a finite number
 */
export function isFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Indicates whether a value is a plain object: prototype `Object.prototype` or
 * `null`, with no constraint on its properties.
 *
 * This is the shape question -- "may I read this by property name?" -- and is
 * deliberately looser than what the data model admits as a record. For that,
 * see `isInertPlainObject()`, which requires a direct `Object` instance whose
 * every own property is an enumerable string-keyed data property. A
 * null-prototype object answers `true` here and `false` there, and both
 * answers are right for their own question.
 *
 * This is a structural predicate, so it narrows in one direction only, and is
 * overloaded accordingly; see the module header for what that means and why.
 * In particular, a `false` result says the value is not `Object`-rooted right
 * now, which is not the same as any statement about its type.
 *
 * @param value - The value to check
 * @param allowNullPrototype - Whether a null-prototype object counts. Default
 *   `true`, the looser shape question. Pass `false` to ask the narrower one --
 *   "is this rooted at `Object.prototype`?" -- which is what a caller wants
 *   when a null-prototype object is not merely a different shape but is
 *   something it must not treat as a record.
 * @returns True if the value is a plain object
 */
export function isPlainObject(
  value: ReadonlyRecord,
  allowNullPrototype?: boolean,
): boolean;
export function isPlainObject(
  value: unknown,
  allowNullPrototype?: boolean,
): value is ReadonlyRecord;
export function isPlainObject(
  value: unknown,
  allowNullPrototype = true,
): boolean {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype) return true;
  return allowNullPrototype && proto === null;
}

/**
 * Indicates whether a value is a plain container -- a plain object (per
 * `isPlainObject`) or an `Array`. Useful when the relevant question is
 * "can I do property-name / array-index member access on this?", since
 * plain objects and arrays are the two value shapes that support that
 * uniformly. Non-plain class instances (`Date`, `Map`, `Set`, `Error`,
 * user-defined classes, ...) deliberately do not qualify.
 *
 * This is a structural predicate, so it narrows in one direction only, and is
 * overloaded accordingly; see the module header. Unlike its neighbors it
 * narrows to a *mutable* pair of types, because its callers are the ones that
 * go on to write through the result.
 *
 * @param value - The value to check
 * @returns True if the value is a plain object or an array
 */
export function isPlainContainer(
  value: ReadonlyRecord | readonly unknown[],
): boolean;
export function isPlainContainer(
  value: unknown,
): value is Record<string, unknown> | unknown[];
export function isPlainContainer(value: unknown): boolean {
  return Array.isArray(value) || isPlainObject(value);
}

/**
 * Predicate for narrowing a `string` type.
 * @param value - The value to check
 * @returns True if the value is a string
 */
export function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Predicate for narrowing a `boolean` type.
 * @param value - The value to check
 * @returns True if the value is a boolean
 */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * Indicates whether a value is a `Primitive`: anything whose `typeof` is
 * neither `object` nor `function`, plus `null`, which `typeof` files under
 * `object`. This is an exact test, so its `false` branch holds every object,
 * array, and function and nothing else.
 */
export function isPrimitive(value: unknown): value is Primitive {
  const type = typeof value;
  return value === null || (type !== "object" && type !== "function");
}

/**
 * Returns the `typeof` tag of a value, with `null` given a tag of its own:
 * `null` for the value `null`, and otherwise exactly what `typeof` returns.
 * The result is a plain string, so testing it leaves `value` at its declared
 * type where a `typeof` test would narrow it; a `switch` whose arms use the
 * narrowed value is written on `typeof` itself.
 */
export function typeOfIncludingNull(value: unknown): JsTypeTagIncludingNull {
  return (value === null) ? "null" : typeof value;
}

/**
 * Indicates whether `key` is one this implementation refuses to copy onto an
 * object from untrusted input. Use at boundaries where external data enters
 * the system (deserialization, structural copying).
 *
 * The reservation belongs to this implementation and not to the data model:
 * see {@link unsafeObjectKeyIn} for which names are refused, why each one is,
 * and what would let it be accepted.
 */
export function isUnsafeObjectKey(key: string): boolean {
  return UNSAFE_OBJECT_KEYS.has(key);
}

/**
 * Returns the reserved own property name the given object carries, if any.
 *
 * This asks about this implementation, not about the data model. A property
 * name is data like any other, and an implementation on a host that does not
 * route property assignment through a prototype chain -- which is most of them
 * -- would reserve no names at all. Each name here is refused for its own
 * local reason, and neither is a limit of the language:
 *
 * * `__proto__` cannot be rebuilt by the copying this system actually does.
 *   Records are reconstructed by assignment (`target[key] = value`) and
 *   `Object.assign()`, and for this name both reach `Object.prototype`'s
 *   accessor instead of creating a property: the value is dropped, and the
 *   copy's prototype is repointed as well when that value is an object or
 *   `null`. Faithful mechanisms do exist -- spread, `Object.fromEntries()`,
 *   `Object.defineProperty()`, and `JSON.parse()` all carry the name -- so
 *   what stands in the way is the copy loops, not JavaScript.
 * * `constructor` copies faithfully. It is reserved because other boundaries
 *   in this implementation already refuse it: the projection to JS values
 *   drops it, and `FabricError` throws on it. Accepting it here would mean
 *   admitting a key that a later boundary discards without saying so.
 *
 * Refusing them is what this implementation does today. The format asks that
 * such records be carried instead, which is work this implementation has to
 * grow, and which will read this list too, to know which names need the care.
 * Until then, refusal is what keeps a record from being corrupted in transit
 * or quietly consumed after it.
 *
 * The check is one `Object.hasOwn()` call per reserved name rather than a walk
 * over the object's own keys, so it costs nothing per property and can sit on
 * a hot validation path.
 *
 * @param value The object to check.
 * @returns The offending property name, or `undefined` if there is none.
 */
export function unsafeObjectKeyIn(value: object): string | undefined {
  for (const key of UNSAFE_OBJECT_KEYS) {
    if (Object.hasOwn(value, key)) {
      return key;
    }
  }

  return undefined;
}
