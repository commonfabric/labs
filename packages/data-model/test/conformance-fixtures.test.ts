import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricInstance, FabricValue } from "@";
import { ProblematicStateError, UnknownValue } from "@/codec-common";
import {
  BaseFabricInstance,
  DEEP_CLONE_CORE,
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
  SHALLOW_UNFROZEN_CLONE,
} from "@/fabric-bases";
import { FabricBytes, FabricKeyPair } from "@/fabric-primitives";
import {
  descriptorOfForTestingOnly,
  fabricValueOfDescriptorForTestingOnly,
  fabricValueOfTextWithModsForTestingOnly,
  type TextWithMods,
  textWithModsOfForTestingOnly,
  type ValueDescriptor,
} from "@/for-testing-only.ts";

/** A `FabricInstance` of a class neither class table names. */
class OtherInstance extends BaseFabricInstance {
  //
  // Unreached stubs
  //
  // Describing an instance reads none of these.
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
  describe("descriptorOfForTestingOnly()", () => {
    it("throws given a key pair holding `CryptoKey` handles", async () => {
      const pair = await crypto.subtle.generateKey("Ed25519", false, [
        "sign",
        "verify",
      ]);
      expect(() => descriptorOfForTestingOnly(new FabricKeyPair(pair)))
        .toThrow("No descriptor for a key pair holding `CryptoKey` handles.");
    });

    it("throws given an instance of a class no table names", () => {
      expect(() => descriptorOfForTestingOnly(new OtherInstance()))
        .toThrow("No descriptor for a value of an unknown class.");
    });

    it("returns a cycle reference for a record that holds itself", () => {
      const record: { self?: FabricValue } = {};
      record.self = record;
      expect(descriptorOfForTestingOnly(record)).toEqual({
        record: [["self", { cycle: 1 }]],
      });
    });

    it("returns a cycle reference counting the containers up to where the cycle closes", () => {
      const record: { x?: FabricValue } = {};
      record.x = [{ x: record }];
      expect(descriptorOfForTestingOnly(record)).toEqual({
        record: [["x", { array: [{ record: [["x", { cycle: 3 }]] }] }]],
      });
    });

    it("returns a container reached twice off the path in full each time", () => {
      const shared = [1];
      expect(descriptorOfForTestingOnly({ a: shared, b: shared })).toEqual({
        record: [["a", { array: [1] }], ["b", { array: [1] }]],
      });
    });

    it("throws given a cycle that closes at an instance", () => {
      const state: FabricValue[] = [];
      const unknown = new UnknownValue("Example@1", state);
      state.push(unknown);
      expect(() => descriptorOfForTestingOnly(unknown))
        .toThrow("No descriptor for a cycle through an instance.");
    });

    it("throws given a cycle that passes through an instance", () => {
      const record: { u?: FabricValue } = {};
      record.u = new UnknownValue("Example@1", [record]);
      expect(() => descriptorOfForTestingOnly(record))
        .toThrow("No descriptor for a cycle through an instance.");
    });
  });

  describe("fabricValueOfDescriptorForTestingOnly()", () => {
    it("throws given a descriptor the notation does not define", () => {
      const cases: ReadonlyArray<readonly [ValueDescriptor, string]> = [
        [{ number: "Infinity" }, "Not a special number"],
        [{ nonesuch: 1 }, "Not a descriptor kind"],
        [{ a: 1, b: 2 }, "Not a single-key object"],
        [{}, "Not a single-key object"],
        [[1], "Not an object"],
        [{ bigint: { text: "1" } }, "Not a string descriptor"],
        [{ utf16: ["a"] }, "Not a code unit"],
        [{ utf16: [-1] }, "Not a code unit"],
        [{ utf16: [0x10000] }, "Not a code unit"],
        [{ utf16: [97.5] }, "Not a code unit"],
        [-0, "Not a number descriptor"],
        [Infinity, "Not a number descriptor"],
        [{ bigint: "0x10" }, "Not a decimal integer"],
        [{ bigint: " 1" }, "Not a decimal integer"],
        [{ bigint: "" }, "Not a decimal integer"],
        [{ bigint: "01" }, "Not a decimal integer"],
        [{ bigint: "-0" }, "Not a decimal integer"],
        [{ EpochNsec: "1e3" }, "Not a decimal integer"],
        [{ Bytes: "ZZ" }, "Not lowercase hexadecimal bytes"],
        [{ array: 1 }, "Not a list"],
        [{ record: [["a"]] }, "Not a pair"],
        [{ record: [["a", 1, 2]] }, "Not a pair"],
        [{ Hash: 1 }, "Not an object"],
        [{ Hash: { tag: "fid1" } }, "No field `hash`"],
        [{ Unavailable: { reason: "gone" } }, "Not an unavailable reason"],
        [
          { Unavailable: { reason: "error", errorKind: "nonesuch" } },
          "Not an error kind",
        ],
        [{ Link: 1 }, "A link's payload must be a record."],
        [{ array: [{ hole: "1" }] }, "Not a hole count"],
        [{ cycle: 1 }, "Not a cycle distance"],
        [{ array: [{ cycle: 2 }] }, "Not a cycle distance"],
        [{ array: [{ cycle: 0 }] }, "Not a cycle distance"],
        [{ array: [{ cycle: 1.5 }] }, "Not a cycle distance"],
        [{ Link: { record: [["a", { cycle: 2 }]] } }, "Not a cycle distance"],
      ];
      for (const [descriptor, message] of cases) {
        expect(() => fabricValueOfDescriptorForTestingOnly(descriptor))
          .toThrow(message);
      }
    });

    it("throws given an array descriptor holding a hole run below one", () => {
      for (const count of [0, -1]) {
        expect(() =>
          fabricValueOfDescriptorForTestingOnly({
            array: [1, { hole: count }],
          })
        ).toThrow("Not a hole count");
      }
    });

    it("returns a value of each descriptor kind that describes back to it", () => {
      const descriptors: readonly ValueDescriptor[] = [
        { unregisteredSymbol: null },
        { KeyPair: { algorithm: "A", publicKey: "01", privateKey: "02" } },
        { Unavailable: { reason: "error", errorKind: "network" } },
        {
          Unavailable: {
            reason: "error",
            errorKind: "general",
            errorMessage: "boom",
          },
        },
        { Map: [["a", 1]] },
        { Set: [1, { bigint: "2" }] },
        { record: [["self", { cycle: 1 }]] },
        { array: [{ record: [["x", { cycle: 2 }]] }, { cycle: 1 }] },
      ];
      for (const descriptor of descriptors) {
        const value = fabricValueOfDescriptorForTestingOnly(descriptor);
        expect(descriptorOfForTestingOnly(value)).toEqual(descriptor);
      }
    });

    it("returns for a cycle reference the container it counts up to", () => {
      const value = fabricValueOfDescriptorForTestingOnly({
        record: [["x", { array: [{ cycle: 2 }] }]],
      }) as { x: FabricValue[] };
      expect(value.x[0]).toBe(value);
    });

    it("returns a record holding a key `__proto__` as an own property", () => {
      const value = fabricValueOfDescriptorForTestingOnly({
        record: [["__proto__", 1]],
      }) as object;
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
      expect(Object.getOwnPropertyDescriptor(value, "__proto__")).toEqual({
        value: 1,
        writable: true,
        enumerable: true,
        configurable: true,
      });
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

    it("returns a value equal to the one written, for each kind of mod", () => {
      const record: { self?: FabricValue; u?: FabricValue } = {
        u: [new UnknownValue("Link@1", { id: "x" }), Symbol("s")],
      };
      record.self = record;
      const read = fabricValueOfTextWithModsForTestingOnly(
        textWithModsOfForTestingOnly(record),
      );
      expect(descriptorOfForTestingOnly(read))
        .toEqual(descriptorOfForTestingOnly(record));
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
          "No path [1] through arrays and records",
        ],
        [
          {
            text: 'fvj1:{"0":null}',
            patches: [{ at: [0], put: { unregisteredSymbol: null } }],
          },
          "No path [0] through arrays and records",
        ],
        [
          {
            text: 'fvj1:[{"/hole":1},null]',
            patches: [{ at: [0], put: { unregisteredSymbol: null } }],
          },
          "No path [0] through arrays and records",
        ],
        [
          {
            text: 'fvj1:{"/Link@1":{"a":null}}',
            patches: [{ at: ["a"], put: { unregisteredSymbol: null } }],
          },
          'No path ["a"] through arrays and records',
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
      ).toThrow('No path ["a","a"] through arrays and records');
    });
  });
});
