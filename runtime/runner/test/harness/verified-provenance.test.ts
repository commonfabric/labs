import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { VERIFIED_BINDING_METADATA_FIELD } from "@commonfabric/pattern-contract/sandbox-contract";

import {
  getVerifiedProvenance,
  readBindingIdentity,
  recordVerifiedProvenance,
} from "../../src/harness/verified-provenance.ts";

/** A factory wearing `metadata` as its verified-binding annotation. */
function annotated(metadata: unknown): () => void {
  const factory = () => {};
  Object.defineProperty(factory, VERIFIED_BINDING_METADATA_FIELD, {
    value: metadata,
  });
  return factory;
}

describe("verified-provenance", () => {
  describe("recordVerifiedProvenance()", () => {
    it("records provenance for a function, keeping the first", () => {
      const fn = () => {};

      recordVerifiedProvenance(fn, { identity: "HASH", symbol: "first" });
      recordVerifiedProvenance(fn, { identity: "HASH", symbol: "second" });

      expect(getVerifiedProvenance(fn)).toEqual({
        identity: "HASH",
        symbol: "first",
      });
    });

    it("records nothing, and throws nothing, for a value that is not a function", () => {
      const notAFunction = { implementation: "HASH" };

      expect(() =>
        recordVerifiedProvenance("HASH", { identity: "HASH", symbol: "s" })
      ).not.toThrow();
      recordVerifiedProvenance(notAFunction, { identity: "HASH" });

      expect(getVerifiedProvenance(notAFunction)).toBeUndefined();
    });
  });

  describe("readBindingIdentity()", () => {
    it("returns a copy of a well-formed annotation", () => {
      const bindingPath = ["handlers", "increment"];
      const factory = annotated({ sourceFile: "/main.tsx", bindingPath });

      const identity = readBindingIdentity(factory);

      expect(identity).toEqual({ sourceFile: "/main.tsx", bindingPath });
      expect(identity?.bindingPath).not.toBe(bindingPath);
    });

    it("returns `undefined` for a value that cannot carry an annotation", () => {
      for (const value of [undefined, null, 0, "main.tsx", true]) {
        expect(readBindingIdentity(value)).toBeUndefined();
      }
    });

    it("returns `undefined` for a value with no annotation", () => {
      expect(readBindingIdentity(() => {})).toBeUndefined();
      expect(readBindingIdentity(annotated("/main.tsx"))).toBeUndefined();
    });

    it("returns `undefined` for an annotation that is not well-formed", () => {
      for (
        const metadata of [
          { bindingPath: ["handlers"] },
          { sourceFile: 1, bindingPath: ["handlers"] },
          { sourceFile: "/main.tsx" },
          { sourceFile: "/main.tsx", bindingPath: "handlers" },
          { sourceFile: "/main.tsx", bindingPath: ["handlers", 0] },
        ]
      ) {
        expect(readBindingIdentity(annotated(metadata))).toBeUndefined();
      }
    });
  });
});
