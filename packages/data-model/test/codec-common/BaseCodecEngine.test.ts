// Tests for the whole-value codec engine base class, exercised through a
// minimal format of its own (see `probe-engine.ts`) rather than through
// `JsonCodecEngine`. What is under test is the part no wire format decides for
// itself, and a format whose containers do the least a container can do is
// what makes those decisions observable.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  BaseNonterminalCodec,
  BaseTerminalCodec,
  type LiveEnvironment,
  NULL_LIVE_ENVIRONMENT,
  ProblematicStateError,
  ProblematicValue,
  UnknownValue,
} from "@/codec-common/index.ts";
import { FabricBytes } from "@/fabric-primitives/index.ts";
import { type FabricValue, isDeepFrozen } from "@/index.ts";
import {
  Marker,
  NESTED,
  newProbeEngine,
  NONTERMINAL_HOST,
  ProbeDecodeAct,
  ProbeEncodeAct,
  ProbeEngine,
  type ProbeValue,
  Tagged,
  TERMINAL_HOST,
} from "./probe-engine.ts";

const ENV = NULL_LIVE_ENVIRONMENT;

describe("BaseCodecEngine", () => {
  describe("terminal vs. nonterminal codecs", () => {
    // The two host codecs return the identical state, `{ inner: NESTED }`,
    // and differ only in which base class they extend. Everything below is
    // therefore the engine's doing rather than theirs.

    it("leaves a terminal codec's state alone", () => {
      const { engine } = newProbeEngine();
      const encoded = engine.encode(TERMINAL_HOST) as Tagged;

      expect(encoded.tag).toBe("T@1");
      // `NESTED` has a codec of its own, and it was not consulted: a
      // terminal state is already in the format's domain, so the walk stops
      // here.
      expect(encoded.state).toEqual({ inner: NESTED });
    });

    it("walks a nonterminal codec's state", () => {
      const { engine } = newProbeEngine();
      const encoded = engine.encode(NONTERMINAL_HOST) as Tagged;

      expect(encoded.tag).toBe("N@1");
      // The same state, expanded: `NESTED` is a `FabricValue`, so the walk
      // went on and `XCodec` encoded it under its own tag.
      const inner = (encoded.state as { inner: ProbeValue }).inner as Tagged;
      expect(inner).toBeInstanceOf(Tagged);
      expect(inner.tag).toBe("X@1");
      expect(inner.state).toBe("encoded-X");
    });

    it("hands a terminal codec the state exactly as it arrived", () => {
      const { engine, record } = newProbeEngine();
      // Hand-built so that both hosts are given the identical wire state.
      const wire = new Tagged("T@1", { inner: new Tagged("X@1", "encoded-X") });

      engine.decode(wire, ENV);

      const seen = record.decoded[0] as { inner: unknown };
      // Undecoded: the inner tag is still a tag, not the value it stands for.
      expect(seen.inner).toBeInstanceOf(Tagged);
    });

    it("hands a nonterminal codec state that has been decoded", () => {
      const { engine, record } = newProbeEngine();
      const wire = new Tagged("N@1", { inner: new Tagged("X@1", "encoded-X") });

      engine.decode(wire, ENV);

      const seen = record.decoded[0] as { inner: unknown };
      // Decoded: the walk reached the inner tag before this codec was called.
      expect(seen.inner).toBe("decoded-X");
    });

    it("reads the kind from the codec's base class, not from its state", () => {
      // The clinching case: identical states in, different wire forms out.

      const { engine } = newProbeEngine();

      expect((engine.encode(TERMINAL_HOST) as Tagged).state)
        .toEqual({ inner: NESTED });
      expect(
        ((engine.encode(NONTERMINAL_HOST) as Tagged).state as {
          inner: ProbeValue;
        }).inner,
      ).toBeInstanceOf(Tagged);
    });
  });

  describe("encodeValue()", () => {
    it("emits a self-representing value as it stands", () => {
      const { engine } = newProbeEngine();

      expect(engine.encode(42)).toBe(42);
      expect(engine.encode("plain")).toBe("plain");
    });

    it("takes the tag from `tagForValue()` rather than from the value", () => {
      const { engine } = newProbeEngine();

      expect((engine.encode(TERMINAL_HOST) as Tagged).tag).toBe("T@1");
    });

    it("throws given a `FabricSpecialObject` no codec claims", () => {
      const { engine } = newProbeEngine();

      expect(() => engine.encode(new FabricBytes(new Uint8Array([1]))))
        .toThrow(/No codec registered for `FabricSpecialObject` subclass/);
    });

    it("throws given a value that is no `FabricValue` at all", () => {
      const { engine } = newProbeEngine();

      expect(() => engine.encode(new Date() as unknown as FabricValue))
        .toThrow(/no applicable codec/);
    });

    it("throws given a circular reference", () => {
      const { engine } = newProbeEngine();
      const value: Record<string, FabricValue> = { a: 1 };
      value.self = value;

      expect(() => engine.encode(value)).toThrow(/Circular reference/);
    });

    it("throws given a cycle that closes through a tagged value", () => {
      // The cycle guard on the codec-matched path, which no container arm
      // reaches: a nonterminal codec's state can name the very value being
      // encoded, and the walk expands that state. Without the enter/leave
      // around the tagged form, this recurses until the stack gives out
      // instead of being refused.

      class SelfNaming {}

      const selfNaming = new SelfNaming() as unknown as FabricValue;
      const codec = new (class SelfNamingCodec extends BaseNonterminalCodec {
        constructor() {
          super(
            "SelfNaming@1",
            SelfNaming as unknown as new (...args: never[]) => object,
          );
        }

        override canEncode(value: FabricValue): boolean {
          return value === selfNaming;
        }

        encode(value: FabricValue): FabricValue {
          // The state names the value it came from, closing the cycle.
          return { self: value };
        }

        canDecode(_state: FabricValue): _state is FabricValue {
          return true;
        }

        decode(): FabricValue {
          return selfNaming;
        }
      })();

      const { engine } = newProbeEngine({ extraCodecs: [codec] });

      expect(() => engine.encode(selfNaming)).toThrow(/Circular reference/);
    });

    it("does not mistake a repeated value for a circular one", () => {
      // The same object twice over is not a cycle, so `seen` has to be unwound
      // as the walk leaves each value rather than only grown. A `Marker`
      // rather than a plain object, because that bookkeeping lives on the
      // codec-matched path and a container never reaches it.

      const { engine } = newProbeEngine();
      const shared = new Marker() as unknown as FabricValue;

      expect(() => engine.encode({ x: shared, y: shared })).not.toThrow();
    });
  });

  describe("decodeValue()", () => {
    // The guard these exercise is the base's, reached through `enterOrReport()`
    // and the `seen` threaded from `decode()`. A format whose transport is a
    // tree can be handed a cycle by a peer, where one that parses its own
    // input cannot, so this is wire data like any other malformation and
    // settles against `lenient` rather than raising unconditionally.

    it("reports a circular reference through a container", () => {
      const { engine } = newProbeEngine({ lenient: true });
      const data: Record<string, ProbeValue> = { a: 1 };
      data.self = data;

      const result = engine.decode(data, ENV) as Record<
        string,
        FabricValue
      >;

      expect(result.a).toBe(1);
      expect(result.self).toBeInstanceOf(ProblematicValue);
      expect((result.self as ProblematicValue).error)
        .toMatch(/circular reference/);
    });

    it("reports a circular reference that closes through a tagged node", () => {
      // A cycle need not run through a container at all: the state under a tag
      // is walked for an unknown tag, as it is for a nonterminal codec, so
      // guarding only the container arms would follow this one forever.

      const { engine } = newProbeEngine({ lenient: true });
      const state: Record<string, ProbeValue> = {};
      const tagged = new Tagged("Zz@1", state);
      state.back = tagged;

      const result = engine.decode(tagged, ENV);

      expect(result).toBeInstanceOf(UnknownValue);
      const inner = (result as UnknownValue).state as Record<
        string,
        FabricValue
      >;
      expect(inner.back).toBeInstanceOf(ProblematicValue);
      expect((inner.back as ProblematicValue).error)
        .toMatch(/circular reference/);
    });

    it("throws given a circular reference when not lenient", () => {
      const { engine } = newProbeEngine();
      const data: Record<string, ProbeValue> = { a: 1 };
      data.self = data;

      expect(() => engine.decode(data, ENV))
        .toThrow(ProblematicStateError);
    });

    it("does not mistake a repeated node for a circular one", () => {
      // The same node twice over is not a cycle, so `seen` has to be unwound as
      // the walk leaves each node rather than only grown. Both a container and
      // a tagged node, those being entered by the same call site.

      const { engine } = newProbeEngine();
      const shared: Record<string, ProbeValue> = { v: 1 };
      const tagged = new Tagged("Zz@1", 2);

      expect(() =>
        engine.decode(
          { a: shared, b: shared, c: tagged, d: tagged },
          ENV,
        )
      ).not.toThrow();
    });
  });

  describe("decodeTagged()", () => {
    it("wraps an unrecognized tag in an `UnknownValue`, decoded state kept", () => {
      const { engine } = newProbeEngine();
      const result = engine.decode(
        new Tagged("Nope@1", new Tagged("X@1", "encoded-X")),
        ENV,
      );

      expect(result).toBeInstanceOf(UnknownValue);
      // Not a rejection: the state is walked so that what is inside a tag
      // nobody claims still round-trips.
      expect((result as UnknownValue).state).toBe("decoded-X");
    });

    it("rejects an empty tag rather than naming an `UnknownValue` with one", () => {
      const { engine } = newProbeEngine();

      expect(() => engine.decode(new Tagged("", "x"), ENV))
        .toThrow(/malformed tag/);
    });

    it("rejects a tag with no version rather than calling it unknown", () => {
      // An unrecognized tag becomes an `UnknownValue` only if it is a tag.
      // `hole` is a meta-tag, well-formed only in the context that defines
      // it, and nowhere else a type this or any registry could carry.

      const { engine } = newProbeEngine();

      expect(() => engine.decode(new Tagged("hole", 5), ENV))
        .toThrow(/malformed tag/);
    });

    it("rejects a tag that is not a string at all", () => {
      // A format finds a tag wherever its own shape puts one, and what it
      // finds off the wire need not be a string.

      const { engine } = newProbeEngine();

      expect(() => engine.decode(new Tagged(42 as never, "x"), ENV))
        .toThrow(/malformed tag/);
    });

    it("deep-freezes what a codec returns", () => {
      // `MarkerCodec.decode()` returns a mutable nested object. Every other
      // codec here returns a primitive, which is deep-frozen however the
      // engine behaves, and so could not witness this.

      const { engine } = newProbeEngine();
      const result = engine.decode(new Tagged("M@1", "m"), ENV);

      expect(result).toEqual({ deep: { n: 1 } });
      expect(isDeepFrozen(result)).toBe(true);
    });
  });

  describe("per-call acts", () => {
    it("mints a fresh encode act for each `encode()` call", () => {
      // Driven through `encode()` rather than by calling the factory twice:
      // what needs pinning is that the entry point consults the factory per
      // call, and a test that only calls the factory stays green even if
      // `encode()` starts memoizing one act for the engine's lifetime.

      const seen: unknown[] = [];
      const { registry } = newProbeEngine();
      // The spy sits on the act rather than the engine, and records `this`:
      // what needs proving is that the act the walk runs on is a fresh one per
      // call, not merely that the factory was consulted.
      const engine = new (class extends ProbeEngine {
        protected override newEncodeAct(env: LiveEnvironment): ProbeEncodeAct {
          return new (class extends ProbeEncodeAct {
            protected override encodeArray(
              value: readonly FabricValue[],
            ): ProbeValue {
              seen.push(this);
              return super.encodeArray(value);
            }
          })(this, env);
        }
      })({ registry });

      engine.encode([1] as unknown as FabricValue);
      engine.encode([1] as unknown as FabricValue);

      expect(seen.length).toBe(2);
      expect(seen[0]).not.toBe(seen[1]);
    });

    it("mints a fresh decode act for each `decode()` call", () => {
      const seen: unknown[] = [];
      const { registry } = newProbeEngine();
      const engine = new (class extends ProbeEngine {
        protected override newDecodeAct(
          env: LiveEnvironment,
          _data: ProbeValue,
        ): ProbeDecodeAct {
          return new (class extends ProbeDecodeAct {
            override decodeValue(data: ProbeValue): FabricValue {
              seen.push(this);
              return super.decodeValue(data);
            }
          })(this, env);
        }
      })({ registry });

      engine.decode([1] as unknown as ProbeValue, ENV);
      engine.decode([1] as unknown as ProbeValue, ENV);

      expect(seen.length).toBeGreaterThanOrEqual(2);
      expect(seen[0]).not.toBe(seen[seen.length - 1]);
    });

    it("gives a re-entrant encode its own in-progress set", () => {
      // The property the per-call act exists for, and it needs a genuinely
      // nested call to show: sequential calls prove nothing, since the set is
      // empty again by the time the second one starts. With walk state on the
      // engine rather than per act, an encode reached from INSIDE another one
      // shares the outer walk's set, so entering a container the outer walk is
      // currently inside reports a cycle that is not there.

      class Reentrant {}

      const outer: FabricValue[] = [];
      let reentered = false;
      let innerResult: unknown;

      const codec =
        new (class ReentrantCodec extends BaseTerminalCodec<ProbeValue> {
          constructor() {
            super("Reentrant@1", Reentrant);
          }

          encode(): ProbeValue {
            if (!reentered) {
              reentered = true;
              innerResult = engine.encode(outer as unknown as FabricValue);
            }
            return 1;
          }

          canDecode(_state: ProbeValue): _state is ProbeValue {
            return true;
          }

          decode(): FabricValue {
            return 1;
          }
        })();

      const { engine } = newProbeEngine({ extraCodecs: [codec] });
      outer.push(new Reentrant() as unknown as FabricValue);

      expect(() => engine.encode(outer as unknown as FabricValue)).not
        .toThrow();
      expect(reentered).toBe(true);
      // Shape rather than mere existence: this says the inner act ran to
      // completion, not merely that it returned something.
      expect(innerResult).toEqual([new Tagged("Reentrant@1", 1)]);
    });

    it("leaves a value even when its codec throws", () => {
      // The act outlives a throw, belonging to the call rather than to the
      // node, so a value left entered would make a later visit report a cycle that
      // is not there. The differential is the message: with the leave in a
      // `finally` the second visit fails the same way the first did; without
      // it, the second fails as a circular reference instead.

      class Boom {}

      const codec = new (class BoomCodec extends BaseTerminalCodec<ProbeValue> {
        constructor() {
          super("Boom@1", Boom);
        }

        encode(): ProbeValue {
          throw new Error("codec refused");
        }

        canDecode(_state: ProbeValue): _state is ProbeValue {
          return true;
        }

        decode(): FabricValue {
          return 1;
        }
      })();

      const { engine } = newProbeEngine({ extraCodecs: [codec] });
      const boom = new Boom() as unknown as FabricValue;
      // One act, driven twice: the second call is what would report a cycle
      // that is not there, had the first left `boom` entered.
      const act = new ProbeEncodeAct(engine, ENV);

      expect(() => act.encodeValue(boom)).toThrow("codec refused");
      expect(() => act.encodeValue(boom)).toThrow("codec refused");
    });

    it("gives a re-entrant decode its own in-progress set", () => {
      // The decode-side twin of the encode re-entrancy test, and the reason
      // the decode act is per call too. The probe format's transport is the
      // tree itself, so its walk guards cycles; with one act shared across
      // calls, an inner decode entering a node the outer walk is inside would
      // report a cycle that is not there.

      let reentered = false;
      let innerResult: unknown;
      const outer: ProbeValue[] = [];

      const codec =
        new (class ReentrantDecodeCodec extends BaseTerminalCodec<ProbeValue> {
          constructor() {
            super("ReentrantDecode@1", class ReentrantDecode {});
          }

          encode(): ProbeValue {
            return 1;
          }

          canDecode(_state: ProbeValue): _state is ProbeValue {
            return true;
          }

          decode(): FabricValue {
            if (!reentered) {
              reentered = true;
              innerResult = engine.decode(outer as unknown as ProbeValue, ENV);
            }
            return 1;
          }
        })();

      const { engine } = newProbeEngine({ extraCodecs: [codec] });
      outer.push(new Tagged("ReentrantDecode@1", 0));

      expect(() => engine.decode(outer as unknown as ProbeValue, ENV))
        .not.toThrow();
      expect(reentered).toBe(true);
      expect(innerResult).toEqual([1]);
    });

    it("carries the live environment on the encode act", () => {
      const { engine } = newProbeEngine();
      const probe = engine as unknown as {
        newEncodeAct(env: unknown): { env: unknown };
      };

      expect(probe.newEncodeAct(ENV).env).toBe(ENV);
    });

    it("carries the live environment on the decode act", () => {
      const { engine } = newProbeEngine();
      const probe = engine as unknown as {
        newDecodeAct(env: unknown): { env: unknown };
      };

      expect(probe.newDecodeAct(ENV).env).toBe(ENV);
    });
  });

  describe("lenient", () => {
    // A codec rejects a state in one of three ways, and which it picks is the
    // codec author's business rather than a caller's. `lenient` is what
    // decides what a caller sees, so it has to settle ALL of them -- which is
    // why each group below covers each. `ThrowingCodec`, `RejectingCodec` and
    // `RefusingCodec` differ in nothing but that choice.

    /** A wire form whose codec rejects by throwing. */
    const THROWN = new Tagged("Throws@1", "x");

    /** A wire form whose codec rejects by returning a report. */
    const RETURNED = new Tagged("Rejects@1", "x");

    /** A wire form whose codec refuses the state in `canDecode()`. */
    const REFUSED = new Tagged("Refuses@1", "x");

    /** A wire form the walk itself finds malformed, no codec involved. */
    const MALFORMED = new Tagged("", "x");

    /** A wire form under a tag no codec claims, which is not a rejection. */
    const UNCLAIMED = new Tagged("Nope@1", "x");

    it("is `false` by default", () => {
      expect(newProbeEngine().engine.lenient).toBe(false);
    });

    describe("when `lenient === false`", () => {
      it("raises a codec's throw", () => {
        const { engine } = newProbeEngine();

        expect(() => engine.decode(THROWN, ENV))
          .toThrow(/rejected by throwing/);
      });

      it("turns a `ProblematicValue` a codec returned into a throw", () => {
        // The half that used to do nothing: this rejection stood either way
        // before, so the setting governed only the codecs that threw.

        const { engine } = newProbeEngine();

        expect(() => engine.decode(RETURNED, ENV))
          .toThrow(/rejected by returning/);
      });

      it("raises a refusal from `canDecode()`", () => {
        // The refusal is reported rather than raised, so strictly it is
        // `reportMalformed()` that raises and the throw then passes back out
        // through the codec-facing `catch`. `cause` is what says it arrives
        // unaltered: a rebuilt error carries the original there, and this one
        // carries nothing, the facts alone being no proof either way.

        const { engine } = newProbeEngine();

        try {
          engine.decode(REFUSED, ENV);
          throw new Error("Should have thrown.");
        } catch (e) {
          expect(e).toBeInstanceOf(ProblematicStateError);
          expect((e as ProblematicStateError).message)
            .toMatch(/state is not one this codec decodes/);
          expect((e as ProblematicStateError).wireTypeTag).toBe("Refuses@1");
          expect((e as ProblematicStateError).state).toBe("x");
          expect((e as ProblematicStateError).cause).toBeUndefined();
        }
      });

      it("raises a malformation the walk itself found", () => {
        const { engine } = newProbeEngine();

        expect(() => engine.decode(MALFORMED, ENV)).toThrow(
          /malformed tag/,
        );
      });

      it("wraps an unclaimed tag in an `UnknownValue` regardless", () => {
        // Not a rejection, so the setting has no say in it.

        const { engine } = newProbeEngine();

        expect(engine.decode(UNCLAIMED, ENV)).toBeInstanceOf(UnknownValue);
      });

      it("carries tag and state however the codec reported it", () => {
        // Throwing and returning a `ProblematicValue` are the codec author's
        // choice and say nothing about what a caller wants, so a strict
        // failure must look the same either way. It did not: the returned
        // form used to become a bare `Error`.

        const { engine } = newProbeEngine();

        for (
          const [label, wire] of [["threw", THROWN], [
            "returned",
            RETURNED,
          ]] as const
        ) {
          try {
            engine.decode(wire, ENV);
            throw new Error(`Should have thrown (${label}).`);
          } catch (e) {
            expect(e).toBeInstanceOf(ProblematicStateError);
            expect((e as ProblematicStateError).state).toBe("x");
          }
        }
      });

      it("raises a `ProblematicStateError` carrying tag and state", () => {
        // The strict counterpart of the `ProblematicValue` the lenient side
        // returns: the same three facts, disposed of by throwing.

        const { engine } = newProbeEngine();

        try {
          engine.decode(MALFORMED, ENV);
          throw new Error("Should have thrown.");
        } catch (e) {
          expect(e).toBeInstanceOf(ProblematicStateError);
          expect((e as ProblematicStateError).wireTypeTag).toBe("");
          expect((e as ProblematicStateError).state).toBeDefined();
        }
      });

      it("keeps what a codec threw as `cause`", () => {
        // Rethrowing as-is would lose the state; building afresh would lose
        // the original. Neither is acceptable, so the original is the cause.

        const { engine } = newProbeEngine();

        try {
          engine.decode(THROWN, ENV);
          throw new Error("Should have thrown.");
        } catch (e) {
          expect(e).toBeInstanceOf(ProblematicStateError);
          expect((e as Error).cause).toBeInstanceOf(Error);
          expect(((e as Error).cause as Error).message)
            .toMatch(/rejected by throwing/);
        }
      });
    });

    describe("when `lenient === true`", () => {
      it("turns a codec's throw into a `ProblematicValue`", () => {
        const { engine } = newProbeEngine({ lenient: true });
        const result = engine.decode(THROWN, ENV);

        expect(result).toBeInstanceOf(ProblematicValue);
        // Carrying the codec's own message, so what went wrong survives the
        // conversion.
        expect((result as ProblematicValue).error)
          .toMatch(/rejected by throwing/);
        expect((result as ProblematicValue).wireTypeTag).toBe("Throws@1");
      });

      it("lets a `ProblematicValue` a codec returned stand", () => {
        const { engine } = newProbeEngine({ lenient: true });
        const result = engine.decode(RETURNED, ENV);

        expect(result).toBeInstanceOf(ProblematicValue);
        expect((result as ProblematicValue).error)
          .toMatch(/rejected by returning/);
      });

      it("turns a refusal from `canDecode()` into a `ProblematicValue`", () => {
        const { engine } = newProbeEngine({ lenient: true });
        const result = engine.decode(REFUSED, ENV);

        expect(result).toBeInstanceOf(ProblematicValue);
        // The message is what separates this from the codec's `decode()`
        // having run and thrown: that one refuses too, and would arrive here
        // wearing the same tag and state.
        expect((result as ProblematicValue).error)
          .toMatch(/state is not one this codec decodes/);
        expect((result as ProblematicValue).wireTypeTag).toBe("Refuses@1");
        expect((result as ProblematicValue).state).toBe("x");
      });

      it("keeps a malformation the walk itself found", () => {
        const { engine } = newProbeEngine({ lenient: true });
        const result = engine.decode(MALFORMED, ENV);

        expect(result).toBeInstanceOf(ProblematicValue);
        expect((result as ProblematicValue).error).toMatch(/malformed tag/);
      });

      it("deep-freezes a `ProblematicValue` a codec returned", () => {
        // The codec arm's freeze: this report is the codec's own product.

        const { engine } = newProbeEngine({ lenient: true });

        expect(isDeepFrozen(engine.decode(RETURNED, ENV))).toBe(true);
      });

      it("deep-freezes a `ProblematicValue` it built itself", () => {
        // The other arm, and a separate line of code: one is the engine
        // wrapping a throw, the other the walk reporting a malformation.
        // Neither stands in for the other.

        const { engine } = newProbeEngine({ lenient: true });

        expect(isDeepFrozen(engine.decode(THROWN, ENV))).toBe(true);
        expect(isDeepFrozen(engine.decode(MALFORMED, ENV))).toBe(true);
      });

      it("wraps an unclaimed tag in an `UnknownValue` regardless", () => {
        const { engine } = newProbeEngine({ lenient: true });

        expect(engine.decode(UNCLAIMED, ENV)).toBeInstanceOf(UnknownValue);
      });
    });
  });
});
