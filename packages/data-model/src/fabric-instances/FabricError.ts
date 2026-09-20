/**
 * `Error` as a `FabricValue`: the wrapper class, and the shape it is built
 * from.
 *
 * A JS error is the wild west -- any property, any prototype -- while the
 * fabric layer needs a value whose observable state is entirely typed. The
 * useful parts therefore become fixed slots and everything else goes to an
 * extras bag reached by map-like methods, with the slot names reserved so that
 * an extra cannot shadow one. The convertible JS form is not retained at all;
 * it is rebuilt on demand.
 *
 * Mutability follows the usual instance rule: writable until the instance is
 * frozen, and every mutator refuses from then on.
 */

import type {
  FabricError as ApiFabricError,
  FabricErrorConstructor as ApiFabricErrorConstructor,
} from "@/api.ts";
import { constructorOfObject } from "@commonfabric/utils/objects";
import { isPlainObject, isUnsafeObjectKey } from "@commonfabric/utils/types";

import { FabricNativeWrapper } from "./FabricNativeWrapper.ts";
import {
  DEEP_CLONE_CORE,
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
  SHALLOW_UNFROZEN_CLONE,
} from "@/fabric-bases";
import { BaseNonterminalCodec } from "@/codec-interface/BaseNonterminalCodec.ts";
import { CODEC_TYPE_TAGS } from "@/codec-interface/codec-type-tags.ts";
import { NullLiveEnvironment } from "@/codec-interface/NullLiveEnvironment.ts";
import {
  CODEC,
  type LiveEnvironment,
  type NonterminalCodec,
} from "@/codec-interface/interface.ts";
import { deepFreeze } from "@/deep-freeze.ts";
import { FrozenSet } from "@/frozen-builtins.ts";
import type {
  FabricPlainObject,
  FabricValue,
  FromNativeErrorOptions,
} from "@/interface.ts";
import {
  errorClassFromType,
  fabricFromConvertibleJsValue,
} from "@/convertible-js.ts";
import { isValidFabricValue } from "@/types";

/**
 * Helper for `FabricError.fromNativeError()`, which converts a nested value
 * the way its default does: a valid `FabricValue` is held as it stands, and
 * anything else goes through `fabricFromConvertibleJsValue()` without freezing.
 */
function convertNestedNativeValue(value: unknown): FabricValue {
  return isValidFabricValue(value)
    ? value
    : fabricFromConvertibleJsValue(value, false);
}

/**
 * Reserved key set for `FabricError`'s extras bag: these names belong to the
 * fixed-schema slots (`type`, `name`, `message`, `stack`, `cause`) and cannot
 * be used as extras keys.
 */
const FABRIC_ERROR_RESERVED_KEYS: FrozenSet<string> = new FrozenSet([
  "type",
  "name",
  "message",
  "stack",
  "cause",
]);

/**
 * Structured state for constructing a `FabricError`. Spec slots are
 * `FabricValue`-typed; the optional `extras` carries any custom enumerable
 * properties (also in `FabricValue` form). After construction, extras are
 * accessed via map-like methods (`getExtra`, `setExtra`, etc.) on the
 * instance; they are not exposed as an own property.
 */
export type FabricErrorState = {
  /** Constructor name of the originating JS `Error`, e.g. `TypeError`. */
  readonly type: string;

  /**
   * The `.name` property. Pass `null` (or omit) to mean "same as `type`"; the
   * resulting instance's `.name` is always a concrete string (`null` is a
   * wire-level optimization at the `[CODEC]` encode boundary, not part of the
   * public API).
   */
  readonly name?: string | null | undefined;

  /** The `.message` property. */
  readonly message: string;

  /** The `.stack` property, or `undefined`. */
  readonly stack: string | undefined;

  /** The `.cause` value, in `FabricValue` form, or `undefined`. */
  readonly cause: FabricValue | undefined;

  /**
   * Optional iterable of custom enumerable own properties, in `FabricValue`
   * form. Keys must not collide with the fixed-schema slot names or with
   * prototype-sensitive keys.
   */
  readonly extras?:
    | Iterable<readonly [string, FabricValue]>
    | Readonly<Record<string, FabricValue>>
    | undefined;
};

/**
 * Wrapper for `Error` instances in the fabric type system. Bridges a JS
 * `Error` (the wild west) into the strongly-typed `FabricValue` layer by
 * implementing `FabricInstance`. The publicly observable state is entirely
 * `FabricValue`-typed: fixed-schema slots (`type`, `name`, `message`, `stack`,
 * `cause`) plus a hidden extras bag accessed via map-like methods (`getExtra`,
 * `setExtra`, `hasExtra`, `deleteExtra`, `extraKeys`, `extraEntries`). The
 * JS `Error` form is produced on demand by `toNativeValue()`.
 *
 * Like all `FabricInstance`s, a `FabricError` is wholeheartedly mutable until
 * frozen and immutable thereafter. Every mutator -- the slot setters along with
 * `setExtra` / `deleteExtra` -- throws once the instance is `Object.freeze`'d.
 * The codec layer handles `FabricError` via its static `[CODEC]`, which is the
 * source of truth for the encoded form. See Section 1.4.1 of the formal spec.
 */
export class FabricError extends FabricNativeWrapper<Error>
  implements ApiFabricError {
  /** Constructor name of the originating JS `Error`, e.g. `TypeError`. */
  #type: string;

  /** The `.name` property (always a concrete string). */
  #name: string;

  /** The `.message` property. */
  #message: string;

  /** The `.stack` property, or `undefined`. */
  #stack: string | undefined;

  /** The `.cause` value, in `FabricValue` form, or `undefined`. */
  #cause: FabricValue | undefined;

  /** Hidden bag of custom enumerable properties, in `FabricValue` form. */
  readonly #extras: Map<string, FabricValue>;

  /**
   * Cached lazy JS projection, populated only once this instance is
   * frozen (so the projection can never go stale against mutable state).
   * While unfrozen, `wrappedValue` rebuilds on each access; thawed copies
   * are always minted fresh by `toNativeThawed()`.
   */
  #nativeFrozen: Error | undefined;

  /**
   * Constructs an instance from a `FabricErrorState` record. All state values
   * must already be in `FabricValue` form. Use `FabricError.fromNativeError()`
   * to construct from a JS `Error`.
   */
  constructor(state: FabricErrorState) {
    super();
    this.#type = state.type;
    this.#name = state.name ?? state.type;
    this.#message = state.message;
    this.#stack = state.stack;
    this.#cause = state.cause;
    this.#extras = new Map();
    const extras = state.extras;
    if (extras !== undefined) {
      const entries: Iterable<readonly [string, FabricValue]> =
        Symbol.iterator in extras
          ? extras as Iterable<readonly [string, FabricValue]>
          : Object.entries(extras as Record<string, FabricValue>);
      for (const [key, value] of entries) {
        if (isUnsafeObjectKey(key) || FABRIC_ERROR_RESERVED_KEYS.has(key)) {
          continue;
        }
        this.#extras.set(key, value);
      }
    }
  }

  /** Constructor name of the originating JS `Error`, e.g. `TypeError`. */
  get type(): string {
    return this.#type;
  }

  /**
   * Sets {@link type}.
   *
   * @throws If this instance is frozen.
   */
  set type(value: string) {
    this.#assertNotFrozen();
    this.#type = value;
  }

  /** The `.name` property (always a concrete string). */
  get name(): string {
    return this.#name;
  }

  /**
   * Sets {@link name}.
   *
   * @throws If this instance is frozen.
   */
  set name(value: string) {
    this.#assertNotFrozen();
    this.#name = value;
  }

  /** The `.message` property. */
  get message(): string {
    return this.#message;
  }

  /**
   * Sets {@link message}.
   *
   * @throws If this instance is frozen.
   */
  set message(value: string) {
    this.#assertNotFrozen();
    this.#message = value;
  }

  /** The `.stack` property, or `undefined`. */
  get stack(): string | undefined {
    return this.#stack;
  }

  /**
   * Sets {@link stack}.
   *
   * @throws If this instance is frozen.
   */
  set stack(value: string | undefined) {
    this.#assertNotFrozen();
    this.#stack = value;
  }

  /** The `.cause` value, in `FabricValue` form, or `undefined`. */
  get cause(): FabricValue | undefined {
    return this.#cause;
  }

  /**
   * Sets {@link cause}.
   *
   * @throws If this instance is frozen.
   */
  set cause(value: FabricValue | undefined) {
    this.#assertNotFrozen();
    this.#cause = value;
  }

  /** Returns the number of entries in the extras bag. */
  get extraSize(): number {
    return this.#extras.size;
  }

  /** Returns the value associated with `key`, or `undefined`. */
  getExtra(key: string): FabricValue | undefined {
    return this.#extras.get(key);
  }

  /** Returns `true` if `key` is present in the extras bag. */
  hasExtra(key: string): boolean {
    return this.#extras.has(key);
  }

  /**
   * Sets `key` to `value` in the extras bag. Throws if this instance is
   * frozen, if `key` is a fixed-schema slot name, or if `key` is a
   * prototype-sensitive key (`__proto__`, `constructor`).
   */
  setExtra(key: string, value: FabricValue): void {
    this.#assertNotFrozen();
    if (isUnsafeObjectKey(key)) {
      throw new Error(
        `Cannot use unsafe key in \`FabricError\` extras: \`${key}\``,
      );
    }
    if (FABRIC_ERROR_RESERVED_KEYS.has(key)) {
      throw new Error(
        `Cannot use fixed-schema slot name in \`FabricError\` extras: \`${key}\``,
      );
    }
    this.#extras.set(key, value);
  }

  /**
   * Removes `key` from the extras bag, returning `true` if it was present.
   * Throws if this instance is frozen.
   */
  deleteExtra(key: string): boolean {
    this.#assertNotFrozen();
    return this.#extras.delete(key);
  }

  /** Returns the keys present in the extras bag. */
  extraKeys(): IterableIterator<string> {
    return this.#extras.keys();
  }

  /** Returns the `[key, value]` entries in the extras bag. */
  extraEntries(): IterableIterator<[string, FabricValue]> {
    return this.#extras.entries();
  }

  /**
   * Deep-freezes in place. Freezes this instance and recurses into the
   * `FabricValue`-typed `cause` and extras-bag values via `subFreeze`. The
   * extras bag's mutation methods are gated by this instance's frozen state,
   * so freezing `this` is sufficient -- there is no separate `Object.freeze`
   * on the bag itself (a `Map` ignores `Object.freeze` for `set`/`delete`).
   * There is no JS-`Error` slot to freeze -- the JS projection is a
   * derivation produced on demand, not stored as canonical state.
   */
  [DEEP_FREEZE](
    subFreeze: (value: FabricValue) => FabricValue,
  ): FabricValue {
    if (this.#cause !== undefined) {
      subFreeze(this.#cause);
    }
    for (const value of this.#extras.values()) {
      subFreeze(value);
    }
    Object.freeze(this);
    return this;
  }

  /**
   * Side-effect-free check mirroring `[DEEP_FREEZE]`'s canonical form: this
   * instance is frozen, and the `cause` plus each value in the extras bag
   * are recursively deep-frozen. Never throws.
   */
  [IS_DEEP_FROZEN](
    subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean {
    if (!Object.isFrozen(this)) return false;
    if (this.#cause !== undefined && !subIsDeepFrozen(this.#cause)) {
      return false;
    }
    for (const value of this.#extras.values()) {
      if (!subIsDeepFrozen(value)) return false;
    }
    return true;
  }

  /**
   * Returns the frozen JS projection. Once this instance is frozen the
   * projection is cached (state can no longer change, so the cache is always
   * valid); while mutable it is rebuilt on each access. `toNativeValue(false)`
   * uses `toNativeThawed()` to mint a thawed copy each time.
   */
  protected get wrappedValue(): Error {
    if (!Object.isFrozen(this)) {
      // Mutable: state may still change, so never cache.
      return this.#buildNativeError(true);
    }
    if (this.#nativeFrozen === undefined) {
      this.#nativeFrozen = this.#buildNativeError(true);
    }
    return this.#nativeFrozen;
  }

  /** @inheritDoc */
  protected [SHALLOW_UNFROZEN_CLONE](): FabricError {
    return new FabricError({
      type: this.#type,
      name: this.#name,
      message: this.#message,
      stack: this.#stack,
      cause: this.#cause,
      extras: this.#extras,
    });
  }

  /** @inheritDoc */
  protected toNativeFrozen(): Error {
    return this.wrappedValue;
  }

  /** @inheritDoc */
  protected toNativeThawed(): Error {
    return this.#buildNativeError(false);
  }

  /**
   * @inheritDoc
   *
   * Round-trips through the codec, matching the codec's `shouldDeepFreeze` to
   * this clone's `frozen` intent (the `deepClone()` template owns the final
   * top-level freeze).
   *
   * Known gap: `encode()` passes `cause` and the extras through by reference,
   * so an unfrozen clone still _shares_ those nested values with the original,
   * and is to that extent not deeply independent. Pinned by a test in
   * `FabricError.test.ts`.
   */
  protected override [DEEP_CLONE_CORE](frozen: boolean): FabricError {
    const codec = FabricError[CODEC];
    const liveEnvironment = new NullLiveEnvironment(
      frozen,
      "no live environment (FabricError deep-clone path).",
    );
    return codec.decode(
      CODEC_TYPE_TAGS.Error,
      codec.encode(this, liveEnvironment),
      liveEnvironment,
    ) as FabricError;
  }

  /**
   * Builds a fresh JS `Error` from this `FabricError`'s state. `cause`
   * and extras are copied through as-is (no recursive unwrap). Callers that
   * need recursive unwrap should use `convertibleJsFromFabricValue()`.
   */
  #buildNativeError(frozen: boolean): Error {
    const ErrorClass = errorClassFromType(this.#type);
    const error = new ErrorClass(this.#message);
    if (error.name !== this.#name) error.name = this.#name;
    if (this.#stack !== undefined) error.stack = this.#stack;
    if (this.#cause !== undefined) error.cause = this.#cause;
    for (const [key, value] of this.#extras) {
      (error as unknown as Record<string, unknown>)[key] = value;
    }
    return frozen ? Object.freeze(error) : error;
  }

  /**
   * Guards a mutator against a frozen instance.
   *
   * @throws If this instance is frozen.
   */
  #assertNotFrozen(): void {
    if (Object.isFrozen(this)) {
      throw new Error("Cannot modify frozen `FabricError`");
    }
  }

  //
  // Static members
  //

  static #codec = Object.freeze(
    new (class FabricErrorCodec
      extends BaseNonterminalCodec<never, FabricPlainObject> {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.Error, FabricError);
      }

      /** @inheritDoc */
      encode(value: FabricError, _env: LiveEnvironment): FabricPlainObject {
        const state: Record<string, FabricValue> = {
          type: value.type,
          name: value.name === value.type ? null : value.name,
          message: value.message,
        };
        if (value.stack !== undefined) {
          state.stack = value.stack;
        }
        if (value.cause !== undefined) {
          state.cause = value.cause;
        }
        for (const [key, val] of value.extraEntries()) {
          state[key] = val;
        }
        return state;
      }

      /**
       * @inheritDoc
       *
       * Beyond being a plain object, the state is held to the types of the
       * four fields the public getters are typed by: `type`, `message` and
       * `stack` each a string where present, and `name` a string or `null`.
       * The fields are checked here rather than by the constructor because the
       * constructor does no validation, so an unchecked field reaches a getter
       * typed `string` as whatever it arrived as. `cause` and the extras are
       * arbitrary `FabricValue`s and are not constrained.
       */
      canDecode(state: FabricValue): state is FabricPlainObject {
        if (!isPlainObject(state)) {
          return false;
        }

        for (const key of ["type", "name", "message", "stack"] as const) {
          if (!Object.hasOwn(state, key)) {
            continue;
          }

          const value = state[key];
          // `null` `name` means "same as `type`" (the wire-level optimization).
          if (
            (typeof value !== "string") && !(key === "name" && value === null)
          ) {
            return false;
          }
        }

        return true;
      }

      /** @inheritDoc */
      decode(
        _typeTag: string,
        state: FabricPlainObject,
        env: LiveEnvironment,
      ): FabricValue {
        const type = (state.type as string) ?? (state.name as string) ??
          "Error";
        // `null` `name` means "same as `type`" (the wire-level optimization).
        const name = (state.name as string | null | undefined) ?? type;
        const message = (state.message as string) ?? "";
        const stack = state.stack as string | undefined;
        const cause = state.cause;

        const extras: Array<[string, FabricValue]> = [];
        for (const key of Object.keys(state)) {
          if (FABRIC_ERROR_RESERVED_KEYS.has(key) || isUnsafeObjectKey(key)) {
            continue;
          }
          extras.push([key, state[key]]);
        }

        const result = new FabricError({
          type,
          name,
          message,
          stack,
          cause,
          extras,
        });
        // Honor `shouldDeepFreeze`: produce the type's correct deep-frozen
        // form via its `[DEEP_FREEZE]` member (recursing through `deepFreeze`).
        return env.shouldDeepFreeze ? deepFreeze(result) : result;
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [CODEC](): NonterminalCodec {
    return this.#codec;
  }

  /**
   * Converts a JS `Error` into an instance. The fixed slots are read off
   * the error, and `cause` and every custom enumerable property go through
   * `options.convert`. By default a nested value that is already a valid
   * `FabricValue` is held as it stands, and anything else is converted the way
   * `fabricFromConvertibleJsValue()` converts it, without freezing, so that the
   * result is a valid `FabricValue` throughout. The instance itself is not
   * frozen.
   *
   * @throws If `convert` throws, which by default it does for a nested value
   * that cannot be converted and for a cycle through `cause`.
   */
  static fromNativeError(
    error: Error,
    options?: FromNativeErrorOptions,
  ): FabricError {
    const convert = options?.convert ?? convertNestedNativeValue;

    // The class is read from the prototype, not from the value. An own
    // `constructor` property is ordinary data, and this name is stored and
    // used to rebuild the error on the way back, so reading it off the value
    // would let a value choose the class it comes back as. A severed prototype
    // names no class, and `Error` is what such a value still is.
    let className: unknown;
    try {
      className = (constructorOfObject(error) as { name?: unknown } | undefined)
        ?.name;
    } catch {
      // A `constructor` accessor on the prototype that throws. Reading it is
      // this conversion's business and failing it is not: the value is an
      // error, and the conversion owes a result rather than the accessor's
      // exception.
      className = undefined;
    }
    const type = (typeof className === "string") && (className !== "")
      ? className
      : "Error";
    const {
      name: rawName,
      message: rawMessage,
      stack,
      cause: rawCause,
    } = error;
    const name = (rawName === type) ? null : rawName;
    // `message` is normally inherited from `Error.prototype`, so a severed
    // prototype leaves a message-less error without one at all. `FabricError`
    // declares a `string`, and the empty string is what such an error means.
    const message = (typeof rawMessage === "string") ? rawMessage : "";
    const cause = (rawCause === undefined) ? undefined : convert(rawCause);
    const extras: Array<[string, FabricValue]> = [];
    for (const key of Object.keys(error)) {
      if (isUnsafeObjectKey(key) || FABRIC_ERROR_RESERVED_KEYS.has(key)) {
        continue;
      }
      extras.push([
        key,
        convert((error as unknown as Record<string, unknown>)[key]),
      ]);
    }
    return new FabricError({ type, name, message, stack, cause, extras });
  }
}

// Compile-time check that the exported `FabricError` constructor matches the
// `FabricErrorConstructor` declared in `@/api.ts`. This catches a declared member
// that is missing here or has the wrong type. It does NOT catch the other
// direction: `satisfies` is an assignability check, so a public member on this
// class that the declaration omits passes silently. Members added here need
// adding there by hand.
FabricError satisfies ApiFabricErrorConstructor;
