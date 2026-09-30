/**
 * The registry a wire format's walker consults: tag to codec on the way in,
 * value to codec on the way out. On the encode side the match is by class where
 * a value has a useful one and by primitive type otherwise, with a value that
 * is already its own wire form answering to neither and getting a sentinel in
 * place of a codec.
 *
 * A registry is mutable while it is being assembled and immutable once frozen,
 * and that is a safety property rather than a convenience. An engine holds the
 * registry it was constructed with, so one handed out unfrozen could gain a
 * registration underneath an engine already relying on it. Building further on
 * a frozen registry means extending it into a new one.
 */

import { backtickQuote } from "@commonfabric/utils/markdown";
import {
  type Constructor,
  typeOfIncludingNull,
} from "@commonfabric/utils/types";

import type { FabricValue } from "@/interface.ts";
import {
  CODEC,
  type CodecForFormat,
  type WireFormat,
} from "@/codec-interface/interface.ts";
import { BaseNonterminalCodec } from "@/codec-interface/BaseNonterminalCodec.ts";
import { BaseTerminalCodec } from "@/codec-interface/BaseTerminalCodec.ts";
import { type JsTypeValueTag, VALUE_TAGS } from "@/types";
import { isCodecTypeTag } from "./isCodecTypeTag.ts";

/**
 * Sentinel returned by {@link CodecRegistry#codecFromValue} for a
 * self-representing value -- one that is its own wire form (encoded as-is, with
 * no codec and no tag).
 */
export const SELF_REP = "self-rep" as const;

/**
 * The primitive `type` keys the registry accepts: the JS type tags of the
 * encodable `FabricValue` primitives, `null` included. A function is no
 * `FabricValue`, and an object value is matched by class via
 * {@link CodecRegistry#register}, so neither has a key here.
 */
export type PrimitiveTypeName = Exclude<JsTypeValueTag, "function">;

/**
 * Gets the constructor function ("class") of the given value, if any, for
 * class-based codec lookup.
 */
function constructorOf(
  value: FabricValue,
): Constructor | undefined {
  if (typeof value === "object") {
    if (value === null) {
      return undefined;
    }

    const proto = Object.getPrototypeOf(value);
    if (proto === null) {
      return undefined;
    }

    return proto.constructor;
  } else if (value !== undefined) {
    // This gets the pseudo-constructor of a primitive. **Note:** `function` is
    // not included in the `FabricValue` union.
    return value.constructor as Constructor;
  } else {
    return undefined;
  }
}

/**
 * Registry of codecs. Provides tag-based lookup for decoding, and
 * primitive-type and class matching for encoding.
 *
 * An instance is mutable while it is being built and immutable once
 * `Object.freeze()`d: every mutator refuses on a frozen instance. Freezing is
 * how a registry becomes safe to hand out, since an engine holds the registry
 * it was constructed with and would otherwise see a later registration. Use
 * {@link #extend} to build on one that is already frozen.
 */
export class CodecRegistry<Encoded> {
  /** The wire format this registry is over. */
  readonly #format: WireFormat<Encoded>;

  /** Tag -> codec map for O(1) decode dispatch. */
  readonly #tagMap = new Map<string, CodecForFormat<Encoded>>();

  /** Class -> codec map for O(1) encode dispatch on object values. */
  readonly #classMap = new Map<Constructor, CodecForFormat<Encoded>>();

  /** Primitive `type` -> codec map for O(1) encode dispatch on primitives. */
  readonly #primitiveCodecs = new Map<
    PrimitiveTypeName,
    CodecForFormat<Encoded>
  >();

  /** Primitive `type`s that are self-representing (encoded as-is). */
  readonly #selfRepTypes = new Set<PrimitiveTypeName>();

  /**
   * Constructs an instance over the given wire format, which decides the
   * symbol {@link #registerClass} reads a codec out from under.
   *
   * `format` must be frozen. A registry holds it for its lifetime and reads
   * the symbol on every class registration, so a mutable descriptor could
   * change which codec a class supplies partway through a registry being
   * built. `readonly` does not carry that: it binds at the type level only,
   * and says nothing about an object arriving from elsewhere.
   *
   * @throws If `format` is not frozen.
   */
  constructor(format: WireFormat<Encoded>) {
    if (!Object.isFrozen(format)) {
      throw new Error("`WireFormat` instances must be frozen.");
    }

    this.#format = format;
  }

  /**
   * Registers the codec that the given class supplies for this registry's
   * format: its `[CODEC]` if it has one, and otherwise the codec bound under
   * the format's own symbol. A class with both supplies the former, that being
   * the one which serves every format.
   *
   * This is what lets a single curated class list serve every format. Which
   * symbol a given class binds is a question about that class and that format
   * -- `FabricRegExp` supplies a nonterminal codec to JSON, having no pattern
   * type of its own to terminate into -- and reading it here means no caller
   * has to keep one list per format in step with the others.
   *
   * The parameter is only `Constructor`, and cannot be narrower: naming the
   * symbol a class must bind would name a format, which is the thing a shared
   * roster must not do. So this refuses at run time what a type cannot rule
   * out. A registry is built at module scope, so the refusal still lands
   * before anything has been encoded.
   *
   * What it does not check is the codec's `PlusType`. A `[CODEC]` is read as
   * the one at `never`, the only kind with a wire form, and a class binding
   * one at another `PlusType` registers all the same; its state is refused by
   * the encode walk instead, as holding a value no codec claims.
   *
   * @throws If the class supplies a codec under neither symbol.
   */
  registerClass(cls: Constructor): void {
    this.#assertNotFrozen();

    const bound = cls as unknown as Partial<
      Record<symbol, CodecForFormat<Encoded>>
    >;
    const codec = bound[CODEC] ?? bound[this.#format.codecSymbol];

    if (codec === undefined) {
      throw new Error(
        "Shouldn't happen: class supplies no codec for this registry's " +
          `format: \`${cls.name}\``,
      );
    }

    this.register(codec);
  }

  /**
   * Registers a codec, indexing it by its `recognizedTypeTag` (for decode) and
   * its `uniqueHandledClass` (for encode dispatch). Either may be `undefined`,
   * in which case the codec is left unindexed for the corresponding lookup;
   * note that a codec with no `uniqueHandledClass` is unreachable for encoding.
   */
  register(codec: CodecForFormat<Encoded>): void {
    this.#assertNotFrozen();

    CodecRegistry.#assertClassified<Encoded>(codec);
    CodecRegistry.#assertTagRegistrable(codec.recognizedTypeTag);

    const uniqueClass = codec.uniqueHandledClass;
    if (uniqueClass !== undefined) {
      this.#classMap.set(uniqueClass, codec);
    }

    const tag = codec.recognizedTypeTag;
    if (tag !== undefined) {
      this.#tagMap.set(tag, codec);
    }
  }

  /**
   * Registers a codec for a primitive `type` (see {@link PrimitiveTypeName}).
   * Indexes the codec by its `recognizedTypeTag` (for decode) and by `type`
   * (for O(1) encode dispatch on primitives).
   */
  registerPrimitive(
    type: PrimitiveTypeName,
    codec: CodecForFormat<Encoded>,
  ): void {
    this.#assertNotFrozen();

    CodecRegistry.#assertClassified<Encoded>(codec);
    CodecRegistry.#assertTagRegistrable(codec.recognizedTypeTag);

    this.#primitiveCodecs.set(type, codec);

    const tag = codec.recognizedTypeTag;
    if (tag !== undefined) {
      this.#tagMap.set(tag, codec);
    }
  }

  /**
   * Registers a primitive `type` (see {@link PrimitiveTypeName}) as
   * self-representing: a value of that type is its own wire form, so
   * {@link #codecFromValue} returns {@link SELF_REP} for it. A type may be both
   * self-representing and have a {@link #registerPrimitive} codec (e.g.
   * `"number"`: finite numbers are self-representing, special ones go through a
   * codec); the codec is tried first.
   */
  registerSelfRep(type: PrimitiveTypeName): void {
    this.#assertNotFrozen();

    this.#selfRepTypes.add(type);
  }

  /**
   * Creates a frozen copy of this instance with the given codecs additionally
   * registered. This instance is left untouched, so a shared registry can be
   * built on without being altered, and the result is frozen so that it in
   * turn can be shared.
   *
   * This is the intended way to add to a registry someone else assembled:
   * extending what a factory returns is what keeps a caller from omitting, by
   * accident, everything that factory put there.
   *
   * An argument may be a class, in which case its codec for this registry's
   * format is found as {@link #registerClass} finds one. That is what a
   * curated roster holds. A bare codec is also accepted, for a caller holding
   * one it did not get from a class -- a codec built for a single registry,
   * say, or one already read out from under a symbol.
   *
   * Arguments are taken as `Array.concat()` takes them -- any number, each
   * either a single entry or a list of them -- so that a caller combining
   * rosters need not splice them into one array first.
   *
   * @param entries The classes and codecs to register in addition,
   *   individually or in lists.
   */
  extend(
    ...entries: readonly (
      | Constructor
      | CodecForFormat<Encoded>
      | readonly (Constructor | CodecForFormat<Encoded>)[]
    )[]
  ): CodecRegistry<Encoded> {
    const result = new CodecRegistry<Encoded>(this.#format);

    for (const [key, value] of this.#tagMap) result.#tagMap.set(key, value);
    for (const [key, value] of this.#classMap) result.#classMap.set(key, value);
    for (const [key, value] of this.#primitiveCodecs) {
      result.#primitiveCodecs.set(key, value);
    }
    for (const type of this.#selfRepTypes) result.#selfRepTypes.add(type);

    for (const arg of entries) {
      if (Array.isArray(arg)) {
        for (const entry of arg) {
          result.#registerEntry(entry);
        }
      } else {
        result.#registerEntry(
          arg as Constructor | CodecForFormat<Encoded>,
        );
      }
    }

    // Frozen as a statement rather than by returning `Object.freeze()`'s
    // result, whose `Readonly<CodecRegistry>` type drops the private-field
    // brand and so is not assignable back to `CodecRegistry`.
    Object.freeze(result);
    return result;
  }

  /**
   * Finds how to encode the given value: a matched codec that can encode it,
   * {@link SELF_REP} if it is a self-representing primitive, or `undefined` if
   * neither matches (the caller falls through to structural handling for
   * arrays and plain objects, or fails for an unencodable value).
   */
  codecFromValue(
    value: FabricValue,
  ): CodecForFormat<Encoded> | typeof SELF_REP | undefined {
    // Primitive dispatch on the value's primitive `type` key, which is its JS
    // type tag. The type's codec is tried first, then self-representation.
    const type = typeOfIncludingNull(value);

    if (type === VALUE_TAGS.function) {
      // Not a `FabricValue`; nothing can encode it.
      return undefined;
    } else if (type !== "object") {
      const matched = this.#primitiveCodecs.get(type);
      if (matched && matched.canEncode(value)) {
        return matched;
      }
      if (this.#selfRepTypes.has(type)) {
        return SELF_REP;
      }
      // No primitive match -- fall through to the class lookup below.
    }

    // Match by the value's exact constructor.
    const constructorFn = constructorOf(value);
    if (constructorFn) {
      const matched = this.#classMap.get(constructorFn);
      if (matched && matched.canEncode(value)) {
        return matched;
      }
    }

    return undefined;
  }

  /** Looks up a codec by tag for decoding. */
  codecFromTag(typeTag: string): CodecForFormat<Encoded> | undefined {
    return this.#tagMap.get(typeTag);
  }

  /**
   * Registers one {@link #extend} entry, which is a class when it is callable
   * and a codec otherwise. Nothing else in the codec system is a function, so
   * the two cannot be confused.
   */
  #registerEntry(
    entry: Constructor | CodecForFormat<Encoded>,
  ): void {
    if (typeof entry === "function") {
      this.registerClass(entry);
    } else {
      this.register(entry);
    }
  }

  /**
   * Guards a mutator against a frozen instance.
   *
   * @throws If this instance is frozen.
   */
  #assertNotFrozen(): void {
    if (Object.isFrozen(this)) {
      throw new Error("Cannot modify frozen `CodecRegistry`");
    }
  }

  //
  // Static members
  //

  /**
   * Guards against registering a codec under a tag that is not one. A decoder
   * refuses a tag that is not syntactically a tag, per Section 9 of the formal
   * spec, so a codec indexed under such a string could emit a value this same
   * system would then refuse to read back. Checking here is what keeps the two
   * sides of a round trip from disagreeing, and does it once per codec rather
   * than once per value.
   *
   * `undefined` is allowed and is not a tag: it marks a codec whose tag is
   * per-instance, read from the value by `tagForValue()` rather than fixed.
   *
   * @throws If `tag` is a string that is not a codec type tag.
   */
  static #assertTagRegistrable(tag: string | undefined): void {
    if ((tag !== undefined) && !isCodecTypeTag(tag)) {
      throw new Error(
        `Cannot register a codec under ${backtickQuote(tag)}: not a codec ` +
          "type tag, so nothing encoded under it could be decoded.",
      );
    }
  }

  /**
   * Checks that a codec declares a kind, by extending one of the two base
   * classes. Nothing is stored: each walker reads the kind again with its own
   * `instanceof` when it dispatches.
   *
   * That makes extending one of the two bases a requirement, which the
   * parameter type does not express: it names the interfaces, and an object
   * satisfying one of those without extending anything has no kind to read.
   * Uses "death before confusion" on that case rather than letting a walker
   * pick a default, because a codec silently taken for the kind it is not
   * would have its state expanded, or left unexpanded, in whole-value
   * encodings far from here.
   *
   * @throws If `codec` extends neither base class.
   */
  static #assertClassified<Encoded>(codec: CodecForFormat<Encoded>): void {
    if (
      !(codec instanceof BaseTerminalCodec) &&
      !(codec instanceof BaseNonterminalCodec)
    ) {
      throw new Error(
        "Shouldn't happen: codec extends neither `BaseNonterminalCodec` nor " +
          "`BaseTerminalCodec`, so it declares no kind: " +
          `\`${codec.constructor.name}\``,
      );
    }
  }
}
