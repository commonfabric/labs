/**
 * Pattern-visible declarations for the fabric value type system, and for the
 * options of the debug renderers over it, in the form that `@commonfabric/api`
 * re-exports to patterns. Everything here is an interface, a type, or a
 * `declare`, except for the brand constants, so the module's only runtime
 * footprint is those constants.
 *
 * The canonical implementations live in this module's siblings --
 * `interface.ts`, `fabric-primitives/FabricHash.ts`,
 * `fabric-primitives/FabricEpochNsec.ts`, and the rest -- and these
 * declarations mirror their public surface. Each of those files asserts beside
 * its own definition that its implementation satisfies the declaration here,
 * so a declaration that no implementation meets stops the build. That check
 * runs one way only: a public member an implementation gains without a
 * declaration here is simply unreachable from a pattern, and no gate reports
 * it. `api-agreement.ts` asserts both directions for the three base classes,
 * whose protocol carries no symbol-keyed members to hold apart.
 *
 * Every concrete `FabricPrimitive` subclass needs an instanceof-capable
 * declaration here, that being an interface, a constructor interface, and a
 * `declare const` combining the two. The interface narrows `.schemaType` to
 * the one name its class reports, and the interface is a member of
 * `ConcreteFabricPrimitive`.
 *
 * This module has no imports, and can have none. `@commonfabric/api`
 * re-exports it to patterns, and the script that builds the type file the
 * sandbox is served inlines this text rather than following a specifier out of
 * it, so a specifier named here would reach a compiler that resolves none.
 *
 * Apart from the drift guards, which each compare an implementation against
 * the declaration here by name and so import it from here under an `Api`
 * alias, two modules import this one: `interface.ts`, which re-exports these
 * declarations to the rest of this package, and `@commonfabric/api`, which
 * re-exports them to patterns. Every other module in this package takes them
 * from `interface.ts`.
 */

//
// Brand symbols
//

/**
 * The nominal brand of `FabricInstancePlus`, and so of `FabricInstance`, whose
 * type in a declaration is the `PlusType` the instance may hold: an interned
 * symbol, so that every realm and every copy of this module agree on its
 * value, and so that the member it keys can never be mistaken for data -- a
 * symbol-keyed member has no place in a schema. A runtime instance never
 * carries the key.
 */
export const FABRIC_INSTANCE_PLUS_BRAND = Symbol.for(
  "@commonfabric/FabricInstancePlus",
);

/**
 * The nominal brand of `FabricPrimitive`: an interned symbol, so that every
 * realm and every copy of this module agree on its value, and so that the
 * member it keys can never be mistaken for data -- a symbol-keyed member has
 * no place in a schema. A runtime instance never carries the key.
 */
export const FABRIC_PRIMITIVE_BRAND = Symbol.for(
  "@commonfabric/FabricPrimitive",
);

//
// `FabricValue` and the types defined directly from it
//

/**
 * The full set of values that the fabric data layer can represent. This is the
 * strongly-typed "middle layer" of the three-layer architecture:
 *
 *     JavaScript "wild west" (`unknown`)
 *       <-> `FabricValue`
 *       <-> serialized (various forms)
 *
 * `FabricValue` is a union consisting of all JS primitive types, plus a handful
 * of object shapes; it does _not_ include the JS `function` type. Some parts of
 * the union impose contractual restrictions that are not enforceable via the
 * TypeScript type system, some (but not all) of which are enforced by runtime
 * validity checks. Notable details:
 *
 * * `number` -- All numbers are considered members of `FabricValue`, including
 *   `-0` and the non-finite numbers. Furthermore, from the perspective of the
 *   data model, `0` and `-0` are distinct, and `NaN` is equal to itself. (This
 *   policy informs how such values interact with sets and maps.)
 *
 * * `symbol` -- Only **registry-interned** symbols are considered valid
 *   `FabricValue`s, that is, only symbols for which `Symbol.keyFor()` returns
 *   a string.
 *
 * * Non-null `object`s in general -- Objects are only valid if:
 *   * They have no synthetic properties (getters, setters).
 *   * They have no own-symbol properties.
 *   * They do not have the "forbidden" own-string properties `constructor` or
 *     `__proto__`.
 *
 * * arrays, type `FabricArray` -- In addition to the restrictions above, arrays
 *   are only considered valid if they are direct instances of `Array`, and have
 *   the named property `length` along with only properties that are valid array
 *   indices whose numeric values are less than `length`. Arrays with holes
 *   _are_ valid.
 *
 * * plain objects, type `FabricPlainObject` -- In addition to the restrictions
 *   above, plain objects are only considered valid if they have the prototype
 *   `Object.prototype` and no non-enumerable own properties.
 *
 * * extensions to JS primitive types, type `FabricPrimitive` -- This is one of
 *   two non-builtin `object` types that can be considered valid. They are meant
 *   to be as equivalent as can be made to a built-in JS primitive type. All
 *   valid `FabricPrimitive` classes are defined directly by the data model.
 *   (That is, it is a closed set.)
 *
 * * extensions to JS container types, type `FabricInstance` -- This is the
 *   other non-builtin `object` type that can be considered valid. It represents
 *   a family of container types, to complement plain objects and arrays with
 *   other possible shapes. The type and associated classes are designed so that
 *   it will eventually be possible for code outside the data model to define
 *   new concrete `FabricInstance` classes, but as of this writing it is not a
 *   fully-implemented facility.
 *
 * From a typesystem perspective, all `FabricValue`s are immutable (deeply
 * read-only), _except_ members of the `FabricInstance` tree. `FabricInstance`s
 * expose arbitrary methods which can cause a change of instance state including
 * changing the set of outgoing references from the instance. This is an
 * _intentional_ hole, because TypeScript has no ergonomic/pithy way to express
 * the desired semantics. (To be clear, it _can_ be done, just not cleanly.)
 *
 * **Deep-frozen honesty (mandatory).** A `FabricValue` must report its frozen
 * state truthfully and permanently. In particular, a `FabricPlainObject` or
 * `FabricArray` is data-only: it must not expose an own accessor
 * (getter/setter) whose result can contradict, or change after, the value's
 * frozen state -- once a `FabricValue` graph is deeply frozen, its contents are
 * fixed. (For a `FabricInstance`, the analogous obligation is on its
 * `[IS_DEEP_FROZEN]` report; see `BaseFabricInstance`.) The rest of the system
 * -- the data model in general and `isDeepFrozen()` specifically, but also the
 * entire codebase that _uses_ the data model -- relies on this to cache
 * deep-frozen proofs by root identity without re-validating; a value that
 * violates it can corrupt data-model invariants, as any broken contract can.
 */
export type FabricValue = FabricValuePlus<never>;

/**
 * The container types that are part of `FabricValue`. Note that
 * `FabricSpecialObject` is a combination of a container type
 * (`FabricInstance`) and a non-container type (`FabricPrimitive`), and the
 * latter is _not_ part of this type.
 */
export type FabricContainerValue = FabricContainerValuePlus<never>;

/** Read-only array of `FabricValue`s. */
export type FabricArray = FabricArrayPlus<never>;

/**
 * Read-only object/record of `FabricValue`s.
 *
 * **Note:** The names `__proto__` and `constructor` are refused at the
 * boundaries where values enter or leave storage, so `FabricPlainObject` is
 * contractually forbidden from defining one, even though there is no way to say
 * that requirement in TypeScript.
 */
export type FabricPlainObject = FabricPlainObjectPlus<never>;

/**
 * The two kinds of `FabricValue` beyond the JavaScript built-ins, as one type.
 * The two differ along one axis: whether the data model treats an instance as
 * a primitive. A `FabricPrimitive` is treated the way a built-in `string` or
 * `number` is; a `FabricInstance` is treated the way an `object` is. What
 * follows from that, and what a caller sees of it, is that a `FabricInstance`
 * may hold and expose arbitrary outgoing `FabricValue` references, and a
 * `FabricPrimitive` may not. `isFabricSpecialObject()` narrows to this type
 * with one check.
 *
 * As part of the overall `FabricValue` contract, no instance of either class
 * exposes any enumerable own property; all interaction with an instance is via
 * its concrete class's instance members, and in particular an object-spread
 * (`{ ...instance }`) on an instance always yields an empty object (`{}`).
 */
export type FabricSpecialObject = FabricSpecialObjectPlus<never>;

/** A `FabricValue` other than `null` or `undefined`. */
export type NonNullableFabricValue = NonNullable<FabricValue>;

//
// `FabricValuePlus` type and most of its direct component types
//
// `FabricValue` is the baseline type used throughout the `data-model`, but in
// terms of implementation, it is defined in terms of `FabricValuePlus` and not
// the other way around. This section includes everything included in the type
// except the two `FabricSpecialObject` classes.
//

/**
 * Type which is equivalent to `FabricValue`, except that it is compatible with
 * one additional type, the `PlusType`: This type is a union of `FabricValue`,
 * `PlusType`, and the containers -- arrays, plain objects, and instances --
 * whose contents may recursively include this type.
 *
 * **Note:** `FabricValuePlus<never>` is the same type as `FabricValue` itself.
 */
export type FabricValuePlus<PlusType> =
  | bigint
  | boolean
  | null
  | number
  | string
  | symbol
  | undefined
  | FabricPrimitive
  | FabricContainerValuePlus<PlusType>
  | PlusType;

/**
 * The container types that are part of `FabricValuePlus`.
 */
export type FabricContainerValuePlus<PlusType> =
  | FabricArrayPlus<PlusType>
  | FabricInstancePlus<PlusType>
  | FabricPlainObjectPlus<PlusType>;

/** Read-only array of `FabricValuePlus`es. */
export type FabricArrayPlus<PlusType> = ReadonlyArray<
  FabricValuePlus<PlusType>
>;

/** Read-only object/record of `FabricValuePlus`es. */
export type FabricPlainObjectPlus<PlusType> = {
  readonly [key: string]: FabricValuePlus<PlusType>;
};

/**
 * A `FabricSpecialObject` whose instance variant includes a `PlusType`.
 */
export type FabricSpecialObjectPlus<PlusType> =
  | FabricPrimitive
  | FabricInstancePlus<PlusType>;

//
// `FabricSpecialObject`: the two special-object classes and their union
//

/**
 * The `FabricValue`s that participate in the fabric protocol as primitives. An
 * instance is always frozen, passes through the convertible-JS conversions
 * unchanged, and holds no arbitrary outgoing `FabricValue` reference.
 * `FabricSpecialObject` says how this differs from `FabricInstance`.
 */
export interface FabricPrimitive {
  /**
   * The nominal brand that tells a `FabricPrimitive` from a `FabricInstance`
   * and from every other object, in the type system. Without it this type is
   * structurally empty, and every object would satisfy it, and through it
   * `FabricValue`. It exists only in the type system: a runtime instance never
   * carries the key.
   */
  readonly [FABRIC_PRIMITIVE_BRAND]: true;

  /**
   * Name of this instance's class in the schema `type` vocabulary: the `type`
   * a schema names to admit this value by its class. Every instance of a class
   * reports the same name, which need not be the name of the class.
   */
  readonly schemaType: FabricPrimitiveSchemaType;
}

export interface FabricPrimitiveConstructor {
  prototype: FabricPrimitive;
}

export declare const FabricPrimitive:
  & FabricPrimitiveConstructor
  & (abstract new (...args: any) => FabricPrimitive);

/**
 * Like `FabricInstance`, except that the instance's state may refer to
 * `PlusType` values instead of _just_ `FabricValue`s.
 */
export interface FabricInstancePlus<PlusType> {
  /**
   * The nominal brand that tells an instance from any other object with the
   * two clone methods, in the type system, and whose type is the `PlusType`
   * the instance may hold. It exists only in the type system: a runtime
   * instance never carries the key.
   */
  readonly [FABRIC_INSTANCE_PLUS_BRAND]: PlusType;

  /**
   * Returns a new deep clone of this instance with equivalent data but no
   * shared structure for any unfrozen data in the original. When `frozen ===
   * true`, produces a frozen instance with maximal structural sharing,
   * including returning `this` if it is already deep-frozen. When `frozen ===
   * false`, produces a deeply-mutable instance with no visible shared
   * reference structure with the original.
   */
  deepClone(frozen: boolean): FabricInstancePlus<PlusType>;

  /** Returns a shallow clone of this instance with the requested frozenness. */
  shallowClone(frozen: boolean): FabricInstancePlus<PlusType>;
}

/**
 * The `FabricValue`s that participate in the fabric protocol as non-primitives.
 * An instance may hold and expose arbitrary outgoing `FabricValue` references,
 * and is mutable until frozen. `FabricSpecialObject` says how this differs
 * from `FabricPrimitive`.
 */
export type FabricInstance = FabricInstancePlus<never>;

export interface FabricInstanceConstructor {
  prototype: FabricInstance;
}

export declare const FabricInstance:
  & FabricInstanceConstructor
  & (abstract new (...args: any) => FabricInstance);

//
// Concrete `FabricPrimitive` classes
//

/**
 * An immutable, frozen sequence of bytes. Read the bytes with `slice()`,
 * `sliceBuffer()`, or `copyInto()`.
 */
export interface FabricBytes extends FabricPrimitive {
  /** @inheritDoc */
  readonly schemaType: "FabricBytes";

  readonly length: number;
  slice(start?: number, end?: number): Uint8Array<ArrayBuffer>;
  sliceBuffer(start?: number, end?: number): ArrayBuffer;
  copyInto(target: Uint8Array, offset?: number, length?: number): number;
}

export interface FabricBytesConstructor {
  new (bytes: Uint8Array | ArrayBufferLike, transfer?: boolean): FabricBytes;
  prototype: FabricBytes;
}

export declare const FabricBytes: FabricBytesConstructor;

/**
 * Temporal type representing a particular day, as a count of days from the
 * POSIX Epoch. Wraps a `bigint` value.
 */
export interface FabricEpochDay extends FabricPrimitive {
  /** @inheritDoc */
  readonly schemaType: "FabricEpochDay";

  readonly value: bigint;
}

export interface FabricEpochDayConstructor {
  new (value: bigint): FabricEpochDay;
  prototype: FabricEpochDay;
}

export declare const FabricEpochDay: FabricEpochDayConstructor;

/**
 * Temporal type representing nanoseconds from the POSIX Epoch.
 * Wraps a `bigint` value.
 */
export interface FabricEpochNsec extends FabricPrimitive {
  /** @inheritDoc */
  readonly schemaType: "FabricEpochNsec";

  readonly value: bigint;
}

export interface FabricEpochNsecConstructor {
  new (value: bigint): FabricEpochNsec;
  prototype: FabricEpochNsec;
}

export declare const FabricEpochNsec: FabricEpochNsecConstructor;

/**
 * A content-addressed identifier: a hash digest paired with an algorithm tag.
 */
export interface FabricHash extends FabricPrimitive {
  /** @inheritDoc */
  readonly schemaType: "FabricHash";

  readonly tag: string;
  readonly bytes: Uint8Array;
  readonly length: number;
  readonly hashString: string;
  toString(): string;
}

export interface FabricHashConstructor {
  new (
    hash: Uint8Array | ArrayBufferLike,
    tag: string,
    transfer?: boolean,
  ): FabricHash;
  prototype: FabricHash;
}

export declare const FabricHash: FabricHashConstructor;

/**
 * An immutable asymmetric key pair.
 *
 * An instance either holds handles -- two `CryptoKey`s, whose material this
 * realm may have no way to reach -- or holds material, the two keys as bytes.
 * `hasMaterial` says which, and every accessor belonging to the other arm
 * throws.
 */
export interface FabricKeyPair extends FabricPrimitive {
  /** @inheritDoc */
  readonly schemaType: "FabricKeyPair";

  readonly algorithm: string;
  readonly hasMaterial: boolean;

  /**
   * A `CryptoKeyPair` holding this instance's two keys. The record is a new
   * object on each call, so a caller may do as it likes with it; the two
   * `CryptoKey`s within it are this instance's own, and are the same two
   * objects on every call. Throws when this instance holds material.
   */
  readonly cryptoKeyPair: CryptoKeyPair;

  /** The public key's handle. Throws when this instance holds material. */
  readonly publicCryptoKey: CryptoKey;

  /** The private key's handle. Throws when this instance holds material. */
  readonly privateCryptoKey: CryptoKey;

  /** The public key's bytes. Throws when this instance holds handles. */
  readonly publicKeyBytes: FabricBytes;

  /** The private key's bytes. Throws when this instance holds handles. */
  readonly privateKeyBytes: FabricBytes;
}

export interface FabricKeyPairConstructor {
  new (pair: CryptoKeyPair): FabricKeyPair;
  new (
    algorithm: string,
    publicKey: FabricBytes | Uint8Array,
    privateKey: FabricBytes | Uint8Array,
  ): FabricKeyPair;
  prototype: FabricKeyPair;
}

export declare const FabricKeyPair: FabricKeyPairConstructor;

/**
 * An immutable regular expression.
 *
 * The pattern is held as a flavor / source / flags triple rather than as a
 * JS `RegExp`, so that flavors with no JS representation can still be
 * carried. `value` reconstitutes a JS `RegExp` where one exists.
 */
export interface FabricRegExp extends FabricPrimitive {
  /** @inheritDoc */
  readonly schemaType: "FabricRegExp";

  readonly source: string;
  readonly flags: string;
  readonly flavor: string;

  /**
   * A fresh JS `RegExp` equivalent to this value, returned anew on each
   * call so the internal instance is never aliased out. Throws for a flavor
   * with no JS `RegExp` representation.
   */
  readonly value: RegExp;
}

export interface FabricRegExpConstructor {
  new (regex: RegExp): FabricRegExp;
  new (flavor: string, source: string, flags: string): FabricRegExp;
  prototype: FabricRegExp;
}

export declare const FabricRegExp: FabricRegExpConstructor;

/**
 * Why a `FabricUnavailable` stands where data would otherwise be. The two
 * transient reasons say the data is on its way; `error` says producing it
 * failed, and is the one reason that carries a kind and a message.
 */
export type UnavailableReason = "pending" | "syncing" | "error";

/**
 * The kinds of failure a `FabricUnavailable` with reason `error` sorts into.
 * `general` is the kind for a failure none of the others describes.
 */
export type UnavailableErrorKind =
  | "general"
  | "schemaMismatch"
  | "invalidInput"
  | "network"
  | "decode"
  | "compile"
  | "provider"
  | "sync";

/**
 * A marker standing in for data that is not available, saying why. It holds
 * no data of its own: the reason, and for the `error` reason the kind of
 * error and a message, are the whole of what it says. Only the `error` reason
 * carries a kind, and it always does; only the `error` reason may carry a
 * message, and `errorMessage` supplies one for its kind when none was given.
 * For the other two reasons every error member is `null`.
 */
export interface FabricUnavailable extends FabricPrimitive {
  /** @inheritDoc */
  readonly schemaType: "FabricUnavailable";

  /** Why the data is unavailable. */
  readonly reason: UnavailableReason;

  /** The kind of error, when the reason is `error`; `null` otherwise. */
  readonly errorKind: UnavailableErrorKind | null;

  /**
   * The message, when the reason is `error`: the one given at construction,
   * or the kind's default when none was. `null` for a transient reason.
   */
  readonly errorMessage: string | null;

  /**
   * The message as given at construction, with no default supplied: `null`
   * for a transient reason, and for an `error` whose message is its kind's
   * default or was never given.
   */
  readonly rawErrorMessage: string | null;

  /** Whether the reason is `pending`. */
  isPending(): boolean;

  /** Whether the reason is `syncing`. */
  isSyncing(): boolean;

  /**
   * Whether the reason is `error`, narrowing `errorKind` and `errorMessage`
   * to the non-`null` values the `error` reason always carries.
   */
  isError(): this is {
    readonly errorKind: UnavailableErrorKind;
    readonly errorMessage: string;
  };

  /**
   * Whether the data is on its way rather than failed: `true` for the
   * `pending` and `syncing` reasons, `false` for `error` whatever its kind.
   */
  isTransient(): boolean;
}

export interface FabricUnavailableConstructor {
  new (
    reason: UnavailableReason,
    errorKind?: UnavailableErrorKind | null,
    errorMessage?: string | null,
  ): FabricUnavailable;
  prototype: FabricUnavailable;
}

export declare const FabricUnavailable: FabricUnavailableConstructor;

//
// The `FabricPrimitive` schema `type` vocabulary
//

/**
 * Union of the concrete `FabricPrimitive` classes this module declares. Every
 * type that ranges over those classes is derived from this one.
 */
export type ConcreteFabricPrimitive =
  | FabricBytes
  | FabricEpochDay
  | FabricEpochNsec
  | FabricHash
  | FabricKeyPair
  | FabricRegExp
  | FabricUnavailable;

/**
 * One of the `FabricPrimitive` validation types -- a non-standard addition to
 * the JSON Schema `type` vocabulary. Each name identifies a concrete
 * `FabricPrimitive` class, being the name its instances report as
 * `.schemaType`, and a value matches by prototype (`instanceof`), not by
 * structure. `"object"` also accepts these values -- every `FabricPrimitive`
 * is a subtype of `"object"` the way an `"integer"` value satisfies a
 * `"number"` schema -- so schemas that do not use this vocabulary admit them
 * all the same.
 */
export type FabricPrimitiveSchemaType = ConcreteFabricPrimitive["schemaType"];

/** Every `FabricPrimitiveSchemaType`, one entry per concrete class. */
export declare const FABRIC_PRIMITIVE_SCHEMA_TYPES:
  readonly FabricPrimitiveSchemaType[];

/** Whether the given schema type names a `FabricPrimitive` class. */
export declare function isFabricPrimitiveSchemaType(
  type: string,
): type is FabricPrimitiveSchemaType;

//
// Concrete `FabricInstance` classes
//

/**
 * Structured state for constructing a `FabricError`. The fixed-schema slots
 * are `FabricValue`-typed; `extras` carries any custom enumerable properties,
 * whose keys must not collide with the slot names.
 */
export type FabricErrorState = {
  /** Constructor name of the originating JS `Error` (e.g. `"TypeError"`). */
  readonly type: string;

  /** The `.name` property. Omit to mean "same as `type`". */
  readonly name?: string | null | undefined;

  /** The `.message` property. */
  readonly message: string;

  /** The `.stack` property, or `undefined`. */
  readonly stack: string | undefined;

  /** The `.cause` value, in `FabricValue` form, or `undefined`. */
  readonly cause: FabricValue | undefined;

  /** Custom enumerable own properties, in `FabricValue` form. */
  readonly extras?:
    | Iterable<readonly [string, FabricValue]>
    | Readonly<Record<string, FabricValue>>
    | undefined;
};

/**
 * An error carried as a `FabricValue`.
 *
 * Like every `FabricInstance` it is mutable until frozen, and every mutator --
 * the slot setters along with `setExtra()` and `deleteExtra()` -- throws once
 * the instance is frozen.
 */
export interface FabricError extends FabricInstance {
  type: string;
  name: string;
  message: string;
  stack: string | undefined;
  cause: FabricValue | undefined;

  getExtra(key: string): FabricValue | undefined;
  hasExtra(key: string): boolean;
  setExtra(key: string, value: FabricValue): void;
  deleteExtra(key: string): boolean;
  readonly extraSize: number;
  extraKeys(): IterableIterator<string>;
  extraEntries(): IterableIterator<[string, FabricValue]>;
}

/** Options accepted by `FabricError.fromNativeError()`. */
export interface FromNativeErrorOptions {
  /**
   * Converter applied to the error's `cause` and to each of its custom
   * enumerable properties, whose result is what the instance holds. When
   * absent, a value that is already a valid `FabricValue` is held as it stands,
   * and anything else is converted the way `fabricFromConvertibleJsValue()`
   * converts it, without freezing.
   */
  readonly convert?: (value: unknown) => FabricValue;
}

export interface FabricErrorConstructor {
  new (state: FabricErrorState): FabricError;
  fromNativeError(
    error: Error,
    options?: FromNativeErrorOptions,
  ): FabricError;
  prototype: FabricError;
}

export declare const FabricError: FabricErrorConstructor;

/**
 * The modern, object-shaped form of a link reference, wrapping the link's
 * addressing payload (a `FabricPlainObject`: its addressing fields plus an
 * optional `schema`). Extends `FabricInstance` because the payload is an
 * outgoing reference (it may carry an arbitrary-`FabricValue` `schema`), so a
 * link is a small object graph, not a leaf.
 */
export interface FabricLink extends FabricInstance {
  readonly payload: FabricPlainObject;
}

export interface FabricLinkConstructor {
  new (payload: FabricPlainObject): FabricLink;
  prototype: FabricLink;
}

export declare const FabricLink: FabricLinkConstructor;

// TODO(danfuzz): `FabricMap` and `FabricSet` are deliberately absent from the
// declarations above. Both need substantial rework before they are useful, and
// declaring them here would imply a utility they do not yet have. Their
// absence is a decision, not an oversight; revisit once that rework lands.

//
// Debug-rendering option types
//

/**
 * Options accepted by `toStructuredDebugValue()`, and by the debug-string
 * renderers built on it.
 */
export interface DebugValueOptions {
  /**
   * Maximum depth of result nesting: a positive integer, or `Infinity` for as
   * deep as the conversion allows. An item which would require further
   * nesting is instead converted into a form suggestive of the elided
   * information. The contents of a `FabricPrimitive` are nested to this depth
   * in their own right, whatever the depth of the `FabricPrimitive` itself.
   * When absent, the depth is ten levels. A large value is capped; there is no
   * guarantee about the _actual_ possible maximum depth.
   */
  readonly maxDepth?: number;

  /**
   * Maximum number of elements of an array which are represented: a positive
   * integer, or `Infinity` for as many as the conversion allows. An array
   * with more elements than this has only the elements at indices below the
   * limit converted, and in place of the rest a form suggestive of the
   * elision, which includes the array's actual length. This applies to an
   * array within the contents of a `FabricPrimitive` too. When absent, the
   * limit is one hundred. A large value is capped.
   */
  readonly maxArrayLength?: number;

  /**
   * Maximum number of bytes of a buffer which are rendered: a positive
   * integer, or `Infinity` for as many as the rendering allows. A buffer is
   * what holds the bytes of a `FabricPrimitive`, such as those of a
   * `FabricBytes`. One with more bytes than this has only that many rendered,
   * and after them a note of the elision, which includes the buffer's actual
   * length. When absent, the limit is two hundred. A large value is capped.
   */
  readonly maxBufferLength?: number;

  /**
   * Maximum number of properties of an object which are represented: a
   * positive integer, or `Infinity` for as many as the conversion allows. An
   * object with more properties than this has only the first that many, in
   * key order, converted, and after them a form suggestive of the elision,
   * which includes the object's actual property count. This applies wherever
   * properties are laid out: a plain object, a class instance's own
   * properties, and the contents of a `FabricSpecialObject`. When absent,
   * the limit is one hundred. A large value is capped.
   */
  readonly maxProperties?: number;

  /**
   * Maximum length of a string which is represented whole: a positive
   * integer, or `Infinity` for as long as the conversion allows. A longer
   * string is converted to a form suggestive of the elision, which carries an
   * excerpt of the string up to the limit and the string's actual length.
   * When absent, the limit is two hundred, or as long as the conversion
   * allows when `maxStringLines` is present. A large value is capped.
   */
  readonly maxStringLength?: number;

  /**
   * Maximum number of lines of a string which is represented whole: a
   * positive integer, or `Infinity` for as many as the conversion allows. A
   * line break is a newline, a carriage return, or the two together; one at
   * the end of the string ends its last line rather than starting another. A
   * string with more lines is converted to the same form a string past
   * `maxStringLength` is, carrying an excerpt of the string up to the limit,
   * line breaks included, and the string's actual length; when both limits
   * apply, the excerpt is the shorter of the two. When absent, the limit is
   * five. A large value is capped.
   */
  readonly maxStringLines?: number;

  /**
   * Replacer function, called on every value and sub-value encountered, to get
   * a replacement value to use. A replacer which does not want to replace a
   * value returns the value it receives, and one which throws is taken to have
   * declined to replace.
   */
  readonly replacer?: (value: any) => any;
}

/** Options accepted by `toCompactDebugString()`. */
export interface CompactDebugStringOptions extends DebugValueOptions {
  /**
   * Maximum length of the result, or `Infinity` for no limit. When the
   * rendering runs longer, the result is truncated to this length, which
   * includes a trailing ASCII ellipsis of `...`. A length below three is taken
   * as three.
   */
  readonly maxLength?: number;

  /**
   * Whether to quote the result as a Markdown code span, the way
   * `backtickQuote()` does, for splicing into message text. `maxLength`
   * bounds the rendering, not the quoted result. When absent, the result is
   * not quoted.
   */
  readonly backtickQuote?: boolean;
}
