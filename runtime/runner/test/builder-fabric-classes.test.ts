/**
 * The special-object classes reach pattern code as `export declare
 * const`s in `data-model/src/api.ts`, which `api/index.ts` re-exports, but the
 * runtime values behind those declarations are bound separately, in
 * `builder/factory.ts`. The two sides are maintained by hand, so a class can be
 * declared without being bound -- which type-checks when the pattern is
 * compiled and then fails once it actually runs. These tests pin the runtime
 * half against the declared half.
 *
 * `types/commonfabric.d.ts` is generated from `api/index.ts`, and is the exact
 * artifact the sandbox hands a pattern as its view of `commonfabric`. Deriving
 * the expected names from it means this test tracks the real declarations
 * rather than a hand-copied list that someone has to remember to extend.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { StaticCache } from "@commonfabric/static";
import { FabricInstance, FabricPrimitive } from "@commonfabric/data-model";
import {
  FabricError,
  FabricLink,
} from "@commonfabric/data-model/fabric-instances";
import {
  FabricBytes,
  FabricDurationDay,
  FabricDurationNsec,
  FabricEpochDay,
  FabricEpochNsec,
  FabricHash,
  FabricKeyPair,
  FabricRegExp,
  FabricUnavailable,
} from "@commonfabric/data-model/fabric-primitives";
import { createBuilder } from "../src/builder/factory.ts";
import { getRuntimeModuleExports } from "../src/sandbox/runtime-modules.ts";

const patternVisibleTypes = await StaticCache.fromFileSystem().getText(
  "types/commonfabric.d.ts",
);
const declaredClasses = [
  ...patternVisibleTypes.matchAll(/^export declare const (Fabric\w+)/gm),
].map((match) => match[1]);

// The `data-model` class each binding is expected to be. This table is the
// test's own knowledge, and the first assertion below pins it against the
// derived list, so the two cannot drift apart silently.
const expectedBindings: Record<string, unknown> = {
  FabricInstance,
  FabricPrimitive,
  FabricEpochNsec,
  FabricEpochDay,
  FabricDurationNsec,
  FabricDurationDay,
  FabricHash,
  FabricLink,
  FabricBytes,
  FabricRegExp,
  FabricKeyPair,
  FabricUnavailable,
  FabricError,
};

describe("commonfabric `FabricSpecialObject` classes", () => {
  // Viewed as a plain record on purpose: the question here is what the builder
  // surface carries at runtime, which is exactly what its static type cannot
  // answer.
  const commonfabric = createBuilder().commonfabric as unknown as Record<
    string,
    unknown
  >;

  describe("runtime bindings", () => {
    it("derives exactly the classes this test knows how to check", () => {
      // This is what stops the per-class checks below from passing vacuously.
      // Each of them is driven by the derived list and looks its expectation up
      // in the table, so a name that appears in only one of the two would
      // compare `undefined` against `undefined` and assert nothing. Requiring
      // the two to match exactly also catches a derivation that matched fewer
      // classes than it should have, which a mere non-empty check would not.

      expect([...declaredClasses].sort()).toEqual(
        Object.keys(expectedBindings).sort(),
      );
    });

    for (const name of declaredClasses) {
      it(`exposes \`${name}\` as a runtime value on the pattern surface`, () => {
        // Presence, not constructibility: `FabricInstance` and
        // `FabricPrimitive` are abstract, and exist at runtime so that
        // `instanceof` works rather than so that they can be `new`-ed.
        // Constructibility is checked per-class below.

        expect(typeof commonfabric[name]).toBe("function");
      });

      it(`binds \`${name}\` to the \`data-model\` class itself`, () => {
        expect(commonfabric[name]).toBe(expectedBindings[name]);
      });
    }
  });

  describe("FabricBytes", () => {
    it("constructs an instance that round-trips its bytes", () => {
      const BoundFabricBytes = commonfabric.FabricBytes as typeof FabricBytes;
      const bytes = new Uint8Array([1, 2, 3, 253, 254, 255]);
      const instance = new BoundFabricBytes(bytes);

      expect(instance).toBeInstanceOf(FabricBytes);
      expect(instance.length).toBe(6);
      expect(instance.slice()).toEqual(bytes);
    });
  });

  describe("FabricLink", () => {
    it("constructs an instance that retains its payload", () => {
      const BoundFabricLink = commonfabric.FabricLink as typeof FabricLink;
      const payload = { id: "of:example", path: ["a", "b"] };
      const instance = new BoundFabricLink(payload);

      expect(instance).toBeInstanceOf(FabricLink);
      expect(instance.payload).toEqual(payload);
    });
  });

  describe("FabricRegExp", () => {
    // Both declared constructor overloads, since the pattern-visible
    // declaration offers both and only one of them is the obvious one.

    it("constructs an instance from a JS `RegExp`", () => {
      const BoundFabricRegExp = commonfabric
        .FabricRegExp as typeof FabricRegExp;
      const instance = new BoundFabricRegExp(/ab+c/gi);

      expect(instance).toBeInstanceOf(FabricRegExp);
      expect(instance.source).toBe("ab+c");
      expect(instance.flags).toBe("gi");
      expect(instance.value).toEqual(/ab+c/gi);
    });

    it("constructs an instance from an explicit flavor, source and flags", () => {
      const BoundFabricRegExp = commonfabric
        .FabricRegExp as typeof FabricRegExp;
      const instance = new BoundFabricRegExp("es2025", "a.c", "s");

      expect(instance.flavor).toBe("es2025");
      expect(instance.source).toBe("a.c");
      expect(instance.flags).toBe("s");
    });
  });

  describe("FabricKeyPair", () => {
    it("constructs an instance from an algorithm name and key bytes", () => {
      const BoundFabricKeyPair = commonfabric
        .FabricKeyPair as typeof FabricKeyPair;
      const instance = new BoundFabricKeyPair(
        "ExampleAlgorithm",
        new Uint8Array([1, 2, 3]),
        new Uint8Array([4, 5, 6]),
      );

      expect(instance).toBeInstanceOf(FabricKeyPair);
      expect(instance.algorithm).toBe("ExampleAlgorithm");
      expect(instance.hasMaterial).toBe(true);
      expect(instance.publicKeyBytes.slice()).toEqual(
        new Uint8Array([1, 2, 3]),
      );
      expect(instance.privateKeyBytes.slice()).toEqual(
        new Uint8Array([4, 5, 6]),
      );
    });
  });

  describe("FabricUnavailable", () => {
    it("constructs an instance from a reason, a kind, and a message", () => {
      const BoundFabricUnavailable = commonfabric
        .FabricUnavailable as typeof FabricUnavailable;
      const instance = new BoundFabricUnavailable("error", "network", "boom");

      expect(instance).toBeInstanceOf(FabricUnavailable);
      expect(instance.reason).toBe("error");
      expect(instance.errorKind).toBe("network");
      expect(instance.errorMessage).toBe("boom");
      expect(instance.isError()).toBe(true);
    });
  });

  describe("FabricError", () => {
    it("constructs an instance carrying its fixed-schema slots", () => {
      const BoundFabricError = commonfabric.FabricError as typeof FabricError;
      const instance = new BoundFabricError({
        type: "TypeError",
        message: "nope",
        stack: undefined,
        cause: undefined,
      });

      expect(instance).toBeInstanceOf(FabricError);
      expect(instance.type).toBe("TypeError");
      expect(instance.name).toBe("TypeError");
      expect(instance.message).toBe("nope");
    });

    it("allows extras to be set and read back", () => {
      // Unlike the other exposed classes, this one is mutable until frozen, so
      // pattern code can reach its extras bag. Pinned because exposing writable
      // members is a choice rather than a side effect of exposing the class.

      const BoundFabricError = commonfabric.FabricError as typeof FabricError;
      const instance = new BoundFabricError({
        type: "Error",
        message: "with extras",
        stack: undefined,
        cause: undefined,
      });

      instance.setExtra("code", 42);

      expect(instance.getExtra("code")).toBe(42);
      expect(instance.hasExtra("code")).toBe(true);
      expect(instance.extraSize).toBe(1);
    });
  });

  describe("the frozen sandbox surface", () => {
    // What a pattern actually receives is not `createBuilder().commonfabric`
    // but that object after `freezeSandboxValue()`, which -- unlike
    // `deepFreeze` -- recurses into functions and freezes each exposed
    // constructor's `.prototype`. A class that behaves on the unfrozen surface
    // could fail here and nowhere else, so the delivered surface gets its own
    // checks.
    //
    // Deliberately coarser than the per-class checks above: freezing is one
    // operation over the whole surface, so a failure would take every class at
    // once and per-name diagnostics would add nothing.

    const sandboxCommonfabric = getRuntimeModuleExports()
      .runtimeExports["commonfabric"] as unknown as Record<string, unknown>;

    it("carries every binding through to pattern code", () => {
      for (const name of declaredClasses) {
        expect(sandboxCommonfabric[name]).toBe(expectedBindings[name]);
      }
    });

    it("allows construction after hardening", () => {
      const BoundFabricBytes = sandboxCommonfabric
        .FabricBytes as typeof FabricBytes;
      const bytes = new Uint8Array([7, 8, 9]);

      expect(new BoundFabricBytes(bytes).slice()).toEqual(bytes);
    });
  });
});
