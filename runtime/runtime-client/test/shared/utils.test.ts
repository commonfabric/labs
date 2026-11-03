import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { CellRef } from "@/protocol/mod.ts";
import { cellRefToInstanceId } from "@/shared/utils.ts";

describe("runtime client shared utilities", () => {
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
