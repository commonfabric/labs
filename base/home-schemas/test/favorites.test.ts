import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { type FavoriteAddress, favoriteKey } from "@commonfabric/home-schemas";

const space = "did:key:test-space";
const id = "of:piece-1";

/** The address of `id` in `space`, resolved in `scope`. */
function address(scope: FavoriteAddress["scope"]): FavoriteAddress {
  return { space, scope, id, path: [] };
}

describe("favoriteKey()", () => {
  it("returns a key that names no scope for a space-scoped address", () => {
    // A key addresses an entity in durable storage, so the spelling below is a
    // contract with what is already stored rather than a formatting choice:
    // every favorite there is keyed by an address in the space scope, written
    // without one.

    expect(favoriteKey(address("space"))).toBe(
      JSON.stringify([space, id, []]),
    );
  });

  it("returns a key naming the scope for a narrower-scoped address", () => {
    expect(favoriteKey(address("user"))).toBe(
      JSON.stringify([space, id, [], "user"]),
    );
  });

  it("returns a distinct key for each scope one id resolves in", () => {
    const keys = new Set(
      (["space", "user", "session"] as const).map((scope) =>
        favoriteKey(address(scope))
      ),
    );
    expect(keys.size).toBe(3);
  });

  it("returns a distinct key for each space one id lives in", () => {
    expect(favoriteKey({ ...address("space"), space: "did:key:other" }))
      .not.toBe(favoriteKey(address("space")));
  });

  it("returns the same key for an omitted path as for an empty one", () => {
    expect(favoriteKey({ space, scope: "space", id })).toBe(
      favoriteKey(address("space")),
    );
  });

  it("returns a distinct key for each path within one document", () => {
    expect(favoriteKey({ space, scope: "space", id, path: ["inner"] }))
      .not.toBe(favoriteKey(address("space")));
  });
});
