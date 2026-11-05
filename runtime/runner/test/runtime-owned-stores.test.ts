import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  runtimeOwnedStoreKey,
  runtimeOwnedStoreOwnerKey,
  RuntimeOwnedStores,
} from "../src/cfc/runtime-owned-stores.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";

const SPACE = "did:key:zOwnedStores" as const;
const OTHER_SPACE = "did:key:zElsewhere" as const;

const identity = { principal: SPACE, sessionId: "session-1" } as Parameters<
  typeof runtimeOwnedStoreOwnerKey
>[2];

const link = (
  id: string,
  scope?: string,
  space: string = SPACE,
): NormalizedFullLink =>
  ({
    space,
    id,
    path: [],
    ...(scope !== undefined && { scope }),
  }) as NormalizedFullLink;

describe("the stores a runtime owns", () => {
  describe("RuntimeOwnedStores", () => {
    it("answers for a store an owner enrolled, and not for one nobody did", () => {
      const stores = new RuntimeOwnedStores();
      stores.add("store-a", "piece-1");
      expect(stores.has("store-a")).toBe(true);
      expect(stores.has("store-b")).toBe(false);
    });

    it("keeps a store the releasing owner was not the last to hold", () => {
      // Two scope instances of one causal piece are two owners of one store.
      const stores = new RuntimeOwnedStores();
      stores.add("store-a", "piece@space");
      stores.add("store-a", "piece@session");

      stores.releaseOwner("piece@space");
      expect(stores.has("store-a")).toBe(true);

      stores.releaseOwner("piece@session");
      expect(stores.has("store-a")).toBe(false);
    });

    it("drops only what the released owner held", () => {
      const stores = new RuntimeOwnedStores();
      stores.add("store-a", "piece-1");
      stores.add("store-b", "piece-2");

      stores.releaseOwner("piece-1");
      expect(stores.has("store-a")).toBe(false);
      expect(stores.has("store-b")).toBe(true);
    });

    it("takes a repeated enrollment as the one it already holds", () => {
      // A re-instantiation enrolls what the instantiation before it did, and
      // one release still empties the store's owner set.
      const stores = new RuntimeOwnedStores();
      stores.add("store-a", "piece-1");
      stores.add("store-a", "piece-1");

      stores.releaseOwner("piece-1");
      expect(stores.has("store-a")).toBe(false);
    });

    it("ignores a release naming an owner it never held", () => {
      const stores = new RuntimeOwnedStores();
      stores.add("store-a", "piece-1");

      stores.releaseOwner("piece-2");
      expect(stores.has("store-a")).toBe(true);
    });
  });

  describe("runtimeOwnedStoreKey()", () => {
    it("names one store across its scoped instances", () => {
      // Scope addresses an instance of one causal cell rather than naming a
      // different store (`docs/specs/scoped-cell-instances.md`).
      expect(runtimeOwnedStoreKey(SPACE, "of:one")).toBe(
        runtimeOwnedStoreKey(SPACE, "of:one"),
      );
      expect(runtimeOwnedStoreKey(SPACE, "of:one")).not.toBe(
        runtimeOwnedStoreKey(SPACE, "of:two"),
      );
      expect(runtimeOwnedStoreKey(SPACE, "of:one")).not.toBe(
        runtimeOwnedStoreKey(OTHER_SPACE, "of:one"),
      );
    });
  });

  describe("runtimeOwnedStoreOwnerKey()", () => {
    it("separates the scope instances of one causal piece", () => {
      const store = link("of:store");
      const spaceScoped = runtimeOwnedStoreOwnerKey(
        store,
        link("of:piece", "space"),
        identity,
      );
      const sessionScoped = runtimeOwnedStoreOwnerKey(
        store,
        link("of:piece", "session"),
        identity,
      );
      expect(spaceScoped).toBeDefined();
      expect(sessionScoped).toBeDefined();
      expect(spaceScoped).not.toBe(sessionScoped);
    });

    it("names no owner for a store outside the owner's space", () => {
      expect(
        runtimeOwnedStoreOwnerKey(
          link("of:store", "space", OTHER_SPACE),
          link("of:piece", "space"),
          identity,
        ),
      ).toBeUndefined();
    });
  });
});
