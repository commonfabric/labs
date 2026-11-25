import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  actingScopeKeyOf,
  entityScopeKeysOf,
  entityScopeKeysProblem,
  namedRootInstance,
  resolveScopeKey,
} from "../v2.ts";

const alice = { principal: "did:key:alice", sessionId: "session:alice" };
const bob = { principal: "did:key:bob", sessionId: "session:bob" };
const aliceUser = resolveScopeKey("user", alice);
const aliceSession = resolveScopeKey("session", alice);
const bobSession = resolveScopeKey("session", bob);

describe("v2-entity-scope-keys", () => {
  describe("namedRootInstance()", () => {
    it("returns `undefined` for a root carrying no `entityScopeKeys`", () => {
      expect(namedRootInstance({ scope: "user" })).toBeUndefined();
    });

    it("returns the `user` entry for a `user`-scoped root", () => {
      expect(
        namedRootInstance({
          scope: "user",
          entityScopeKeys: { user: aliceUser, session: aliceSession },
        }),
      ).toBe(aliceUser);
    });

    it("returns the `session` entry for a `session`-scoped root", () => {
      expect(
        namedRootInstance({
          scope: "session",
          entityScopeKeys: { user: aliceUser, session: aliceSession },
        }),
      ).toBe(aliceSession);
    });

    it("returns `undefined` for a `space`-scoped root, and for one declaring no scope", () => {
      const entityScopeKeys = { user: aliceUser };

      expect(namedRootInstance({ scope: "space", entityScopeKeys }))
        .toBeUndefined();
      expect(namedRootInstance({ entityScopeKeys })).toBeUndefined();
    });
  });

  describe("actingScopeKeyOf()", () => {
    it("returns the `user` entry of a map holding it alone", () => {
      expect(actingScopeKeyOf({ user: aliceUser })).toBe(aliceUser);
    });

    it("returns the `session` entry of a map holding one", () => {
      expect(actingScopeKeyOf({ user: aliceUser, session: aliceSession }))
        .toBe(aliceSession);
    });
  });

  describe("entityScopeKeysOf()", () => {
    it("returns a `user` entry alone for an identity naming no session", () => {
      expect(entityScopeKeysOf({ principal: alice.principal })).toEqual({
        user: aliceUser,
      });
    });

    it("returns both entries for an identity naming a session", () => {
      expect(entityScopeKeysOf(alice)).toEqual({
        user: aliceUser,
        session: aliceSession,
      });
    });

    it("throws for an identity naming no principal", () => {
      expect(() => entityScopeKeysOf({ sessionId: alice.sessionId })).toThrow(
        "user scoped memory operations require a principal",
      );
    });
  });

  describe("entityScopeKeysProblem()", () => {
    it("returns `undefined` for a root carrying no `entityScopeKeys`", () => {
      expect(entityScopeKeysProblem({ scope: "user" })).toBeUndefined();
    });

    it("returns `undefined` for a `user` entry alone, and for both entries of one principal", () => {
      expect(
        entityScopeKeysProblem({
          scope: "user",
          entityScopeKeys: { user: aliceUser },
        }),
      ).toBeUndefined();
      expect(
        entityScopeKeysProblem({
          scope: "session",
          entityScopeKeys: { user: aliceUser, session: aliceSession },
        }),
      ).toBeUndefined();
    });

    it("returns `undefined` for a `space`-scoped root carrying a `user` entry", () => {
      expect(entityScopeKeysProblem({ entityScopeKeys: { user: aliceUser } }))
        .toBeUndefined();
    });

    it("names a value that is not a plain object", () => {
      for (const entityScopeKeys of [aliceUser, [aliceUser], null, 7]) {
        expect(entityScopeKeysProblem({ entityScopeKeys })).toBe(
          "it is not a record",
        );
      }
    });

    it("names an entry under a name other than `user` and `session`", () => {
      expect(
        entityScopeKeysProblem({
          entityScopeKeys: { user: aliceUser, space: "space" },
        }),
      ).toBe("it holds an entry for `space`");
    });

    it("names a `user` entry that is absent or is not a canonical `user` scope key", () => {
      for (
        const user of [undefined, 7, "space", aliceSession, "user:a/b", "user:"]
      ) {
        expect(entityScopeKeysProblem({ entityScopeKeys: { user } })).toBe(
          "its `user` entry is not a canonical `user` scope key",
        );
      }
    });

    it("names a `session` entry that is not a canonical `session` scope key", () => {
      for (const session of [7, "space", aliceUser, "session:a", null]) {
        expect(
          entityScopeKeysProblem({
            entityScopeKeys: { user: aliceUser, session },
          }),
        ).toBe("its `session` entry is not a canonical `session` scope key");
      }
    });

    it("names entries of different principals", () => {
      expect(
        entityScopeKeysProblem({
          entityScopeKeys: { user: aliceUser, session: bobSession },
        }),
      ).toBe("its `user` and `session` entries name different principals");
    });

    it("names a `session`-scoped root whose map holds no `session` entry", () => {
      expect(
        entityScopeKeysProblem({
          scope: "session",
          entityScopeKeys: { user: aliceUser },
        }),
      ).toBe(
        "it holds no `session` entry for the root's `session`-scoped document",
      );
    });
  });
});
