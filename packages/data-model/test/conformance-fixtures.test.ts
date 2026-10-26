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
import { FabricError, FabricLink, FabricMap } from "@/fabric-instances";
import { FabricBytes, FabricKeyPair } from "@/fabric-primitives";
import {
  descriptorOfForTestingOnly,
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

  describe("probesOfForTestingOnly()", () => {
    it("returns a probe for each node, before those of what it holds, with record keys in UTF-8 order", () => {
      const record = Object.fromEntries([["b", [true]], ["\ud800", null], [
        "a",
        1n,
      ]]);
      expect(probesOfForTestingOnly(record)).toEqual([
        [[], { record: ["a", "b", { utf16: [0xd800] }] }],
        [["a"], { bigint: "1" }],
        [["b"], { array: 1 }],
        [["b", 0], true],
        [[{ utf16: [0xd800] }], null],
      ]);
    });

    it("returns no probe for the index of a hole", () => {
      const array: FabricValue[] = [1];
      array[2] = undefined;
      expect(probesOfForTestingOnly(array)).toEqual([
        [[], { array: 3 }],
        [[0], 1],
        [[2], { undefined: null }],
      ]);
    });

    it("returns the probes of an instance's fields, by the paths of the value rather than of the wire", () => {
      expect(
        probesOfForTestingOnly(
          new FabricLink({ id: "x", path: ["a"] }),
        ),
      ).toEqual([
        [[], { instance: "Link@1" }],
        [["payload"], { record: ["id", "path"] }],
        [["payload", "id"], "x"],
        [["payload", "path"], { array: 1 }],
        [["payload", "path", 0], "a"],
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
        [["type"], "TypeError"],
        [["name"], "TypeError"],
        [["message"], "m"],
        [["extras"], { record: [] }],
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
        [["type"], "Error"],
        [["name"], "Custom"],
        [["message"], "m"],
        [["stack"], "s"],
        [["cause"], null],
        [["extras"], { record: ["code"] }],
        [["extras", "code"], 7],
      ]);
    });

    it("returns an unknown value's tag and the probes of its state", () => {
      expect(probesOfForTestingOnly(new UnknownValue("Future@2", [1])))
        .toEqual([
          [[], { unknown: "Future@2" }],
          [["state"], { array: 1 }],
          [["state", 0], 1],
        ]);
    });

    it("returns no probe at or under the path of a patch", () => {
      const record: { self?: FabricValue; s?: FabricValue; n?: FabricValue } = {
        s: Symbol("s"),
        n: 1,
      };
      record.self = record;
      expect(
        probesOfForTestingOnly(record, [
          { at: ["s"], put: { unregisteredSymbol: "s" } },
          { at: ["self"], put: { cycle: [] } },
        ]),
      ).toEqual([[[], { record: ["n", "s", "self"] }], [["n"], 1]]);
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
        .toThrow("No probe for a map.");
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
