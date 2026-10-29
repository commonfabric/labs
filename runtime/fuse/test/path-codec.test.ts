import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { decodeFuseComponent, encodeFuseComponent } from "../path-codec.ts";

describe("path-codec", () => {
  describe("the empty component", () => {
    // An empty string is not a usable filesystem name, so the codec spells it
    // as a reserved token that no other component encodes to.

    it("encodes to a non-empty name that decodes back to the empty string", () => {
      const encoded = encodeFuseComponent("");

      expect(encoded).not.toBe("");
      expect(decodeFuseComponent(encoded)).toBe("");
    });

    it("encodes differently from the literal text of its own encoding", () => {
      const reserved = encodeFuseComponent("");
      const literal = encodeFuseComponent(reserved);

      expect(literal).not.toBe(reserved);
      expect(decodeFuseComponent(literal)).toBe(reserved);
    });
  });
});
