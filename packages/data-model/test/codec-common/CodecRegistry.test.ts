/**
 * The registry's two jobs -- accepting codecs and serving lookups -- and the
 * line that freezing draws between them.
 *
 * Acceptance is where the refusals live. A codec has to be classifiable, the
 * base class it extends being the only record of what its state means, and it
 * has to carry a tag. Both conditions are checked on every route in rather
 * than on one of them, since a registration that arrived by a side door is
 * still one the walker will trust.
 *
 * Lookup works from a value, from a tag, or returns the sentinel meaning that
 * no codec is needed. Which symbol a class's codec is read from is settled
 * here too: the format-agnostic binding wins over the format's own when a
 * class has both, and a binding belonging to some other format is not
 * consulted at all.
 *
 * Freezing then separates the two jobs. Every mutator refuses afterward while
 * every lookup still works, and extending yields a new registry carrying the
 * base's registrations without the base itself gaining anything.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { Constructor } from "@commonfabric/utils/types";

import { SELF_REP } from "@/codec-common/CodecRegistry.ts";
import {
  BaseNonterminalCodec,
  BaseTerminalCodec,
  CODEC,
  CodecRegistry,
  type FabricCodec,
  type LiveEnvironment,
  type NonterminalCodec,
  type TerminalCodec,
  UnknownValue,
  type WireFormat,
} from "@/codec-common/index.ts";
import { FabricRegExp } from "@/fabric-primitives/index.ts";
import { type FabricValue, toCompactDebugString } from "@/index.ts";

/**
 * Test codec that matches a single pre-set value (by `===`) and records
 * whether `canEncode()` was consulted, so tests can distinguish the classMap
 * fast path from the linear-scan slow path. Nothing but `canEncode()` is ever
 * exercised by the registry, so the rest throw.
 */
class TestCodec extends BaseNonterminalCodec {
  canEncodeCalled = false;
  readonly #accept: FabricValue | undefined;

  constructor(
    recognizedTypeTag: string | undefined,
    uniqueHandledClass: Constructor | undefined,
    accept?: FabricValue,
  ) {
    super(recognizedTypeTag, uniqueHandledClass);
    this.#accept = accept;
  }

  override canEncode(value: FabricValue): boolean {
    this.canEncodeCalled = true;
    return (this.#accept !== undefined) && (value === this.#accept);
  }

  encode(_value: FabricValue): FabricValue {
    throw new Error("Unimplemented.");
  }

  canDecode(_state: FabricValue): _state is FabricValue {
    throw new Error("Unimplemented.");
  }

  decode(
    _typeTag: string,
    _state: FabricValue,
    _env: LiveEnvironment,
  ): FabricValue {
    throw new Error("Unimplemented.");
  }
}

/**
 * Builds a fresh registry with the codec-under-test bracketed by two
 * never-matching codecs, so a test can detect whether the linear scan ran.
 */
function buildRegistry(
  classSource: Constructor | undefined,
  example: FabricValue,
) {
  const first = new TestCodec("First@1", undefined);
  const handler = new TestCodec("Handler@1", classSource, example);
  const last = new TestCodec("Last@1", undefined);
  const registry = new CodecRegistry(TEST_FORMAT);
  registry.register(first);
  registry.register(handler);
  registry.register(last);
  return { first, handler, last, registry };
}

/**
 * Terminal counterpart to {@link TestCodec}, for the cases that turn on which
 * kind of codec was registered. Its members are never reached; extending
 * `BaseTerminalCodec` is the whole of what it contributes.
 */
class TestTerminalCodec extends BaseTerminalCodec<string> {
  constructor(recognizedTypeTag: string, uniqueHandledClass?: Constructor) {
    super(recognizedTypeTag, uniqueHandledClass);
  }

  /**
   * @inheritDoc
   *
   * Accepts anything, so that a case can register this by primitive `type`
   * and reach it without a class to match on.
   */
  override canEncode(_value: FabricValue): boolean {
    return true;
  }

  encode(_value: FabricValue): string {
    throw new Error("Unimplemented.");
  }

  canDecode(_state: string): _state is string {
    throw new Error("Unimplemented.");
  }

  decode(
    _typeTag: string,
    _state: string,
    _env: LiveEnvironment,
  ): FabricValue {
    throw new Error("Unimplemented.");
  }
}

/**
 * Codec satisfying the interface without extending either base class, for the
 * cases pinning that the registry refuses one. Its members are never reached.
 */
const UNCLASSIFIABLE_CODEC: FabricCodec<never, string> = {
  get uniqueHandledClass(): Constructor | undefined {
    return FabricRegExp;
  },

  get recognizedTypeTag(): string | undefined {
    return "Unclassifiable@1";
  },

  canEncode(_value: FabricValue): boolean {
    return true;
  },

  tagForValue(_value: FabricValue): string {
    return "Unclassifiable@1";
  },

  encode(_value: FabricValue): string {
    throw new Error("Unimplemented.");
  },

  canDecode(_state: string): boolean {
    throw new Error("Unimplemented.");
  },

  decode(
    _typeTag: string,
    _state: string,
    _env: LiveEnvironment,
  ): FabricValue {
    throw new Error("Unimplemented.");
  },
};

/** Test symbol standing in for a format's own codec symbol. */
const TEST_CODEC: unique symbol = Symbol("test.codec");

/** Frozen test wire format, as the constructor requires. */
const TEST_FORMAT: WireFormat<string> = Object.freeze({
  codecSymbol: TEST_CODEC,
});

describe("CodecRegistry", () => {
  describe("registration guards", () => {
    // A codec carries its own kind, in the class it extends, and the registry
    // stores it unaltered -- so there is nothing here to assert about kind
    // beyond that a codec which declares none is refused. What a walker does
    // with the kind is pinned where a walker reads it.

    it("reaches a primitive-registered codec by value and by tag", () => {
      const codec = new TestTerminalCodec("TermPrim@1");
      const registry = new CodecRegistry(TEST_FORMAT);
      registry.registerPrimitive("bigint", codec);

      expect(registry.codecFromValue(914n)).toBe(codec);
      expect(registry.codecFromTag("TermPrim@1")).toBe(codec);
    });

    it("finds a class's codec when one is passed to `extend()`", () => {
      const codec = new TestTerminalCodec("ViaExtend@1", FabricRegExp);
      class Extended {
        static get [TEST_CODEC](): TerminalCodec<string> {
          return codec;
        }
      }

      const registry = new CodecRegistry(TEST_FORMAT).extend([Extended]);

      expect(registry.codecFromTag("ViaExtend@1")).toBe(codec);
    });

    it("registers codecs of either kind through `extend()`", () => {
      const nonterminal = new TestCodec("Nonterm@1", FabricRegExp);
      const terminal = new TestTerminalCodec("Term@1");
      const registry = new CodecRegistry(TEST_FORMAT).extend(
        nonterminal,
        terminal,
      );

      expect(registry.codecFromTag("Nonterm@1")).toBe(nonterminal);
      expect(registry.codecFromTag("Term@1")).toBe(terminal);
    });

    it("throws given a codec whose recognized tag is empty", () => {
      // Spec §9 makes a bare `/` key an encoding error whatever follows it,
      // and the decoder reports it as one. A codec registered under it could
      // encode a value that this same system would then refuse to read back.

      const codec = new TestCodec("", FabricRegExp);
      const registry = new CodecRegistry(TEST_FORMAT);

      expect(() => registry.register(codec)).toThrow(
        /Cannot register a codec under/,
      );
    });

    it("throws given a codec whose recognized tag has no version", () => {
      // The register-time counterpart of the decoder's check: `hole` is a
      // meta-tag rather than a type, so a decoder refuses it, and a codec
      // indexed under it would emit exactly what the decoder refuses.

      const codec = new TestCodec("hole", FabricRegExp);
      const registry = new CodecRegistry(TEST_FORMAT);

      expect(() => registry.register(codec)).toThrow(
        /not a codec type tag/,
      );
    });

    it("registers a codec whose recognized tag is `undefined`", () => {
      // Not a tag, and not an error: it marks a codec whose tag is read from
      // each value rather than fixed.

      const codec = new TestCodec(undefined, FabricRegExp);
      const registry = new CodecRegistry(TEST_FORMAT);

      expect(() => registry.register(codec)).not.toThrow();
    });

    it("throws given an empty-tagged codec registered by primitive", () => {
      const codec = new TestTerminalCodec("");
      const registry = new CodecRegistry(TEST_FORMAT);

      expect(() => registry.registerPrimitive("bigint", codec)).toThrow(
        /Cannot register a codec under/,
      );
    });

    it("throws given a codec that extends neither base class", () => {
      const registry = new CodecRegistry(TEST_FORMAT);

      expect(() => registry.register(UNCLASSIFIABLE_CODEC)).toThrow(
        "Shouldn't happen: codec extends neither",
      );
    });

    it("throws given an unclassifiable codec registered by primitive", () => {
      const registry = new CodecRegistry(TEST_FORMAT);

      expect(() => registry.registerPrimitive("bigint", UNCLASSIFIABLE_CODEC))
        .toThrow("Shouldn't happen: codec extends neither");
    });

    it("throws given an unclassifiable codec passed to `extend()`", () => {
      const registry = new CodecRegistry(TEST_FORMAT);

      expect(() => registry.extend(UNCLASSIFIABLE_CODEC)).toThrow(
        "Shouldn't happen: codec extends neither",
      );
    });
  });

  describe("constructor()", () => {
    it("throws given an unfrozen `WireFormat`", () => {
      // A registry holds its format and reads the symbol on every class
      // registration, so a mutable one could change what a class supplies
      // partway through the registry being built.

      const unfrozen: WireFormat<string> = { codecSymbol: TEST_CODEC };

      expect(() => new CodecRegistry(unfrozen)).toThrow(
        "`WireFormat` instances must be frozen.",
      );
    });
  });

  describe("instance members", () => {
    describe("registerClass()", () => {
      it("registers the codec bound under the format's own symbol", () => {
        const codec = new TestTerminalCodec("FromFormat@1", FabricRegExp);
        class Formatted {
          static get [TEST_CODEC](): TerminalCodec<string> {
            return codec;
          }
        }
        const registry = new CodecRegistry(TEST_FORMAT);

        registry.registerClass(Formatted);

        expect(registry.codecFromTag("FromFormat@1")).toBe(codec);
      });

      it("registers a class's `[CODEC]` when it has one", () => {
        const codec = new TestCodec("FromCodec@1", FabricRegExp);
        class Neutral {
          static get [CODEC](): NonterminalCodec {
            return codec;
          }
        }
        const registry = new CodecRegistry(TEST_FORMAT);

        registry.registerClass(Neutral);

        expect(registry.codecFromTag("FromCodec@1")).toBe(codec);
      });

      it("prefers `[CODEC]` over the format's symbol when a class binds both", () => {
        // The format-neutral codec is the one that serves every format, so it
        // wins wherever a class offers a choice.

        const neutral = new TestCodec("Neutral@1", FabricRegExp);
        const formatted = new TestTerminalCodec("Formatted@1", FabricRegExp);
        class Both {
          static get [CODEC](): NonterminalCodec {
            return neutral;
          }
          static get [TEST_CODEC](): TerminalCodec<string> {
            return formatted;
          }
        }
        const registry = new CodecRegistry(TEST_FORMAT);

        registry.registerClass(Both);

        expect(registry.codecFromTag("Neutral@1")).toBe(neutral);
        expect(registry.codecFromTag("Formatted@1")).toBeUndefined();
      });

      it("throws given a class binding neither symbol", () => {
        class Neither {}
        const registry = new CodecRegistry(TEST_FORMAT);

        expect(() => registry.registerClass(Neither)).toThrow(
          "Shouldn't happen: class supplies no codec",
        );
      });

      it("ignores a codec bound under some other format's symbol", () => {
        // Two formats' symbols on one class is the arrangement this exists to
        // serve; a registry reads only its own.

        const other: unique symbol = Symbol("other.codec");
        const codec = new TestTerminalCodec("Other@1", FabricRegExp);
        class OtherFormatOnly {
          static get [other](): TerminalCodec<string> {
            return codec;
          }
        }
        const registry = new CodecRegistry(TEST_FORMAT);

        expect(() => registry.registerClass(OtherFormatOnly)).toThrow(
          "Shouldn't happen: class supplies no codec",
        );
      });
    });

    describe("codecFromValue()", () => {
      for (
        const { classSource, example, counter } of [
          { classSource: Boolean, example: false, counter: [1, 2, 3] },
          { classSource: BigInt, example: 914n, counter: true },
          { classSource: Number, example: 123, counter: "florp" },
          { classSource: String, example: "blorp", counter: null },
          {
            classSource: Symbol,
            example: Symbol.for("bleep"),
            counter: undefined,
          },
          {
            classSource: FabricRegExp, // a `FabricPrimitive`
            example: new FabricRegExp(/123/),
            counter: { a: "boop" },
          },
          {
            classSource: UnknownValue, // a `FabricInstance`
            example: new UnknownValue("Unk@12", { muffin: "corn" }),
            counter: 123n,
          },
        ] as const
      ) {
        const sourceName = classSource.name;
        const exampleStr = toCompactDebugString(example);
        const counterStr = toCompactDebugString(counter);
        const cls = classSource as unknown as Constructor;

        it(`given ${exampleStr}, finds the ${sourceName} codec by class`, () => {
          const { first, handler, last, registry } = buildRegistry(
            cls,
            example,
          );
          expect(registry.codecFromValue(example)).toBe(handler);
          // Only the class-matched codec is consulted -- there is no linear scan.
          expect(first.canEncodeCalled).toBe(false);
          expect(handler.canEncodeCalled).toBe(true);
          expect(last.canEncodeCalled).toBe(false);
        });

        it(`returns undefined for ${counterStr} (no ${sourceName} match)`, () => {
          const { first, handler, last, registry } = buildRegistry(
            cls,
            example,
          );
          expect(registry.codecFromValue(counter)).toBeUndefined();
          // A class miss consults no codec (no linear scan).
          expect(first.canEncodeCalled).toBe(false);
          expect(handler.canEncodeCalled).toBe(false);
          expect(last.canEncodeCalled).toBe(false);
        });
      }

      it("returns `undefined` for a `null`-prototype object", () => {
        const { registry } = buildRegistry(
          FabricRegExp,
          new FabricRegExp(/x/),
        );
        const nullProto = Object.create(null) as Record<string, FabricValue>;
        nullProto.a = 1;

        expect(registry.codecFromValue(nullProto)).toBeUndefined();
      });
    });

    describe("registerPrimitive()", () => {
      it("dispatches a primitive value to its codec (encode + decode)", () => {
        const registry = new CodecRegistry(TEST_FORMAT);
        const codec = new TestCodec("Big@1", undefined, 42n);
        registry.registerPrimitive("bigint", codec);
        expect(registry.codecFromValue(42n)).toBe(codec);
        expect(registry.codecFromTag("Big@1")).toBe(codec);
      });

      it("returns `undefined` when the codec's `canEncode()` says no", () => {
        const registry = new CodecRegistry(TEST_FORMAT);
        registry.registerPrimitive(
          "bigint",
          new TestCodec("Big@1", undefined, 42n),
        );
        expect(registry.codecFromValue(99n)).toBeUndefined();
      });
    });

    describe("registerSelfRep()", () => {
      it("returns `SELF_REP` for a self-representing primitive value", () => {
        const registry = new CodecRegistry(TEST_FORMAT);
        registry.registerSelfRep("string");
        expect(registry.codecFromValue("hi")).toBe(SELF_REP);
      });

      it("tries the type's codec before falling to self-rep", () => {
        const registry = new CodecRegistry(TEST_FORMAT);
        const codec = new TestCodec("Num@1", undefined, 42);
        registry.registerPrimitive("number", codec);
        registry.registerSelfRep("number");
        expect(registry.codecFromValue(42)).toBe(codec); // codec match
        expect(registry.codecFromValue(99)).toBe(SELF_REP); // self-rep fallback
      });
    });

    describe("extend()", () => {
      it("returns a different instance", () => {
        const base = new CodecRegistry(TEST_FORMAT);
        expect(base.extend()).not.toBe(base);
      });

      it("returns a frozen instance", () => {
        expect(Object.isFrozen(new CodecRegistry(TEST_FORMAT).extend())).toBe(
          true,
        );
      });

      it("carries over every kind of registration the base holds", () => {
        const base = new CodecRegistry(TEST_FORMAT);
        const codec = new TestCodec("Carried@1", undefined);
        const primitive = new TestCodec("Prim@1", undefined);
        base.register(codec);
        base.registerPrimitive("bigint", primitive);
        base.registerSelfRep("string");

        const extended = base.extend();

        expect(extended.codecFromTag("Carried@1")).toBe(codec);
        expect(extended.codecFromTag("Prim@1")).toBe(primitive);
        expect(extended.codecFromValue("florp")).toBe(SELF_REP);
      });

      it("registers a codec given on its own", () => {
        const added = new TestCodec("Added@1", undefined);
        const extended = new CodecRegistry(TEST_FORMAT).extend(added);

        expect(extended.codecFromTag("Added@1")).toBe(added);
      });

      it("registers codecs given individually and in lists, in any mix", () => {
        const loose = new TestCodec("Loose@1", undefined);
        const listed = new TestCodec("Listed@1", undefined);
        const alsoListed = new TestCodec("AlsoListed@1", undefined);

        const extended = new CodecRegistry(TEST_FORMAT)
          .extend(loose, [listed, alsoListed]);

        expect(extended.codecFromTag("Loose@1")).toBe(loose);
        expect(extended.codecFromTag("Listed@1")).toBe(listed);
        expect(extended.codecFromTag("AlsoListed@1")).toBe(alsoListed);
      });

      it("leaves the base without the added registrations", () => {
        const base = new CodecRegistry(TEST_FORMAT);
        base.extend(new TestCodec("Added@1", undefined));

        expect(base.codecFromTag("Added@1")).toBe(undefined);
      });
    });

    describe("codecFromTag()", () => {
      it("returns the codec registered under a tag", () => {
        const registry = new CodecRegistry(TEST_FORMAT);
        const codec = new TestCodec("Foo@1", undefined);
        registry.register(codec);
        expect(registry.codecFromTag("Foo@1")).toBe(codec);
      });

      it("returns `undefined` for an unregistered tag", () => {
        const registry = new CodecRegistry(TEST_FORMAT);
        registry.register(new TestCodec("Foo@1", undefined));
        expect(registry.codecFromTag("Bar@2")).toBeUndefined();
      });

      it("resolves the last registration when a tag is reused", () => {
        const registry = new CodecRegistry(TEST_FORMAT);
        const first = new TestCodec("Dup@1", undefined);
        const second = new TestCodec("Dup@1", undefined);
        registry.register(first);
        registry.register(second);
        expect(registry.codecFromTag("Dup@1")).toBe(second);
      });
    });
  });

  describe("frozen instances", () => {
    // `Object.freeze()` cannot reach a private `Map` or `Set`, so each mutator
    // has to refuse on its own; these cases pin that each one does.

    describe("register()", () => {
      it("throws", () => {
        const registry = Object.freeze(new CodecRegistry(TEST_FORMAT));
        expect(() => registry.register(new TestCodec("Nope@1", undefined)))
          .toThrow("Cannot modify frozen `CodecRegistry`");
      });
    });

    describe("registerPrimitive()", () => {
      it("throws", () => {
        const registry = Object.freeze(new CodecRegistry(TEST_FORMAT));
        expect(() =>
          registry.registerPrimitive(
            "bigint",
            new TestCodec("Nope@1", undefined),
          )
        ).toThrow("Cannot modify frozen `CodecRegistry`");
      });
    });

    describe("registerSelfRep()", () => {
      it("throws", () => {
        const registry = Object.freeze(new CodecRegistry(TEST_FORMAT));
        expect(() => registry.registerSelfRep("string"))
          .toThrow("Cannot modify frozen `CodecRegistry`");
      });
    });

    it("still returns a codec for a registered tag", () => {
      const base = new CodecRegistry(TEST_FORMAT);
      const codec = new TestCodec("Readable@1", undefined);
      base.register(codec);
      Object.freeze(base);

      expect(base.codecFromTag("Readable@1")).toBe(codec);
    });
  });
});
