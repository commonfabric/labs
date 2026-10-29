import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { CellRef } from "@/protocol/mod.ts";
import { cellRefToInstanceId, describeFailure } from "@/shared/utils.ts";

describe("runtime client shared utilities", () => {
  describe("describeFailure", () => {
    it("returns an `Error`'s message", () => {
      expect(describeFailure(new Error("boom"))).toBe("boom");
    });

    it("returns the text of a value thrown that is not an `Error`", () => {
      expect(describeFailure("plain")).toBe("plain");
      expect(describeFailure(42)).toBe("42");
      expect(describeFailure(undefined)).toBe("undefined");
    });

    it("returns `/undescribable` for a value that refuses coercion", () => {
      // `String()` reaches for `toString` and `valueOf`; an object made with
      // `Object.create(null)` has neither to find.
      expect(describeFailure(Object.create(null))).toBe("/undescribable");
    });

    it("returns `/undescribable` when reading the message throws", () => {
      const hostile = new Error("unreachable");
      Object.defineProperty(hostile, "message", {
        get() {
          throw new Error("no message for you");
        },
      });
      expect(describeFailure(hostile)).toBe("/undescribable");
    });
  });

  describe("cellRefToInstanceId", () => {
    const ref: CellRef = {
      id: "of:fid1:test" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
    };

    it("keeps a user instance stable across that user's sessions", () => {
      const userRef = { ...ref, scope: "user" as const };
      expect(
        cellRefToInstanceId(userRef, {
          principal: "did:key:alice",
          sessionId: "one",
        }),
      ).toBe(
        cellRefToInstanceId(userRef, {
          principal: "did:key:alice",
          sessionId: "two",
        }),
      );
      expect(
        cellRefToInstanceId(userRef, {
          principal: "did:key:alice",
          sessionId: "one",
        }),
      ).not.toBe(
        cellRefToInstanceId(userRef, {
          principal: "did:key:bob",
          sessionId: "one",
        }),
      );
    });

    it("separates session instances for one user", () => {
      const sessionRef = { ...ref, scope: "session" as const };
      expect(
        cellRefToInstanceId(sessionRef, {
          principal: "did:key:alice",
          sessionId: "one",
        }),
      ).not.toBe(
        cellRefToInstanceId(sessionRef, {
          principal: "did:key:alice",
          sessionId: "two",
        }),
      );
    });

    it("separates identities containing delimiter-like text", () => {
      const sessionRef = { ...ref, scope: "session" as const };
      expect(
        cellRefToInstanceId(sessionRef, {
          principal: "a:b",
          sessionId: "c",
        }),
      ).not.toBe(
        cellRefToInstanceId(sessionRef, {
          principal: "a",
          sessionId: "b:c",
        }),
      );
    });

    it("keeps space instances independent of the viewer", () => {
      expect(
        cellRefToInstanceId(ref, {
          principal: "did:key:alice",
          sessionId: "one",
        }),
      ).toBe(
        cellRefToInstanceId(ref, {
          principal: "did:key:bob",
          sessionId: "two",
        }),
      );
    });
  });
});
