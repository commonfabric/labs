import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricInstance, FabricValue } from "@";
import { UnknownValue } from "@/codec-common";
import {
  BaseFabricInstance,
  DEEP_CLONE_CORE,
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
  SHALLOW_UNFROZEN_CLONE,
} from "@/fabric-bases";
import { FabricKeyPair } from "@/fabric-primitives";
import {
  descriptorOfForTestingOnly,
  fabricValueOfDescriptorForTestingOnly,
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

  protected [DEEP_CLONE_CORE](_frozen: boolean): FabricInstance {
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
});
