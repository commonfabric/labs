/**
 * What the codec base class does on its own, before a concrete codec overrides
 * anything.
 *
 * Two of its results come straight from what it was constructed with, and both
 * are optional: a codec naming no handled class cannot recognize a value by
 * class, and one naming no tag cannot produce a tag. Each is covered in both
 * the supplied and the omitted form, because the omitted form is where the
 * base either returns `undefined` or insists on being overridden, and those
 * are different promises.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { BaseFabricCodec, type LiveEnvironment } from "@/codec-common/index.ts";
import { FabricRegExp } from "@/fabric-primitives/index.ts";
import type { FabricValue } from "@/index.ts";

/**
 * Minimal concrete `BaseFabricCodec` for exercising the base class's own
 * behavior. The subclass contract is not under test here, so those members
 * throw.
 */
class TestCodec extends BaseFabricCodec<never, FabricValue> {
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

describe("BaseFabricCodec", () => {
  describe("instance members", () => {
    describe("recognizedTypeTag", () => {
      it("returns the tag passed to the constructor", () => {
        expect(new TestCodec("Foo@1", undefined).recognizedTypeTag).toBe(
          "Foo@1",
        );
      });

      it("is `undefined` when constructed with no recognized tag", () => {
        expect(new TestCodec(undefined, undefined).recognizedTypeTag).toBe(
          undefined,
        );
      });
    });

    describe("uniqueHandledClass", () => {
      it("returns the class passed to the constructor", () => {
        const codec = new TestCodec("Test@1", FabricRegExp);

        expect(codec.uniqueHandledClass).toBe(FabricRegExp);
      });

      it("is `undefined` when constructed with no handled class", () => {
        const codec = new TestCodec("Test@1", undefined);

        expect(codec.uniqueHandledClass).toBeUndefined();
      });
    });

    describe("canEncode()", () => {
      it("returns `true` for an instance of the handled class", () => {
        const codec = new TestCodec("Test@1", FabricRegExp);

        expect(codec.canEncode(new FabricRegExp(/x/))).toBe(true);
      });

      it("returns `false` for a value of another class", () => {
        const codec = new TestCodec("Test@1", FabricRegExp);

        expect(codec.canEncode("not a regexp")).toBe(false);
      });

      it("returns `false` when there is no handled class", () => {
        // A codec with no class to match on encodes nothing by this
        // implementation; one that means to match by some other test
        // overrides.
        const codec = new TestCodec("Test@1", undefined);

        expect(codec.canEncode(new FabricRegExp(/x/))).toBe(false);
      });
    });

    describe("tagForValue()", () => {
      it("returns the codec's `recognizedTypeTag`", () => {
        const codec = new TestCodec("Foo@1", undefined);
        expect(codec.tagForValue("anything")).toBe("Foo@1");
      });

      it("throws when the codec has no recognized tag (must be overridden)", () => {
        const codec = new TestCodec(undefined, undefined);
        expect(() => codec.tagForValue("anything")).toThrow(
          "no recognized tag",
        );
      });
    });
  });
});
