/**
 * Which symbol a value's codec is found under, and what happens when the
 * answer is absent or ambiguous.
 *
 * An instance binds one format-agnostic `[CODEC]`, while a primitive's codec
 * terminates an encoding and so is bound per wire format under that format's
 * own symbol. Asking without naming a format therefore succeeds for the one
 * and fails for the other, which is most of what these cases pin.
 *
 * The precedence case is built on a double rather than a real class, because
 * nothing in the tree binds both symbols. With a real class the two could not
 * disagree, and the case would pass whichever way the lookup happened to be
 * written.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type {
  FabricInstance,
  FabricInstancePlus,
  FabricSpecialObject,
  FabricValue,
  FabricValuePlus,
} from "@";
import {
  CODEC,
  codecOf,
  JSON_CODEC,
  type LiveEnvironment,
  type NonterminalCodec,
  type TerminalCodec,
} from "@/codec-common";
import type { JsonCodecValue } from "@/codec-json/interface.ts";
import { BaseFabricSpecialObject } from "@/fabric-bases";
import { FabricError } from "@/fabric-instances";
import { FabricBytes } from "@/fabric-primitives";

/**
 * Declares a direct subclass of the runtime root as the `FabricSpecialObject`
 * it is not, so that a case can hand `codecOf()` a class that binds no codec.
 * Such a value is out of contract, and the cast is what says so.
 */
function outOfContract(value: BaseFabricSpecialObject): FabricSpecialObject {
  return value as unknown as FabricSpecialObject;
}

// The carrier below is checked when the file is type-checked, not when it
// runs: each assignment in it pins what `codecOf()` infers from its argument,
// and the `@ts-expect-error` marks the one it must refuse.

declare const env: LiveEnvironment;
declare const instance: FabricInstance;
declare const instancePlusError: FabricInstancePlus<Error>;

/** Carrier for the checks on what `codecOf()` infers for its result. */
function codecOfTypeChecks() {
  // A `FabricInstance` yields a codec at `never`, so its decoded values are
  // `FabricValue`s. That pins the inference rather than the assignment: at
  // `unknown`, which is where a failed inference lands, `decode()` would
  // return `unknown`.
  const atNever: NonterminalCodec<never> = codecOf(instance);
  const decoded: FabricValue = codecOf(instance).decode("X@1", null, env);

  // A `FabricInstancePlus<Error>` yields a codec at `Error`, which takes the
  // instance and exposes its state at that same `PlusType`.
  const atError: NonterminalCodec<Error> = codecOf(instancePlusError);
  const state: FabricValuePlus<Error> = codecOf(instancePlusError).encode(
    instancePlusError,
    env,
  );
  // @ts-expect-error a codec at `Error` is not one at `never`
  const notNever: NonterminalCodec = codecOf(instancePlusError);

  return { atNever, decoded, atError, state, notNever };
}

describe("codecOf()", () => {
  describe("given no `altCodec`", () => {
    it("returns the class's `[CODEC]` for a `FabricInstance`", () => {
      const err = FabricError.fromNativeError(new Error("x"));
      expect(codecOf(err)).toBe(FabricError[CODEC]);
    });

    it("throws for a `FabricPrimitive`", () => {
      // A primitive's codec terminates an encoding, so it is bound per wire
      // format under that format's own symbol rather than to `[CODEC]`.
      const fb = new FabricBytes(new Uint8Array([1, 2, 3]));
      expect(() => codecOf(fb)).toThrow("no `[CODEC]`");
    });

    it("throws for a `FabricSpecialObject` binding no `[CODEC]`", () => {
      class NoCodec extends BaseFabricSpecialObject {}
      expect(() => codecOf(outOfContract(new NoCodec()))).toThrow(
        "no `[CODEC]`",
      );
    });
  });

  describe("given an `altCodec`", () => {
    it("returns the alternative for a `FabricPrimitive`", () => {
      const fb = new FabricBytes(new Uint8Array([1, 2, 3]));
      expect(codecOf(fb, JSON_CODEC)).toBe(FabricBytes[JSON_CODEC]);
    });

    it("prefers `[CODEC]` when the class binds both", () => {
      // No class in the tree binds both, so this needs a double: with only a
      // real class the two symbols cannot disagree, and the case would pass
      // whichever one the implementation preferred.
      class BothCodecs extends BaseFabricSpecialObject {
        static get [CODEC](): NonterminalCodec {
          return FabricError[CODEC];
        }

        static get [JSON_CODEC](): TerminalCodec<JsonCodecValue> {
          return FabricBytes[JSON_CODEC];
        }
      }

      expect(codecOf(outOfContract(new BothCodecs()), JSON_CODEC)).toBe(
        FabricError[CODEC],
      );
    });

    it("throws when the class binds neither symbol", () => {
      class NoCodec extends BaseFabricSpecialObject {}
      expect(() => codecOf(outOfContract(new NoCodec()), JSON_CODEC))
        .toThrow("no `[CODEC]`");
    });
  });

  describe("result type", () => {
    it("is at the `PlusType` of the value, `never` for a `FabricInstance`", () => {
      // The type checker decides the claim; at run time only the carrier is
      // observable.
      expect(typeof codecOfTypeChecks).toBe("function");
    });
  });
});
