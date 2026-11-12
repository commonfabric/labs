import type {
  FabricRegExp as ApiFabricRegExp,
  FabricRegExpConstructor as ApiFabricRegExpConstructor,
} from "@/api.ts";
import { backtickQuote } from "@commonfabric/text/markdown";

import { BaseFabricPrimitive, VALUE_TAG } from "@/fabric-bases";
import { BLESSING_TOKEN } from "@/fabric-bases/blessing.ts";
import {
  FABRIC_PRIMITIVE_VALUE_TAGS,
  type FabricPrimitiveValueTag,
} from "./interface.ts";

/**
 * The flavor of a JS `RegExp`, and the only one currently representable as
 * one.
 */
const JS_FLAVOR = "es2025";

/**
 * Immutable regular-expression value in the fabric type system.
 *
 * The essential state is `{ source, flags, flavor }` -- the values needed to
 * (re)construct an equivalent regex. A `FabricRegExp` is a leaf type with
 * respect to references (it holds no nested `FabricValue`s) and is reasonably
 * conceived of as stateless: although a JS `RegExp` carries mutable internal
 * state (notably `lastIndex`), the stored `RegExp` is never handed out
 * un-cloned, so no mutable state is exposed -- `value` returns a fresh clone on
 * each call.
 *
 * `flavor` identifies the regex dialect. Only `"es2025"`, the dialect of a JS
 * `RegExp`, is currently representable as one; for that flavor the
 * constructor proactively builds and retains a private `RegExp`, which both
 * validates the pattern syntax eagerly and makes `value` cheap. Other flavors
 * are stored faithfully (`source` / `flags` / `flavor`) but cannot yet produce
 * a JS `RegExp`, so `value` throws for them -- leaving room to represent
 * other regex syntaxes in the future. See Section 1.4.5 of
 * `1-fabric-values.md`.
 *
 * The type is disabled for codecs: this class binds no codec, so no wire
 * format carries an instance, and encoding one throws as it does for any class
 * no registry knows.
 */
export class FabricRegExp extends BaseFabricPrimitive
  implements ApiFabricRegExp {
  /** The pattern source text. */
  readonly #source: string;

  /** The flags string (e.g. `"gi"`). */
  readonly #flags: string;

  /** Regex flavor/dialect identifier (e.g. `"es2025"`). */
  readonly #flavor: string;

  /**
   * The JS `RegExp`, built eagerly for the `"es2025"` flavor (and only
   * that flavor). `undefined` for other flavors, which cannot yet produce a
   * JS `RegExp`. Never handed out directly -- `value` returns a fresh
   * clone.
   */
  readonly #value: RegExp | undefined;

  /**
   * Constructs an instance, either from a JS `RegExp` (implying the
   * `"es2025"` flavor) or from explicit `flavor` / `source` / `flags`.
   *
   * When the resulting flavor is `"es2025"`, the `source` and `flags` are
   * validated eagerly by building the retained JS `RegExp`. A JS
   * `RegExp` argument with extra enumerable own properties is rejected (the
   * built-in `.lastIndex` is non-enumerable, so `Object.keys()` only sees
   * user-added properties).
   */
  constructor(regex: RegExp);
  constructor(flavor: string, source: string, flags: string);
  constructor(
    regexOrFlavor: RegExp | string,
    source?: string,
    flags?: string,
  ) {
    super(BLESSING_TOKEN, FabricRegExp);

    if (regexOrFlavor instanceof RegExp) {
      rejectExtraRegExpProperties(regexOrFlavor);
      this.#source = regexOrFlavor.source;
      this.#flags = regexOrFlavor.flags;
      this.#flavor = JS_FLAVOR;
    } else {
      this.#flavor = regexOrFlavor;
      this.#source = source ?? "";
      this.#flags = flags ?? "";
    }

    // Only `"es2025"` is representable as a JS `RegExp`; build it eagerly
    // (which also validates the pattern). Other flavors store their strings but
    // have no convertible JS form yet.
    this.#value = (this.#flavor === JS_FLAVOR)
      ? new RegExp(this.#source, this.#flags)
      : undefined;
  }

  //
  // Instance members
  //

  /** @inheritDoc */
  get [VALUE_TAG](): FabricPrimitiveValueTag {
    return FABRIC_PRIMITIVE_VALUE_TAGS.FabricRegExp;
  }

  /** @inheritDoc */
  get schemaType(): "FabricRegExp" {
    return "FabricRegExp";
  }

  /** The pattern source text. */
  get source(): string {
    return this.#source;
  }

  /** The flags string (e.g. `"gi"`). */
  get flags(): string {
    return this.#flags;
  }

  /** Regex flavor/dialect identifier (e.g. `"es2025"`). */
  get flavor(): string {
    return this.#flavor;
  }

  /**
   * A fresh JS `RegExp` equivalent to this value, returned anew on each
   * call so the internal instance is never aliased out (the caller cannot
   * reach its `lastIndex` etc.). Throws when the flavor is not `"es2025"`,
   * which has no JS `RegExp` representation.
   */
  get value(): RegExp {
    if (this.#value === undefined) {
      throw new Error(
        `Cannot represent flavor ${
          backtickQuote(this.#flavor)
        } as a JS \`RegExp\`.`,
      );
    }
    return new RegExp(this.#value);
  }

  //
  // Static members
  //

  static {
    Object.freeze(this);
    Object.freeze(this.prototype);
  }
}

/**
 * Rejects `RegExp` instances with extra enumerable properties. The built-in
 * `.lastIndex` property is not enumerable, so `Object.keys()` won't see it. Any
 * enumerable own property is therefore user-added and causes rejection.
 */
function rejectExtraRegExpProperties(regex: RegExp): void {
  if (Object.keys(regex).length > 0) {
    throw new Error(
      "Not representable as a `FabricValue`: `RegExp` with extra enumerable " +
        "properties",
    );
  }
}

// Compile-time check that the exported `FabricRegExp` constructor matches the
// `FabricRegExpConstructor` declared in `@/api.ts`. This catches a declared member
// that is missing here or has the wrong type. It does NOT catch the other
// direction: `satisfies` is an assignability check, so a public member on this
// class that the declaration omits passes silently. Members added here need
// adding there by hand.
FabricRegExp satisfies ApiFabricRegExpConstructor;
