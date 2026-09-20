/**
 * Tests for the realm-crossing wire format: the engine, the entry points over
 * it, and the kind each participating class declares.
 *
 * The round trips go through a real `Worker`, not `structuredClone()` in this
 * realm. Cloning runs the same encoding algorithm, so it would prove the
 * walk is invertible -- but this format exists to carry values to another
 * realm, and only the far side can show that what arrives there is a live
 * instance of the right class rather than a shape that happens to match.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { defer } from "@commonfabric/utils/defer";

import type { FabricValue } from "@";
import {
  BaseTerminalCodec,
  NULL_LIVE_ENVIRONMENT,
  ProblematicStateError,
  ProblematicValue,
  REALM_CODEC,
  UnknownValue,
} from "@/codec-common";
import {
  RealmCodecEngine,
  type RealmCodecValue,
  type RealmEncodedValue,
  type RealmTaggedValue,
} from "@/codec-realm";
import { RealmDecodeAct } from "@/codec-realm/RealmDecodeAct.ts";
import { RealmEncodeAct } from "@/codec-realm/RealmEncodeAct.ts";
import {
  createDefaultRealmRegistry,
  fabricFromRealmValue,
  newDefaultRealmCodecEngine,
  realmFromFabricValue,
} from "@/codecs.ts";
import { FabricError } from "@/fabric-instances";
import {
  FabricBytes,
  FabricEpochDay,
  FabricEpochNsec,
  FabricHash,
  FabricKeyPair,
  FabricRegExp,
  FabricUnavailable,
  UNAVAILABLE_SYNCING,
} from "@/fabric-primitives";
import type { EchoReport } from "./realm-echo-worker.ts";

/**
 * A marker for hand-built wire data, taken from the engine rather than written
 * out here. What these tests need is one a *peer* could have sent: equal to
 * what this build mints, and not identical to any particular call's, which is
 * exactly what one encode's marker is to every other encode.
 *
 * Deriving it is what keeps that true. Written out as a literal it would be a
 * second copy of the format's version, free to drift from the first -- and
 * drift that `decode()`'s validation happened to move with would leave every
 * hand-built case below exercising a form the engine no longer emits.
 */
const WIRE_MARKER = realmFromFabricValue(null)[0];

/** Wraps hand-built wire data in an outer envelope under {@link WIRE_MARKER}. */
function wire(payload: unknown): RealmEncodedValue {
  return [WIRE_MARKER, payload as RealmCodecValue];
}

/** A tagged form under {@link WIRE_MARKER}, for hand-built wire data. */
function tagged(tag: unknown, state: unknown): RealmCodecValue {
  return [WIRE_MARKER, tag, state] as unknown as RealmCodecValue;
}

/** The walked tree inside an encoded value's outer envelope. */
function payloadOf(encoded: RealmEncodedValue): RealmCodecValue {
  return encoded[1];
}

/** The state under a tagged form, for an encoded value that is one. */
function stateOf(encoded: RealmEncodedValue): RealmCodecValue {
  return (payloadOf(encoded) as unknown as RealmTaggedValue)[2];
}

/**
 * Encodes `value`, sends it to a real `Worker`, and returns what that worker
 * made of it. Waits on the worker's own message rather than polling, and
 * terminates it however the wait ends.
 */
async function crossRealm(value: FabricValue): Promise<EchoReport> {
  const worker = new Worker(
    new URL("./realm-echo-worker.ts", import.meta.url).href,
    { type: "module" },
  );
  const report = defer<EchoReport>();

  worker.onmessage = (ev) => report.resolve(ev.data as EchoReport);
  worker.onerror = (ev) => report.reject(new Error(ev.message));

  try {
    worker.postMessage(realmFromFabricValue(value));
    return await report.promise;
  } finally {
    worker.terminate();
  }
}

describe("RealmCodecEngine", () => {
  describe("encode()", () => {
    it("leaves a container even when encoding a child throws", () => {
      // The in-progress set belongs to the act, not the node, so a container left
      // entered by a throw stays entered. A later visit to it then reports a
      // cycle that is not there -- and says so, naming a circular reference
      // where the real fault was the child. The differential is the message:
      // both attempts must fail the same way the first did.

      const engine = newDefaultRealmCodecEngine();
      const act = new RealmEncodeAct(engine, NULL_LIVE_ENVIRONMENT);
      // A function is no kind of `FabricValue`, so encoding the element throws
      // from inside the array's own descent.
      const holder = [() => 1] as unknown as FabricValue;

      expect(() => act.encodeValue(holder)).toThrow(/Cannot encode function/);
      expect(() => act.encodeValue(holder)).toThrow(/Cannot encode function/);
    });

    it("mints a marker equal to every other call's and identical to none", () => {
      // Both halves of what `WIRE_MARKER` assumes about the engine, and it is
      // derived from one of these calls, so the pair is what says the
      // assumption holds rather than merely that a constant matches itself.
      // Equal: the shape and version a decoder checks are stable across
      // calls, which is what lets a peer's payload decode here at all.
      // Distinct: each call mints its own, which is what makes an earlier
      // encoding's marker ordinary data when it turns up inside a later one.

      const first = realmFromFabricValue(null)[0];
      const second = realmFromFabricValue(null)[0];

      expect(first).toEqual(second);
      expect(first).not.toBe(second);
      expect(first).toEqual(WIRE_MARKER);
    });

    it("wraps the walked tree, which is otherwise the caller's own", () => {
      const value = { a: 1 };

      // Not merely equal: the same object. An outer envelope would make that
      // impossible for any value at all, however little of it needed
      // encoding.
      expect(payloadOf(realmFromFabricValue(value))).toBe(value);
    });

    it("returns a payload holding no encodable value by identity", () => {
      const value = { a: 1, b: { c: "two" }, d: [3, 4] };

      // Copy-on-write: nothing here needs encoding, so nothing is rebuilt and
      // the transport does the only copying.
      expect(payloadOf(realmFromFabricValue(value))).toBe(value);
    });

    it("rebuilds only the containers on the path to an encoded value", () => {
      const untouched = { c: "two" };
      const value = { a: new FabricBytes(new Uint8Array([1])), b: untouched };
      const payload = payloadOf(realmFromFabricValue(value)) as Record<
        string,
        RealmCodecValue
      >;

      expect(payload).not.toBe(value);
      expect(payload.b).toBe(untouched);
    });

    it("leaves a `/`-prefixed key untouched, this format reserving no key", () => {
      const value = { "/quote": "not a tag here", "/Bytes@1": "nor this" };

      expect(payloadOf(realmFromFabricValue(value))).toBe(value);
    });

    it("encodes a `FabricBytes` to a transferable `ArrayBuffer`", () => {
      const payload = payloadOf(realmFromFabricValue(
        new FabricBytes(new Uint8Array([1, 2, 250])),
      ));
      const state = (payload as unknown as RealmTaggedValue)[2];

      // An `ArrayBuffer` rather than a view onto one, that being the form
      // `postMessage()` can transfer.
      expect(state).toBeInstanceOf(ArrayBuffer);
      expect([...new Uint8Array(state as ArrayBuffer)]).toEqual([1, 2, 250]);
    });

    it("encodes a `FabricBytes` to a buffer covering exactly its bytes", () => {
      // A transfer hands over the whole buffer, so a state covering more than
      // the value would cede bytes that are not part of it.

      const payload = payloadOf(realmFromFabricValue(
        new FabricBytes(new Uint8Array([1, 2, 250])),
      ));
      const state = (payload as unknown as RealmTaggedValue)[2] as ArrayBuffer;

      expect(state.byteLength).toBe(3);
    });

    it("encodes a `FabricHash` to a tag and a transferable `ArrayBuffer`", () => {
      const payload = payloadOf(realmFromFabricValue(
        new FabricHash(new Uint8Array([1, 2, 3]), "fid1"),
      ));
      const state = (payload as unknown as RealmTaggedValue)[2] as {
        tag: string;
        hash: ArrayBuffer;
      };

      // Both byte-carrying classes reach `postMessage()`'s transferable form,
      // so a transfer list can be assembled from either without reaching
      // through a view.
      expect(state.tag).toBe("fid1");
      expect(state.hash).toBeInstanceOf(ArrayBuffer);
      expect([...new Uint8Array(state.hash)]).toEqual([1, 2, 3]);
      // Covering exactly the bytes: a transfer hands over the whole buffer.
      expect(state.hash.byteLength).toBe(3);
    });

    it("does not hand out the bytes an encoded `FabricHash` holds", () => {
      const hash = new FabricHash(new Uint8Array([1, 2, 3]), "fid1");
      const state = stateOf(realmFromFabricValue(hash)) as {
        hash: ArrayBuffer;
      };

      new Uint8Array(state.hash)[0] = 99;
      // Read through `bytes`, not `toString()`: the string forms are computed
      // once in the constructor, so they cannot witness a mutation of the
      // bytes and a test resting on them passes however this codec behaves.
      expect([...hash.bytes]).toEqual([1, 2, 3]);
    });

    it("encodes a `FabricEpochNsec` to a `bigint`", () => {
      const payload = payloadOf(realmFromFabricValue(
        new FabricEpochNsec(1234567890123456789n),
      ));

      expect((payload as unknown as RealmTaggedValue)[2]).toBe(
        1234567890123456789n,
      );
    });

    it("encodes an interned symbol to its registry key", () => {
      // Cloning refuses every symbol, so this is the one JavaScript primitive
      // the format has to encode at all.

      const payload = payloadOf(
        realmFromFabricValue(Symbol.for("k") as FabricValue),
      );

      expect((payload as unknown as RealmTaggedValue)[2]).toBe("k");
    });

    it("throws when given a unique symbol, rather than interning one", () => {
      // A unique symbol has no key to carry, so there is nothing to encode
      // that would decode back to it. Coercing one to a registry symbol would
      // hand the far side a different symbol wearing its description.

      expect(() => realmFromFabricValue(Symbol("d") as FabricValue))
        .toThrow(/no applicable codec/);
      expect(() => realmFromFabricValue(Symbol() as FabricValue))
        .toThrow(/no applicable codec/);
    });

    it("does not hand out the bytes an encoded `FabricBytes` holds", () => {
      const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
      const state = new Uint8Array(
        stateOf(realmFromFabricValue(bytes)) as ArrayBuffer,
      );

      state[0] = 99;
      expect([...bytes.slice()]).toEqual([1, 2, 3]);
    });

    it("keeps a shared subtree shared when it needs no encoding", () => {
      const shared = { s: 1 };
      const payload = payloadOf(
        realmFromFabricValue({ a: shared, b: shared }),
      ) as Record<
        string,
        RealmCodecValue
      >;

      // Copy-on-write does this rather than any memo: `shared` comes back by
      // identity from both positions, so both still hold the one object.
      expect(payload.a).toBe(shared);
      expect(payload.a).toBe(payload.b);
    });

    it("rebuilds a shared subtree separately when it needs encoding", () => {
      const shared = { bytes: new FabricBytes(new Uint8Array([1, 2])) };
      const payload = payloadOf(
        realmFromFabricValue({ a: shared, b: shared }),
      ) as Record<
        string,
        RealmCodecValue
      >;

      // The other half of the contract, and the reason it is worth stating:
      // each position rebuilds on its own, so the encoding has two equal
      // objects where the value had one.
      expect(payload.a).not.toBe(payload.b);
      expect(payload.a).toEqual(payload.b);
    });

    it("throws when given a circular reference", () => {
      const value: Record<string, FabricValue> = { a: 1 };
      value.self = value;

      expect(() => realmFromFabricValue(value)).toThrow(/Circular reference/);
    });

    it("throws when given an object with a key this runtime reserves", () => {
      const value = Object.defineProperty({}, "__proto__", {
        value: 1,
        enumerable: true,
        configurable: true,
        writable: true,
      });

      expect(() => realmFromFabricValue(value)).toThrow(/reserves/);
    });
  });

  describe("decode()", () => {
    it("returns a plain payload as it stands", () => {
      // With no tagged form anywhere in it, an ordinary value decodes to
      // itself once the outer envelope is stripped.

      expect(fabricFromRealmValue(wire({ a: 1 }))).toEqual({ a: 1 });
    });

    it("throws when given a form this format never emits", () => {
      // Cloning carries a `Date`; this format has no codec that produces one,
      // so it can only have come from something other than an `encode()`.

      expect(() => fabricFromRealmValue(wire(new Date()))).toThrow(
        /not a form this format emits/,
      );
    });

    it("throws when given a buffer or view in an untagged position", () => {
      // Section 6 names all three, and singles out `ArrayBuffer`: it is the
      // one such type this format's own value union contains, legitimate only
      // as the state under a byte-carrying tag and never on its own. Cloning
      // carries each of these, so a peer can send one.

      for (
        const bad of [
          new Uint8Array([1, 2]).buffer,
          new Uint8Array([1, 2]),
          new DataView(new Uint8Array([1, 2]).buffer),
        ]
      ) {
        expect(() => fabricFromRealmValue(wire(bad)))
          .toThrow(/not a form this format emits/);
      }
    });

    it("returns a `FabricHash` for a terminal state carrying a reserved key and a cycle", () => {
      // A terminal state is opaque, per Section 3.3: the walk hands it to its
      // codec without descending, so the reserved-key rule of Section 3.2 and
      // the cycle rule of Section 4 -- both of which refuse these outright in
      // a walked container -- never reach inside one. `Hash@1` reads `tag`
      // and `hash` and never looks at the rest.

      const state: Record<string, unknown> = {
        tag: "fid1",
        hash: new Uint8Array([1, 2, 3]).buffer,
      };

      Object.defineProperty(state, "constructor", {
        value: "reserved, and ignored",
        enumerable: true,
        configurable: true,
        writable: true,
      });
      state.self = state;

      const decoded = fabricFromRealmValue(wire(tagged("Hash@1", state)));

      expect(decoded).toBeInstanceOf(FabricHash);
      expect((decoded as FabricHash).tag).toBe("fid1");
      expect([...(decoded as FabricHash).bytes]).toEqual([1, 2, 3]);
    });

    it("throws when given a reserved key in a container it walks", () => {
      // The control for the case above, and what bounds it: the same key in a
      // position the walk reaches IS refused. Without this pair, the opacity
      // case alone would read as the rule not existing.

      const walked: Record<string, unknown> = { a: 1 };

      Object.defineProperty(walked, "constructor", {
        value: "reserved, and refused",
        enumerable: true,
        configurable: true,
        writable: true,
      });

      expect(() => fabricFromRealmValue(wire(walked))).toThrow(/reserves/);
    });

    it("returns an empty `es2025` pattern for a `RegExp@1` state with no fields", () => {
      // Section 7.1: every field of this codec's state defaults when absent,
      // which is what lets a narrower encoder omit what it has nothing to say
      // about.

      const decoded = fabricFromRealmValue(wire(tagged("RegExp@1", {})));

      expect(decoded).toBeInstanceOf(FabricRegExp);
      expect((decoded as FabricRegExp).flavor).toBe("es2025");
      expect((decoded as FabricRegExp).source).toBe("");
      expect((decoded as FabricRegExp).flags).toBe("");
    });

    it("returns a `ProblematicValue` for a `RegExp@1` field present as `undefined`", () => {
      // Absent and present-as-`undefined` are different, and this format is
      // where the difference can arise: cloning carries `undefined` directly,
      // so a peer can send one on purpose, and defaulting it would answer a
      // question the wire did ask.

      const engine = newDefaultRealmCodecEngine({ lenient: true });
      const decoded = engine.decode(
        wire(tagged("RegExp@1", { source: undefined })),
        NULL_LIVE_ENVIRONMENT,
      );

      expect(decoded).toBeInstanceOf(ProblematicValue);
      expect((decoded as ProblematicValue).error)
        .toMatch(/state is not one this codec decodes/);
    });

    it("throws when given a `Map`, which is no form this format emits", () => {
      // Cloning carries one faithfully, so a peer can send one; nothing here
      // makes one, so finding one is a malformation like any other.

      expect(() => fabricFromRealmValue(wire(new Map([["a", 1]]))))
        .toThrow(/not a form this format emits/);
    });

    it("throws when given an outer envelope that is not two elements", () => {
      // The one place this engine takes instruction from the data, so the
      // slot count is checked before slot zero is read as a marker at all.
      // Three of these carry a well-formed marker, which is what gives the
      // slot-count clause its grip: with that clause gone nothing else here
      // refuses them. The empty array reaches the same clause, having no
      // second slot rather than a bad marker; only `"nope"` and `42` are
      // refused for not being arrays at all.

      for (
        const bad of [
          [],
          [["fvr1"]],
          [["fvr1"], 1, 2],
          [["fvr1"], 1, 2, 3],
          "nope",
          42,
        ]
      ) {
        expect(() => fabricFromRealmValue(bad as never))
          .toThrow(/two-element outer envelope/);
      }
    });

    it("returns three slots headed by `undefined` as data, with no marker adopted", () => {
      // A decode act holds no marker until `decode()` adopts one off the
      // envelope, and a walk driven with such an act recognizes no tagged
      // form at all. That is the safe answer rather than a degenerate one:
      // `undefined` is a value this format carries directly, so a payload can
      // put one in slot zero for free, and identity against an absent marker
      // would match it and read the array as a tagged form.

      class Exposed extends RealmCodecEngine {
        decodeWithoutMarker(data: unknown): FabricValue {
          const act = new RealmDecodeAct(this, NULL_LIVE_ENVIRONMENT);
          return act.decodeValue(data as never);
        }
      }

      const engine = new Exposed({ registry: createDefaultRealmRegistry() });
      // A state this format carries as data, so that what the walk does with
      // slot zero is the only thing under test: a bare `ArrayBuffer` would be
      // refused on its own account once the array is walked as data.
      const decoded = engine.decodeWithoutMarker([
        undefined,
        "EpochDay@1",
        7n,
      ]);

      // Data, not a `FabricEpochDay` built from a forged tagged form.
      expect(Array.isArray(decoded)).toBe(true);
      expect((decoded as FabricValue[])[1]).toBe("EpochDay@1");
      expect(decoded).not.toBeInstanceOf(FabricEpochDay);
    });

    it("returns a `ProblematicValue` for a bad state, for every codec that validates one", () => {
      // Section 7.1 of `4-realm-encoding.md` requires a codec to reject the
      // state it is handed rather than coerce it, so each of these is a
      // requirement rather than an observation. Lenient, because the report is
      // what is under test -- strictly these raise, which the cases above
      // already cover.

      const engine = newDefaultRealmCodecEngine({ lenient: true });
      const bad = (tag: string, state: unknown) => {
        const result = engine.decode(
          wire(tagged(tag, state)),
          NULL_LIVE_ENVIRONMENT,
        );

        // Asserted here rather than at each call: the name of this case
        // promises the class, and a cast promises nothing.
        expect(result).toBeInstanceOf(ProblematicValue);
        return result as ProblematicValue;
      };

      // The refusal is the engine's, `canDecode()` having declined the state,
      // so every one of these carries the same wording. What each case
      // establishes is that the codec declines its own kind of bad state, not
      // how the decline is phrased.
      const refused = /state is not one this codec decodes/;

      // Wrong primitive type where a `bigint` is required.
      expect(bad("EpochDay@1", "7").error).toMatch(refused);
      expect(bad("EpochNsec@1", 7).error).toMatch(refused);

      // Not a record at all, then a record with the wrong field types.
      expect(bad("Hash@1", 42).error).toMatch(refused);
      expect(bad("Hash@1", { tag: 1, hash: 2 }).error).toMatch(refused);
      expect(bad("RegExp@1", 42).error).toMatch(refused);
      expect(bad("RegExp@1", { source: 1, flags: 2, flavor: 3 }).error)
        .toMatch(refused);

      // Bytes wants the transport's own byte carrier and takes nothing else.
      expect(bad("Bytes@1", "nope").error).toMatch(refused);

      // Well-typed fields that still do not make a value. `RegExp@1` is the
      // one codec here whose construction can fail on data that passed every
      // type check, so its refusal has to survive a throw rather than only a
      // shape test: a source and a flag set that `RegExp` itself rejects.
      expect(
        bad("RegExp@1", { source: "(", flags: "g", flavor: "es2025" })
          .error,
      ).toMatch(/Invalid regular expression/);
      expect(
        bad("RegExp@1", { source: "a", flags: "zz", flavor: "es2025" })
          .error,
      ).toMatch(/Invalid flags/);
    });

    it("throws when given a symbol or a function untagged", () => {
      // Cloning carries neither, so neither reaches this across the boundary
      // -- but `decode()` is callable in the realm that built its argument,
      // and passing them through would leave a value in the result that this
      // format cannot emit and `encode()` will not take.

      expect(() => fabricFromRealmValue(wire(Symbol("u"))))
        .toThrow(/Cannot decode symbol/);
      expect(() => fabricFromRealmValue(wire(() => 1)))
        .toThrow(/Cannot decode function/);
      // Nested, where a pass-through would hide inside a frozen container.
      expect(() => fabricFromRealmValue(wire({ a: Symbol("u") })))
        .toThrow(/Cannot decode symbol/);
    });

    it("throws when given an outer envelope whose marker is not this format's", () => {
      // A primitive at slot zero is the case that would break recognition
      // outright: `===` on one is value equality, so any payload holding the
      // same primitive would reproduce the marker. The rest are refused
      // because a marker this build did not write is one whose encoding it
      // cannot claim to understand.

      const bad = [
        // Primitives, which cannot mark anything.
        "fvr1",
        42,
        null,
        undefined,
        7n,
        true,
        // Objects, but not the shape Section 2.4 specifies.
        {},
        { 0: "fvr1", length: 1 },
        [],
        ["fvr1", "extra"],
        // The right shape, carrying a version this build does not implement.
        ["fvr2"],
        ["FVR1"],
      ];

      for (const marker of bad) {
        expect(() => fabricFromRealmValue([marker, { a: 1 }] as never))
          .toThrow(/expected an outer envelope headed by a `fvr1` marker/);
      }
    });

    it("refuses an envelope that is not exactly two slots", () => {
      // Without the slot count, a tagged form arriving here would be read as
      // an envelope and its tag handed back as the tree.

      const marker = ["fvr1"];

      for (
        const wrong of [
          [marker],
          [marker, "Tagged@1", { a: 1 }],
          [marker, { a: 1 }, "extra"],
        ]
      ) {
        expect(() => fabricFromRealmValue(wrong as never))
          .toThrow(/expected a two-element outer envelope/);
      }
    });

    it("decodes an outer envelope headed by a peer's own equal marker", () => {
      // The control for the case above, and the property that lets a peer
      // send a well-formed payload at all: what is checked is the marker's
      // shape and version, never its identity against one this realm minted.

      expect(fabricFromRealmValue([["fvr1"], { a: 1 }] as never))
        .toEqual({ a: 1 });
    });

    it("treats a two-element array in a data position as data", () => {
      // A genuine payload cannot hold the current marker at all, but a peer
      // can send anything. Slot count is checked before identity, so this is
      // an array and not a tagged form missing its state.

      const marker = realmFromFabricValue(null)[0];
      const decoded = fabricFromRealmValue(
        [marker, { a: [marker, "EpochDay@1"] }] as never,
      ) as Record<string, FabricValue>;

      expect(Array.isArray(decoded.a)).toBe(true);
      expect((decoded.a as FabricValue[])[1]).toBe("EpochDay@1");
    });

    it("throws when given an outer envelope nested as its own payload", () => {
      // `E = [m, E]`. The walk visits `E` again beneath itself, where the guard
      // has it, so this is a cycle rather than an unbounded descent.

      const envelope: unknown[] = [["fvr1"], null];
      envelope[1] = envelope;

      expect(() => fabricFromRealmValue(envelope as never))
        .toThrow(/circular reference/);
    });

    it("treats an array the marker does not head as ordinary data", () => {
      // Three elements and a lookalike marker in slot zero, and still data:
      // recognition is identity, and this array's slot zero is some other
      // object however equal it looks.

      const lookalike = ["fvr1"];
      const decoded = fabricFromRealmValue(
        wire({ a: [lookalike, "EpochDay@1", 7n] }),
      ) as Record<string, FabricValue>;

      expect(Array.isArray(decoded.a)).toBe(true);
      expect((decoded.a as FabricValue[])[1]).toBe("EpochDay@1");
      // And slot zero is still the array the payload built, not swapped for
      // anything: an unrecognized head is data like the rest of it.
      expect((decoded.a as FabricValue[])[0]).toBe(lookalike);
    });

    it("throws when given a tagged form whose tag is not a tag", () => {
      // Slot one holds whatever a peer put there, so this format can find a
      // non-string in tag position where JSON never can. The engine hands it
      // over as it found it, and the shared tag check judges it, so what is
      // refused here is refused the same way under any format.

      expect(() => fabricFromRealmValue(wire(tagged(42, "x"))))
        .toThrow(/malformed tag/);
      expect(() => fabricFromRealmValue(wire(tagged(Symbol("s"), "x"))))
        .toThrow(/malformed tag/);
      expect(() => fabricFromRealmValue(wire(tagged("hole", "x"))))
        .toThrow(/malformed tag/);
    });

    it("keeps the offending key in a lenient refusal", () => {
      const engine = newDefaultRealmCodecEngine({ lenient: true });
      const decoded = engine.decode(
        wire(tagged(42, "x")),
        NULL_LIVE_ENVIRONMENT,
      ) as ProblematicValue;

      expect(decoded).toBeInstanceOf(ProblematicValue);
      expect(decoded.error).toMatch(/malformed tag/);
      // The key itself, rendered: a report of a bad tag that did not say
      // which tag would be most of the way to useless.
      expect(decoded.wireTypeTag).toBe("42");
    });

    it("raises a codec's rejection as a `ProblematicStateError`", () => {
      // A codec's own rejection rather than the walk's: the tag is claimed,
      // and `FabricBytes` wants an `ArrayBuffer` where this carries a string.
      // The default engine is strict, so this throws.

      try {
        fabricFromRealmValue(wire(tagged("Bytes@1", "nope")));
        throw new Error("Should have thrown.");
      } catch (e) {
        expect(e).toBeInstanceOf(ProblematicStateError);
        expect((e as ProblematicStateError).wireTypeTag).toBe("Bytes@1");
        expect((e as ProblematicStateError).state).toBe("nope");

        // The tag rides on the error, so a codec that also named it in its
        // message would say it twice. These do not.
        expect((e as Error).message).not.toMatch(/Bytes@1/);
      }
    });

    it("returns that same rejection as a `ProblematicValue` when lenient", () => {
      // Every realm codec reports by returning one, as its JSON
      // counterpart does; `lenient` is what decides which a caller sees.

      const engine = newDefaultRealmCodecEngine({ lenient: true });
      const decoded = engine.decode(
        wire(tagged("Bytes@1", "nope")),
        NULL_LIVE_ENVIRONMENT,
      );

      expect(decoded).toBeInstanceOf(ProblematicValue);
      expect((decoded as ProblematicValue).wireTypeTag).toBe("Bytes@1");
      expect((decoded as ProblematicValue).error)
        .toMatch(/state is not one this codec decodes/);
    });

    it("raises a symbol's bad state without naming the tag twice", () => {
      // `SymbolCodec` reports by returning a `ProblematicValue`, as the rest
      // of this format's codecs do. The tag rides on the error whichever way a
      // codec reports, so one throwing an `Error` of its own that named the
      // tag would have the message say it a second time.

      try {
        fabricFromRealmValue(wire(tagged("Symbol@1", 42)));
        throw new Error("Should have thrown.");
      } catch (e) {
        expect(e).toBeInstanceOf(ProblematicStateError);
        expect((e as ProblematicStateError).wireTypeTag).toBe("Symbol@1");
        expect((e as ProblematicStateError).state).toBe(42);
        expect((e as Error).message).not.toMatch(/Symbol@1/);
      }
    });

    it("wraps an unclaimed tag in an `UnknownValue` rather than refusing", () => {
      // Three slots headed by the marker ARE the tagged form, so this is a
      // well-formed value carrying a tag no codec claims -- a different thing
      // from a malformation.

      const decoded = fabricFromRealmValue(wire(tagged("Nope@1", 1)));

      expect(decoded).toBeInstanceOf(UnknownValue);
      expect((decoded as UnknownValue).wireTypeTag).toBe("Nope@1");
    });

    it("throws when given a circular reference", () => {
      // Cloning reproduces a cyclic graph faithfully, so unlike JSON -- whose
      // `JSON.parse()` cannot produce one -- this format can actually be sent
      // a cycle by a peer. Without a guard the walk recurses until the stack
      // gives out, which is the one refusal `lenient` could not contain.

      const object: Record<string, RealmCodecValue> = { a: 1 };
      object.self = object;
      const array: RealmCodecValue[] = [1];
      array.push(array);

      expect(() => fabricFromRealmValue(wire(object))).toThrow(
        /circular reference/,
      );
      expect(() => fabricFromRealmValue(wire(array))).toThrow(
        /circular reference/,
      );
    });

    it("throws when given a circular reference closed through tagged values alone", () => {
      // The tagged form is a container too: `decodeTagged()` walks the state
      // again for a nonterminal codec, for a tag no codec claims, and for a
      // tag that is not one. So a graph of tagged forms can close a cycle with no
      // plain container in it at all, and cloning carries one faithfully.

      const unknownTag = tagged("Nope@1", null) as unknown as unknown[];
      unknownTag[2] = unknownTag;

      const malformedTag = tagged(42, null) as unknown as unknown[];
      malformedTag[2] = malformedTag;

      const nonterminal = tagged("Error@1", null) as unknown as unknown[];
      nonterminal[2] = nonterminal;

      for (const one of [unknownTag, malformedTag, nonterminal]) {
        expect(() => fabricFromRealmValue(wire(one)))
          .toThrow(/circular reference/);
      }
    });

    it("throws when given a circular reference closed through a mix of the two", () => {
      const object: Record<string, RealmCodecValue> = {};
      object.tagged = tagged("Nope@1", object);

      expect(() => fabricFromRealmValue(wire(object))).toThrow(
        /circular reference/,
      );
    });

    it("decodes the same tagged value at two positions, which is no cycle", () => {
      // The guard must catch a node reached while still being decoded, not one
      // merely seen twice. Sequential visits leave the set between them, so
      // this is the check that it does not over-refuse.
      //
      // One tagged node at both positions, and not two values that encode
      // alike: `wrapTag()` builds a fresh tagged form per visit, so encoding a
      // value that holds one instance twice yields two nodes and revisits
      // nothing. A hand-built node is reused directly to get the sharing this
      // needs.

      const shared = tagged("EpochDay@1", 7n);
      const decoded = fabricFromRealmValue(
        wire({ x: shared, y: shared }),
      ) as Record<string, FabricValue>;

      expect(decoded.x).toBeInstanceOf(FabricEpochDay);
      expect(decoded.y).toBeInstanceOf(FabricEpochDay);
    });

    it("returns a reserved-key `ProblematicValue`, not a circular one, for a repeated object", () => {
      // The reserved-key arm returns early, so it has to leave the
      // in-progress set on its way out. Without that, the second position
      // holding the same object would be read as a back-edge and reported as
      // a cycle -- the right refusal for the wrong reason.

      const offender = Object.defineProperty({ a: 1 }, "constructor", {
        value: "c",
        enumerable: true,
        configurable: true,
        writable: true,
      }) as Record<string, RealmCodecValue>;
      const engine = newDefaultRealmCodecEngine({ lenient: true });
      const decoded = engine.decode(
        wire({ first: offender, second: offender }),
        NULL_LIVE_ENVIRONMENT,
      ) as Record<string, ProblematicValue>;

      expect(decoded.first).toBeInstanceOf(ProblematicValue);
      expect(decoded.second).toBeInstanceOf(ProblematicValue);
      expect(decoded.first?.error).toMatch(/reserves/);
      expect(decoded.second?.error).toMatch(/reserves/);
    });

    it("returns a `ProblematicValue` at the cycle when lenient", () => {
      const engine = newDefaultRealmCodecEngine({ lenient: true });
      const object: Record<string, RealmCodecValue> = { a: 1 };
      object.self = object;
      const decoded = engine.decode(
        wire(object),
        NULL_LIVE_ENVIRONMENT,
      ) as Record<string, FabricValue>;

      // The report replaces the back-edge rather than the whole value, so
      // everything else survives.
      expect(decoded.a).toBe(1);
      expect(decoded.self).toBeInstanceOf(ProblematicValue);
    });

    it("throws when given a key this runtime reserves", () => {
      // The rebuild below assigns, and on a host with the standard
      // `__proto__` accessor that would drop the key and repoint the result's
      // prototype. The key is computed on purpose: in an object literal a
      // `__proto__:` sets the prototype rather than creating a property, so a
      // literal cannot express this shape at all.

      const data = Object.defineProperty({ a: 1 }, "__proto__", {
        value: { hostile: true },
        enumerable: true,
        configurable: true,
        writable: true,
      });

      expect(() => fabricFromRealmValue(wire(data))).toThrow(/reserves/);
    });

    it("returns that refusal as a `ProblematicValue` when lenient", () => {
      const engine = newDefaultRealmCodecEngine({ lenient: true });
      const data = Object.defineProperty({ a: 1 }, "constructor", {
        value: "c",
        enumerable: true,
        configurable: true,
        writable: true,
      });
      const decoded = engine.decode(
        wire(data),
        NULL_LIVE_ENVIRONMENT,
      ) as ProblematicValue;

      expect(decoded).toBeInstanceOf(ProblematicValue);
      expect(decoded.wireTypeTag).toBe("constructor");
    });

    it("returns an object needing no decoding by identity", () => {
      const data = { a: 1, b: { c: "two" }, d: [3, 4] };

      // Copy-on-write on the decode side, as on the encode side. Each format
      // writes its own `decodeValue()`, so this is not covered by any test of
      // the shared engine.
      expect(fabricFromRealmValue(wire(data))).toBe(data);
    });

    it("returns an array needing no decoding by identity", () => {
      const data = [1, "two", { three: 3 }];

      expect(fabricFromRealmValue(wire(data))).toBe(data);
    });

    it("rebuilds only the objects on the path to a decoded value", () => {
      const untouched = { c: "two" };
      const data = { a: tagged("EpochNsec@1", 7n), b: untouched };
      const decoded = fabricFromRealmValue(wire(data)) as Record<
        string,
        FabricValue
      >;

      expect(decoded).not.toBe(data);
      expect(decoded.b).toBe(untouched);
    });

    it("rebuilds only the arrays on the path to a decoded value", () => {
      const untouched = [1, 2];
      const data = [tagged("EpochNsec@1", 7n), untouched];
      const decoded = fabricFromRealmValue(wire(data)) as FabricValue[];

      expect(decoded).not.toBe(data);
      expect(decoded[1]).toBe(untouched);
    });

    it("freezes what it retains from the value ceded to it", () => {
      const inner = { c: "two" };
      const innerArray = [1, 2];
      const data = {
        a: tagged("EpochNsec@1", 7n),
        b: inner,
        d: innerArray,
      };

      fabricFromRealmValue(wire(data));

      // Both came back by identity rather than rebuilt, so freezing them is
      // the whole of what keeps the result immutable.
      expect(Object.isFrozen(inner)).toBe(true);
      expect(Object.isFrozen(innerArray)).toBe(true);
    });

    it("leaves an outer encode its own marker when a codec re-enters it", () => {
      // Each act mints its own marker, so an encode
      // reached from inside another cannot disturb the outer one's. The way
      // to reach that with input the model admits is a codec calling back
      // through a public entry point -- a getter would do it in fewer lines
      // and would not be a `FabricValue`, accessors being rejected by Section
      // 1.5 of `1-fabric-values.md`.
      //
      // Sequential calls would test nothing here: the outer has returned
      // before a second starts, so per-act and per-engine markers look
      // identical. What discriminates them is a tagged form built AFTER the
      // nested call returns, which must still carry the outer marker.

      class Reentrant {}

      let nestedMarker: unknown;

      const codec =
        new (class ReentrantCodec extends BaseTerminalCodec<RealmCodecValue> {
          constructor() {
            super("Reentrant@1", Reentrant);
          }

          encode(): RealmCodecValue {
            nestedMarker = (engine.encode(7n) as unknown as unknown[])[0];
            return 1;
          }

          canDecode(state: RealmCodecValue): state is RealmCodecValue {
            return state === 1;
          }

          decode(): FabricValue {
            return 1;
          }
        })();

      const engine = new RealmCodecEngine({
        registry: createDefaultRealmRegistry().extend(codec),
      });

      const encoded = engine.encode({
        first: new Reentrant() as unknown as FabricValue,
        second: new FabricEpochDay(2n),
      }) as unknown as [
        unknown,
        Record<string, unknown[]>,
      ];

      expect(encoded[1].second![0]).toBe(encoded[0]);
      expect(nestedMarker).not.toBe(encoded[0]);
    });

    it("does not read an earlier encode's marker as this one's", () => {
      // The property the per-call marker exists for, and the whole of why it
      // is minted per call rather than held on the engine. A value may
      // legitimately hold a subtree of some earlier encoding -- whatever
      // assembled it is trusted and has seen one -- and copy-on-write carries
      // that subtree through, so the older marker ends up sitting in a *data*
      // position. A marker that outlived its call would be read there as a
      // tagged form, and user data would decode as a tagged value. What is
      // asserted is only that: whether the walk passed the subtree through or
      // rebuilt it, the same older marker object lands in slot zero either
      // way, and the point is that it is not this call's.

      const earlier = realmFromFabricValue(new FabricEpochDay(7n));
      const value = Object.freeze({
        smuggled: payloadOf(earlier) as FabricValue,
      });

      const decoded = fabricFromRealmValue(
        realmFromFabricValue(value),
      ) as Record<string, FabricValue>;

      // Data, three slots and all, rather than a decoded value.
      expect(Array.isArray(decoded.smuggled)).toBe(true);
      expect((decoded.smuggled as FabricValue[])[1]).toBe("EpochDay@1");
      expect(decoded.smuggled).not.toBeInstanceOf(FabricEpochDay);
    });

    it("reads those same three slots as tagged under a matching marker", () => {
      // The control for the case above, and what makes the pair a statement
      // about identity rather than about shape: the very same slots, under the
      // marker the outer envelope carries, do decode as the value they name.

      const marker = realmFromFabricValue(null)[0];
      const decoded = fabricFromRealmValue(
        [marker, [marker, "EpochDay@1", 7n]] as never,
      );

      expect(decoded).toBeInstanceOf(FabricEpochDay);
    });

    it("decodes a tree carrying bytes exactly once", () => {
      // Taking the buffer over detaches it, which is what ceding buys and what
      // it costs. A control sits beside it: a tree with no byte-carrying value
      // decodes as often as it likes, so what the first case pins is the
      // buffer and not decoding in general.

      const withBytes = realmFromFabricValue(
        { blob: new FabricBytes(new Uint8Array([1, 2, 250])) },
      );

      expect(fabricFromRealmValue(withBytes)).toBeDefined();
      // The message says how the buffer came to be detached, not merely that
      // it is: the runtime's own phrasing names the state without naming the
      // cause, and a second decode is the only way a tree reaches it.
      expect(() => fabricFromRealmValue(withBytes))
        .toThrow(/detached buffer, this tree having been decoded already/);

      const withoutBytes = realmFromFabricValue({
        when: new FabricEpochNsec(7n),
      });

      expect(fabricFromRealmValue(withoutBytes)).toBeDefined();
      expect(fabricFromRealmValue(withoutBytes)).toBeDefined();
    });

    it("decodes a tree carrying a `FabricHash` exactly once", () => {
      // The same property, and the reason to state it of both: a `FabricHash`
      // reaches the take-over through a record rather than as a bare buffer,
      // so a change that spared one could miss the other.

      const encoded = realmFromFabricValue(
        { digest: new FabricHash(new Uint8Array(32).fill(7), "sha256") },
      );

      expect(fabricFromRealmValue(encoded)).toBeDefined();
      expect(() => fabricFromRealmValue(encoded))
        .toThrow(/detached, this tree having been decoded already/);
    });

    it("returns a `ProblematicValue` for a spent byte tree when lenient", () => {
      // Decoding twice is settled against leniency like every other refusal,
      // which the two cases above pin only on the strict side. The report
      // lands where the bytes would have been, the rest of the value
      // surviving around it.

      const encoded = realmFromFabricValue({
        blob: new FabricBytes(new Uint8Array([1, 2, 250])),
        n: 7,
      });
      const engine = newDefaultRealmCodecEngine({ lenient: true });

      expect(engine.decode(encoded, NULL_LIVE_ENVIRONMENT))
        .toBeDefined();

      const second = engine.decode(
        encoded,
        NULL_LIVE_ENVIRONMENT,
      ) as Record<string, unknown>;

      expect(second.blob).toBeInstanceOf(ProblematicValue);
      expect(second.n).toBe(7);
    });
  });

  describe("across a real realm boundary", () => {
    it("decodes each class on the far side", async () => {
      const report = await crossRealm({
        bytes: new FabricBytes(new Uint8Array([1, 2, 250])),
        nsec: new FabricEpochNsec(1234567890123456789n),
        days: new FabricEpochDay(20_000n),
        hash: new FabricHash(new Uint8Array([9, 8, 7]), "fid1"),
        regexp: new FabricRegExp(/ab+c/gi),
        unavailable: new FabricUnavailable("error", "general", "boom"),
        prefab: UNAVAILABLE_SYNCING,
      });

      expect(report.ok).toBe(true);
      // Class identity, judged in the realm that received the value. A
      // structured clone alone flattens every one of these to a bare object.
      expect(report.classes).toEqual({
        bytes: "FabricBytes",
        nsec: "FabricEpochNsec",
        days: "FabricEpochDay",
        hash: "FabricHash",
        regexp: "FabricRegExp",
        unavailable: "FabricUnavailable",
        prefab: "FabricUnavailable",
      });
      // Content as well as class. A transposed field or a dropped value would
      // leave every `classes` entry correct, so the class check alone cannot
      // see it.
      expect(report.facts?.bytes).toEqual([1, 2, 250]);
      expect(report.facts?.nsec).toBe(1234567890123456789n);
      expect(report.facts?.days).toBe(20_000n);
      expect(report.facts?.hashTag).toBe("fid1");
      expect(report.facts?.hashBytes).toEqual([9, 8, 7]);
      expect(report.facts?.regexpParts).toEqual(["es2025", "ab+c", "gi"]);
      expect(report.facts?.unavailableParts)
        .toEqual(["error", "general", "boom"]);
      // The far realm has its own prefab, and a message-less reason decodes to
      // it there as it does here.
      expect(report.facts?.prefabIsThatRealmsPrefab).toBe(true);
    });

    it("carries what a plain `postMessage()` would lose or mangle", async () => {
      // Three things have to be true of this array for the assertion below to
      // mean anything. The `FabricBytes` forces the walk to REBUILD it, since
      // an all-plain array is returned by identity under copy-on-write and the
      // transport alone would then preserve the holes. One hole sits BEFORE
      // that element, which the rebuild's copy-the-prefix path must carry; and
      // one sits AFTER it, which the main loop must skip. Either alone leaves
      // the other path unexercised.

      const sparse: FabricValue[] = [
        1,
        2,
        new FabricBytes(new Uint8Array([3])),
        4,
        5,
      ];
      delete sparse[1];
      delete sparse[3];

      const report = await crossRealm({
        plain: { "/slashy": "no escaping needed" },
        sparse,
        big: 42n,
        negZero: -0,
        nothing: undefined,
        sym: Symbol.for("interned"),
        // A payload's own array, shaped exactly like a tagged form and headed
        // by an equal-looking marker. Section 1.1 asks the transport to keep
        // two distinct-but-equal objects distinct, and only a crossing can
        // check the transport: same-realm this is a fact about `===`, but a
        // transport that interned equal subtrees would merge this with the
        // real marker and the far side would decode ordinary data as a value.
        lookalike: [["fvr1"], "EpochDay@1", 7n],
      });

      expect(report.ok).toBe(true);
      // A `/`-prefixed key is ordinary data here, where JSON must escape it.
      expect(report.facts?.slashy).toBe("no escaping needed");
      // Holes survive as holes, so `/hole` needs no counterpart.
      expect(report.facts?.holeKeys).toEqual(["0", "2", "4"]);
      expect(report.classes?.sparse).toBe("Array");
      expect(report.facts?.sparseLength).toBe(5);
      expect(report.facts?.big).toBe(42n);
      expect(report.facts?.negZeroIsNegative).toBe(true);
      expect(report.facts?.nothingPresent).toBe(true);
      // A symbol is the one primitive cloning refuses outright, so this one
      // crossed through `SymbolCodec`. Internedness under the same key is the
      // whole of what the format promises, and so the whole of what is
      // checked: identity across a realm boundary is not a question it
      // answers, there being no realm in which both symbols exist to compare.
      expect(report.facts?.symbolIsInterned).toBe(true);
      // Still an array on the far side, and still carrying its own contents:
      // the transport kept it distinct from the marker it resembles. The
      // classes check above says the same thing from the other direction --
      // a merged marker would have made this a `FabricEpochDay`.
      expect(report.facts?.lookalikeIsArray).toBe(true);
      expect(report.facts?.lookalikeTag).toBe("EpochDay@1");
      expect(report.classes?.lookalike).toBe("Array");
    });

    it("carries a `FabricKeyPair`'s handles across as live `CryptoKey`s", async () => {
      // The whole reason this class has a realm arm and no JSON one. A
      // non-extractable key cannot produce its bytes, so no format that writes
      // bytes down can carry it; cloning carries the key itself, and what has
      // to be shown is that what lands on the far side is still that key
      // rather than a shape resembling it.

      const source = await crypto.subtle.generateKey(
        { name: "Ed25519" },
        false,
        ["sign", "verify"],
      ) as CryptoKeyPair;

      const report = await crossRealm({ keyPair: new FabricKeyPair(source) });

      expect(report.ok).toBe(true);
      expect(report.classes).toEqual({ keyPair: "FabricKeyPair" });
      expect(report.facts?.keyPair).toEqual({
        algorithm: "Ed25519",
        hasMaterial: false,
        publicKeyClass: "CryptoKey",
        privateKeyClass: "CryptoKey",
        privateKeyType: "private",
        // Extractability intact: a key that could not be exported here must
        // not become one that can be exported there.
        privateKeyExtractable: false,
        privateKeyUsages: ["sign"],
      });
    });

    it("carries a `FabricKeyPair`'s material across as bytes", async () => {
      const report = await crossRealm({
        keyPair: new FabricKeyPair(
          "ExampleAlgorithm",
          new Uint8Array([1, 2, 3]),
          new Uint8Array([250, 251]),
        ),
      });

      expect(report.ok).toBe(true);
      expect(report.classes).toEqual({ keyPair: "FabricKeyPair" });
      expect(report.facts?.keyPair).toEqual({
        algorithm: "ExampleAlgorithm",
        hasMaterial: true,
        publicKey: [1, 2, 3],
        privateKey: [250, 251],
      });
    });

    it("expands a nonterminal codec's state, terminating what is inside it", async () => {
      const report = await crossRealm({
        err: new FabricError({
          type: "RangeError",
          message: "boom",
          stack: undefined,
          cause: undefined,
          extras: { detail: new FabricBytes(new Uint8Array([7])) },
        }),
      });

      expect(report.ok).toBe(true);
      // `FabricError` binds one format-neutral `[CODEC]`, so the walk expands
      // its state; the `FabricBytes` inside then terminates as this format's
      // bytes rather than as JSON's base64url text.
      expect(report.classes).toEqual({ err: "FabricError" });
    });
  });

  describe("the kind each class declares for this format", () => {
    // The wire form cannot witness this for every class -- where a state is a
    // record of strings, a walk that descends into it and one that passes it
    // through emit the same thing -- so the declaration is asserted directly,
    // which is also how `CodecRegistry` reads it.

    for (
      const [name, cls] of [
        ["FabricBytes", FabricBytes],
        ["FabricEpochNsec", FabricEpochNsec],
        ["FabricEpochDay", FabricEpochDay],
        ["FabricHash", FabricHash],
        ["FabricRegExp", FabricRegExp],
        ["FabricUnavailable", FabricUnavailable],
      ] as const
    ) {
      it(`declares \`${name}\` terminal`, () => {
        expect(cls[REALM_CODEC] instanceof BaseTerminalCodec).toBe(true);
      });
    }

    it("declares `FabricError` nonterminal, one codec serving every format", () => {
      const registered = FabricError as unknown as Record<symbol, unknown>;

      expect(registered[REALM_CODEC]).toBe(undefined);
    });
  });
});
