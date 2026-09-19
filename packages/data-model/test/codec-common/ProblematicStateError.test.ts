import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { ProblematicStateError } from "@/codec-common/index.ts";

describe("ProblematicStateError", () => {
  it("is an `Error`", () => {
    const e = new ProblematicStateError("T@1", { x: 1 }, "boom");

    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ProblematicStateError");
    expect(e.message).toBe("boom");
  });

  describe("constructor()", () => {
    it("keeps a `FabricValue` state by identity", () => {
      const state = { x: 1 };

      expect(new ProblematicStateError("T@1", state, "boom").state).toBe(state);
    });

    it("renders a non-`FabricValue` state", () => {
      const e = new ProblematicStateError("T@1", new Uint8Array([1, 2]), "b");

      expect(typeof e.state).toBe("string");
      expect(e.state).toMatch(/Uint8Array/);
    });

    it("preserves the wire type tag", () => {
      expect(new ProblematicStateError("Bad@7", 1, "b").wireTypeTag)
        .toBe("Bad@7");
    });
  });

  describe("fromThrown()", () => {
    it("takes an `Error`'s message and keeps it as `cause`", () => {
      const thrown = new RangeError("out of range");
      const e = ProblematicStateError.fromThrown("T@1", { x: 1 }, thrown);

      expect(e.message).toBe("out of range");
      expect(e.cause).toBe(thrown);
    });

    it("renders a thrown non-`Error`, still keeping it as `cause`", () => {
      // JavaScript permits throwing anything, so there may be no message to
      // take -- but the thrown value is still the best account of what
      // happened, and is not discarded.
      for (const thrown of [{ nope: true }, "plain string", 42, undefined]) {
        const e = ProblematicStateError.fromThrown("T@1", 1, thrown);

        expect(typeof e.message).toBe("string");
        expect(e.message.length).toBeGreaterThan(0);
        expect(e.cause).toBe(thrown);
      }
    });

    it("returns the thrown one when it already says the same thing", () => {
      // Re-wrapping would add a `cause` chain a reader has to walk to reach
      // the message that matters, and say nothing the original does not.
      const inner = new ProblematicStateError("T@1", { x: 1 }, "boom");
      const state = inner.state;

      expect(ProblematicStateError.fromThrown("T@1", state, inner))
        .toBe(inner);
    });

    it("wraps when the tag differs", () => {
      const inner = new ProblematicStateError("T@1", { x: 1 }, "boom");

      const outer = ProblematicStateError.fromThrown(
        "Other@1",
        inner.state,
        inner,
      );

      expect(outer).not.toBe(inner);
      expect(outer.wireTypeTag).toBe("Other@1");
      expect(outer.cause).toBe(inner);
    });

    it("wraps when the state differs", () => {
      const inner = new ProblematicStateError("T@1", { x: 1 }, "boom");

      const outer = ProblematicStateError.fromThrown("T@1", { x: 2 }, inner);

      expect(outer).not.toBe(inner);
      expect(outer.cause).toBe(inner);
    });

    it("coerces the state as the constructor does", () => {
      const e = ProblematicStateError.fromThrown(
        "T@1",
        new Uint8Array([1, 2, 3]),
        new Error("nope"),
      );

      expect(typeof e.state).toBe("string");
    });
  });
});
