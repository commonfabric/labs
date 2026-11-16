import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { resolveScopeKey } from "../v2.ts";
import { deleteInapplicableEntries } from "../v2/server.ts";

const ALICE = "did:key:z6Mk-inapplicable-alice";
const BOB = "did:key:z6Mk-inapplicable-bob";

describe("deleteInapplicableEntries()", () => {
  const alice = { principal: ALICE, sessionId: "session-a" };
  const keys = {
    space: "space",
    aliceUser: resolveScopeKey("user", alice),
    aliceSession: resolveScopeKey("session", alice),
    bobUser: resolveScopeKey("user", { principal: BOB }),
    otherSession: resolveScopeKey("session", {
      principal: ALICE,
      sessionId: "session-b",
    }),
  };
  const entries = () =>
    new Map(
      Object.entries(keys).map(([name, scopeKey]) => [name, { scopeKey }]),
    );

  it("keeps the space instance and the identity's own user and session instances", () => {
    const held = entries();

    deleteInapplicableEntries(held, alice);

    expect([...held.keys()]).toEqual(["space", "aliceUser", "aliceSession"]);
  });

  it("keeps only the space instance for an identity with no principal", () => {
    const held = entries();

    deleteInapplicableEntries(held, { sessionId: "session-a" });

    expect([...held.keys()]).toEqual(["space"]);
  });
});
