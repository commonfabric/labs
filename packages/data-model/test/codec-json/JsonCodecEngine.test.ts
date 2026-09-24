/**
 * The JSON codec end to end: what a value becomes as text and as bytes, and
 * what comes back.
 *
 * The hard part is that JSON is also the escape mechanism. A tagged form is
 * itself a `/`-keyed object, so a plain object that happens to carry such a
 * key is ambiguous with one, and the quoting rules exist to tell the two apart
 * in every direction. Several groups of cases here do nothing but police that
 * boundary.
 *
 * Arrays are the other place the format has to express something JSON cannot.
 * A hole is not `null`, so runs of them are written explicitly, and a run
 * arriving malformed has to be handled rather than trusted.
 *
 * Two invariants run underneath all of it. Encoding is deterministic, key
 * order included, so the same value yields the same text. And decoding
 * produces a deep-frozen result, identically whether it began as text or as
 * bytes -- the places where the decoder hands back an extracted sub-tree
 * directly are sound only if nothing can mutate it afterward.
 *
 * Lenient mode is what happens when a value will not decode at all: it becomes
 * a `ProblematicValue` rather than an exception.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricInstance, type FabricValue, isDeepFrozen } from "@";
import {
  BaseLiveEnvironment,
  BaseNonterminalCodec,
  BaseTerminalCodec,
  CodecRegistry,
  ProblematicStateError,
  ProblematicValue,
  UnknownValue,
} from "@/codec-common";
import { JsonCodecEngine } from "@/codec-json";
import { JSON_FORMAT, type JsonCodecValue } from "@/codec-json/interface.ts";
import {
  createDefaultJsonRegistry,
  jsonFromFabricValue,
  newDefaultJsonCodecEngine,
} from "@/codecs.ts";
import {
  BaseFabricInstance,
  DEEP_CLONE_CORE,
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
  SHALLOW_UNFROZEN_CLONE,
} from "@/fabric-bases";
import { FabricError } from "@/fabric-instances";
import {
  FabricBytes,
  FabricEpochDay,
  FabricEpochNsec,
  FabricRegExp,
  FabricUnavailable,
  UNAVAILABLE_PENDING,
} from "@/fabric-primitives";
import { utf8SortedKeysOf } from "@commonfabric/utils/utf8";

/**
 * Shared test `LiveEnvironment`: `getCell()` always throws (no test
 * here reaches it); `shouldDeepFreeze` is inherited from
 * `BaseLiveEnvironment` (defaults to `true`).
 */
class TestLiveEnvironment extends BaseLiveEnvironment {
  constructor() {
    super(true);
  }

  override getCell(): never {
    throw new Error("getCell not implemented in test runtime");
  }
}

/**
 * A `FabricInstance` with no registered codec, for exercising the encode-side
 * mandate guard (every encoded form must be explicitly represented).
 */
class UnregisteredInstance extends BaseFabricInstance {
  get wireTypeTag(): string {
    return "Unregistered@1";
  }

  //
  // Unreached stubs
  //
  // The encode-side mandate guard fires before any of these are reached.
  //

  [DEEP_FREEZE](_subFreeze: (value: FabricValue) => FabricValue): FabricValue {
    throw new Error("not implemented");
  }

  [IS_DEEP_FROZEN](
    _subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean {
    throw new Error("not implemented");
  }

  protected [DEEP_CLONE_CORE](_frozen: boolean): FabricInstance {
    throw new Error("not implemented");
  }

  protected [SHALLOW_UNFROZEN_CLONE](): FabricInstance {
    return new UnregisteredInstance();
  }
}

/**
 * The encoding prefix tag, named once for the assertions below that pin the
 * encoded form or that feed the decoder deliberately broken input. Bridging
 * between encoded strings and codec-value trees does NOT go through this --
 * that is what `JsonCodecEngine`'s wrap/unwrap helpers are for.
 */
const ENCODING_PREFIX = "fvj1:";

/** Creates a standard test codec (non-lenient) and a mock runtime. */
function makeTestCodec() {
  const jsonCodecEngine = newDefaultJsonCodecEngine();
  const runtime = new TestLiveEnvironment();
  return { jsonCodecEngine, runtime };
}

/** Helper: encode then decode (round-trip) through the public API. */
function roundTrip(value: FabricValue): FabricValue {
  const { jsonCodecEngine, runtime } = makeTestCodec();
  const encoded = jsonCodecEngine.encode(value);
  return jsonCodecEngine.decode(encoded, runtime);
}

/**
 * Helper: encode a value and return the codec-value tree (parsed JSON).
 * Used for assertions about the intermediate codec value.
 */
function toEncodedFormat(value: FabricValue): JsonCodecValue {
  const { jsonCodecEngine } = makeTestCodec();
  const encoded = jsonCodecEngine.encode(value);
  return JSON.parse(
    JsonCodecEngine.unwrapEncodedValueForTesting(encoded),
  ) as JsonCodecValue;
}

/**
 * Helper: decode from a codec-value tree. Stringifies to JSON first (tagged as
 * an encoded value), then feeds through the public decode API.
 */
function fromEncodedFormat(
  data: JsonCodecValue,
  malformed = false,
): FabricValue {
  // Lenient, because much of what this decodes is malformed on purpose and
  // the point is to inspect what the engine made of it; a strict engine
  // raises instead, which the tests below pin separately. `malformed` goes on
  // to the wrap helper, whose own validity check is a strict decode, and so
  // rejects exactly the payloads these cases are made of.
  const jsonCodecEngine = newDefaultJsonCodecEngine({ lenient: true });
  const runtime = new TestLiveEnvironment();
  return jsonCodecEngine.decode(
    JsonCodecEngine.wrapEncodedValueForTesting(
      JSON.stringify(data),
      malformed,
    ),
    runtime,
  );
}

describe("JsonCodecEngine", () => {
  describe("`registry` constructor option", () => {
    // An empty registry recognizes no class and no tag, so it differs from the
    // built-in one on any fabric class. `FabricError` is the probe: the
    // built-in registry encodes it and decodes it back, and these cases assert
    // the empty registry's behavior instead, in both directions.

    it("throws on encode for a class the supplied registry lacks", () => {
      const jsonCodecEngine = new JsonCodecEngine({
        registry: new CodecRegistry(JSON_FORMAT),
      });
      const value = FabricError.fromNativeError(new Error("boom"));

      expect(() => jsonCodecEngine.encode(value)).toThrow(
        "No codec registered for `FabricSpecialObject` subclass `FabricError`.",
      );
    });

    it("returns an `UnknownValue` on decode for a tag the supplied registry lacks", () => {
      const encoded = newDefaultJsonCodecEngine().encode(
        FabricError.fromNativeError(new Error("boom")),
      );
      const jsonCodecEngine = new JsonCodecEngine({
        registry: new CodecRegistry(JSON_FORMAT),
      });

      const result = jsonCodecEngine.decode(
        encoded,
        new TestLiveEnvironment(),
      );

      expect(result).toBeInstanceOf(UnknownValue);
      expect((result as UnknownValue).wireTypeTag).toBe("Error@1");
    });
  });

  describe("terminal vs. nonterminal codecs", () => {
    // The two kinds differ in exactly one respect: whether the walker
    // processes the state a codec produces. Every codec this package registers
    // for JSON hides that difference, because each of their states is a
    // self-representing value -- one of `null`, `boolean`, `number`, `string`
    // -- and the walker is the identity on those by definition.
    //
    // Nothing in the types requires that. `JsonCodecValue` admits structure,
    // and a structured state is where the two kinds part company.
    //
    // These cases use a state that does not survive one: a plain object
    // carrying a `/`-prefixed key. The walker escapes such an object with
    // `/quote` on the way out, and decodes the tag it names on the way back,
    // so which kind of codec produced it is legible in the encoded form and in
    // what `decode()` is handed.

    const PROBE_TAG = "Probe@1";
    const PROBE_STATE = Object.freeze({ "/Bytes@1": "AQID" });

    /** Stateless instance, existing only to have a class to dispatch on. */
    class ProbeInstance extends BaseFabricInstance {
      get wireTypeTag(): string {
        return PROBE_TAG;
      }

      [DEEP_FREEZE](
        _subFreeze: (value: FabricValue) => FabricValue,
      ): FabricValue {
        return this;
      }

      [IS_DEEP_FROZEN](
        _subIsDeepFrozen: (value: FabricValue) => boolean,
      ): boolean {
        return true;
      }

      protected [SHALLOW_UNFROZEN_CLONE](): FabricInstance {
        return new ProbeInstance();
      }

      protected [DEEP_CLONE_CORE](_frozen: boolean): FabricInstance {
        return new ProbeInstance();
      }
    }

    class ProbeTerminalCodec extends BaseTerminalCodec<JsonCodecValue> {
      /** State most recently handed to `decode()`. */
      received: JsonCodecValue = null;

      constructor() {
        super(PROBE_TAG, ProbeInstance);
      }

      encode(_value: FabricValue): JsonCodecValue {
        return PROBE_STATE;
      }

      canDecode(_state: JsonCodecValue): _state is JsonCodecValue {
        return true;
      }

      decode(_typeTag: string, state: JsonCodecValue): FabricValue {
        this.received = state;
        return new ProbeInstance();
      }
    }

    class ProbeNonterminalCodec extends BaseNonterminalCodec {
      /** State most recently handed to `decode()`. */
      received: FabricValue = null;

      constructor() {
        super(PROBE_TAG, ProbeInstance);
      }

      encode(_value: FabricValue): FabricValue {
        return PROBE_STATE;
      }

      canDecode(_state: FabricValue): _state is FabricValue {
        return true;
      }

      decode(_typeTag: string, state: FabricValue): FabricValue {
        this.received = state;
        return new ProbeInstance();
      }
    }

    /** Builds a codec over the default registry plus the given probe. */
    function codecWith(
      probe: ProbeTerminalCodec | ProbeNonterminalCodec,
    ): JsonCodecEngine {
      return new JsonCodecEngine({
        registry: createDefaultJsonRegistry().extend(probe),
      });
    }

    /** The encoded tree a probe produces for a `ProbeInstance`. */
    function encodedFormatFrom(
      probe: ProbeTerminalCodec | ProbeNonterminalCodec,
    ): JsonCodecValue {
      const encoded = codecWith(probe).encode(new ProbeInstance());
      return JSON.parse(
        encoded.slice(ENCODING_PREFIX.length),
      ) as JsonCodecValue;
    }

    it("writes a terminal codec's state to the encoded form untouched", () => {
      expect(encodedFormatFrom(new ProbeTerminalCodec())).toEqual({
        [`/${PROBE_TAG}`]: { "/Bytes@1": "AQID" },
      });
    });

    it("expands a nonterminal codec's state on the way to the encoded form", () => {
      // The `/quote` wrapper is the walker's mark: it saw a plain object with
      // a reserved key and escaped it.

      expect(encodedFormatFrom(new ProbeNonterminalCodec())).toEqual({
        [`/${PROBE_TAG}`]: { "/quote": { "/Bytes@1": "AQID" } },
      });
    });

    it("hands a terminal codec the encoded state exactly as it arrived", () => {
      const probe = new ProbeTerminalCodec();

      codecWith(probe).decode(
        JsonCodecEngine.wrapEncodedValueForTesting(
          JSON.stringify({ [`/${PROBE_TAG}`]: { "/Bytes@1": "AQID" } }),
          true,
        ),
        new TestLiveEnvironment(),
      );

      expect(probe.received).toEqual({ "/Bytes@1": "AQID" });
    });

    it("lets a terminal codec judge a state that names a tag", () => {
      // A terminal codec's state is its own business, so a tag appearing
      // inside one is just data rather than something the walker expands.
      // `BigInt@1` sees a non-string and rejects it, which is the judgment
      // this pins; a lenient engine keeps that verdict as a value, naming the
      // tag whose codec made it.

      const jsonCodecEngine = newDefaultJsonCodecEngine({ lenient: true });

      const result = jsonCodecEngine.decode(
        JsonCodecEngine.wrapEncodedValueForTesting(
          JSON.stringify({ "/BigInt@1": { "/Undefined@1": "bad" } }),
          true, // Undecodable on purpose; that is what this test is about.
        ),
        new TestLiveEnvironment(),
      );

      expect(result).toBeInstanceOf(ProblematicValue);
      expect((result as unknown as ProblematicValue).wireTypeTag).toBe(
        "BigInt@1",
      );
    });

    it("throws a codec's rejection when not lenient, tag borne", () => {
      // The same rejection, through a strict engine. `BigInt@1` reports by
      // RETURNING a `ProblematicValue` rather than throwing, and the engine
      // settles the two reporting styles into one answer.

      const jsonCodecEngine = newDefaultJsonCodecEngine();

      expect(jsonCodecEngine.lenient).toBe(false);

      try {
        jsonCodecEngine.decode(
          JsonCodecEngine.wrapEncodedValueForTesting(
            JSON.stringify({ "/BigInt@1": { "/Undefined@1": "bad" } }),
            true, // Undecodable on purpose; that is what this test is about.
          ),
          new TestLiveEnvironment(),
        );
        throw new Error("Should have thrown.");
      } catch (e) {
        expect(e).toBeInstanceOf(ProblematicStateError);
        expect((e as ProblematicStateError).wireTypeTag).toBe("BigInt@1");

        // The tag rides on the error rather than being spliced into the
        // message, so the codec's own words reach a caller unaltered. Taken
        // from the lenient run rather than restated here, so that this
        // compares the two dispositions of one rejection.
        const lenient = newDefaultJsonCodecEngine({ lenient: true }).decode(
          JsonCodecEngine.wrapEncodedValueForTesting(
            JSON.stringify({ "/BigInt@1": { "/Undefined@1": "bad" } }),
            true,
          ),
          new TestLiveEnvironment(),
        );

        expect(lenient).toBeInstanceOf(ProblematicValue);
        expect((e as Error).message).toBe((lenient as ProblematicValue).error);
      }
    });

    it("hands a nonterminal codec state that has been expanded", () => {
      const probe = new ProbeNonterminalCodec();

      codecWith(probe).decode(
        JsonCodecEngine.wrapEncodedValueForTesting(
          JSON.stringify({ [`/${PROBE_TAG}`]: { "/Bytes@1": "AQID" } }),
          true,
        ),
        new TestLiveEnvironment(),
      );

      expect(probe.received).toBeInstanceOf(FabricBytes);
    });
  });

  describe("a string that is not this format's serialized form", () => {
    const NOT_OURS = '{"a":1}';

    it("throws when strict", () => {
      expect(() =>
        newDefaultJsonCodecEngine().decode(NOT_OURS, new TestLiveEnvironment())
      )
        .toThrow(/Not a JSON-encoded `FabricValue` string/);
    });

    it("returns a `ProblematicValue` when lenient", () => {
      // A serialized form is data off a channel like any other, so being the
      // wrong shape for this format settles against `lenient` exactly as a
      // malformation inside a well-formed one does. Anything else would make
      // the outermost check the one refusal `lenient` could not contain.

      const decoded = newDefaultJsonCodecEngine({ lenient: true })
        .decode(NOT_OURS, new TestLiveEnvironment());

      expect(decoded).toBeInstanceOf(ProblematicValue);
      expect((decoded as ProblematicValue).error)
        .toMatch(/Not a JSON-encoded `FabricValue` string/);
    });
    it("throws for a well-tagged but unparseable payload when strict", () => {
      const bad = "fvj1:{not json";

      expect(() =>
        newDefaultJsonCodecEngine().decode(bad, new TestLiveEnvironment())
      )
        .toThrow(/Malformed JSON in an encoded `FabricValue` string/);
    });

    it("returns a `ProblematicValue` for an unparseable payload when lenient", () => {
      // The tag says the form is ours and the text under it is not JSON. That
      // is a refusal of the serialized form just as an absent tag is, so it
      // settles the same way -- otherwise `lenient` would contain one half of
      // "is this well-formed?" and not the other.

      const decoded = newDefaultJsonCodecEngine({ lenient: true })
        .decode("fvj1:{not json", new TestLiveEnvironment());

      expect(decoded).toBeInstanceOf(ProblematicValue);

      const problem = decoded as ProblematicValue;

      // All three facts, not just the message: the tag and state are what
      // carry the refusal's account of what arrived, and a settlement that
      // dropped them would still match on the message alone.
      expect(problem.error)
        .toMatch(/Malformed JSON in an encoded `FabricValue` string/);
      expect(problem.wireTypeTag).toBe("");
      expect(problem.state).toBe("{not json");

      // Deep-frozen like any other decoded result, so a caller cannot alter
      // the account it was handed.
      expect(Object.isFrozen(problem)).toBe(true);
    });
  });

  describe("primitives round-trip", () => {
    it("passes through `null`", () => {
      expect(roundTrip(null)).toBe(null);
    });

    it("passes through `true`", () => {
      expect(roundTrip(true)).toBe(true);
    });

    it("passes through `false`", () => {
      expect(roundTrip(false)).toBe(false);
    });

    it("passes through `0`", () => {
      expect(roundTrip(0)).toBe(0);
    });

    it("passes through `42`", () => {
      expect(roundTrip(42)).toBe(42);
    });

    it("passes through `3.14`", () => {
      expect(roundTrip(3.14)).toBe(3.14);
    });

    it("passes through empty string", () => {
      expect(roundTrip("")).toBe("");
    });

    it("passes through `hello`", () => {
      expect(roundTrip("hello")).toBe("hello");
    });

    it("passes through strings with special characters", () => {
      expect(roundTrip("with\nnewlines")).toBe("with\nnewlines");
      expect(roundTrip("with\ttabs")).toBe("with\ttabs");
      expect(roundTrip('with"quotes')).toBe('with"quotes');
    });

    it("passes through lone surrogates in strings and property names", () => {
      expect(roundTrip("\ud800")).toBe("\ud800");
      expect(roundTrip("a\udc00b")).toBe("a\udc00b");
      expect(roundTrip({ "\udbff": ["\udfff"] })).toEqual({
        "\udbff": ["\udfff"],
      });
    });

    it("passes through `Number.MAX_SAFE_INTEGER`", () => {
      expect(roundTrip(Number.MAX_SAFE_INTEGER)).toBe(
        Number.MAX_SAFE_INTEGER,
      );
    });

    it("passes through negative numbers", () => {
      expect(roundTrip(-1)).toBe(-1);
      expect(roundTrip(-3.14)).toBe(-3.14);
    });
  });

  describe("tagged-type round-trips through the full stack", () => {
    // Representative coverage that the encode→tag-wrap→decode mechanism works
    // for the standalone-codec and `FabricPrimitive` types, including nesting
    // in arrays and objects. Per-codec encode/decode detail lives in each
    // type's own unit test (e.g. `BigIntCodec.test.ts`,
    // `FabricEpochNsec.test.ts`).

    it("round-trips `undefined` at top level, in arrays, and as object values", () => {
      expect(roundTrip(undefined)).toBe(undefined);

      const arr = [1, undefined, 3];
      const arrResult = roundTrip(arr) as FabricValue[];
      expect(arrResult[0]).toBe(1);
      expect(arrResult[1]).toBe(undefined);
      expect(1 in arrResult).toBe(true); // not a hole
      expect(arrResult[2]).toBe(3);

      const obj = { a: 1, b: undefined };
      const objResult = roundTrip(obj) as Record<string, FabricValue>;
      expect(objResult.a).toBe(1);
      expect(objResult.b).toBe(undefined);
      expect("b" in objResult).toBe(true); // key preserved
    });

    it("round-trips `bigint` at top level, in arrays, and as object values", () => {
      expect(roundTrip(42n)).toBe(42n);

      const arr = [1, 42n, "hello"];
      const arrResult = roundTrip(arr) as FabricValue[];
      expect(arrResult[0]).toBe(1);
      expect(arrResult[1]).toBe(42n);
      expect(arrResult[2]).toBe("hello");

      const obj = { a: 1, b: 42n };
      const objResult = roundTrip(obj) as Record<string, FabricValue>;
      expect(objResult.a).toBe(1);
      expect(objResult.b).toBe(42n);
    });

    it("round-trips special numbers (`-0`/`NaN`/`±Infinity`) at top level, in arrays, and as object values", () => {
      // `+0` is not a special number; it round-trips as a plain JSON number.
      expect(roundTrip(0)).toBe(0);
      expect(Object.is(roundTrip(-0), -0)).toBe(true);
      expect(Number.isNaN(roundTrip(NaN))).toBe(true);
      expect(roundTrip(Infinity)).toBe(Infinity);
      expect(roundTrip(-Infinity)).toBe(-Infinity);

      const arr = [1, NaN, -0, Infinity, -Infinity, 2];
      const arrResult = roundTrip(arr) as number[];
      expect(arrResult[0]).toBe(1);
      expect(Number.isNaN(arrResult[1])).toBe(true);
      expect(Object.is(arrResult[2], -0)).toBe(true);
      expect(arrResult[3]).toBe(Infinity);
      expect(arrResult[4]).toBe(-Infinity);
      expect(arrResult[5]).toBe(2);

      const obj = {
        nz: -0,
        nan: NaN,
        pinf: Infinity,
        ninf: -Infinity,
      };
      const objResult = roundTrip(obj) as Record<string, number>;
      expect(Object.is(objResult.nz, -0)).toBe(true);
      expect(Number.isNaN(objResult.nan)).toBe(true);
      expect(objResult.pinf).toBe(Infinity);
      expect(objResult.ninf).toBe(-Infinity);
    });

    it("round-trips interned symbols at top level, in arrays, and as object values", () => {
      const top = roundTrip(Symbol.for("hello"));
      expect(typeof top).toBe("symbol");
      expect(top).toBe(Symbol.for("hello"));

      const arr = [
        Symbol.for("a"),
        1,
        Symbol.for("b"),
      ];
      const arrResult = roundTrip(arr) as unknown[];
      expect(arrResult[0]).toBe(Symbol.for("a"));
      expect(arrResult[1]).toBe(1);
      expect(arrResult[2]).toBe(Symbol.for("b"));

      const obj = {
        kind: Symbol.for("event"),
        flag: Symbol.for("ready"),
      };
      const objResult = roundTrip(obj) as Record<string, unknown>;
      expect(objResult.kind).toBe(Symbol.for("event"));
      expect(objResult.flag).toBe(Symbol.for("ready"));
    });

    it("round-trips an interned symbol whose key has a lone surrogate", () => {
      expect(roundTrip(Symbol.for("\ud800"))).toBe(Symbol.for("\ud800"));
      expect(roundTrip({ kind: Symbol.for("a\udc00") })).toEqual({
        kind: Symbol.for("a\udc00"),
      });
    });

    it("loudly fails to encode an unencodable value (unique / uninterned `Symbol`)", () => {
      // `SymbolCodec.canEncode()` returns false for unique symbols (no
      // registry key), so no codec claims them. A default-configured
      // `JsonCodecEngine` must then fail loudly rather than silently flatten the
      // symbol to `{}`.

      const { jsonCodecEngine } = makeTestCodec();
      expect(() => jsonCodecEngine.encode(Symbol("nope"))).toThrow(
        "no applicable codec",
      );
    });

    it("round-trips `FabricEpochNsec` at top level and in nested structures", () => {
      const top = roundTrip(
        new FabricEpochNsec(1704067200000000000n),
      ) as unknown as FabricEpochNsec;
      expect(top).toBeInstanceOf(FabricEpochNsec);
      expect(top.value).toBe(1704067200000000000n);

      const obj = {
        timestamp: new FabricEpochNsec(42000000000n),
        label: "test",
      };
      const result = roundTrip(obj) as Record<string, FabricValue>;
      expect(result.label).toBe("test");
      const ts = result.timestamp as unknown as FabricEpochNsec;
      expect(ts).toBeInstanceOf(FabricEpochNsec);
      expect(ts.value).toBe(42000000000n);
    });

    it("round-trips `FabricEpochDay` at top level and in nested structures", () => {
      const top = roundTrip(
        new FabricEpochDay(19723n),
      ) as unknown as FabricEpochDay;
      expect(top).toBeInstanceOf(FabricEpochDay);
      expect(top.value).toBe(19723n);

      const obj = {
        date: new FabricEpochDay(19723n),
        label: "birthday",
      };
      const result = roundTrip(obj) as Record<string, FabricValue>;
      expect(result.label).toBe("birthday");
      const d = result.date as unknown as FabricEpochDay;
      expect(d).toBeInstanceOf(FabricEpochDay);
      expect(d.value).toBe(19723n);
    });

    it("round-trips `FabricRegExp` at top level and in nested structures", () => {
      const top = roundTrip(
        new FabricRegExp(/ab+c/gi),
      ) as unknown as FabricRegExp;
      expect(top).toBeInstanceOf(FabricRegExp);
      expect(top.source).toBe("ab+c");
      expect(top.flags).toBe("gi");
      expect(top.flavor).toBe("es2025");

      const obj = {
        pattern: new FabricRegExp(/\d+/g),
        label: "digits",
      };
      const result = roundTrip(obj) as Record<string, FabricValue>;
      expect(result.label).toBe("digits");
      const re = result.pattern as unknown as FabricRegExp;
      expect(re).toBeInstanceOf(FabricRegExp);
      expect(re.source).toBe("\\d+");
      expect(re.flags).toBe("g");
    });

    it("round-trips `FabricUnavailable` at top level and in nested structures", () => {
      const top = roundTrip(
        new FabricUnavailable("error", "general", "boom"),
      ) as unknown as FabricUnavailable;
      expect(top).toBeInstanceOf(FabricUnavailable);
      expect(top.reason).toBe("error");
      expect(top.errorMessage).toBe("boom");

      const obj = {
        status: new FabricUnavailable("pending"),
        label: "later",
      };
      const result = roundTrip(obj) as Record<string, FabricValue>;
      expect(result.label).toBe("later");
      // A message-less reason decodes to its prefab, through the engine as
      // through the codec alone.
      expect(result.status).toBe(UNAVAILABLE_PENDING);
    });
  });

  describe("un-registered instance types", () => {
    it("throws when encoding a `FabricInstance` with no registered codec", () => {
      const { jsonCodecEngine } = makeTestCodec();
      expect(() => jsonCodecEngine.encode(new UnregisteredInstance()))
        .toThrow("No codec registered");
    });

    it("throws on a non-plain object with no codec (e.g. a raw `Map`)", () => {
      // A non-plain object that is neither a FabricInstance nor codec-handled
      // must fail loudly, not be mis-encoded as a plain object.

      const { jsonCodecEngine } = makeTestCodec();
      expect(() => jsonCodecEngine.encode(new Map() as unknown as FabricValue))
        .toThrow("no applicable codec");
    });
  });

  describe("dense arrays", () => {
    it("round-trips empty array", () => {
      const result = roundTrip([]) as FabricValue[];
      expect(result).toEqual([]);
    });

    it("round-trips single-element array", () => {
      const result = roundTrip([42]) as FabricValue[];
      expect(result.length).toBe(1);
      expect(result[0]).toBe(42);
    });

    it("round-trips mixed-type array", () => {
      const arr = [null, "str", true, 42];
      const result = roundTrip(arr) as FabricValue[];
      expect(result[0]).toBe(null);
      expect(result[1]).toBe("str");
      expect(result[2]).toBe(true);
      expect(result[3]).toBe(42);
    });

    it("round-trips nested arrays", () => {
      const arr = [[1, 2], [3, [4, 5]]];
      const result = roundTrip(arr) as FabricValue[];
      expect((result[0] as FabricValue[])[0]).toBe(1);
      expect((result[0] as FabricValue[])[1]).toBe(2);
      expect(
        ((result[1] as FabricValue[])[1] as FabricValue[])[0],
      ).toBe(4);
    });
  });

  describe("malformed `/hole` runs", () => {
    // A run's count reaches the write index directly, so an unchecked one has
    // consequences unrelated to what was wrong with it: a string concatenates
    // onto the index, and a negative or fractional count makes the length
    // assignment throw. Wire data is untrusted, so each is reported instead.

    /** Decodes a hand-built array, which is deliberately not encodable. */
    function decodeArray(entries: JsonCodecValue[]): FabricValue {
      // Lenient; see `fromEncodedFormat()` above.
      const jsonCodecEngine = newDefaultJsonCodecEngine({ lenient: true });
      const runtime = new TestLiveEnvironment();
      return jsonCodecEngine.decode(
        JsonCodecEngine.wrapEncodedValueForTesting(
          JSON.stringify(entries),
          true,
        ),
        runtime,
      );
    }

    const BAD_COUNTS: readonly (readonly [string, JsonCodecValue])[] = [
      ["a string", "2"],
      ["a negative number", -5],
      ["zero", 0],
      ["a fraction", 1.5],
      ["an object", { x: 1 }],
      ["`null`", null],
    ];

    for (const [label, count] of BAD_COUNTS) {
      it(`returns a \`ProblematicValue\` given ${label} as a count`, () => {
        const result = decodeArray(["a", { "/hole": count }, "b"]);

        expect(result).toBeInstanceOf(ProblematicValue);
        const prob = result as unknown as ProblematicValue;
        expect(prob.wireTypeTag).toBe("hole");
        expect(prob.state).toEqual(count);
        expect(prob.error).toContain("expected a positive integer count");
      });
    }

    it("returns a `ProblematicValue` given a count past the array maximum", () => {
      // A safe integer can still be more elements than an array can hold, in
      // which case setting the length is what would fail.

      const result = decodeArray(["a", { "/hole": 2 ** 40 }, "b"]);

      expect(result).toBeInstanceOf(ProblematicValue);
      expect((result as unknown as ProblematicValue).error).toContain(
        "past the",
      );
    });

    it("returns a `ProblematicValue` when later entries carry the total past it", () => {
      // The run alone is exactly what an array can hold; the two entries
      // placed after it are what make the total too large.

      const result = decodeArray([{ "/hole": 2 ** 32 - 1 }, "a", "b"]);

      expect(result).toBeInstanceOf(ProblematicValue);
      expect((result as unknown as ProblematicValue).error).toContain(
        "past the",
      );
    });

    it("places an entry at the last index a run can leave free", () => {
      // The bound is on length, where the largest index is one less, so this
      // is where an off-by-one would show: the entry lands at the last legal
      // index and the array is exactly as long as one may be. A step further
      // and the entry would become a plain property rather than an element,
      // which the previous case is what catches.

      const result = decodeArray(
        [{ "/hole": (2 ** 32 - 1) - 1 }, "z"],
      ) as FabricValue[];

      expect(result.length).toBe(2 ** 32 - 1);
      expect(result[(2 ** 32 - 1) - 1]).toBe("z");
    });

    it("decodes a run reaching exactly the array maximum", () => {
      const result = decodeArray([{ "/hole": 2 ** 32 - 1 }]) as FabricValue[];

      expect(result.length).toBe(2 ** 32 - 1);
    });

    it("decodes a run of one, the smallest a count may be", () => {
      const result = decodeArray(["a", { "/hole": 1 }, "b"]) as FabricValue[];

      expect(result.length).toBe(3);
      expect(1 in result).toBe(false);
      expect(result[2]).toBe("b");
    });
  });

  describe("sparse arrays", () => {
    it("encodes `[1,,3]` with `/hole`", () => {
      // deno-lint-ignore no-sparse-arrays

      const arr = [1, , 3];
      const result = toEncodedFormat(arr) as JsonCodecValue[];
      expect(result.length).toBe(3);
      expect(result[0]).toBe(1);
      expect(result[1]).toEqual({ "/hole": 1 });
      expect(result[2]).toBe(3);
    });

    it("round-trips `[1,,3]` preserving holes", () => {
      // deno-lint-ignore no-sparse-arrays

      const arr = [1, , 3];
      const result = roundTrip(arr) as FabricValue[];
      expect(result.length).toBe(3);
      expect(result[0]).toBe(1);
      expect(1 in result).toBe(false); // true hole
      expect(result[2]).toBe(3);
    });

    it("encodes consecutive holes as run-length encoded", () => {
      // deno-lint-ignore no-sparse-arrays

      const arr = [1, , , , 5];
      const result = toEncodedFormat(arr) as JsonCodecValue[];
      expect(result.length).toBe(3); // [1, {"/hole": 3}, 5]
      expect(result[0]).toBe(1);
      expect(result[1]).toEqual({ "/hole": 3 });
      expect(result[2]).toBe(5);
    });

    it("round-trips `[1,,,,5]`", () => {
      // deno-lint-ignore no-sparse-arrays

      const arr = [1, , , , 5];
      const result = roundTrip(arr) as FabricValue[];
      expect(result.length).toBe(5);
      expect(result[0]).toBe(1);
      expect(1 in result).toBe(false);
      expect(2 in result).toBe(false);
      expect(3 in result).toBe(false);
      expect(result[4]).toBe(5);
    });

    it("round-trips all-holes array `[,,,]`", () => {
      // deno-lint-ignore no-sparse-arrays

      const arr = [, , ,];
      const result = roundTrip(arr) as FabricValue[];
      expect(result.length).toBe(3);
      expect(0 in result).toBe(false);
      expect(1 in result).toBe(false);
      expect(2 in result).toBe(false);
    });

    it("round-trips very sparse array", () => {
      const arr = new Array(1000001) as FabricValue[];
      arr[1000000] = "x";
      const result = roundTrip(arr) as FabricValue[];
      expect(result.length).toBe(1000001);
      expect(0 in result).toBe(false);
      expect(999999 in result).toBe(false);
      expect(result[1000000]).toBe("x");
    });

    it("round-trips interleaved holes and `undefined`", () => {
      // [1, <hole>, undefined, <hole>, 3]
      const arr = new Array(5) as FabricValue[];
      arr[0] = 1;
      // index 1 is a hole
      arr[2] = undefined;
      // index 3 is a hole
      arr[4] = 3;
      const result = roundTrip(arr) as FabricValue[];
      expect(result.length).toBe(5);
      expect(result[0]).toBe(1);
      expect(1 in result).toBe(false); // hole
      expect(result[2]).toBe(undefined);
      expect(2 in result).toBe(true); // not a hole
      expect(3 in result).toBe(false); // hole
      expect(result[4]).toBe(3);
    });

    it("encodes interleaved holes/`undefined` correctly", () => {
      const arr = new Array(5) as FabricValue[];
      arr[0] = 1;
      arr[2] = undefined;
      arr[4] = 3;
      const result = toEncodedFormat(arr) as JsonCodecValue[];
      expect(result).toEqual([
        1,
        { "/hole": 1 },
        { "/Undefined@1": null },
        { "/hole": 1 },
        3,
      ]);
    });
  });

  describe("plain objects", () => {
    it("round-trips empty object", () => {
      const result = roundTrip({}) as Record<string, FabricValue>;
      expect(Object.keys(result)).toEqual([]);
    });

    it("round-trips simple object", () => {
      const obj = { a: 1, b: "two", c: true };
      const result = roundTrip(obj) as Record<string, FabricValue>;
      expect(result.a).toBe(1);
      expect(result.b).toBe("two");
      expect(result.c).toBe(true);
    });

    it("round-trips nested objects", () => {
      const obj = { outer: { inner: 42 } };
      const result = roundTrip(obj) as Record<
        string,
        Record<string, FabricValue>
      >;
      expect(result.outer!.inner).toBe(42);
    });

    it("preserves `undefined` values in objects", () => {
      const obj = { a: 1, b: undefined };
      const result = roundTrip(obj) as Record<string, FabricValue>;
      expect(result.a).toBe(1);
      expect(result.b).toBe(undefined);
      expect("b" in result).toBe(true);
    });

    describe("key ordering (Section 10)", () => {
      it("emits keys in UTF-8 byte order for a bare plain object", () => {
        const obj = { c: 3, a: 1, b: 2 };
        const encoded = toEncodedFormat(obj) as Record<string, JsonCodecValue>;
        expect(Object.keys(encoded)).toEqual(["a", "b", "c"]);
      });

      it("emits keys in UTF-8 byte order regardless of insertion order", () => {
        const obj1 = { x: 1, y: 2, z: 3 };
        const obj2 = { z: 3, x: 1, y: 2 };
        const obj3 = { y: 2, z: 3, x: 1 };
        const jsonCodecEngine = newDefaultJsonCodecEngine();
        expect(jsonCodecEngine.encode(obj1)).toBe(jsonCodecEngine.encode(obj2));
        expect(jsonCodecEngine.encode(obj1)).toBe(jsonCodecEngine.encode(obj3));
      });

      it("sorts keys in nested plain objects", () => {
        const obj = {
          b: { z: 1, a: 2 },
          a: 0,
        };
        const encoded = toEncodedFormat(obj) as Record<string, JsonCodecValue>;
        expect(Object.keys(encoded)).toEqual(["a", "b"]);
        const inner = encoded.b as Record<string, JsonCodecValue>;
        expect(Object.keys(inner)).toEqual(["a", "z"]);
      });

      it("sorts keys correctly for supplementary characters (UTF-8 vs UTF-16)", () => {
        // U+10000 (UTF-16: D800 DC00; UTF-8: F0 90 80 80) sorts AFTER U+E000
        // (UTF-16: E000; UTF-8: EE 80 80) in UTF-8 byte order, but BEFORE it in
        // JS native (UTF-16) order. The encoder must use UTF-8 order.

        const obj = {
          ["\u{10000}"]: 1,
          [""]: 2,
        };
        const encoded = toEncodedFormat(obj) as Record<string, JsonCodecValue>;
        expect(Object.keys(encoded)).toEqual(["", "\u{10000}"]);
      });

      it("matches the key order used by `ValueHasher`", () => {
        // Both subsystems must agree on the canonical sort order. Cross-check
        // via `utf8SortedKeysOf`, which is the function `ValueHasher` uses.

        const obj = {
          ["\u{1F600}"]: 1,
          b: 2,
          ["﻿"]: 3,
          a: 4,
        };
        const encoded = toEncodedFormat(obj) as Record<string, JsonCodecValue>;
        expect(Object.keys(encoded)).toEqual([
          ...utf8SortedKeysOf(obj as object),
        ]);
      });
    });
  });

  describe("/object escaping", () => {
    describe("/quote: literal-only /-keyed objects", () => {
      it("emits `/quote` for single-key literal `/`-prefixed object", () => {
        const obj = { "/myKey": "val" };
        expect(toEncodedFormat(obj)).toEqual({ "/quote": { "/myKey": "val" } });
      });

      it('round-trips `{ "/myKey": "val" }`', () => {
        const obj = { "/myKey": "val" };
        const result = roundTrip(obj) as Record<string, FabricValue>;
        expect(result["/myKey"]).toBe("val");
      });

      it('emits `/quote` for `{ "/Link@1": "fake" }` (looks like tag but is literal user data)', () => {
        const obj = { "/Link@1": "fake" };
        expect(toEncodedFormat(obj)).toEqual({
          "/quote": { "/Link@1": "fake" },
        });
      });

      it('round-trips `{ "/Link@1": "fake" }`', () => {
        const obj = { "/Link@1": "fake" };
        const result = roundTrip(obj) as Record<string, FabricValue>;
        expect(result["/Link@1"]).toBe("fake");
      });

      it("emits `/quote` for multi-key literal object with one `/`-prefixed key", () => {
        const obj = { a: 1, "/b": 2 };
        expect(toEncodedFormat(obj)).toEqual({ "/quote": { a: 1, "/b": 2 } });
      });

      it("round-trips multi-key literal object with one `/`-prefixed key", () => {
        const obj = { a: 1, "/b": 2 };
        const result = roundTrip(obj) as Record<string, FabricValue>;
        expect(result["a"]).toBe(1);
        expect(result["/b"]).toBe(2);
      });

      it("emits `/quote` for multi-key literal object with multiple `/`-prefixed keys", () => {
        const obj = { "/a": 1, "/b": 2, c: 3 };
        expect(toEncodedFormat(obj)).toEqual({
          "/quote": { "/a": 1, "/b": 2, c: 3 },
        });
      });

      it("round-trips multi-key literal object with multiple `/`-prefixed keys", () => {
        const obj = { "/a": 1, "/b": 2, c: 3 };
        const result = roundTrip(obj) as Record<string, FabricValue>;
        expect(result["/a"]).toBe(1);
        expect(result["/b"]).toBe(2);
        expect(result["c"]).toBe(3);
      });

      it("emits `/quote` when value is a plain nested object (no `/`-keys inside)", () => {
        const obj = { "/x": { a: 1 } };
        expect(toEncodedFormat(obj)).toEqual({ "/quote": { "/x": { a: 1 } } });
      });

      it("round-trips `/`-keyed object whose value is a plain nested object", () => {
        const obj = { "/x": { a: 1 } };
        const result = roundTrip(obj) as Record<
          string,
          Record<string, FabricValue>
        >;
        expect(result["/x"]!["a"]).toBe(1);
      });

      it("collapses a `/quote` nested inside an array value into the outer one", () => {
        // The array element is itself a literal `/`-keyed object, so it encodes
        // as its own `/quote`. Wrapping the whole structure has to unquote
        // *through* the array; otherwise the inner wrapper survives into the
        // output, and decoding -- which strips exactly one `/quote` layer --
        // hands back the wrapper instead of the object the caller wrote.

        const obj = { "/outer": [{ "/inner": "val" }] };
        expect(toEncodedFormat(obj)).toEqual({
          "/quote": { "/outer": [{ "/inner": "val" }] },
        });

        const result = roundTrip(obj) as Record<string, FabricValue[]>;
        expect(result["/outer"]![0]).toEqual({ "/inner": "val" });
      });
    });

    describe("`/object` over a state that is not an object", () => {
      for (
        const [label, state] of [
          ["a string", "nope"],
          ["a number", 42],
          ["`null`", null],
          ["an array", [1, 2]],
        ] as const
      ) {
        it(`returns a \`ProblematicValue\` for ${label} when lenient`, () => {
          const decoded = fromEncodedFormat(
            { "/object": state } as JsonCodecValue,
            true,
          );

          expect(decoded).toBeInstanceOf(ProblematicValue);
          expect((decoded as ProblematicValue).error)
            .toMatch(/`\/object` state is not an object/);
        });
      }

      it("throws for a state that is not an object when strict", () => {
        const engine = newDefaultJsonCodecEngine();
        const text = JsonCodecEngine.wrapEncodedValueForTesting(
          JSON.stringify({ "/object": "nope" }),
          true,
        );

        expect(() => engine.decode(text, new TestLiveEnvironment()))
          .toThrow(/`\/object` state is not an object/);
      });
    });

    describe("/object: any value requires encoding", () => {
      it("emits `/quote` for doubly-nested `/`-prefixed literal object (whole subtree is literal)", () => {
        const obj = { "/x": { "/y": 123 } };
        const encoded = toEncodedFormat(obj);
        // Whole subtree is deep-literal, so it takes a single `/quote` wrap of
        // the original structure.
        expect(encoded).toEqual({
          "/quote": { "/x": { "/y": 123 } },
        });
        const result = roundTrip(obj) as Record<
          string,
          Record<string, FabricValue>
        >;
        expect(result["/x"]!["/y"]).toBe(123);
      });

      it("uses `/quote` for a literal subtree and `/object` for a Fabric type", () => {
        // All-literal: single /quote wraps the whole structure.
        const literal = { "/x": { "/y": 123 } };
        expect(toEncodedFormat(literal)).toEqual({
          "/quote": { "/x": { "/y": 123 } },
        });

        // Fabric type as value: `/object` with the epoch encoded as its tagged
        // form.
        const withEpoch = {
          "/x": new FabricEpochDay(42n),
        };
        expect(toEncodedFormat(withEpoch)).toEqual({
          "/object": { "/x": { "/EpochDay@1": expect.anything() } },
        });
      });

      it("emits `/object` for `/`-keyed object with `FabricError` value", () => {
        const err = FabricError.fromNativeError(new TypeError("eep!"));
        const obj = { "/x": err };
        const encoded = toEncodedFormat(obj);
        expect(Object.keys(encoded as object)).toEqual(["/object"]);
      });

      it("round-trips `FabricError` as value inside `/`-prefixed key object", () => {
        const err = FabricError.fromNativeError(new TypeError("eep!"));
        const obj = { "/x": err };
        const result = roundTrip(obj) as Record<string, FabricValue>;
        expect(result["/x"]).toBeInstanceOf(FabricError);
        expect((result["/x"] as unknown as FabricError).message).toBe(
          "eep!",
        );
      });

      it("round-trips `FabricEpochDay` as value inside `/`-prefixed key object", () => {
        const day = new FabricEpochDay(42n);
        const obj = { "/x": day };
        const result = roundTrip(obj) as Record<string, FabricValue>;
        expect(result["/x"]).toBeInstanceOf(FabricEpochDay);
        expect((result["/x"] as unknown as FabricEpochDay).value).toBe(42n);
      });

      it("emits `/object` for mixed: literal and encoded values", () => {
        const obj = {
          "/a": "literal",
          "/b": FabricError.fromNativeError(new Error("oops")),
        };
        const encoded = toEncodedFormat(obj);
        expect(Object.keys(encoded as object)).toEqual(["/object"]);
      });

      it("round-trips mixed literal+encoded `/`-keyed object", () => {
        const obj = {
          "/a": "literal",
          "/b": FabricError.fromNativeError(new Error("oops")),
        };
        const result = roundTrip(obj) as Record<string, FabricValue>;
        expect(result["/a"]).toBe("literal");
        expect(result["/b"]).toBeInstanceOf(FabricError);
      });
    });

    describe("general", () => {
      describe("malformed wire", () => {
        it("produces `ProblematicValue` for a multi-key object with a `/`-prefixed key", () => {
          // Wire data without a `/quote` or `/object` wrapper: the decoder must
          // not silently round-trip it as a plain object.

          const data = { a: 1, "/b": 2 } as JsonCodecValue;
          const result = fromEncodedFormat(data, true);
          expect(result).toBeInstanceOf(ProblematicValue);
        });

        it("produces `ProblematicValue` for a bare `/`-keyed object", () => {
          // Per spec §9, a single-key object whose key is bare `/` (empty tag
          // after stripping the leading slash) is an encoding error. Decoding
          // must produce a `ProblematicValue`, not an `UnknownValue` with an
          // empty tag.

          const data = { "/": "x" } as JsonCodecValue;
          const result = fromEncodedFormat(data, true);
          expect(result).toBeInstanceOf(ProblematicValue);
        });
      });

      it("does not wrap plain object with no `/`-prefixed keys", () => {
        const obj = { a: 1, b: 2 };
        expect(toEncodedFormat(obj)).toEqual({ a: 1, b: 2 });
      });

      it("decodes an `/object`-wrapped multi-key object with `/`-prefixed key correctly", () => {
        const data = { "/object": { a: 1, "/b": 2 } } as JsonCodecValue;
        const result = fromEncodedFormat(data) as Record<string, FabricValue>;
        expect(result["a"]).toBe(1);
        expect(result["/b"]).toBe(2);
      });

      it("round-trips nested object containing `/`-prefixed key", () => {
        const obj = { outer: { "/inner": 1 } };
        const result = roundTrip(obj) as Record<
          string,
          Record<string, FabricValue>
        >;
        expect(result["outer"]!["/inner"]).toBe(1);
      });

      it("still routes a single-key `/`-prefixed object through `#unwrapTag()` (no regression)", () => {
        // Single-key `/Tag@N` objects are handled by `#unwrapTag()` rather than
        // the plain-object path, so they produce an `UnknownValue` for the
        // unrecognized tag and never reach the multi-key guard's
        // `ProblematicValue`.

        const data = { "/Future@7": { id: "x" } } as JsonCodecValue;
        const result = fromEncodedFormat(data);
        expect(result).toBeInstanceOf(UnknownValue);
        expect((result as unknown as UnknownValue).wireTypeTag).toBe(
          "Future@7",
        );
      });

      it("strips exactly one `/quote` layer — inner `/quote` is preserved literally", () => {
        // The encoded form `{"/quote": {"/quote": "x"}}` is a `/quote`-wrapped
        // literal whose content happens to be `{"/quote": "x"}`. Decoding must
        // return that inner object as a frozen plain object, and must _not_
        // recurse into it and return just `x`.

        const encoded = { "/quote": { "/quote": "x" } } as JsonCodecValue;
        const result = fromEncodedFormat(encoded) as Record<
          string,
          FabricValue
        >;
        expect(result["/quote"]).toBe("x");
      });

      it("round-trips object whose value is a `/quote`-keyed literal", () => {
        // In `{"/x": {"/quote": "inner"}}`, the value at `/x` is user data
        // that happens to have a `/quote` key. It must survive encode and
        // decode intact.

        const obj = { "/x": { "/quote": "inner" } };
        const result = roundTrip(obj) as Record<
          string,
          Record<string, FabricValue>
        >;
        expect(result["/x"]!["/quote"]).toBe("inner");
      });
    });

    describe("property names this runtime reserves", () => {
      it("produces a `ProblematicValue` for a reserved key", () => {
        // The decoder is a boundary where external bytes enter, and the
        // assignment it rebuilds records with cannot create these names: in a
        // realm that keeps the `__proto__` accessor, the key would be lost and
        // the result's prototype repointed to whatever the bytes carried.
        // Nothing this implementation writes can contain one, so bytes that do
        // are reported rather than decoded.
        //
        // The keys are computed on purpose: in an object literal a bare or
        // quoted `__proto__:` sets the prototype instead of creating a
        // property, so a literal cannot express this encoded shape at all.
        // `JSON.parse()`, which is how such bytes actually arrive, does create
        // the own property.

        expect(
          fromEncodedFormat({ ["__proto__"]: { hostile: true }, a: 1 }, true),
        )
          .toBeInstanceOf(ProblematicValue);
        expect(fromEncodedFormat({ ["constructor"]: "c" }, true))
          .toBeInstanceOf(ProblematicValue);
      });

      it("throws rather than encoding a reserved key", () => {
        // The encode side is the caller's own value rather than a channel's,
        // so it raises where the decode side reports. Leaving it unguarded is
        // damage either way: on a host with the standard `__proto__` accessor
        // the key is dropped in the rebuild, and on one without, it reaches
        // the wire as text this same decoder refuses -- written and never
        // readable.

        for (const key of ["__proto__", "constructor"]) {
          const value = Object.defineProperty({ a: 1 }, key, {
            value: "payload",
            enumerable: true,
            configurable: true,
            writable: true,
          });

          // `encode()` directly rather than `toEncodedFormat()`: that helper
          // round-trips through the testing unwrap, which decodes, so a test
          // written against it passes on the DECODE guard and says nothing
          // about this one.
          const { jsonCodecEngine } = makeTestCodec();

          expect(() => jsonCodecEngine.encode(value)).toThrow(/reserves/);
        }
      });

      it("produces a `ProblematicValue` for a reserved key nested in the graph", () => {
        const result = fromEncodedFormat({
          nested: { ["__proto__"]: 1 },
        }, true) as Record<string, unknown>;
        expect(result.nested).toBeInstanceOf(ProblematicValue);
        expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      });

      it("produces a `ProblematicValue` for a reserved key inside `/object`", () => {
        expect(fromEncodedFormat({ "/object": { ["__proto__"]: 1 } }, true))
          .toBeInstanceOf(ProblematicValue);
      });

      it("leaves `Object.prototype` untouched where the accessor is standard", () => {
        // The refusal above is checked in Deno, which replaces
        // `Object.prototype.__proto__` with a setter that defines an own
        // property -- so a decoder that assigned the key would look correct
        // here no matter what. This installs the standard accessor, which is
        // what browsers have and what this code also runs under, and pins the
        // outcome the refusal exists to produce: nothing decoded, and no
        // prototype repointed.

        const saved = Object.getOwnPropertyDescriptor(
          Object.prototype,
          "__proto__",
        );
        try {
          Object.defineProperty(Object.prototype, "__proto__", {
            configurable: true,
            get(this: object) {
              return Object.getPrototypeOf(this);
            },
            set(this: object, v: unknown) {
              // Spec-faithful: a no-op unless the value is an object or `null`.
              if ((typeof v === "object") || (typeof v === "function")) {
                Object.setPrototypeOf(this, v as object | null);
              }
            },
          });

          const hostile = { hostile: true };
          expect(fromEncodedFormat({ ["__proto__"]: hostile, a: 1 }, true))
            .toBeInstanceOf(ProblematicValue);

          const nested = fromEncodedFormat({
            deep: { ["__proto__"]: hostile },
          }, true) as Record<string, unknown>;
          expect(nested.deep).toBeInstanceOf(ProblematicValue);
          expect(Object.getPrototypeOf(nested)).toBe(Object.prototype);

          // The payload reached nobody: not the decoded records, and not the
          // shared prototype every object in the process inherits from.
          expect(
            (Object.prototype as Record<string, unknown>).hostile,
          ).toBe(undefined);
          expect(({} as Record<string, unknown>).hostile).toBe(undefined);
        } finally {
          if (saved === undefined) {
            delete (Object.prototype as Record<string, unknown>)["__proto__"];
          } else {
            Object.defineProperty(Object.prototype, "__proto__", saved);
          }
        }
      });
    });
  });

  describe("/quote handling", () => {
    it("decodes `/quote` as literal (no inner decoding)", () => {
      const data = {
        "/quote": { "/Link@1": { id: "abc" } },
      } as JsonCodecValue;
      const result = fromEncodedFormat(data);
      // The inner structure is returned as-is, not decoded.
      const obj = result as Record<string, unknown>;
      expect(obj["/Link@1"]).toEqual({ id: "abc" });
    });

    it("deep-freezes `/quote` result objects", () => {
      const data = {
        "/quote": { "/Link@1": { id: "abc" } },
      } as JsonCodecValue;
      const result = fromEncodedFormat(data) as Record<string, unknown>;
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result["/Link@1"])).toBe(true);
    });

    it("deep-freezes `/quote` result arrays", () => {
      const data = {
        "/quote": [1, { nested: "obj" }, [2, 3]],
      } as JsonCodecValue;
      const result = fromEncodedFormat(data) as unknown[];
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result[1])).toBe(true);
      expect(Object.isFrozen(result[2])).toBe(true);
    });

    it("throws on mutation of a `/quote` result", () => {
      const data = {
        "/quote": { key: "val" },
      } as JsonCodecValue;
      const result = fromEncodedFormat(data) as Record<string, unknown>;
      expect(() => {
        result.key = "changed";
      }).toThrow();
    });
  });

  describe("unknown type tags", () => {
    it("produces `UnknownValue` for unrecognized tags via `decode()`", () => {
      const data = {
        "/FutureType@2": { some: "data" },
      } as JsonCodecValue;
      const result = fromEncodedFormat(data);
      expect(result).toBeInstanceOf(UnknownValue);
      const unknown = result as unknown as UnknownValue;
      expect(unknown.wireTypeTag).toBe("FutureType@2");
      expect(unknown.state).toEqual({ some: "data" });
    });

    it("preserves the `UnknownValue` tag in the encoded form via `encode()`", () => {
      // Encoding an UnknownValue produces the original tagged form.

      const us = new UnknownValue("FutureType@2", { some: "data" });
      const encodedFormat = toEncodedFormat(us);
      expect(encodedFormat).toEqual({
        "/FutureType@2": { some: "data" },
      });
    });

    it("round-trips `UnknownValue` through encode/decode", () => {
      const us = new UnknownValue("FutureType@2", { some: "data" });
      const result = roundTrip(us);
      expect(result).toBeInstanceOf(UnknownValue);
      const unknown = result as unknown as UnknownValue;
      expect(unknown.wireTypeTag).toBe("FutureType@2");
      expect(unknown.state).toEqual({ some: "data" });
    });

    it("rejects a `/hole` outside array context rather than calling it unknown", () => {
      // Per spec §9, `UnknownValue` is for a syntactically well-formed tag no
      // codec claims. `hole` is a meta-tag, meaningful only among array
      // elements, and is a structural violation anywhere else.

      const data = { "/hole": 5 } as JsonCodecValue;

      expect(() => fromEncodedFormat(data)).toThrow(/malformed tag/);
    });
  });

  describe("circular reference detection", () => {
    it("throws on object referencing itself", () => {
      const { jsonCodecEngine } = makeTestCodec();
      const obj: Record<string, unknown> = {};
      obj.self = obj;
      expect(() => jsonCodecEngine.encode(obj as FabricValue)).toThrow(
        "Circular reference",
      );
    });

    it("throws on array referencing itself", () => {
      const { jsonCodecEngine } = makeTestCodec();
      const arr: unknown[] = [];
      arr.push(arr);
      expect(() => jsonCodecEngine.encode(arr as FabricValue)).toThrow(
        "Circular reference",
      );
    });

    it("throws on indirect circular reference (A -> B -> A)", () => {
      const { jsonCodecEngine } = makeTestCodec();
      const a: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      a.ref = b;
      b.ref = a;
      expect(() => jsonCodecEngine.encode(a as FabricValue)).toThrow(
        "Circular reference",
      );
    });

    it("throws on `FabricInstance` whose state references itself", () => {
      const { jsonCodecEngine } = makeTestCodec();
      // Create an instance with a circular reference in its state.
      const state = { eek: [] as FabricValue[] };
      state.eek.push(state);

      const us = new UnknownValue("Test@1", state);
      expect(() => jsonCodecEngine.encode(us))
        .toThrow(
          "Circular reference",
        );
    });

    it("duplicates a shared reference into equal subtrees", () => {
      const shared = { val: 42 };
      const obj = { a: shared, b: shared };
      // Should not throw -- shared references are fine, and only cycles are
      // rejected.
      const result = toEncodedFormat(obj);
      expect(result).toEqual({ a: { val: 42 }, b: { val: 42 } });
    });
  });

  describe("`Problematic@1` (strict mode)", () => {
    // The engine exempts this codec from the rule that a returned
    // `ProblematicValue` fails a strict decode, because for this one such a
    // value is the successful product: a record of a *past* failure reads back
    // as one however strict the reader. A refusal is not that product, so a
    // record this codec did not write fails, and the pair below is what keeps
    // the exemption from covering both.

    /** Decodes a `Problematic@1` payload through a strict engine. */
    function decodeStrict(state: JsonCodecValue): FabricValue {
      return newDefaultJsonCodecEngine().decode(
        JsonCodecEngine.wrapEncodedValueForTesting(
          JSON.stringify({ "/Problematic@1": state }),
          true,
        ),
        new TestLiveEnvironment(),
      );
    }

    it("decodes a well-formed record", () => {
      const result = decodeStrict({
        tag: "BadType@1",
        state: "original data",
        error: "boom",
      }) as ProblematicValue;

      expect(result).toBeInstanceOf(ProblematicValue);
      expect(result.wireTypeTag).toBe("BadType@1");
      expect(result.state).toBe("original data");
      expect(result.error).toBe("boom");
    });

    it("throws for a record this codec did not write", () => {
      expect(() => decodeStrict("nope")).toThrow(
        /state is not one this codec decodes/,
      );
    });
  });

  describe("`ProblematicValue` (lenient mode)", () => {
    it("encodes a `ProblematicValue` under its own tag, fault and all", () => {
      const prob = new ProblematicValue(
        "BadType@1",
        "original data",
        "something went wrong",
      );

      // The preserved tag is data here rather than encoded structure, which is
      // what lets an instance reporting an unusable tag be encoded at all.
      expect(toEncodedFormat(prob)).toEqual({
        "/Problematic@1": {
          tag: "BadType@1",
          state: "original data",
          error: "something went wrong",
        },
      });
    });

    it("round-trips a `ProblematicValue` whose preserved tag is not a tag", () => {
      const prob = new ProblematicValue("hole", "original data", "boom");
      const result = roundTrip(prob) as ProblematicValue;

      expect(result).toBeInstanceOf(ProblematicValue);
      expect(result.wireTypeTag).toBe("hole");
      expect(result.state).toBe("original data");
      expect(result.error).toBe("boom");
    });

    it("wraps failed handler decoding in lenient mode", () => {
      const jsonCodecEngine = newDefaultJsonCodecEngine({ lenient: true });
      const runtime = new TestLiveEnvironment();

      // `BigInt@1` with a non-string state produces a `ProblematicValue` in
      // lenient mode: the codec's `canDecode()` refuses it, and the engine
      // reports the refusal.
      const data = { "/BigInt@1": 42 } as JsonCodecValue;
      const result = jsonCodecEngine.decode(
        JsonCodecEngine.wrapEncodedValueForTesting(
          JSON.stringify(data),
          true, // Malformed on purpose; the helper's own check is strict.
        ),
        runtime,
      );
      expect(result).toBeInstanceOf(ProblematicValue);
      const prob = result as unknown as ProblematicValue;
      expect(prob.wireTypeTag).toBe("BigInt@1");
    });

    it("wraps a throw from a terminal codec, over the encoded-form state", () => {
      // `Undefined@1` is terminal and throws outright, so it reaches the
      // lenient catch from the terminal arm. A codec that reports a bad state
      // by returning a `ProblematicValue` never reaches that catch at all.
      //
      // What the state assertion pins is what the *report* carries, which is
      // the encoded form. That the *codec* is handed the encoded form is a separate
      // fact, pinned separately above.

      const jsonCodecEngine = newDefaultJsonCodecEngine({ lenient: true });
      const data = { "/Undefined@1": { "/Bytes@1": "AQID" } } as JsonCodecValue;

      const result = jsonCodecEngine.decode(
        JsonCodecEngine.wrapEncodedValueForTesting(
          JSON.stringify(data),
          true, // Undecodable on purpose; that is what this test is about.
        ),
        new TestLiveEnvironment(),
      );

      expect(result).toBeInstanceOf(ProblematicValue);
      const prob = result as unknown as ProblematicValue;
      expect(prob.wireTypeTag).toBe("Undefined@1");
      expect(prob.state).toEqual({ "/Bytes@1": "AQID" });
    });

    it("deep-freezes the `ProblematicValue` it wraps a throw in", () => {
      // A `ProblematicValue` is not frozen at construction, so this is what
      // witnesses the deep-frozen contract on the lenient path. The codecs
      // that report by RETURNING one are frozen by the arm above instead, so
      // neither arm stands in for the other.

      const jsonCodecEngine = newDefaultJsonCodecEngine({ lenient: true });
      const data = { "/Undefined@1": { "/Bytes@1": "AQID" } } as JsonCodecValue;

      const result = jsonCodecEngine.decode(
        JsonCodecEngine.wrapEncodedValueForTesting(JSON.stringify(data), true),
        new TestLiveEnvironment(),
      );

      expect(isDeepFrozen(result)).toBe(true);
    });

    it("wraps failed class-registry decoding in lenient mode", () => {
      const jsonCodecEngine = newDefaultJsonCodecEngine({ lenient: true });
      const runtime = new TestLiveEnvironment();

      // Map@1's codec always throws on decode ("not yet implemented"),
      // triggering lenient wrapping.
      const data = {
        "/Map@1": [["key", "value"]],
      } as JsonCodecValue;
      const result = jsonCodecEngine.decode(
        JsonCodecEngine.wrapEncodedValueForTesting(
          JSON.stringify(data),
          true, // Undecodable on purpose; that is what this test is about.
        ),
        runtime,
      );
      expect(result).toBeInstanceOf(ProblematicValue);
      const prob = result as unknown as ProblematicValue;
      expect(prob.wireTypeTag).toBe("Map@1");
    });
  });

  describe("freeze guarantees", () => {
    it("freezes decoded arrays", () => {
      const result = fromEncodedFormat(
        [1, 2, 3] as JsonCodecValue,
      );
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("freezes decoded objects", () => {
      const result = fromEncodedFormat(
        { a: 1 } as JsonCodecValue,
      ) as Record<string, FabricValue>;
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("throws on mutation of a decoded array", () => {
      const result = fromEncodedFormat(
        [1, 2, 3] as JsonCodecValue,
      );
      expect(() => {
        (result as unknown as number[])[0] = 99;
      }).toThrow();
    });

    it("throws on mutation of a decoded object", () => {
      const result = fromEncodedFormat(
        { a: 1 } as JsonCodecValue,
      ) as Record<string, FabricValue>;
      expect(() => {
        (result as Record<string, unknown>).a = 99;
      }).toThrow();
    });

    it("freezes nested decoded objects", () => {
      const result = fromEncodedFormat(
        { inner: { val: 42 } } as JsonCodecValue,
      ) as Record<string, Record<string, FabricValue>>;
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.inner)).toBe(true);
    });

    it("freezes decoded `/object`-unwrapped objects", () => {
      const data = { "/object": { "/myKey": "val" } } as JsonCodecValue;
      const result = fromEncodedFormat(data) as Record<
        string,
        FabricValue
      >;
      expect(Object.isFrozen(result)).toBe(true);
    });

    //
    // The fallback arms, deep-frozen
    //
    // These pin the guarantee on the arms that wrap wire state rather than
    // decode it — an `UnknownValue` and a `ProblematicValue`. They assert
    // with `isDeepFrozen()` rather than `Object.isFrozen()`, because an arm
    // that froze only the value it built, and not what it wrapped, would pass
    // the shallow check.
    //

    it("deep-freezes an `UnknownValue` from an unrecognized tag", () => {
      const result = fromEncodedFormat(
        { "/Nope@1": { a: 1 } } as JsonCodecValue,
      );

      expect(result).toBeInstanceOf(UnknownValue);
      expect(isDeepFrozen(result)).toBe(true);
    });

    it("deep-freezes an `UnknownValue` through its state", () => {
      const result = fromEncodedFormat(
        { "/Nope@1": { inner: { deep: [1, 2] } } } as JsonCodecValue,
      ) as UnknownValue;
      const state = result.state as { inner: { deep: unknown[] } };

      expect(isDeepFrozen(result)).toBe(true);
      expect(Object.isFrozen(state.inner)).toBe(true);
      expect(Object.isFrozen(state.inner.deep)).toBe(true);
    });

    it("deep-freezes a `ProblematicValue` from a malformed tag", () => {
      // `malformed`, because the wrap helper validates with a strict decode
      // and would otherwise reject the very payload this case is made of.

      const result = fromEncodedFormat(
        { "/": { a: 1 } } as JsonCodecValue,
        true,
      );

      expect(result).toBeInstanceOf(ProblematicValue);
      expect(isDeepFrozen(result)).toBe(true);
    });
  });

  describe("`FabricCodec.decode()` deep-frozen contract", () => {
    // Anything returned via a registered `FabricCodec` is guaranteed
    // deep-frozen at the `decode()` boundary, so callers do not each have to
    // freeze. That holds of every other arm too, the unknown-tag fallback
    // included; the cases just above cover those.

    it("deep-freezes a codec-produced value at the boundary", () => {
      // `/EpochNsec@1` dispatches through a registered codec; the
      // decoded FabricEpochNsec must be deep-frozen on return.

      const result = fromEncodedFormat(
        { "/EpochNsec@1": "AA" } as JsonCodecValue,
      );
      expect(result).toBeInstanceOf(FabricEpochNsec);
      expect(isDeepFrozen(result)).toBe(true);
    });

    it("deep-freezes a lenient-mode `ProblematicValue` from a codec", () => {
      // `/BigInt@1` with non-string state fails codec validation; the
      // lenient catch produces a ProblematicValue -- still a codec-arm return,
      // so the contract deep-freezes it (not a crash: it is the value
      // lenient mode produces precisely to avoid crashing).

      const jsonCodecEngine = newDefaultJsonCodecEngine({ lenient: true });
      const runtime = new TestLiveEnvironment();
      const result = jsonCodecEngine.decode(
        JsonCodecEngine.wrapEncodedValueForTesting(
          JSON.stringify({ "/BigInt@1": 42 }),
          true, // Malformed on purpose; the helper's own check is strict.
        ),
        runtime,
      );
      expect(result).toBeInstanceOf(ProblematicValue);
      expect(isDeepFrozen(result)).toBe(true);
    });

    it("yields a deep-frozen result from a codec round-trip", () => {
      const result = roundTrip(
        new FabricEpochNsec(1704067200000000000n),
      );
      expect(result).toBeInstanceOf(FabricEpochNsec);
      expect(isDeepFrozen(result)).toBe(true);
    });
  });

  describe("deep-frozen encoded invariant", () => {
    // Every `JsonCodecValue` handed to the decode walk must be deep-frozen.
    //
    // The `/quote` arm does `return state`, handing back a node lifted straight
    // out of the parsed codec-value tree (see `#unwrapTag()`'s contract). That
    // shortcut is sound only because the parsed tree is deep-frozen at
    // construction, which both construction sites must therefore do. These
    // cases pin it, so that dropping the guarantee cannot pass unnoticed.

    /** Decodes one codec-value tree through this format's boundary. */
    function decodeTree(data: JsonCodecValue): FabricValue {
      const { jsonCodecEngine, runtime } = makeTestCodec();

      return jsonCodecEngine.decode(
        JsonCodecEngine.wrapEncodedValueForTesting(JSON.stringify(data)),
        runtime,
      );
    }

    const cases: Array<[string, JsonCodecValue]> = [
      ["plain nested object + array", { a: { b: [1, 2, { c: 3 }] } }],
      ["/quote literal with nested object and array", {
        "/quote": { x: [1, { y: 2 }], z: { w: [3, 4] } },
      }],
      ["/quote literal whose top value is an array", {
        "/quote": [[1, 2], { a: 1 }, [{ b: 2 }]],
      }],
      ["/object-wrapped object with a /-prefixed key", {
        "/object": { "/k": { nested: [1, 2] } },
      }],
      ["tagged handler value (EpochNsec, arm-1 contract)", {
        "/EpochNsec@1": "AA",
      }],
      ["mixed: a /quote value beside a normal array", {
        meta: [1, 2],
        lit: { "/quote": { deep: { deeper: [9] } } },
      }],
    ];

    for (const [name, encoded] of cases) {
      it(`yields a deep-frozen result: ${name}`, () => {
        expect(isDeepFrozen(decodeTree(encoded))).toBe(true);
      });
    }

    it("deep-freezes `/quote` content at every depth", () => {
      const encoded = {
        "/quote": { outer: { inner: [1, 2] } },
      } as JsonCodecValue;
      const { jsonCodecEngine, runtime } = makeTestCodec();
      const result = jsonCodecEngine.decode(
        JsonCodecEngine.wrapEncodedValueForTesting(JSON.stringify(encoded)),
        runtime,
      ) as Record<string, Record<string, FabricValue[]>>;

      expect(isDeepFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.outer)).toBe(true);
      expect(Object.isFrozen(result.outer!.inner)).toBe(true);
      expect(() => {
        (result.outer!.inner as unknown as number[])[0] = 99;
      }).toThrow();
      expect(() => {
        (result.outer as Record<string, unknown>).added = true;
      }).toThrow();
    });

    it("returns a deep-frozen value end-to-end from an `encode()`→`/quote`→`decode()` round-trip", () => {
      // An object whose keys are all /-prefixed but whose values are all
      // quote-safe routes through the encode-side /quote path, then back
      // through the decode /quote `return state` arm.

      const value = {
        "/a": 1,
        "/b": { plain: [1, 2] },
      };
      const result = roundTrip(value);
      expect(isDeepFrozen(result)).toBe(true);
      expect(result).toEqual({ "/a": 1, "/b": { plain: [1, 2] } });
    });
  });

  describe("entry points", () => {
    describe("encode()", () => {
      it("returns a prefixed JSON string", () => {
        const jsonCodecEngine = newDefaultJsonCodecEngine();
        const result = jsonCodecEngine.encode(42);
        expect(typeof result).toBe("string");
        expect(JsonCodecEngine.seemsLikeEncoded(result)).toBe(true);
        expect(
          JSON.parse(JsonCodecEngine.unwrapEncodedValueForTesting(result)),
        ).toBe(42);
      });
    });

    describe("decode()", () => {
      it("parses a prefixed JSON string back to a value", () => {
        const jsonCodecEngine = newDefaultJsonCodecEngine();
        const runtime = new TestLiveEnvironment();
        const result = jsonCodecEngine.decode(
          JsonCodecEngine.wrapEncodedValueForTesting("42"),
          runtime,
        );
        expect(result).toBe(42);
      });
    });

    describe(".lenient", () => {
      it("defaults to `false`", () => {
        const jsonCodecEngine = newDefaultJsonCodecEngine();
        expect(jsonCodecEngine.lenient).toBe(false);
      });

      it("can be set to `true`", () => {
        const jsonCodecEngine = newDefaultJsonCodecEngine({ lenient: true });
        expect(jsonCodecEngine.lenient).toBe(true);
      });
    });

    it("round-trips tagged types through `encode()`/`decode()`", () => {
      const jsonCodecEngine = newDefaultJsonCodecEngine();
      const runtime = new TestLiveEnvironment();
      const se = FabricError.fromNativeError(new Error("test"));
      const encoded = jsonCodecEngine.encode(se);
      const decoded = jsonCodecEngine.decode(encoded, runtime);
      expect(decoded).toBeInstanceOf(FabricError);
      expect((decoded as unknown as FabricError).message).toBe("test");
    });
  });

  describe("malformed encoded the engine itself detects", () => {
    /** The encoded shapes the engine rejects without any codec being consulted. */
    const CASES: readonly (readonly [string, JsonCodecValue, RegExp])[] = [
      ["a bare `/` key", { "/": "x" }, /malformed tag/],
      ["a `/`-prefixed key in a bare object", { a: 1, "/b": 2 }, /reserved/],
      ["a key this runtime reserves", { ["__proto__"]: 1 }, /reserves/],
      [
        "a `/hole` count that is not one",
        [{ "/hole": "2" }],
        /positive integer/,
      ],
    ];

    for (const [what, encoded, message] of CASES) {
      it(`throws given ${what}, when not lenient`, () => {
        const jsonCodecEngine = newDefaultJsonCodecEngine();

        expect(jsonCodecEngine.lenient).toBe(false);
        expect(() =>
          jsonCodecEngine.decode(
            JsonCodecEngine.wrapEncodedValueForTesting(
              JSON.stringify(encoded),
              true, // Malformed on purpose; that is what these are about.
            ),
            new TestLiveEnvironment(),
          )
        ).toThrow(message);
      });

      it(`returns a \`ProblematicValue\` given ${what}, when lenient`, () => {
        // The same detection, kept as a value. Which side of this a caller
        // gets is `lenient` and nothing else -- notably not whether a codec
        // or the walk noticed, which these cases are the walk noticing.

        expect(fromEncodedFormat(encoded, true)).toBeInstanceOf(
          ProblematicValue,
        );
      });
    }
  });

  describe("complex round-trips", () => {
    it("round-trips deeply nested structure", () => {
      const value = {
        users: [
          { name: "Alice", scores: [100, undefined, 95] },
          { name: "Bob", scores: [] },
        ],
        meta: { version: 1, debug: undefined },
      };

      const result = roundTrip(value) as Record<string, FabricValue>;
      const users = result.users as FabricValue[];
      const alice = users[0] as Record<string, FabricValue>;
      expect(alice.name).toBe("Alice");
      const scores = alice.scores as FabricValue[];
      expect(scores[0]).toBe(100);
      expect(scores[1]).toBe(undefined);
      expect(1 in scores).toBe(true);
      expect(scores[2]).toBe(95);

      const meta = result.meta as Record<string, FabricValue>;
      expect(meta.version).toBe(1);
      expect(meta.debug).toBe(undefined);
      expect("debug" in meta).toBe(true);
    });

    it("round-trips `FabricError` in array", () => {
      const se = FabricError.fromNativeError(new Error("oops"));
      const arr = [1, se, 3];
      const result = roundTrip(arr) as FabricValue[];
      expect(result[0]).toBe(1);
      expect(result[1]).toBeInstanceOf(FabricError);
      expect(
        (result[1] as unknown as FabricError).message,
      ).toBe("oops");
      expect(result[2]).toBe(3);
    });

    it("round-trips `FabricError` as object value", () => {
      const obj = {
        error: FabricError.fromNativeError(new Error("fail")),
        code: 500,
      };
      const result = roundTrip(obj) as Record<string, FabricValue>;
      expect(result.error).toBeInstanceOf(FabricError);
      expect(
        (result.error as unknown as FabricError).message,
      ).toBe("fail");
      expect(result.code).toBe(500);
    });

    it("encodes a `FabricError` as `/Error@1` carrying `type` and `message`", () => {
      // The `@1` in the tag makes this a versioned encoded surface, so the exact
      // shape asserted below is the contract rather than an implementation
      // detail.

      const se = FabricError.fromNativeError(new TypeError("compat test"));
      const encoded = toEncodedFormat(
        se,
      ) as Record<string, unknown>;
      expect(Object.keys(encoded)).toEqual(["/Error@1"]);
      const state = encoded["/Error@1"] as Record<string, unknown>;
      expect(state.type).toBe("TypeError");
      expect(state.name).toBe(null); // null = same as type (common case)
      expect(state.message).toBe("compat test");
    });
  });

  describe("seemsLikeEncoded()", () => {
    // Decides on the prefix alone and never parses, so these cases are about
    // where that suffices and where it would be too eager: the bare prefix
    // counts, a prefix that is partial or not at the front does not, and plain
    // JSON that happens to look similar does not. One case feeds it real
    // encoder output, so the shape recognized here cannot drift from the shape
    // produced.

    it("recognizes a string with the encoding prefix", () => {
      expect(JsonCodecEngine.seemsLikeEncoded('fvj1:{"a":1}')).toBe(true);
      expect(JsonCodecEngine.seemsLikeEncoded("fvj1:null")).toBe(true);
      expect(JsonCodecEngine.seemsLikeEncoded("fvj1:42")).toBe(true);
    });

    it("recognizes the bare prefix", () => {
      expect(JsonCodecEngine.seemsLikeEncoded("fvj1:")).toBe(true);
    });

    it("recognizes the actual output of `jsonFromFabricValue()` (round-trip check)", () => {
      const encoded = jsonFromFabricValue({ a: 1, b: 42n });
      expect(JsonCodecEngine.seemsLikeEncoded(encoded)).toBe(true);
    });

    it("returns `false` for an empty string", () => {
      expect(JsonCodecEngine.seemsLikeEncoded("")).toBe(false);
    });

    it("returns `false` for plain JSON without the prefix", () => {
      // These are plain JSON without the prefix, so the dispatch must reject
      // them.

      expect(JsonCodecEngine.seemsLikeEncoded("true")).toBe(false);
      expect(JsonCodecEngine.seemsLikeEncoded("false")).toBe(false);
      expect(JsonCodecEngine.seemsLikeEncoded("null")).toBe(false);
      expect(JsonCodecEngine.seemsLikeEncoded('"hello"')).toBe(false);
      expect(JsonCodecEngine.seemsLikeEncoded("[1,2,3]")).toBe(false);
      expect(JsonCodecEngine.seemsLikeEncoded('{"a":1}')).toBe(false);
      expect(JsonCodecEngine.seemsLikeEncoded("42")).toBe(false);
      expect(JsonCodecEngine.seemsLikeEncoded("-1")).toBe(false);
    });

    it("returns `false` for a partial or misplaced prefix", () => {
      expect(JsonCodecEngine.seemsLikeEncoded("fvj")).toBe(false);
      expect(JsonCodecEngine.seemsLikeEncoded("fvj1")).toBe(false);
      expect(JsonCodecEngine.seemsLikeEncoded("FVJ1:")).toBe(false);
      expect(JsonCodecEngine.seemsLikeEncoded("fvj2:")).toBe(false);
      expect(JsonCodecEngine.seemsLikeEncoded(" fvj1:")).toBe(false);
      expect(JsonCodecEngine.seemsLikeEncoded("xfvj1:")).toBe(false);
    });

    it("returns `false` for a bare identifier or other non-JSON-looking string", () => {
      expect(JsonCodecEngine.seemsLikeEncoded("hello")).toBe(false);
      expect(JsonCodecEngine.seemsLikeEncoded("undefined")).toBe(false);
    });
  });

  describe("test-only prefix helpers", () => {
    describe("unwrapEncodedValueForTesting()", () => {
      it("yields the JSON text under the tag", () => {
        const encoded = newDefaultJsonCodecEngine().encode(42);
        expect(JsonCodecEngine.unwrapEncodedValueForTesting(encoded))
          .toBe("42");
      });

      it("round-trips with `wrapEncodedValueForTesting()`", () => {
        const encoded = newDefaultJsonCodecEngine().encode(
          { b: 1, a: [true, null] },
        );
        const json = JsonCodecEngine.unwrapEncodedValueForTesting(encoded);
        expect(JsonCodecEngine.wrapEncodedValueForTesting(json))
          .toBe(encoded);
      });

      it("preserves a value plain JSON could not carry", () => {
        // The case that motivates having a golden format at all: these survive
        // the trip only as tagged forms.

        const encoded = newDefaultJsonCodecEngine().encode(
          { z: -0, n: NaN, i: -Infinity },
        );
        const rebuilt = newDefaultJsonCodecEngine().decode(
          JsonCodecEngine.wrapEncodedValueForTesting(
            JsonCodecEngine.unwrapEncodedValueForTesting(encoded),
          ),
          new TestLiveEnvironment(),
        ) as Record<string, number>;
        expect(Object.is(rebuilt.z, -0)).toBe(true);
        expect(Number.isNaN(rebuilt.n)).toBe(true);
        expect(rebuilt.i).toBe(-Infinity);
      });

      it("throws given a string carrying no tag", () => {
        // The whole point of the tag: untagged JSON is not one of ours, however
        // well-formed it happens to be.

        expect(() => JsonCodecEngine.unwrapEncodedValueForTesting("42"))
          .toThrow();
      });

      it("throws given an empty string", () => {
        expect(() => JsonCodecEngine.unwrapEncodedValueForTesting(""))
          .toThrow();
      });

      it("throws given a tag with nothing after it", () => {
        // `seemsLikeEncoded()` accepts this, so only the throwaway decode
        // catches it.

        expect(() =>
          JsonCodecEngine.unwrapEncodedValueForTesting(ENCODING_PREFIX)
        )
          .toThrow();
      });

      it("throws given a tag followed by text that will not parse", () => {
        expect(() =>
          JsonCodecEngine.unwrapEncodedValueForTesting(
            `${ENCODING_PREFIX}{nope`,
          )
        ).toThrow();
      });
    });

    describe("wrapEncodedValueForTesting()", () => {
      it("produces something the codec accepts", () => {
        const { runtime } = makeTestCodec();
        const encoded = JsonCodecEngine.wrapEncodedValueForTesting(
          JSON.stringify({ a: 1 }),
        );
        expect(JsonCodecEngine.seemsLikeEncoded(encoded)).toBe(true);
        expect(newDefaultJsonCodecEngine().decode(encoded, runtime))
          .toEqual({ a: 1 });
      });

      it("returns the body unaltered beneath the tag", () => {
        const body = JSON.stringify({ b: 2, a: 1 });
        expect(JsonCodecEngine.wrapEncodedValueForTesting(body))
          .toBe(`${ENCODING_PREFIX}${body}`);
      });

      it("decodes a pretty-printed body", () => {
        // The re-encoded form is not compared against the input, so whitespace
        // is immaterial -- which is what lets a golden file be readable.

        const pretty = JSON.stringify({ a: 1, b: [2, 3] }, null, 2);
        const encoded = JsonCodecEngine.wrapEncodedValueForTesting(pretty);
        const { runtime } = makeTestCodec();
        expect(newDefaultJsonCodecEngine().decode(encoded, runtime))
          .toEqual({ a: 1, b: [2, 3] });
      });

      it("throws given text that will not parse", () => {
        expect(() => JsonCodecEngine.wrapEncodedValueForTesting("{nope"))
          .toThrow();
      });

      it("throws given an empty body", () => {
        expect(() => JsonCodecEngine.wrapEncodedValueForTesting(""))
          .toThrow();
      });

      it("throws given an already-tagged string", () => {
        // Double-tagging is a mistake worth catching: the tag is not part of
        // the JSON, so the result would not parse.

        const encoded = newDefaultJsonCodecEngine().encode(42);
        expect(() => JsonCodecEngine.wrapEncodedValueForTesting(encoded))
          .toThrow();
      });
    });

    describe("isMalformed", () => {
      // `Map@1`'s codec always throws on decode, so it stands in for any
      // payload the codec cannot decode. Reaching that codec takes a
      // registry that has it: against the format-only default, `Map@1` is
      // merely an unrecognized tag and decodes to an `UnknownValue`.

      const undecodable = JSON.stringify({ "/Map@1": [["key", "value"]] });

      it("refuses a payload undecodable by the given registry's codecs", () => {
        expect(() =>
          JsonCodecEngine.wrapEncodedValueForTesting(
            undecodable,
            false,
            createDefaultJsonRegistry(),
          )
        ).toThrow();
      });

      it("wraps a tag no registered codec claims", () => {
        expect(JsonCodecEngine.wrapEncodedValueForTesting(undecodable))
          .toBe(`${ENCODING_PREFIX}${undecodable}`);
      });

      it("wraps an undecodable payload when told it is deliberate", () => {
        expect(
          JsonCodecEngine.wrapEncodedValueForTesting(undecodable, true),
        ).toBe(`${ENCODING_PREFIX}${undecodable}`);
      });

      it("unwraps an undecodable payload when told it is deliberate", () => {
        expect(
          JsonCodecEngine.unwrapEncodedValueForTesting(
            `${ENCODING_PREFIX}${undecodable}`,
            true,
          ),
        ).toBe(undecodable);
      });

      it("wraps text that will not parse at all", () => {
        // Malformed means malformed: the flag is a caller saying the payload is
        // broken on purpose, so nothing is checked and the tag simply goes on
        // the front.

        expect(JsonCodecEngine.wrapEncodedValueForTesting("{nope", true))
          .toBe(`${ENCODING_PREFIX}{nope`);
      });

      it("unwraps text that will not parse at all", () => {
        expect(
          JsonCodecEngine.unwrapEncodedValueForTesting(
            `${ENCODING_PREFIX}{nope`,
            true,
          ),
        ).toBe("{nope");
      });

      it("still requires the tag on unwrap, however deliberate", () => {
        // Not a judgment about the payload: stripping a prefix that is not
        // there yields nonsense, not the body.

        expect(() => JsonCodecEngine.unwrapEncodedValueForTesting("42", true))
          .toThrow();
      });
    });
  });
});
