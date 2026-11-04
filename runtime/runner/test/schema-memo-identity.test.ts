// The shared-schema-memo identity tripwire (traverse.ts, OW10 /
// key-vocabulary.md §5's identity-bound invariant; PR #5439 thread
// r3731191386): one memo instance may only ever be traversed under ONE
// identity. The binding key must be INJECTIVE over (principal,
// sessionId) — a raw-delimiter encoding lets two DISTINCT identities
// collide (NUL inside a segment, undefined vs empty string), and a
// collision here is precisely the cross-identity memo sharing the guard
// exists to make loud.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assertSchemaMemoIdentity, createSchemaMemo } from "../src/traverse.ts";

describe("schema memo identity binding", () => {
  it("binds a memo to its first identity and refuses a different one", () => {
    const memo = createSchemaMemo();
    assertSchemaMemoIdentity(memo, {
      principal: "did:key:alice",
      sessionId: "s-1",
    });
    // Same identity again: fine.
    assertSchemaMemoIdentity(memo, {
      principal: "did:key:alice",
      sessionId: "s-1",
    });
    expect(() =>
      assertSchemaMemoIdentity(memo, {
        principal: "did:key:bob",
        sessionId: "s-1",
      })
    ).toThrow("second identity");
  });

  it("the binding key is injective: NUL inside a segment cannot alias two distinct identities", () => {
    const memo = createSchemaMemo();
    assertSchemaMemoIdentity(memo, {
      principal: "a\0b",
      sessionId: "c",
    });
    // A DIFFERENT identity that a raw-NUL-delimited encoding collides
    // with ("a\0b\0c" both ways). The guard must refuse it.
    expect(() =>
      assertSchemaMemoIdentity(memo, {
        principal: "a",
        sessionId: "b\0c",
      })
    ).toThrow("second identity");
  });

  it("the binding key distinguishes an ABSENT component from an empty string", () => {
    const memo = createSchemaMemo();
    assertSchemaMemoIdentity(memo, { sessionId: "s-1" });
    expect(() =>
      assertSchemaMemoIdentity(memo, { principal: "", sessionId: "s-1" })
    ).toThrow("second identity");
  });
});
