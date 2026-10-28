import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricInstance, FabricValue } from "@";
import { ProblematicStateError, UnknownValue } from "@/codec-common";
import { jsonFromFabricValue } from "@/codecs.ts";
import {
  BaseFabricInstance,
  DEEP_CLONE_CORE,
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
  SHALLOW_UNFROZEN_CLONE,
} from "@/fabric-bases";
import { FabricError, FabricLink, FabricMap } from "@/fabric-instances";
import { FabricBytes, FabricKeyPair } from "@/fabric-primitives";
import {
  fabricValueOfTextWithModsForTestingOnly,
  probesOfForTestingOnly,
  type TextWithMods,
  textWithModsOfForTestingOnly,
} from "@/for-testing-only.ts";

/** A `FabricInstance` of a class neither class table names. */
class OtherInstance extends BaseFabricInstance {
  //
  // Unreached stubs
  //
  // Probing an instance reads none of these.
  //

  [DEEP_FREEZE](_subFreeze: (value: FabricValue) => FabricValue): FabricValue {
    throw new Error("not implemented");
  }

  [IS_DEEP_FROZEN](
    _subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean {
    throw new Error("not implemented");
  }

  [DEEP_CLONE_CORE](_frozen: boolean): FabricInstance {
    throw new Error("not implemented");
  }

  protected [SHALLOW_UNFROZEN_CLONE](): FabricInstance {
    return new OtherInstance();
  }
}

describe("conformance-fixtures", () => {
  describe("probesOfForTestingOnly()", () => {
    it("returns a special form for each container before the probes of what it holds, with record keys in UTF-8 order", () => {
      const record = Object.fromEntries([["b", [true]], ["\ud800", null], [
        "a",
        1n,
      ]]);
      expect(probesOfForTestingOnly(record)).toEqual([
        [[], { record: 3 }],
        [["a"], 'fvj1:{"/BigInt@1":"AQ"}'],
        [["b"], { array: 1 }],
        [["b", 0], "fvj1:true"],
        [[{ utf16: [0xd800] }], "fvj1:null"],
      ]);
    });

    it("returns the canonical text of each leaf, written on its own", () => {
      expect(
        probesOfForTestingOnly([
          "a\ud800",
          -0,
          undefined,
          Symbol.for("s"),
          new FabricBytes(new Uint8Array([1])),
        ]),
      ).toEqual([
        [[], { array: 5 }],
        [[0], 'fvj1:"a\\ud800"'],
        [[1], 'fvj1:{"/SpecialNumber@1":"-0"}'],
        [[2], 'fvj1:{"/Undefined@1":null}'],
        [[3], 'fvj1:{"/Symbol@1":"s"}'],
        [[4], 'fvj1:{"/Bytes@1":"AQ"}'],
      ]);
    });

    it("returns a hole run for each maximal run of holes, at its first index", () => {
      const array: FabricValue[] = [1];
      array[3] = 2;
      array.length = 5;
      expect(probesOfForTestingOnly(array)).toEqual([
        [[], { array: 5 }],
        [[0], "fvj1:1"],
        [[1], { holes: 2 }],
        [[3], "fvj1:2"],
        [[4], { holes: 1 }],
      ]);
    });

    it("returns the probes of an instance's fields, by the paths of the value rather than of the wire", () => {
      expect(
        probesOfForTestingOnly(
          new FabricLink({ id: "x", path: ["a"] }),
        ),
      ).toEqual([
        [[], { instance: "Link@1" }],
        [["payload"], { record: 2 }],
        [["payload", "id"], 'fvj1:"x"'],
        [["payload", "path"], { array: 1 }],
        [["payload", "path", 0], 'fvj1:"a"'],
      ]);
    });

    it("returns an error's extras even when there are none, and no probe for an absent stack or cause", () => {
      const error = new FabricError({
        type: "TypeError",
        name: "TypeError",
        message: "m",
        stack: undefined,
        cause: undefined,
      });
      expect(probesOfForTestingOnly(error)).toEqual([
        [[], { instance: "Error@1" }],
        [["type"], 'fvj1:"TypeError"'],
        [["name"], 'fvj1:"TypeError"'],
        [["message"], 'fvj1:"m"'],
        [["extras"], { record: 0 }],
      ]);
    });

    it("returns an error's stack, cause and extras where it has them", () => {
      const error = new FabricError({
        type: "Error",
        name: "Custom",
        message: "m",
        stack: "s",
        cause: null,
        extras: { code: 7 },
      });
      expect(probesOfForTestingOnly(error)).toEqual([
        [[], { instance: "Error@1" }],
        [["type"], 'fvj1:"Error"'],
        [["name"], 'fvj1:"Custom"'],
        [["message"], 'fvj1:"m"'],
        [["stack"], 'fvj1:"s"'],
        [["cause"], "fvj1:null"],
        [["extras"], { record: 1 }],
        [["extras", "code"], "fvj1:7"],
      ]);
    });

    it("returns an unknown value's tag and the probes of its state", () => {
      expect(probesOfForTestingOnly(new UnknownValue("Future@2", [1])))
        .toEqual([
          [[], { unknown: "Future@2" }],
          [["state"], { array: 1 }],
          [["state", 0], "fvj1:1"],
        ]);
    });

    it("returns no probe at or under the path of a patch, and the special forms of the containers along it", () => {
      const record: { self?: FabricValue; s?: FabricValue; n?: FabricValue } = {
        s: [Symbol("s")],
        n: 1,
      };
      record.self = record;
      expect(
        probesOfForTestingOnly(record, [
          { at: ["s", 0], put: { unregisteredSymbol: "s" } },
          { at: ["self"], put: { cycle: [] } },
        ]),
      ).toEqual([
        [[], { record: 3 }],
        [["n"], "fvj1:1"],
        [["s"], { array: 1 }],
      ]);
    });

    it("throws given a cycle no patch closes", () => {
      const record: { self?: FabricValue } = {};
      record.self = record;
      expect(() => probesOfForTestingOnly(record))
        .toThrow('No probe for a cycle at ["self"]');
    });

    it("throws given a symbol of no registry key that no patch puts", () => {
      expect(() => probesOfForTestingOnly([Symbol("s")]))
        .toThrow("No probe for a symbol of no registry key at [0]");
    });

    it("throws given a map, whose codec is a stub", () => {
      expect(() => probesOfForTestingOnly(new FabricMap(new Map())))
        .toThrow("No fields for a map.");
    });

    it("throws given a key pair holding `CryptoKey` handles, which has no text", async () => {
      const pair = await crypto.subtle.generateKey("Ed25519", false, [
        "sign",
        "verify",
      ]);
      expect(() => probesOfForTestingOnly([new FabricKeyPair(pair)]))
        .toThrow("Cannot encode a key pair that holds handles");
    });

    it("throws given an instance of a class no table names", () => {
      expect(() => probesOfForTestingOnly([new OtherInstance()])).toThrow(
        "No codec registered",
      );
    });
  });

  describe("textWithModsOfForTestingOnly()", () => {
    it("returns the text with record keys in UTF-8 order, keys that read as integers among them", () => {
      expect(textWithModsOfForTestingOnly({ "2": 2, "10": 10, a: [1n] }))
        .toEqual({ text: 'fvj1:{"10":10,"2":2,"a":[{"/BigInt@1":"AQ"}]}' });
    });

    it("returns the text of a record holding a key the encoder reserves", () => {
      expect(textWithModsOfForTestingOnly(JSON.parse('{"__proto__":1}')))
        .toEqual({ text: 'fvj1:{"__proto__":1}' });
    });

    it("returns a patch at each place a cycle closes, naming the container it closes at", () => {
      const inner: { x?: FabricValue } = {};
      inner.x = [inner];
      expect(textWithModsOfForTestingOnly({ a: inner })).toEqual({
        text: 'fvj1:{"a":{"x":[null]}}',
        patches: [{ at: ["a", "x", 0], put: { cycle: ["a"] } }],
      });
    });

    it("returns a patch at each unregistered symbol, under its description", () => {
      expect(textWithModsOfForTestingOnly([Symbol(), { "\ud800": Symbol("") }]))
        .toEqual({
          text: 'fvj1:[null,{"\\ud800":null}]',
          patches: [
            { at: [0], put: { unregisteredSymbol: null } },
            {
              at: [1, { utf16: [0xd800] }],
              put: { unregisteredSymbol: "" },
            },
          ],
        });
    });

    it("returns a patch whose path steps through the fields of an instance a cycle runs through", () => {
      const record: { link?: FabricValue } = {};
      record.link = new FabricLink({ record });
      expect(textWithModsOfForTestingOnly(record)).toEqual({
        text: 'fvj1:{"link":{"/Link@1":{"record":null}}}',
        patches: [{ at: ["link", "payload", "record"], put: { cycle: [] } }],
      });
    });

    it("returns a patch naming a link's payload where a cycle closes at it", () => {
      const payload: { self?: FabricValue } = {};
      payload.self = payload;
      expect(
        textWithModsOfForTestingOnly(new FabricLink(Object.freeze(payload))),
      )
        .toEqual({
          text: 'fvj1:{"/Link@1":{"self":null}}',
          patches: [{ at: ["payload", "self"], put: { cycle: ["payload"] } }],
        });
    });

    it("throws given a map, whose codec is a stub", () => {
      expect(() => textWithModsOfForTestingOnly([new FabricMap(new Map())]))
        .toThrow("No fields for a map. Its codec is a stub");
    });

    it("returns a patch naming an instance where a cycle closes at it", () => {
      const state: { self?: FabricValue } = {};
      const unknown = new UnknownValue("Future@1", state);
      state.self = unknown;
      expect(textWithModsOfForTestingOnly(unknown)).toEqual({
        text: 'fvj1:{"/Future@1":{"self":null}}',
        patches: [{ at: ["state", "self"], put: { cycle: [] } }],
      });
    });

    it("returns patches at an error's cause and among its extras", () => {
      const error = new FabricError({
        type: "Error",
        name: "Error",
        message: "m",
        stack: undefined,
        cause: undefined,
      });
      error.cause = error;
      error.setExtra("x", [Symbol("s")]);
      expect(textWithModsOfForTestingOnly(error)).toEqual({
        text: 'fvj1:{"/Error@1":{"cause":null,"message":"m","name":null,' +
          '"type":"Error","x":[null]}}',
        patches: [
          { at: ["cause"], put: { cycle: [] } },
          { at: ["extras", "x", 0], put: { unregisteredSymbol: "s" } },
        ],
      });
    });

    it("leaves the instances of the value it is given as they are", () => {
      const error = new FabricError({
        type: "Error",
        name: "Error",
        message: "m",
        stack: undefined,
        cause: undefined,
      });
      error.cause = error;
      const state: { self?: FabricValue } = {};
      state.self = state;
      const unknown = new UnknownValue("Future@1", state);
      textWithModsOfForTestingOnly([error, unknown]);
      expect(error.cause).toBe(error);
      expect(unknown.state).toBe(state);
      expect(state.self).toBe(state);
    });

    it("throws given an unknown value under a tag the format itself decides", () => {
      for (
        const tag of ["BigInt@1", "SpecialNumber@1", "Symbol@1", "Undefined@1"]
      ) {
        expect(() =>
          textWithModsOfForTestingOnly([new UnknownValue(tag, null)])
        ).toThrow(
          `No text and mods write an unknown value under ${tag}, a tag the format itself decides.`,
        );
      }
    });

    it("returns as unclaimed the tag of each unknown value that a codec claims, and no other", () => {
      expect(
        textWithModsOfForTestingOnly([
          new UnknownValue("Link@1", { id: "x" }),
          new UnknownValue("Bytes@1", "AQ"),
          new UnknownValue("Example@1", null),
          new UnknownValue("Link@1", { id: "y" }),
        ]).unclaimed,
      ).toEqual(["Bytes@1", "Link@1"]);
    });

    describe("for a value whose text the encoder writes", () => {
      // A value that is not plain JSON has its text from this package's
      // encoder, with only its record keys put in UTF-8 order.

      it("returns the encoder's text unchanged where its keys are already in order", () => {
        const values: FabricValue[] = [
          { a: 1n, b: [undefined, Symbol.for("s")] },
          new FabricError({
            type: "TypeError",
            name: "Custom",
            message: "m",
            stack: undefined,
            cause: -0,
            extras: { code: 7 },
          }),
          new FabricLink({ id: "x", path: ["p"] }),
          new UnknownValue("Example@1", { a: [NaN] }),
        ];
        for (const value of values) {
          expect(textWithModsOfForTestingOnly(value))
            .toEqual({ text: jsonFromFabricValue(value) });
        }
      });

      it("returns the encoder's text with nothing changed but the order of its keys", () => {
        const value = {
          "2": 2n,
          "10": [{ "b": 1n, "a": 2 }],
          a: new FabricError({
            type: "Error",
            name: "Error",
            message: "m",
            stack: undefined,
            cause: undefined,
            extras: { "2": "two", "10": "ten" },
          }),
        };
        const encoded = jsonFromFabricValue(value);
        const { text } = textWithModsOfForTestingOnly(value);
        expect(text).toBe(
          'fvj1:{"10":[{"a":2,"b":{"/BigInt@1":"AQ"}}],"2":{"/BigInt@1":"Ag"},' +
            '"a":{"/Error@1":{"10":"ten","2":"two","message":"m",' +
            '"name":null,"type":"Error"}}}',
        );
        expect(text).not.toBe(encoded);
        expect(JSON.parse(text.slice("fvj1:".length)))
          .toEqual(JSON.parse(encoded.slice("fvj1:".length)));
      });
    });
  });

  describe("fabricValueOfTextWithModsForTestingOnly()", () => {
    it("returns the value its text decodes to, deep-frozen", () => {
      const value = fabricValueOfTextWithModsForTestingOnly({
        text: 'fvj1:{"a":[{"/Bytes@1":"AQ"}]}',
      }) as { a: FabricValue[] };
      expect(value.a[0]).toBeInstanceOf(FabricBytes);
      expect(Object.isFrozen(value)).toBe(true);
      expect(Object.isFrozen(value.a)).toBe(true);
    });

    it("returns an unknown value for each value under an unclaimed tag, and a decoded one under any other", () => {
      const value = fabricValueOfTextWithModsForTestingOnly({
        text: 'fvj1:[{"/Link@1":{"id":"x"}},{"/Bytes@1":"AQ"}]',
        unclaimed: ["Link@1"],
      }) as FabricValue[];
      expect(value[0]).toBeInstanceOf(UnknownValue);
      expect((value[0] as UnknownValue).wireTypeTag).toBe("Link@1");
      expect(value[1]).toBeInstanceOf(FabricBytes);
    });

    it("returns the container a cycle patch names, at the place it is put", () => {
      const value = fabricValueOfTextWithModsForTestingOnly({
        text: 'fvj1:{"a":{"x":[null]}}',
        patches: [{ at: ["a", "x", 0], put: { cycle: ["a"] } }],
      }) as { a: { x: FabricValue[] } };
      expect(value.a.x[0]).toBe(value.a);
      expect(Object.isFrozen(value.a)).toBe(true);
    });

    it("returns an unregistered symbol under its description where a patch puts one", () => {
      const value = fabricValueOfTextWithModsForTestingOnly({
        text: "fvj1:null",
        patches: [{ at: [], put: { unregisteredSymbol: "local" } }],
      });
      expect(typeof value).toBe("symbol");
      expect(Symbol.keyFor(value as symbol)).toBeUndefined();
      expect((value as symbol).description).toBe("local");
    });

    it("returns a link made again with the payload a patch puts, where the decoded one was", () => {
      const value = fabricValueOfTextWithModsForTestingOnly({
        text: 'fvj1:{"link":{"/Link@1":{"record":null}}}',
        patches: [{ at: ["link", "payload", "record"], put: { cycle: [] } }],
      }) as { link: FabricLink };
      expect(value.link).toBeInstanceOf(FabricLink);
      expect(value.link.payload.record).toBe(value);
      expect(Object.isFrozen(value)).toBe(true);
    });

    it("returns a link whose payload holds itself where cycle patches name the payload", () => {
      const value = fabricValueOfTextWithModsForTestingOnly({
        text: 'fvj1:{"/Link@1":{"a":null,"b":null}}',
        patches: [
          { at: ["payload", "a"], put: { cycle: ["payload"] } },
          { at: ["payload", "b"], put: { cycle: ["payload"] } },
        ],
      }) as FabricLink;
      expect(value.payload.a).toBe(value.payload);
      expect(value.payload.b).toBe(value.payload);
      expect(Object.isFrozen(value)).toBe(true);
    });

    it("returns an unknown value made again with the state a patch puts", () => {
      const value = fabricValueOfTextWithModsForTestingOnly({
        text: 'fvj1:{"u":{"/Future@1":null}}',
        patches: [{ at: ["u", "state"], put: { cycle: [] } }],
      }) as { u: UnknownValue };
      expect(value.u).toBeInstanceOf(UnknownValue);
      expect(value.u.wireTypeTag).toBe("Future@1");
      expect(value.u.state).toBe(value);
    });

    it("returns the instance a cycle patch names, at a place inside its state", () => {
      const value = fabricValueOfTextWithModsForTestingOnly({
        text: 'fvj1:{"/Future@1":{"self":null}}',
        patches: [{ at: ["state", "self"], put: { cycle: [] } }],
      }) as UnknownValue;
      expect((value.state as { self: FabricValue }).self).toBe(value);
      expect(Object.isFrozen(value)).toBe(true);
    });

    it("returns an error holding what patches put in its cause and among its extras", () => {
      const value = fabricValueOfTextWithModsForTestingOnly({
        text: 'fvj1:{"/Error@1":{"cause":null,"message":"m","name":null,' +
          '"type":"Error","x":[null]}}',
        patches: [
          { at: ["cause"], put: { cycle: [] } },
          { at: ["extras", "x", 0], put: { cycle: [] } },
        ],
      }) as FabricError;
      expect(value.cause).toBe(value);
      expect((value.getExtra("x") as FabricValue[])[0]).toBe(value);
    });

    it("returns a value equal to the one written, for each kind of mod", () => {
      const record: { self?: FabricValue; u?: FabricValue } = {
        u: [new UnknownValue("Link@1", { id: "x" }), Symbol("s")],
      };
      record.self = record;
      const read = fabricValueOfTextWithModsForTestingOnly(
        textWithModsOfForTestingOnly(record),
      ) as { self: FabricValue; u: [UnknownValue, symbol] };
      expect(read.self).toBe(read);
      expect(read.u[0]).toBeInstanceOf(UnknownValue);
      expect(read.u[0].wireTypeTag).toBe("Link@1");
      expect(read.u[0].state).toEqual({ id: "x" });
      expect(Symbol.keyFor(read.u[1])).toBeUndefined();
      expect(read.u[1].description).toBe("s");
    });

    it("throws what the codec throws refusing the text", () => {
      expect(() =>
        fabricValueOfTextWithModsForTestingOnly({
          text: 'fvj1:{"__proto__":1}',
        })
      ).toThrow(ProblematicStateError);
    });

    it("throws given mods that break the rules", () => {
      const cases: ReadonlyArray<readonly [TextWithMods, string]> = [
        [
          { text: "fvj1:1", unclaimed: ["Link@1", "Bytes@1"] },
          "`unclaimed` not in order, each tag once",
        ],
        [
          { text: "fvj1:1", unclaimed: ["Link@1", "Link@1"] },
          "`unclaimed` not in order, each tag once",
        ],
        [
          { text: "fvj1:1", unclaimed: ["BigInt@1"] },
          "No class to leave out claims BigInt@1",
        ],
        [
          { text: "fvj1:1", unclaimed: ["Example@1"] },
          "No class to leave out claims Example@1",
        ],
        [
          {
            text: "fvj1:[1]",
            patches: [{ at: [0], put: { unregisteredSymbol: null } }],
          },
          "No `null` to patch at [0]",
        ],
        [
          {
            text: "fvj1:[null]",
            patches: [{ at: [1], put: { unregisteredSymbol: null } }],
          },
          "No path [1] through arrays, records and instances",
        ],
        [
          {
            text: 'fvj1:{"0":null}',
            patches: [{ at: [0], put: { unregisteredSymbol: null } }],
          },
          "No path [0] through arrays, records and instances",
        ],
        [
          {
            text: 'fvj1:[{"/hole":1},null]',
            patches: [{ at: [0], put: { unregisteredSymbol: null } }],
          },
          "No path [0] through arrays, records and instances",
        ],
        [
          {
            text: 'fvj1:{"/Link@1":{"a":null}}',
            patches: [{ at: ["a"], put: { unregisteredSymbol: null } }],
          },
          'No path ["a"] through arrays, records and instances',
        ],
        [
          {
            text: "fvj1:[null]",
            patches: [{ at: ["payload"], put: { unregisteredSymbol: null } }],
          },
          'No path ["payload"] through arrays, records and instances',
        ],
        [
          {
            text: 'fvj1:{"/Bytes@1":"AQ"}',
            patches: [{ at: ["payload"], put: { unregisteredSymbol: null } }],
          },
          'No path ["payload"] through arrays, records and instances',
        ],
        [
          {
            text: 'fvj1:{"/Future@1":{"x":null}}',
            patches: [{
              at: ["payload", "x"],
              put: { unregisteredSymbol: null },
            }],
          },
          'No path ["payload","x"] through arrays, records and instances',
        ],
        [
          {
            text:
              'fvj1:{"/Error@1":{"message":"m","name":null,"type":"Error",' +
              '"x":{"y":null}}}',
            patches: [{ at: ["extras", "x", "y"], put: { cycle: ["extras"] } }],
          },
          'No array, record or instance at ["extras"] for a cycle to close at',
        ],
        [
          {
            text: 'fvj1:{"/Link@1":{"a":null}}',
            patches: [{ at: ["payload", "a"], put: { cycle: [] } }],
          },
          'The patch at ["payload","a"] does not hold once all are made',
        ],
        [
          {
            text: "fvj1:[null]",
            patches: [
              { at: [0], put: { unregisteredSymbol: null } },
              { at: [0], put: { unregisteredSymbol: "again" } },
            ],
          },
          "Two patches at [0]",
        ],
        [
          {
            text: "fvj1:[null]",
            patches: [{ at: [0], put: { cycle: [0] } }],
          },
          "Not a proper prefix of the path a cycle is put at: [0]",
        ],
        [
          {
            text: 'fvj1:{"a":[null]}',
            patches: [{ at: ["a", 0], put: { cycle: ["b"] } }],
          },
          'Not a proper prefix of the path a cycle is put at: ["b"]',
        ],
        [
          { text: "fvj1:null", patches: [{ at: [], put: { cycle: [] } }] },
          "Not a proper prefix of the path a cycle is put at: []",
        ],
      ];
      for (const [stated, message] of cases) {
        expect(() => fabricValueOfTextWithModsForTestingOnly(stated))
          .toThrow(message);
      }
    });

    it("throws given a patch that runs into what another patch puts", () => {
      // Every path is followed through the decoded text before any patch is
      // made, so the second patch finds the `null` the first replaces.

      expect(() =>
        fabricValueOfTextWithModsForTestingOnly({
          text: 'fvj1:{"a":null}',
          patches: [
            { at: ["a"], put: { cycle: [] } },
            { at: ["a", "a"], put: { unregisteredSymbol: null } },
          ],
        })
      ).toThrow('No path ["a","a"] through arrays, records and instances');
    });
  });
});
