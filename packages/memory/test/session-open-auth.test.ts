import { assertEquals, assertRejects } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { FabricPlainObject, FabricValue } from "@commonfabric/api";
import { hashOf } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";

import { MEMORY_PROTOCOL } from "../v2.ts";
import {
  verifySessionOpenAuthorization,
  wireAuthorizationOf,
} from "../v2/session-open-auth.ts";
import { alice, bob, mallory, space } from "./principal.ts";

const now = 1_000_000;
const audience = bob.did();
const challenge = {
  value: "challenge:one",
  expiresAt: now + 60,
};

const signedFields = (
  extra: { aud?: string; challenge?: string; iat?: number; exp?: number } = {},
) => ({
  aud: audience,
  challenge: challenge.value,
  iat: now,
  exp: now + 300,
  ...extra,
});

const verifyOptions = (
  extra: Partial<Parameters<typeof verifySessionOpenAuthorization>[1]> = {},
) => ({
  audience,
  challenge,
  nowSeconds: now,
  ...extra,
});

// Build a signed session.open authorization the same way the production client
// does.
const buildOpen = async (
  extra: { aud?: string; challenge?: string; iat?: number; exp?: number } = {},
  identity = alice,
  session: {
    sessionId?: string;
    seenSeq?: number;
    sessionToken?: string;
    genesisRoot?: FabricValue;
  } = {},
) => {
  const sub = space.did();
  const invocation: Record<string, FabricValue> = {
    iss: identity.did(),
    cmd: "session.open",
    sub,
    args: { protocol: MEMORY_PROTOCOL, session },
    ...extra,
  };
  const signature = await identity.sign(hashOf(invocation).bytes);
  if (signature.error) throw signature.error;
  return {
    space: sub,
    session: { ...session },
    invocation,
    authorization: { signature: new FabricBytes(signature.ok) },
  };
};

describe("wireAuthorizationOf", () => {
  it("narrows an authorization carrying a `FabricBytes` signature", () => {
    const signature = new FabricBytes(new Uint8Array([1, 2, 3]));
    assertEquals(wireAuthorizationOf({ signature }), { signature });
  });

  it("rejects a non-record authorization", () => {
    assertEquals(wireAuthorizationOf(undefined), undefined);
    assertEquals(wireAuthorizationOf("signed"), undefined);
    assertEquals(wireAuthorizationOf(null), undefined);
  });

  it("rejects a signature that is not `FabricBytes`", () => {
    // Raw bytes are what the in-process `Signature<T>` looks like; the wire
    // form must be the `FabricPrimitive`, so this must not narrow. The
    // declared `FabricValue` does not keep a `Uint8Array` out of the
    // argument position; the check does.
    assertEquals(
      wireAuthorizationOf(
        { signature: new Uint8Array([1, 2, 3]) } as unknown as FabricValue,
      ),
      undefined,
    );
    assertEquals(wireAuthorizationOf({}), undefined);
  });
});

describe("verifySessionOpenAuthorization", () => {
  it("binds the complete custom-root expectation to the signed descriptor", async () => {
    const root = {
      source: "system:loom/main.tsx",
      cause: "signed-intent",
      argument: { title: "Expected" },
    };
    const message = await buildOpen(signedFields(), alice, {
      genesisRoot: root,
    });
    assertEquals(
      await verifySessionOpenAuthorization(message, verifyOptions()),
      alice.did(),
    );
    await assertRejects(() =>
      verifySessionOpenAuthorization(
        { ...message, session: {} },
        verifyOptions(),
      )
    );
    await assertRejects(() =>
      verifySessionOpenAuthorization({
        ...message,
        session: { genesisRoot: { ...root, argument: { title: "Changed" } } },
      }, verifyOptions())
    );
  });
  it("accepts a valid signed open and returns the issuer principal", async () => {
    assertEquals(
      await verifySessionOpenAuthorization(
        await buildOpen(signedFields()),
        verifyOptions(),
      ),
      alice.did(),
    );
  });

  it("rejects a malformed/unauthorized open", async () => {
    const msg = await buildOpen(signedFields());
    // Tamper with the issuer after signing.
    msg.invocation.iss = bob.did();
    await assertRejects(() =>
      verifySessionOpenAuthorization(msg, verifyOptions())
    );
  });

  it("rejects a resume token changed outside the signed invocation", async () => {
    const msg = await buildOpen(signedFields(), alice, {
      sessionId: "session:resume",
      seenSeq: 7,
      sessionToken: "token:signed",
    });
    msg.session = {
      sessionId: "session:resume",
      seenSeq: 7,
      sessionToken: "token:tampered",
    };
    await assertRejects(
      () => verifySessionOpenAuthorization(msg, verifyOptions()),
      Error,
      "authorization mismatch",
    );
  });

  //
  // Expiry
  //

  it("accepts an unexpired open", async () => {
    const msg = await buildOpen(signedFields({ iat: now, exp: now + 300 }));
    assertEquals(
      await verifySessionOpenAuthorization(
        msg,
        verifyOptions({
          nowSeconds: now + 10,
        }),
      ),
      alice.did(),
    );
  });

  it("rejects an expired open (beyond the skew grace)", async () => {
    const msg = await buildOpen(
      signedFields({ iat: now - 1000, exp: now - 500 }),
    );
    await assertRejects(
      () =>
        verifySessionOpenAuthorization(
          msg,
          verifyOptions({
            nowSeconds: now,
            clockSkewSeconds: 120,
          }),
        ),
      Error,
      "expired",
    );
  });

  it("tolerates clock skew within the grace window", async () => {
    const msg = await buildOpen(signedFields({ iat: now, exp: now - 30 }));
    assertEquals(
      await verifySessionOpenAuthorization(
        msg,
        verifyOptions({
          nowSeconds: now,
          clockSkewSeconds: 120,
        }),
      ),
      alice.did(),
    );
  });

  it("rejects a missing issued-at timestamp", async () => {
    const msg = await buildOpen({
      aud: audience,
      challenge: challenge.value,
      exp: now + 300,
    });
    await assertRejects(
      () => verifySessionOpenAuthorization(msg, verifyOptions()),
      Error,
      "requires iat",
    );
  });

  it("rejects a missing expiry timestamp", async () => {
    const msg = await buildOpen({
      aud: audience,
      challenge: challenge.value,
      iat: now,
    });
    await assertRejects(
      () => verifySessionOpenAuthorization(msg, verifyOptions()),
      Error,
      "requires exp",
    );
  });

  //
  // Challenge binding
  //

  it("accepts a challenged open with the matching challenge", async () => {
    const msg = await buildOpen(signedFields());
    assertEquals(
      await verifySessionOpenAuthorization(msg, verifyOptions()),
      alice.did(),
    );
  });

  it("rejects a missing challenge when one was issued", async () => {
    const msg = await buildOpen({ aud: audience });
    await assertRejects(
      () => verifySessionOpenAuthorization(msg, verifyOptions()),
      Error,
      "requires challenge",
    );
  });

  it("rejects the wrong challenge", async () => {
    const msg = await buildOpen(signedFields({ challenge: "challenge:other" }));
    await assertRejects(
      () => verifySessionOpenAuthorization(msg, verifyOptions()),
      Error,
      "challenge mismatch",
    );
  });

  it("rejects an expired challenge", async () => {
    const msg = await buildOpen(signedFields());
    await assertRejects(
      () =>
        verifySessionOpenAuthorization(
          msg,
          verifyOptions({
            challenge: {
              value: challenge.value,
              expiresAt: now,
            },
            nowSeconds: now,
          }),
        ),
      Error,
      "challenge expired",
    );
  });

  //
  // Audience binding
  //

  it("accepts an audience-bound open at the matching host", async () => {
    assertEquals(
      await verifySessionOpenAuthorization(
        await buildOpen(signedFields()),
        verifyOptions(),
      ),
      alice.did(),
    );
  });

  it("rejects a missing audience when the server configures one", async () => {
    const msg = await buildOpen({ challenge: challenge.value });
    await assertRejects(
      () => verifySessionOpenAuthorization(msg, verifyOptions()),
      Error,
      "requires audience",
    );
  });

  it("rejects an audience-bound open replayed to a different host", async () => {
    const msg = await buildOpen(signedFields());
    await assertRejects(
      () =>
        verifySessionOpenAuthorization(
          msg,
          verifyOptions({
            audience: mallory.did(),
          }),
        ),
      Error,
      "audience mismatch",
    );
  });

  describe("record shape", () => {
    // A class instance reads as carrying no properties, so a descriptor
    // comparison over one compares nothing against nothing. `FabricBytes` is
    // the instance a peer can put there: the codec decodes it at any position
    // in the invocation, which the issuer then signs like any other content.
    it("rejects an open whose signed session descriptor is a class instance", async () => {
      const msg = await buildOpen(signedFields(), alice, {
        sessionId: "session:resume",
      });
      const invocation = {
        ...msg.invocation,
        args: {
          protocol: MEMORY_PROTOCOL,
          session: new FabricBytes(new Uint8Array([1, 2, 3])),
        },
      };
      const signature = await alice.sign(hashOf(invocation).bytes);
      if (signature.error) throw signature.error;
      await assertRejects(
        () =>
          verifySessionOpenAuthorization({
            space: msg.space,
            session: {},
            invocation,
            authorization: { signature: new FabricBytes(signature.ok) },
          }, verifyOptions()),
        Error,
        "authorization mismatch",
      );
    });

    // The declared `FabricPlainObject` is what the wire parser establishes,
    // not something this function may assume of its own argument.
    it("rejects an open whose invocation is a class instance", async () => {
      const msg = await buildOpen(signedFields());
      await assertRejects(
        () =>
          verifySessionOpenAuthorization({
            ...msg,
            invocation: new FabricBytes(
              new Uint8Array([1, 2, 3]),
            ) as unknown as FabricPlainObject,
          }, verifyOptions()),
        Error,
        "requires authorization",
      );
    });

    it("returns `undefined` from `wireAuthorizationOf` for a class-instance authorization", () => {
      expect(
        wireAuthorizationOf(new FabricBytes(new Uint8Array([1, 2, 3]))),
      ).toBe(undefined);
    });
  });
});
