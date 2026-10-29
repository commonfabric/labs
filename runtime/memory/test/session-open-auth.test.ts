import { assertEquals, assertRejects } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { FabricPlainObject, FabricValue } from "@commonfabric/api";
import { hashOf } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import {
  type Delegation,
  delegationCid,
  issueDelegation,
} from "@commonfabric/identity";

import { MEMORY_PROTOCOL } from "../v2.ts";
import { type ClientInfo, createClientInfo } from "../v2/client-info.ts";
import {
  authorizeLoopbackSessionOpen,
  MAX_PROOF_CHAIN_LENGTH,
  verifySessionOpenAuthorization,
  verifySessionOpenProofs,
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
    client?: ClientInfo;
    sessionId?: string;
    seenSeq?: number;
    sessionToken?: string;
    resumeKey?: string;
    resumeAttempt?: number;
    genesisRoot?: FabricValue;
    spaceKind?: string;
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
  it("binds client identity to the signed session descriptor", async () => {
    const client = createClientInfo({
      application: "cf",
      gitSha: "a".repeat(40),
    });
    const message = await buildOpen(signedFields(), alice, { client });
    expect(await verifySessionOpenAuthorization(message, verifyOptions())).toBe(
      alice.did(),
    );
    for (
      const session of [
        {},
        { client: { ...client, generation: 2 } },
        {
          client: { ...client, application: "shell" },
        },
        { client: { ...client, gitSha: "b".repeat(40) } },
        { client: { ...client, instanceId: "another-runtime" } },
        { client: { ...client, startedAt: client.startedAt + 1 } },
      ]
    ) {
      await expect(
        verifySessionOpenAuthorization(
          { ...message, session },
          verifyOptions(),
        ),
      ).rejects.toMatchObject({ name: "AuthorizationError" });
    }
    const unsigned = await buildOpen(signedFields());
    await expect(
      verifySessionOpenAuthorization(
        { ...unsigned, session: { client } },
        verifyOptions(),
      ),
    ).rejects.toMatchObject({ name: "AuthorizationError" });
  });

  it("binds client identity when the reserved generation field is absent", async () => {
    const client = { ...createClientInfo({ application: "cf", gitSha: null }) };
    delete client.generation;
    const message = await buildOpen(signedFields(), alice, { client });
    expect(await verifySessionOpenAuthorization(message, verifyOptions())).toBe(
      alice.did(),
    );
    for (
      const session of [
        {},
        { client: { ...client, generation: 1 } },
        { client: { ...client, application: "shell" } },
      ]
    ) {
      await expect(
        verifySessionOpenAuthorization(
          { ...message, session },
          verifyOptions(),
        ),
      ).rejects.toMatchObject({ name: "AuthorizationError" });
    }
  });

  it("binds the complete custom-root expectation to the signed descriptor", async () => {
    const root = {
      source: "system:system/loom/main.tsx",
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
  it("binds the declared space kind to the signed descriptor", async () => {
    const message = await buildOpen(signedFields(), alice, {
      spaceKind: "fabrichat-room",
    });
    assertEquals(
      await verifySessionOpenAuthorization(message, verifyOptions()),
      alice.did(),
    );
    for (const session of [{}, { spaceKind: "notebook" }]) {
      await assertRejects(
        () =>
          verifySessionOpenAuthorization(
            { ...message, session },
            verifyOptions(),
          ),
        Error,
        "authorization mismatch",
      );
    }
    const malformed = await buildOpen(signedFields(), alice, {
      spaceKind: 7 as unknown as string,
    });
    await assertRejects(
      () =>
        verifySessionOpenAuthorization(
          { ...malformed, session: {} },
          verifyOptions(),
        ),
      Error,
      "authorization mismatch",
    );
    const unsigned = await buildOpen(signedFields());
    await assertRejects(
      () =>
        verifySessionOpenAuthorization(
          { ...unsigned, session: { spaceKind: "fabrichat-room" } },
          verifyOptions(),
        ),
      Error,
      "authorization mismatch",
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

  it("rejects a resume key added, changed or dropped outside the signed invocation", async () => {
    const resume = {
      sessionId: "session:resume",
      seenSeq: 7,
      sessionToken: "token:signed",
    };
    const msg = await buildOpen(signedFields(), alice, {
      ...resume,
      resumeKey: "key:signed",
    });
    assertEquals(
      await verifySessionOpenAuthorization(msg, verifyOptions()),
      alice.did(),
    );
    for (const session of [{ ...resume, resumeKey: "key:tampered" }, resume]) {
      await assertRejects(
        () =>
          verifySessionOpenAuthorization({ ...msg, session }, verifyOptions()),
        Error,
        "authorization mismatch",
      );
    }
    const unkeyed = await buildOpen(signedFields(), alice, resume);
    await assertRejects(
      () =>
        verifySessionOpenAuthorization(
          { ...unkeyed, session: { ...resume, resumeKey: "key:injected" } },
          verifyOptions(),
        ),
      Error,
      "authorization mismatch",
    );
  });

  it("rejects a resume attempt added, changed or dropped outside the signed invocation", async () => {
    const resume = {
      sessionId: "session:resume",
      seenSeq: 7,
      sessionToken: "token:signed",
      resumeKey: "key:signed",
    };
    const numbered = await buildOpen(signedFields(), alice, {
      ...resume,
      resumeAttempt: 2,
    });
    expect(await verifySessionOpenAuthorization(numbered, verifyOptions()))
      .toBe(alice.did());
    for (const session of [{ ...resume, resumeAttempt: 3 }, resume]) {
      await expect(verifySessionOpenAuthorization(
        { ...numbered, session },
        verifyOptions(),
      )).rejects.toThrow("authorization mismatch");
    }
    const unnumbered = await buildOpen(signedFields(), alice, resume);
    await expect(verifySessionOpenAuthorization(
      { ...unnumbered, session: { ...resume, resumeAttempt: 3 } },
      verifyOptions(),
    )).rejects.toThrow("authorization mismatch");
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

describe("authorizeLoopbackSessionOpen", () => {
  it("returns the issuer of a signed open that verifies", async () => {
    expect(
      await authorizeLoopbackSessionOpen(
        await buildOpen(signedFields()),
        verifyOptions(),
      ),
    ).toBe(alice.did());
  });

  it("throws for a signed open whose invocation no longer matches its signature", async () => {
    const message = await buildOpen(signedFields());
    message.invocation.iat = 0;
    await expect(
      Promise.resolve(authorizeLoopbackSessionOpen(message, verifyOptions())),
    ).rejects.toThrow("Invalid signature");
  });

  it("throws for a signed open addressed to a different audience", async () => {
    const message = await buildOpen(signedFields({ aud: mallory.did() }));
    await expect(
      Promise.resolve(authorizeLoopbackSessionOpen(message, verifyOptions())),
    ).rejects.toThrow("memory session.open audience mismatch");
  });

  it("returns the issuer of a signed open that also names another principal", async () => {
    const message = await buildOpen(signedFields());
    expect(
      await authorizeLoopbackSessionOpen({
        ...message,
        authorization: { ...message.authorization, principal: mallory.did() },
      }, verifyOptions()),
    ).toBe(alice.did());
  });

  it("returns the principal an unsigned open names", async () => {
    expect(
      await authorizeLoopbackSessionOpen(
        {
          space: space.did(),
          session: {},
          authorization: { principal: mallory.did() },
        },
        verifyOptions(),
      ),
    ).toBe(mallory.did());
  });

  it("returns `undefined` for an unsigned open that names no principal", async () => {
    expect(
      await authorizeLoopbackSessionOpen(
        { space: space.did(), session: {}, authorization: {} },
        verifyOptions(),
      ),
    ).toBeUndefined();
  });
});

describe("verifySessionOpenProofs", () => {
  // The space delegates to alice, and alice delegates on to bob: the two
  // chains every case below is built from. The space is its own owner, as a
  // profile space is, so the root issuer is the space DID.
  const rootDelegation = (
    fields: Partial<Parameters<typeof issueDelegation>[1]> = {},
  ) =>
    issueDelegation(space, {
      aud: alice.did(),
      sub: space.did(),
      cmd: "/memory",
      pol: [],
      ...fields,
    });
  const onwardDelegation = (
    fields: Partial<Parameters<typeof issueDelegation>[1]> = {},
  ) =>
    issueDelegation(alice, {
      aud: bob.did(),
      sub: space.did(),
      cmd: "/memory/session.open",
      pol: [],
      ...fields,
    });

  /** A signed open as `principal` presenting `chain`, with `prf` naming it
   * unless `prf` is given. */
  const signedOpen = (
    chain: Delegation[],
    principal = alice,
    prf: FabricValue = chain.map((d) => d.cid),
  ) => ({
    space: space.did(),
    session: {},
    invocation: {
      iss: principal.did(),
      cmd: "session.open",
      sub: space.did(),
      args: { protocol: MEMORY_PROTOCOL, session: {} },
      ...signedFields(),
      prf,
    },
    authorization: {
      signature: new FabricBytes(new Uint8Array(64)),
      proofs: chain.map((d) => new FabricBytes(d.bytes)),
    },
  });

  /** Options for `principal`; `null` is an open authenticating no one. */
  const proofOptions = (principal: string | null = alice.did()) => ({
    space: space.did(),
    principal: principal ?? undefined,
    nowSeconds: now,
  });

  it("returns `undefined` for an open presenting no chain", async () => {
    expect(
      await verifySessionOpenProofs(await buildOpen(), proofOptions()),
    ).toBeUndefined();
  });

  it("returns the root issuer for a chain of one from the space to the opener", async () => {
    const root = await rootDelegation();
    expect(
      await verifySessionOpenProofs(signedOpen([root]), proofOptions()),
    ).toEqual({ rootIssuer: space.did() });
  });

  it("returns the root issuer for a chain of two ending at the opener", async () => {
    const chain = [await rootDelegation(), await onwardDelegation()];
    expect(
      await verifySessionOpenProofs(
        signedOpen(chain, bob),
        proofOptions(bob.did()),
      ),
    ).toEqual({ rootIssuer: space.did() });
  });

  it("returns the root issuer for an open naming an authenticated principal and carrying proofs alone", async () => {
    const root = await rootDelegation();
    expect(
      await verifySessionOpenProofs(
        {
          space: space.did(),
          session: {},
          authorization: { proofs: [new FabricBytes(root.bytes)] },
        },
        proofOptions(),
      ),
    ).toEqual({ rootIssuer: space.did() });
  });

  it("throws when the open authenticates no principal", async () => {
    const root = await rootDelegation();
    await expect(
      verifySessionOpenProofs(signedOpen([root]), proofOptions(null)),
    ).rejects.toThrow("authenticates no principal");
  });

  it("throws when `prf` names a CID other than the proof's", async () => {
    const root = await rootDelegation();
    const other = await rootDelegation();
    await expect(
      verifySessionOpenProofs(
        signedOpen([root], alice, [other.cid]),
        proofOptions(),
      ),
    ).rejects.toThrow("not the delegation `prf` names");
  });

  it("throws when a signed open carries proofs without `prf`, or `prf` without proofs", async () => {
    const root = await rootDelegation();
    const { invocation, ...rest } = signedOpen([root]);
    const { prf: _, ...unbound } = invocation;
    await expect(
      verifySessionOpenProofs({ ...rest, invocation: unbound }, proofOptions()),
    ).rejects.toThrow("`prf` does not name one CID per proof");
    await expect(
      verifySessionOpenProofs(
        {
          ...rest,
          invocation,
          authorization: { signature: new FabricBytes(new Uint8Array(64)) },
        },
        proofOptions(),
      ),
    ).rejects.toThrow("`proofs` is not a non-empty array");
  });

  it("throws for a proof that is not bytes", async () => {
    const root = await rootDelegation();
    const open = signedOpen([root]);
    await expect(
      verifySessionOpenProofs(
        { ...open, authorization: { ...open.authorization, proofs: ["x"] } },
        proofOptions(),
      ),
    ).rejects.toThrow("proof 0 is not bytes");
  });

  it("throws for a proof whose signature does not verify", async () => {
    const root = await rootDelegation();
    const forged = root.bytes.slice();
    forged[10] ^= 0xff;
    const open = signedOpen([root]);
    await expect(
      verifySessionOpenProofs(
        {
          ...open,
          invocation: {
            ...open.invocation,
            prf: [await delegationCid(forged)],
          },
          authorization: {
            ...open.authorization,
            proofs: [new FabricBytes(forged)],
          },
        },
        proofOptions(),
      ),
    ).rejects.toThrow("proof 0 signature does not verify");
  });

  it("throws for a proof over another space", async () => {
    const root = await rootDelegation({ sub: mallory.did() });
    await expect(
      verifySessionOpenProofs(signedOpen([root]), proofOptions()),
    ).rejects.toThrow("proof 0 is over another space");
  });

  it("throws for a proof that names no subject", async () => {
    const root = await rootDelegation({ sub: null });
    await expect(
      verifySessionOpenProofs(signedOpen([root]), proofOptions()),
    ).rejects.toThrow("proof 0 names no subject");
  });

  it("throws for a proof whose command does not cover opening a session", async () => {
    const root = await rootDelegation({ cmd: "/memory/transact" });
    await expect(
      verifySessionOpenProofs(signedOpen([root]), proofOptions()),
    ).rejects.toThrow("proof 0 does not cover /memory/session.open");
  });

  it("throws for a proof past its expiry second, and accepts one at it", async () => {
    const expired = await rootDelegation({ exp: now - 1 });
    await expect(
      verifySessionOpenProofs(signedOpen([expired]), proofOptions()),
    ).rejects.toThrow("proof 0 has expired");
    const atExpiry = await rootDelegation({ exp: now });
    expect(
      await verifySessionOpenProofs(signedOpen([atExpiry]), proofOptions()),
    ).toEqual({ rootIssuer: space.did(), expiresAt: now });
  });

  it("throws for a proof that is not yet valid", async () => {
    const early = await rootDelegation({ nbf: now + 1_000 });
    await expect(
      verifySessionOpenProofs(signedOpen([early]), proofOptions()),
    ).rejects.toThrow("proof 0 is not yet valid");
  });

  it("throws for a chain whose links do not meet", async () => {
    const root = await rootDelegation();
    const stray = await issueDelegation(mallory, {
      aud: bob.did(),
      sub: space.did(),
      cmd: "/memory",
      pol: [],
    });
    await expect(
      verifySessionOpenProofs(
        signedOpen([root, stray], bob),
        proofOptions(bob.did()),
      ),
    ).rejects.toThrow("proof 1 is not issued by the previous audience");
  });

  it("throws for a chain whose last audience is not the opener", async () => {
    const root = await rootDelegation();
    await expect(
      verifySessionOpenProofs(signedOpen([root], bob), proofOptions(bob.did())),
    ).rejects.toThrow("the last audience is not the open's principal");
  });

  it("throws for a chain longer than the bound before verifying any signature", async () => {
    const root = await rootDelegation();
    const chain = Array.from(
      { length: MAX_PROOF_CHAIN_LENGTH + 1 },
      () => root,
    );
    await expect(
      verifySessionOpenProofs(signedOpen(chain), proofOptions()),
    ).rejects.toThrow(
      `the chain is longer than ${MAX_PROOF_CHAIN_LENGTH} proofs`,
    );
  });

  it("returns the earliest expiry among the chain's proofs", async () => {
    const chain = [
      await rootDelegation({ exp: now + 500 }),
      await onwardDelegation({ exp: now + 200 }),
    ];
    expect(
      await verifySessionOpenProofs(
        signedOpen(chain, bob),
        proofOptions(bob.did()),
      ),
    ).toEqual({ rootIssuer: space.did(), expiresAt: now + 200 });
  });
});
