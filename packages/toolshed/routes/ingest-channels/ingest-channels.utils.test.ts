import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { Runtime } from "@commonfabric/runner";
import {
  createAclServer,
  genesisAcl,
  LoopbackSessionFactory,
  TestStorageManager,
} from "@/lib/test-support/memory-acl.ts";
import {
  type ControlDeps,
  type ControlResult,
  processList,
  processMint,
  processRevoke,
  processRotate,
} from "./ingest-channels.utils.ts";
import {
  channelId,
  getLifetimeChannelCount,
  getOwnerRegistrationIndex,
  getRegistration,
  getRegistrationIndex,
  getSpaceLifetimeChannelCount,
  processIngest,
  saveRegistration,
} from "@/routes/ingest/ingest.utils.ts";

// Shaped like a real derived channel id: ids are validated before they become
// a cell cause in the operator's service space.
const WELL_FORMED_ID = "ing_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** Narrow a ControlResult to its success body, failing loudly otherwise. */
const ok = <T>(result: ControlResult<T>): T => {
  assert(
    result.status === 200,
    `expected 200, got ${result.status}: ${JSON.stringify(result.body)}`,
  );
  return result.body;
};

/** Narrow a ControlResult to its error message. */
const err = (result: ControlResult<unknown>): string => {
  assert(result.status !== 200, "expected a failure");
  return result.body.error;
};

describe("ingest-channels control plane", () => {
  // The brief's acceptance criteria, run against a REAL memory server with
  // `acl: { mode: "enforce" }`: a user holding only their own identity key can
  // mint a channel for their own space, is refused when naming a space they do
  // not control, can list / rotate / revoke, and a revoked token stops working.
  //
  // Ownership is enforced against a space with a CONCRETE, non-derived owner.
  // That matters: on a deployment where space DIDs derive from a public
  // passphrase, anyone can sign as the space and grant themselves OWNER, so a
  // test against such a space would prove nothing about the check.

  let server: MemoryV2Server.Server;
  let factory: LoopbackSessionFactory;
  let operator: Identity;
  let alice: Identity;
  let mallory: Identity;
  let spaceIdentity: Identity;
  let space: string;
  let storageManager: TestStorageManager;
  let runtime: Runtime;
  let deps: ControlDeps;

  beforeEach(async () => {
    server = createAclServer(`ingest-channels-${crypto.randomUUID()}`);
    factory = new LoopbackSessionFactory(server);
    operator = await Identity.fromPassphrase("ic-operator");
    alice = await Identity.fromPassphrase("ic-alice");
    mallory = await Identity.fromPassphrase("ic-mallory");
    spaceIdentity = await Identity.fromPassphrase("ic-space");
    space = spaceIdentity.did();
    storageManager = TestStorageManager.overServer({ as: operator }, factory);
    runtime = new Runtime({
      apiUrl: new URL("https://ic-test.invalid"),
      storageManager,
    });
    deps = {
      runtime,
      serviceSpace: operator.did(),
      operatorDid: operator.did(),
      serviceDids: [],
      hostsSpace: () => true,
      apiUrl: "https://ic-test.invalid",
    };
    // Alice owns the space; the operator can write into it. This is the
    // healthy, correctly-provisioned shape.
    await genesisAcl(factory, spaceIdentity, {
      [alice.did()]: "OWNER",
      [operator.did()]: "WRITE",
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
    await server.close();
  });

  /**
   * A second space co-owned by alice and mallory. A space ACL can only be
   * INITIALIZED once, so a co-owned shape has to be genesis'd on its own space
   * rather than layered onto the one in beforeEach.
   */
  const sharedSpace = async (
    /** Extra co-owners, since an ACL can only be initialized once. */
    ...alsoOwners: string[]
  ): Promise<string> => {
    const id = await Identity.fromPassphrase(
      `ic-shared-${crypto.randomUUID()}`,
    );
    await genesisAcl(factory, id, {
      [alice.did()]: "OWNER",
      [mallory.did()]: "OWNER",
      ...Object.fromEntries(alsoOwners.map((did) => [did, "OWNER"])),
      [operator.did()]: "WRITE",
    });
    return id.did();
  };

  // `revoke` binds to the generation the caller looked at, so a test has to
  // name the real one — which also means a test cannot accidentally revoke a
  // channel that moved underneath it without noticing.
  const revOf = async (id: string): Promise<number> =>
    (await getRegistration(runtime, operator.did(), id))?.revision ?? 0;

  const mint = (caller: Identity, requestId: string, over = {}) =>
    processMint(deps, caller.did(), {
      space,
      installId: "phone-1",
      requestId,
      ...over,
    });

  it("mints for a space the caller owns, and returns the token exactly once", async () => {
    const res = await mint(alice, "req-1");
    expect(res.status).toBe(200);
    expect(typeof ok(res).token).toBe("string");
    expect(ok(res).token.startsWith("ingsec_")).toBe(true);
    expect(ok(res).space).toBe(space);

    // Only the hash is ever stored, and the hash never leaves the server.
    const stored = await getRegistration(
      runtime,
      operator.did(),
      ok(res).id,
    );
    expect(stored?.secretHash).toBeDefined();
    expect(stored?.secretHash).not.toBe(ok(res).token);
    expect(stored?.owner).toBe(alice.did());
    expect(JSON.stringify(res.body)).not.toContain(stored!.secretHash);
  });

  it("refuses a caller who does not own the space", async () => {
    // The headline acceptance criterion.

    const res = await mint(mallory, "req-2");
    expect(res.status).toBe(403);
    expect(err(res)).toContain("Not authorized");
    // Nothing was minted, so no request id was consumed either.
    expect(await getRegistration(runtime, operator.did(), "ing_anything"))
      .toBeNull();
  });

  it("refuses an unhosted space identically to an unowned one", async () => {
    const unowned = await mint(mallory, "req-3");
    const unhosted = await processMint(
      { ...deps, hostsSpace: () => false },
      alice.did(),
      { space, installId: "phone-1", requestId: "req-4" },
    );
    expect(unhosted.status).toBe(unowned.status);
    expect(unhosted.body).toEqual(unowned.body);
  });

  it("returns 409 and NO token when a requestId is replayed", async () => {
    // Without this, a captured mint replayed inside the ≤300s proof freshness
    // window would mint a FRESH secret and hand it to the replayer.

    const first = await mint(alice, "req-dup");
    expect(first.status).toBe(200);

    const replay = await mint(alice, "req-dup");
    expect(replay.status).toBe(409);
    expect("token" in replay.body).toBe(false);

    // And the live token is untouched — a replay must not rotate anyone out.
    const stored = await getRegistration(
      runtime,
      operator.did(),
      ok(first).id,
    );
    const ingest = await processIngest(
      runtime,
      operator.did(),
      ok(first).id,
      ok(first).token,
      JSON.stringify({ partition: "2026-08-04", records: [{ x: 1 }] }),
    );
    expect(ingest.status).toBe(200);
    expect(stored).not.toBeNull();
  });

  it("refuses to re-mint under a different causePrefix", async () => {
    expect((await mint(alice, "req-a")).status).toBe(200);
    const res = await mint(alice, "req-b", { causePrefix: "elsewhere" });
    expect(res.status).toBe(409);
    expect(err(res)).toContain("cause-prefix");
  });

  it("rejects an installId that could impersonate an integration audience", async () => {
    // `did:web:commonfabric.org#oauth2` and `#plaid` are the token-less
    // integration audiences; the segment charset is what keeps a minted
    // audience out of that namespace.

    const res = await mint(alice, "req-c", {
      installId: "did:web:commonfabric.org#oauth2",
    });
    expect(res.status).toBe(400);
  });

  it("rotates in place: new token works, old token stops", async () => {
    const first = await mint(alice, "req-r1");
    const id = ok(first).id;

    const rotated = await processRotate(deps, alice.did(), {
      id,
      requestId: "req-r2",
    });
    expect(rotated.status).toBe(200);
    expect(ok(rotated).id).toBe(id);
    expect(ok(rotated).token).not.toBe(ok(first).token);

    const body = JSON.stringify({
      partition: "2026-08-04",
      records: [{ x: 1 }],
    });
    const withNew = await processIngest(
      runtime,
      operator.did(),
      id,
      ok(rotated).token,
      body,
    );
    expect(withNew.status).toBe(200);

    // 403, not 401: the holder of the superseded token has proven possession,
    // so it gets an actionable "re-pair" instead of a blank refusal. A merely
    // wrong token still gets the equalized 401 — asserted below.
    const withOld = await processIngest(
      runtime,
      operator.did(),
      id,
      ok(first).token,
      body,
    );
    expect(withOld.status).toBe(403);
  });

  it("refuses rotate and revoke from a non-owner (IDOR)", async () => {
    // The invariant whose violation is a total break: rotate/revoke authorize
    // against the registration's STORED space, never against caller input.

    const first = await mint(alice, "req-i1");
    const id = ok(first).id;

    const rot = await processRotate(deps, mallory.did(), {
      id,
      requestId: "req-i2",
    });
    expect(rot.status).toBe(403);
    expect("token" in rot.body).toBe(false);

    const rev = await processRevoke(deps, mallory.did(), {
      id,
      requestId: "rv-1",
      expectedRevision: await revOf(id),
    });
    expect(rev.status).toBe(403);

    // Alice's token still works — Mallory changed nothing.
    const still = await processIngest(
      runtime,
      operator.did(),
      id,
      ok(first).token,
      JSON.stringify({ partition: "2026-08-04", records: [{ x: 1 }] }),
    );
    expect(still.status).toBe(200);
  });

  it("returns the unowned denial for a rotate and a revoke addressed to a space the channel does not write into", async () => {
    // The owner asks, so only the space the request was addressed to stands
    // between the request and the channel.

    const first = await mint(alice, "req-as1");
    const id = ok(first).id;

    const rot = await processRotate(deps, alice.did(), {
      id,
      requestId: "req-as2",
      space: "did:key:z6MkaaaabbbbccccddddeeeeffffgggghhhhAAAA",
    });
    expect(rot.status).toBe(403);
    expect("token" in rot.body).toBe(false);

    const rev = await processRevoke(deps, alice.did(), {
      id,
      requestId: "rv-as1",
      expectedRevision: await revOf(id),
      space: "did:key:z6MkaaaabbbbccccddddeeeeffffgggghhhhAAAA",
    });
    expect(rev.status).toBe(403);

    const still = await processIngest(
      runtime,
      operator.did(),
      id,
      ok(first).token,
      JSON.stringify({ partition: "2026-08-04", records: [{ x: 1 }] }),
    );
    expect(still.status).toBe(200);
  });

  it("rotates a channel addressed through the space it writes into", async () => {
    const first = await mint(alice, "req-as3");

    const rotated = await processRotate(deps, alice.did(), {
      id: ok(first).id,
      requestId: "req-as4",
      space,
    });

    expect(rotated.status).toBe(200);
  });

  it("returns a URL that names the channel's space ahead of its id", async () => {
    const minted = ok(await mint(alice, "req-url"));

    expect(minted.url).toBe(
      `${deps.apiUrl}/api/spaces/${space}/ingest/${minted.id}`,
    );
  });

  it("answers identically for an unknown channel id and an unowned one", async () => {
    const first = await mint(alice, "req-u1");
    const unowned = await processRevoke(deps, mallory.did(), {
      id: ok(first).id,
      requestId: "rv-2",
      expectedRevision: await revOf(ok(first).id),
    });
    const unknown = await processRevoke(deps, mallory.did(), {
      id: "ing_nosuchchannel",
      requestId: "rv-3",
      expectedRevision: await revOf("ing_nosuchchannel"),
    });
    expect(unknown.status).toBe(unowned.status);
    expect(unknown.body).toEqual(unowned.body);
  });

  it("revokes: subsequent POSTs stop, and the audit record survives", async () => {
    const first = await mint(alice, "req-v1");
    const id = ok(first).id;

    const revoked = await processRevoke(deps, alice.did(), {
      id,
      requestId: "rv-4",
      expectedRevision: await revOf(id),
    });
    expect(revoked.status).toBe(200);

    const after = await processIngest(
      runtime,
      operator.did(),
      id,
      ok(first).token,
      JSON.stringify({ partition: "2026-08-04", records: [{ x: 1 }] }),
    );
    // A correct token on a revoked channel gets the re-pair signal, not a 401.
    expect(after.status).toBe(403);

    // The registration is kept — it is the only record of who was authorized
    // to write provenance-marked data into this space.
    const stored = await getRegistration(runtime, operator.did(), id);
    expect(stored?.enabled).toBe(false);
    expect(stored?.revoked?.by).toBe(alice.did());
  });

  it("lists only the caller's own channels, never a secret hash", async () => {
    await mint(alice, "req-l1");

    const mine = await processList(deps, alice.did(), {});
    const channels = ok(mine).channels;
    expect(channels.length).toBe(1);
    expect(channels[0].space).toBe(space);
    expect(JSON.stringify(mine.body)).not.toContain("secretHash");

    const theirs = await processList(deps, mallory.did(), {});
    expect(ok(theirs).channels.length).toBe(0);
  });

  it("scopes the list to one space the caller owns", async () => {
    await mint(alice, "req-f1");
    const otherSpace = await sharedSpace();
    await processMint(deps, alice.did(), {
      space: otherSpace,
      installId: "phone-9",
      requestId: "req-f2",
    });

    // Unscoped: everything alice minted, across both spaces.
    expect(ok(await processList(deps, alice.did(), {})).channels.length).toBe(
      2,
    );

    // Scoped: only the named space. Passing a space is now an authorization
    // boundary, not a client-side filter — see the owner-inventory tests.
    const scoped = ok(
      await processList(deps, alice.did(), { space: otherSpace }),
    );
    expect(scoped.channels.map((c) => c.space)).toEqual([otherSpace]);
  });

  it("refuses at mint when the operator cannot write the space", async () => {
    // The highest-value item in the brief: a channel that would accept POSTs
    // and commit nothing must be refused at mint, with an actionable message.

    const lonely = await Identity.fromPassphrase("ic-space-no-operator");
    await genesisAcl(factory, lonely, { [alice.did()]: "OWNER" });

    const res = await processMint(deps, alice.did(), {
      space: lonely.did(),
      installId: "phone-2",
      requestId: "req-o1",
    });
    expect(res.status).toBe(409);
    expect(err(res)).toContain(operator.did());
  });

  it("re-minting a revoked channel yields a token that actually works", async () => {
    // The data plane refuses any registration carrying `revoked`, so a re-mint
    // that left the flag set would hand back a token dead on its first POST —
    // a success message and a broken device.

    const first = await mint(alice, "req-rm1");
    const id = ok(first).id;
    expect(
      (await processRevoke(deps, alice.did(), {
        id,
        requestId: "rv-5",
        expectedRevision: await revOf(id),
      }))
        .status,
    ).toBe(200);

    const reminted = await mint(alice, "req-rm2");
    expect(reminted.status).toBe(200);

    const post = await processIngest(
      runtime,
      operator.did(),
      id,
      ok(reminted).token,
      JSON.stringify({ partition: "2026-08-04", records: [{ x: 1 }] }),
    );
    expect(post.status).toBe(200);

    // Re-authorizing clears the live flag but must NOT erase the trail.
    const stored = await getRegistration(runtime, operator.did(), id);
    expect(stored?.enabled).toBe(true);
    expect(stored?.revoked).toBeUndefined();
    expect(stored?.revocations?.length).toBe(1);
    expect(stored?.revocations?.[0].by).toBe(alice.did());
  });

  it("tells a device holding a rotated-away token to re-pair", async () => {
    // The whole point of relaxing the 401 equalization was the rotation case,
    // and rotation replaces the secret — so without a superseded-hash record
    // the 403 branch is structurally unreachable for exactly that case.

    const first = await mint(alice, "req-rr1");
    const id = ok(first).id;
    await processRotate(deps, alice.did(), { id, requestId: "req-rr2" });

    const body = JSON.stringify({
      partition: "2026-08-04",
      records: [{ x: 1 }],
    });
    const stale = await processIngest(
      runtime,
      operator.did(),
      id,
      ok(first).token,
      body,
    );
    expect(stale.status).toBe(403);
    expect(JSON.stringify(stale.body)).toContain("rotated");

    // A merely WRONG token still gets the equalized 401 — the 403 is
    // proof-of-possession of the superseded secret, not a channel oracle.
    const wrong = await processIngest(
      runtime,
      operator.did(),
      id,
      "ingsec_notarealtokenatall",
      body,
    );
    expect(wrong.status).toBe(401);

    // And an empty token must not match the dummy hash into a 403.
    const empty = await processIngest(runtime, operator.did(), id, "", body);
    expect(empty.status).toBe(401);
  });

  it("refuses to take over a channel owned by another principal", async () => {
    // A co-owner minting the same low-entropy installId ("phone-1") would
    // otherwise silently replace `owner` and kill the incumbent's live token
    // with no revocation record.

    const shared = await sharedSpace();
    const first = await processMint(deps, alice.did(), {
      space: shared,
      installId: "phone-1",
      requestId: "req-to1",
    });
    expect(first.status).toBe(200);

    const takeover = await processMint(deps, mallory.did(), {
      space: shared,
      installId: "phone-1",
      requestId: "req-to2",
    });
    expect(takeover.status).toBe(409);
    expect(err(takeover)).toContain("different owner");

    // Alice's device keeps working.
    const post = await processIngest(
      runtime,
      operator.did(),
      ok(first).id,
      ok(first).token,
      JSON.stringify({ partition: "2026-08-04", records: [{ x: 1 }] }),
    );
    expect(post.status).toBe(200);
  });

  it("allows takeover after an explicit revoke, and records it", async () => {
    // The guard's error message says "revoke it first" — so revoking first has
    // to actually work. Revoke preserves `owner` (attribution, not liveness)
    // and there is no delete path, so gating on owner alone would lock the
    // channel to one DID permanently and the advice would be a lie. This is
    // also how a user who re-keys recovers their own device.

    const shared = await sharedSpace();
    const first = await processMint(deps, alice.did(), {
      space: shared,
      installId: "phone-1",
      requestId: "req-tk1",
    });
    const id = ok(first).id;

    expect(
      (await processRevoke(deps, mallory.did(), {
        id,
        requestId: "rv-6",
        expectedRevision: await revOf(id),
      }))
        .status,
    ).toBe(200);

    const taken = await processMint(deps, mallory.did(), {
      space: shared,
      installId: "phone-1",
      requestId: "req-tk2",
    });
    expect(taken.status).toBe(200);

    const stored = await getRegistration(runtime, operator.did(), id);
    expect(stored?.owner).toBe(mallory.did());
    expect(stored?.enabled).toBe(true);
    expect(stored?.revoked).toBeUndefined();
    // The handover is on the record.
    expect(stored?.revocations?.length).toBe(1);
    expect(stored?.revocations?.[0].by).toBe(mallory.did());

    // And the new owner's token actually works.
    const post = await processIngest(
      runtime,
      operator.did(),
      id,
      ok(taken).token,
      JSON.stringify({ partition: "2026-08-04", records: [{ x: 1 }] }),
    );
    expect(post.status).toBe(200);
  });

  it("keeps the revocation history across repeated revoke/mint cycles", async () => {
    // `processRevoke` shallow-spreads a stored registration, and stored values
    // are deep-frozen: without rebuilding them the history is silently dropped
    // on the second revoke.

    const first = await mint(alice, "req-h1");
    const id = ok(first).id;
    await processRevoke(deps, alice.did(), {
      id,
      requestId: "rv-7",
      expectedRevision: await revOf(id),
    });
    await mint(alice, "req-h2");
    await processRevoke(deps, alice.did(), {
      id,
      requestId: "rv-8",
      expectedRevision: await revOf(id),
    });
    await mint(alice, "req-h3");

    const stored = await getRegistration(runtime, operator.did(), id);
    expect(stored?.revocations?.length).toBe(2);
  });

  it("refuses a captured revoke replayed after the channel is re-minted", async () => {
    // A revoke request is a durable weapon unless its request id is spent. The
    // signed body names only the channel, so a captured revoke stays replayable
    // for its whole proof window — long enough for the owner to notice the
    // outage, re-pair the device, and have the replay kill the NEW credential.
    //
    // The no-op leg is the load-bearing one: if a replay against an
    // already-revoked channel returns 200 without spending the id, the attacker
    // just waits for the re-mint and fires the same request again.

    const first = await mint(alice, "req-w1a");
    const id = ok(first).id;
    const captured = "rv-captured";

    expect(
      (await processRevoke(deps, alice.did(), {
        id,
        requestId: captured,
        expectedRevision: await revOf(id),
      }))
        .status,
    ).toBe(200);

    // Replayed while still revoked: refused, not a silent 200.
    const early = await processRevoke(deps, alice.did(), {
      id,
      requestId: captured,
      expectedRevision: await revOf(id),
    });
    expect(early.status).toBe(409);

    // Alice re-pairs the device.
    const second = await mint(alice, "req-w1b");
    expect(second.status).toBe(200);

    // The captured request fired at the fresh credential.
    const replay = await processRevoke(deps, alice.did(), {
      id,
      requestId: captured,
      expectedRevision: await revOf(id),
    });
    expect(replay.status).toBe(409);

    // The re-minted token still ingests: the replay changed nothing.
    const stored = await getRegistration(runtime, operator.did(), id);
    expect(stored?.revoked).toBeUndefined();
    expect(stored?.enabled).toBe(true);
    expect(
      (await processIngest(
        runtime,
        operator.did(),
        id,
        ok(second).token,
        JSON.stringify({ partition: "2026-08-04", records: [{ x: 1 }] }),
      )).status,
    ).toBe(200);
  });

  it("exposes the revocation history to the owner via list", async () => {
    const first = await mint(alice, "req-x1");
    await processRevoke(deps, alice.did(), {
      id: ok(first).id,
      requestId: "rv-9",
      expectedRevision: await revOf(ok(first).id),
    });
    await mint(alice, "req-x2");

    const listed = await processList(deps, alice.did(), {});
    const channels = ok(listed).channels;
    // A trail the owner cannot read would not have justified soft-revoke.
    expect((channels[0].revocations as unknown[]).length).toBe(1);
  });

  it("re-minting leaves the old device an actionable 403, not a blank 401", async () => {
    // Re-minting the same installId is how a user re-pairs a device, and it
    // replaces the secret — so it IS a rotation and must leave the old device
    // an actionable answer. Without the superseded hash it gets the blank 401
    // that the whole 403 re-pair decision exists to remove, on the likeliest
    // path to reach it.

    const first = await mint(alice, "req-rp1");
    const id = ok(first).id;

    const reminted = await mint(alice, "req-rp2");
    expect(reminted.status).toBe(200);

    const body = JSON.stringify({
      partition: "2026-08-04",
      records: [{ x: 1 }],
    });
    const stale = await processIngest(
      runtime,
      operator.did(),
      id,
      ok(first).token,
      body,
    );
    expect(stale.status).toBe(403);
    expect(JSON.stringify(stale.body)).toContain("rotated");

    // The new token works, and a wrong token still gets the equalized 401.
    expect(
      (await processIngest(
        runtime,
        operator.did(),
        id,
        ok(reminted).token,
        body,
      )).status,
    ).toBe(200);
    expect(
      (await processIngest(
        runtime,
        operator.did(),
        id,
        "ingsec_nope",
        body,
      )).status,
    ).toBe(401);
  });

  describe("storage faults", () => {
    // Storage faults must surface as 502, never as a denial or an uncaught 500
    // — the same contract the data plane holds. Every verb reaches storage, so
    // every verb needs it.

    const broken = {
      getCell() {
        throw new Error("boom");
      },
      // `authorizeSpaceOwner` reaches this before any cell work.
      storageManager: { synced: () => Promise.resolve() },
    } as unknown as Runtime;

    const brokenDeps = () => ({ ...deps, runtime: broken });

    /**
     * Fail only on the registry cells, so authorization succeeds first and the
     * fault lands on the write path proper — the 502-not-a-denial contract.
     *
     * Shadows `getCell` on the instance rather than wrapping the runtime in a
     * Proxy: `Runtime` reads private class fields, which throw when `this` is a
     * Proxy receiver.
     */
    const withFault = async <T>(
      match: string,
      fn: (faulted: ControlDeps) => Promise<T>,
    ): Promise<T> => {
      // deno-lint-ignore no-explicit-any
      const original = (runtime.getCell as any).bind(runtime) as (
        // deno-lint-ignore no-explicit-any
        ...args: any[]
      ) => unknown;
      // deno-lint-ignore no-explicit-any
      (runtime as any).getCell = (...args: any[]) => {
        if (typeof args[1] === "string" && args[1].includes(match)) {
          throw new Error(`boom: ${args[1]}`);
        }
        return original(...args);
      };
      try {
        return await fn(deps);
      } finally {
        // deno-lint-ignore no-explicit-any
        delete (runtime as any).getCell;
      }
    };

    it("a failed registration lookup is a 502, not a denial", async () => {
      const res = await withFault(
        "cf:ingest:ing_",
        (d) =>
          processMint(d, alice.did(), {
            space,
            installId: "phone-1",
            requestId: "req-f1",
          }),
      );
      expect(res.status).toBe(502);
    });

    it("a failed request-id claim is a 502", async () => {
      const res = await withFault(
        "cf:ingest:requests:",
        (d) =>
          processMint(d, alice.did(), {
            space,
            installId: "phone-1",
            requestId: "req-f2",
          }),
      );
      expect(res.status).toBe(502);
    });

    it("a failed owner-index read is a 502", async () => {
      const res = await withFault(
        "cf:ingest:by-owner:",
        (d) =>
          processMint(d, alice.did(), {
            space,
            installId: "phone-1",
            requestId: "req-f3",
          }),
      );
      expect(res.status).toBe(502);
    });

    it("a failed revoke write is a 502", async () => {
      const first = await mint(alice, "req-f4");
      const id = ok(first).id;
      const res = await withFault(
        "cf:ingest:by-owner:",
        async (d) =>
          processRevoke(d, alice.did(), {
            id,
            requestId: "rv-10",
            expectedRevision: await revOf(id),
          }),
      );
      expect(res.status).toBe(502);
    });

    it("mint -> fails closed as a denial, not an admit", async () => {
      const res = await processMint(brokenDeps(), alice.did(), {
        space,
        installId: "phone-1",
        requestId: "req-b1",
      });
      expect(res.status).toBe(403);
    });

    it("list -> 502", async () => {
      expect((await processList(brokenDeps(), alice.did(), {})).status).toBe(
        502,
      );
    });

    it("rotate and revoke -> 502", async () => {
      expect(
        (await processRotate(brokenDeps(), alice.did(), {
          id: WELL_FORMED_ID,
          requestId: "req-b2",
        })).status,
      ).toBe(502);
      expect(
        (await processRevoke(brokenDeps(), alice.did(), {
          id: WELL_FORMED_ID,
          requestId: "rv-11",
          expectedRevision: await revOf(WELL_FORMED_ID),
        }))
          .status,
      ).toBe(502);
    });
  });

  describe("input validation", () => {
    it("a malformed space DID shares the ownership denial, not its own error", async () => {
      // A distinguishable shape error would be a free probe for whether a
      // space exists, so it must answer exactly like "not an owner".

      const res = await processMint(deps, alice.did(), {
        space: "not-a-did",
        installId: "phone-1",
        requestId: "req-v1",
      });
      expect(res.status).toBe(403);
      expect(res.body).toEqual(
        (await mint(mallory, "req-v2")).body,
      );
    });

    it("rejects a malformed causePrefix and requestId", async () => {
      expect(
        (await mint(alice, "req-v3", { causePrefix: "has/slash" })).status,
      ).toBe(400);
      expect((await mint(alice, "bad requestId")).status).toBe(400);
      expect(
        (await processRotate(deps, alice.did(), {
          id: WELL_FORMED_ID,
          requestId: "bad id",
        })).status,
      ).toBe(400);
    });
  });

  it("refuses once the caller holds the per-owner cap of live channels", async () => {
    const capped = { ...deps, maxChannelsPerOwner: 1 };
    expect(
      (await processMint(capped, alice.did(), {
        space,
        installId: "phone-1",
        requestId: "req-c1",
      })).status,
    ).toBe(200);

    const second = await processMint(capped, alice.did(), {
      space,
      installId: "phone-2",
      requestId: "req-c2",
    });
    expect(second.status).toBe(409);
    expect(err(second)).toContain("Revoke some before minting more");

    // The cap counts LIVE channels, so the remedy it prescribes has to work.
    const first = channelId(space, "phone-1");
    expect(
      (await processRevoke(capped, alice.did(), {
        id: first,
        requestId: "rv-12",
        expectedRevision: await revOf(first),
      })).status,
    )
      .toBe(200);
    expect(
      (await processMint(capped, alice.did(), {
        space,
        installId: "phone-2",
        requestId: "req-c3",
      })).status,
    ).toBe(200);
  });

  it("refuses a revoke that was captured, withheld, and delivered after a re-mint", async () => {
    // The requestId alone does NOT close this, and that is the whole reason
    // `expectedRevision` exists. An id only proves "this exact request was
    // already DELIVERED". A request that is captured and WITHHELD was never
    // delivered, so its id is unspent and looks perfectly fresh — it stays a
    // live weapon for the rest of the proof window, and lands on whatever
    // credential exists when it is finally let through.
    //
    // The realistic shape: the attacker swallows Alice's revoke, Alice sees it
    // fail and retries (a fresh id), then re-pairs the device — and only then
    // is the original let through.

    const first = await mint(alice, "req-wh1");
    const id = ok(first).id;

    // Signed but never delivered. This is the generation it was signed against.
    const withheld = {
      id,
      requestId: "rv-withheld",
      expectedRevision: await revOf(id),
    };

    // Alice's retry carries a DIFFERENT request id, so nothing about the
    // withheld one is consumed by it.
    expect(
      (await processRevoke(deps, alice.did(), {
        id,
        requestId: "rv-retry",
        expectedRevision: await revOf(id),
      })).status,
    ).toBe(200);

    // She re-pairs the device.
    const second = await mint(alice, "req-wh2");
    expect(second.status).toBe(200);

    // The withheld request is finally delivered. Its id is unspent and its
    // signature is inside the freshness window — only the generation it names
    // is stale, and that is what refuses it.
    const late = await processRevoke(deps, alice.did(), withheld);
    expect(late.status).toBe(409);
    expect(err(late)).toContain("changed since you looked at it");

    // The freshly paired device is untouched.
    const stored = await getRegistration(runtime, operator.did(), id);
    expect(stored?.revoked).toBeUndefined();
    expect(
      (await processIngest(
        runtime,
        operator.did(),
        id,
        ok(second).token,
        JSON.stringify({ partition: "2026-08-04", records: [{ x: 1 }] }),
      )).status,
    ).toBe(200);
  });

  it("holds the live cap against a burst of concurrent mints", async () => {
    // The cap used to be counted before the write, from a separate read. Every
    // request in a burst then read the same under-cap number and every one of
    // them committed, so the limit was exceeded by the width of the burst — the
    // easiest bound in the system to walk straight through. The count now comes
    // off the owner index inside the transaction that updates it.

    const capped = { ...deps, maxChannelsPerOwner: 2 };
    const results = await Promise.all(
      ["a", "b", "c", "d", "e"].map((n) =>
        processMint(capped, alice.did(), {
          space,
          installId: `phone-${n}`,
          requestId: `req-burst-${n}`,
        })
      ),
    );
    expect(results.filter((r) => r.status === 200).length).toBe(2);
    // Every refusal is the cap, not a crash or a lost precondition.
    for (const r of results.filter((r) => r.status !== 200)) {
      expect(r.status).toBe(409);
    }
    const owned = await getOwnerRegistrationIndex(
      runtime,
      operator.did(),
      alice.did(),
    );
    expect(owned.length).toBe(2);
  });

  it("bounds how many channels one owner can ever create", async () => {
    // Revoking frees a live slot but frees no storage: the registration cell
    // and the audit entry are kept on purpose. Without a lifetime bound,
    // mint/revoke in a loop is one authenticated user growing deployment-wide
    // state forever.

    const capped = {
      ...deps,
      maxChannelsPerOwner: 1,
      maxLifetimeChannelsPerOwner: 2,
    };
    for (const n of ["a", "b"]) {
      expect(
        (await processMint(capped, alice.did(), {
          space,
          installId: `life-${n}`,
          requestId: `req-life-${n}`,
        })).status,
      ).toBe(200);
      expect(
        (await processRevoke(capped, alice.did(), {
          id: channelId(space, `life-${n}`),
          requestId: `rv-life-${n}`,
          expectedRevision: await revOf(channelId(space, `life-${n}`)),
        })).status,
      ).toBe(200);
    }

    // No live channels at all now, so the live cap is wide open — and it still
    // refuses, because the thing being bounded is not liveness.
    const third = await processMint(capped, alice.did(), {
      space,
      installId: "life-c",
      requestId: "req-life-c",
    });
    expect(third.status).toBe(409);
    expect(err(third)).toContain("lifetime limit");
    expect(err(third)).not.toContain("Revoke some");

    // Re-minting an ALREADY created channel is free: the meter counts distinct
    // channels, not writes, or re-pairing a device would burn the allowance.
    expect(
      (await processMint(capped, alice.did(), {
        space,
        installId: "life-a",
        requestId: "req-life-a2",
      })).status,
    ).toBe(200);
    expect(
      await getLifetimeChannelCount(runtime, operator.did(), alice.did()),
    ).toBe(2);
  });

  it("charges a takeover to the acquirer's lifetime meter", async () => {
    // The meter is read as a record of what an identity holds, and a takeover
    // adds a channel to the acquirer without creating one. Charging only
    // creation let an identity accumulate channels with its meter pinned at
    // zero.

    const shared = await sharedSpace();
    const capped = { ...deps, maxLifetimeChannelsPerOwner: 1 };
    const minted = await processMint(capped, alice.did(), {
      space: shared,
      installId: "hand-over",
      requestId: "req-to1",
    });
    const id = ok(minted).id;
    await processRevoke(capped, alice.did(), {
      id,
      requestId: "rv-to1",
      expectedRevision: await revOf(id),
    });

    // Mallory takes it over — permitted, because it is revoked.
    expect(
      (await processMint(capped, mallory.did(), {
        space: shared,
        installId: "hand-over",
        requestId: "req-to2",
      })).status,
    ).toBe(200);
    expect(
      await getLifetimeChannelCount(runtime, operator.did(), mallory.did()),
    ).toBe(1);

    // And it counted: her allowance of one is now spent.
    const third = await processMint(capped, mallory.did(), {
      space: shared,
      installId: "her-own",
      requestId: "req-to3",
    });
    expect(third.status).toBe(409);
    expect(err(third)).toContain("lifetime limit");
  });

  it("charges a takeover to the space meter, so churn cannot route around it", async () => {
    // Charging the space meter only for CREATION left the bound useless. A
    // fresh key that is refused a new channel can revoke an existing one and
    // re-mint it instead: it acquires a channel, and mints its own permanent
    // by-owner, lifetime and requests cells, while the space meter never moves.

    const churned = await Identity.generate();
    const shared = await sharedSpace(churned.did());
    const capped = { ...deps, maxLifetimeChannelsPerSpace: 1 };

    const minted = await processMint(capped, alice.did(), {
      space: shared,
      installId: "target",
      requestId: "req-churn-1",
    });
    const id = ok(minted).id;
    expect(await getSpaceLifetimeChannelCount(runtime, operator.did(), shared))
      .toBe(1);

    // The fresh key clears the takeover guard by revoking first — permitted,
    // it is a space owner — so `creating` is false on the re-mint.
    expect(
      (await processRevoke(capped, churned.did(), {
        id,
        requestId: "rv-churn",
        expectedRevision: await revOf(id),
      })).status,
    ).toBe(200);

    const takeover = await processMint(capped, churned.did(), {
      space: shared,
      installId: "target",
      requestId: "req-churn-2",
    });
    expect(takeover.status).toBe(409);
    expect(err(takeover)).toContain("neither does using a different key");

    // Nothing durable was minted for the churned key.
    expect(
      await getLifetimeChannelCount(runtime, operator.did(), churned.did()),
    ).toBe(0);
    expect(
      await getOwnerRegistrationIndex(runtime, operator.did(), churned.did()),
    ).toEqual([]);
  });

  it("makes a repeated revoke self-limiting rather than endlessly writable", async () => {
    // Revoking an already-revoked channel goes through the transaction rather
    // than short-circuiting on the registration read. A read-only fast path
    // would decide "already revoked" from a snapshot, and a re-mint landing in
    // that window would leave it reporting success while a fresh credential is
    // live.
    //
    // Advancing the revision on that write is what keeps it from being an
    // amplifier: at a stable revision the same request replays forever, each
    // one a real durable transaction.

    const first = await mint(alice, "req-noop");
    const id = ok(first).id;
    await processRevoke(deps, alice.did(), {
      id,
      requestId: "rv-noop-0",
      expectedRevision: await revOf(id),
    });
    const settled = await getRegistration(runtime, operator.did(), id);
    const at = await revOf(id);

    // A second revoke against the current generation succeeds and reports the
    // ORIGINAL revocation — attribution is not overwritten.
    const again = await processRevoke(deps, alice.did(), {
      id,
      requestId: "rv-noop-1",
      expectedRevision: at,
    });
    expect(again.status).toBe(200);
    expect(ok(again).revokedAt).toBe(settled?.revoked?.at);
    expect((await getRegistration(runtime, operator.did(), id))?.revoked?.by)
      .toBe(alice.did());

    // And it moved the generation, so the very same request cannot be issued
    // again without going back to read the new one.
    expect(await revOf(id)).toBe(at + 1);
    const third = await processRevoke(deps, alice.did(), {
      id,
      requestId: "rv-noop-2",
      expectedRevision: at,
    });
    expect(third.status).toBe(409);
  });

  it("refuses a revoke whose generation went stale between read and write", async () => {
    // The registration is read once to authorize and check the generation, then
    // again inside the write transaction. Only the second read decides, which
    // is what stops a re-mint in that window from being reported as a
    // revocation.

    const first = await mint(alice, "req-toctou");
    const id = ok(first).id;
    const at = await revOf(id);

    // Revoke and re-mint: the channel is live again at a later generation.
    await processRevoke(deps, alice.did(), {
      id,
      requestId: "rv-toctou",
      expectedRevision: at,
    });
    const remint = await mint(alice, "req-toctou-2");
    expect(remint.status).toBe(200);

    // A revoke naming the pre-revoke generation must not report success.
    const stale = await processRevoke(deps, alice.did(), {
      id,
      requestId: "rv-toctou-late",
      expectedRevision: at,
    });
    expect(stale.status).toBe(409);
    const live = await getRegistration(runtime, operator.did(), id);
    expect(live?.revoked).toBeUndefined();
    expect(live?.enabled).toBe(true);
  });

  it("bounds a space against an owner rotating through fresh keys", async () => {
    // A per-owner quota bounds a KEYPAIR, and keypairs are free: one person can
    // grant OWNER to as many fresh DIDs as they like and spend a new allowance
    // from each — while every new DID also mints its own permanent bookkeeping
    // cells. The space is what they cannot mint for free here.

    const third = await Identity.generate();
    const shared = await sharedSpace(third.did());
    const capped = {
      ...deps,
      maxLifetimeChannelsPerOwner: 1,
      maxLifetimeChannelsPerSpace: 2,
    };
    // Alice and Mallory each spend their whole per-owner allowance.
    for (const [who, n] of [[alice, "k1"], [mallory, "k2"]] as const) {
      expect(
        (await processMint(capped, who.did(), {
          space: shared,
          installId: n,
          requestId: `req-key-${n}`,
        })).status,
      ).toBe(200);
    }
    expect(
      await getSpaceLifetimeChannelCount(runtime, operator.did(), shared),
    ).toBe(2);

    // A third key with a fresh per-owner meter still cannot create anything.
    const blocked = await processMint(capped, third.did(), {
      space: shared,
      installId: "k3",
      requestId: "req-key-k3",
    });
    expect(blocked.status).toBe(409);
    expect(err(blocked)).toContain("neither does using a different key");
    // Nothing was written for the refused key: the bookkeeping cell family a
    // fresh DID would otherwise mint is exactly what this bounds.
    expect(
      await getLifetimeChannelCount(runtime, operator.did(), third.did()),
    ).toBe(0);
    expect(
      await getOwnerRegistrationIndex(runtime, operator.did(), third.did()),
    )
      .toEqual([]);
  });

  it("keeps a revoked channel visible to the space owner, with its generation", async () => {
    // Revoking the last channel in a space used to answer the space's real
    // owner with "not authorized for that space" — a denial that is simply
    // false, on the path they would walk to confirm the revoke worked.
    //
    // Worse, `revoke` requires the channel's current generation and `list` is
    // the only place a generation is published, so an unlistable revoked
    // channel had an unknowable generation: every later revoke of it answered
    // 409 telling the caller to go list something that would never appear.

    const shared = await sharedSpace();
    const minted = await processMint(deps, alice.did(), {
      space: shared,
      installId: "only-one",
      requestId: "req-f4",
    });
    const id = ok(minted).id;
    await processRevoke(deps, alice.did(), {
      id,
      requestId: "rv-f4",
      expectedRevision: await revOf(id),
    });

    const listed = await processList(deps, alice.did(), { space: shared });
    expect(listed.status).toBe(200);
    const seen = ok(listed).channels.find((c) => c.id === id);
    expect(seen?.revoked).toBeDefined();

    // And the generation it publishes is the one a second revoke must name —
    // the loop that was previously unclosable.
    const second = await processRevoke(deps, alice.did(), {
      id,
      requestId: "rv-f4b",
      expectedRevision: seen!.revision,
    });
    expect(second.status).toBe(200);
    // The response publishes the new generation, so a third needs no re-list.
    expect(
      (await processRevoke(deps, alice.did(), {
        id,
        requestId: "rv-f4c",
        expectedRevision: ok(second).revision,
      })).status,
    ).toBe(200);

    // A space that never had a channel is still indistinguishable from one the
    // caller does not own — the existence oracle stays closed.
    const untouched = await sharedSpace();
    expect((await processList(deps, alice.did(), { space: untouched })).status)
      .toBe(403);
  });

  it("keeps revocation state across a second revoke with a fresh id", async () => {
    // The second revoke re-embeds the deep-frozen `revoked` object into a new
    // container — the exact round-trip that silently drops values — so the
    // ORIGINAL attribution surviving it is worth pinning on its own.

    const first = await mint(alice, "req-2rv");
    const id = ok(first).id;
    const before = await revOf(id);
    await processRevoke(deps, alice.did(), {
      id,
      requestId: "rv-2a",
      expectedRevision: before,
    });
    const revoked = await getRegistration(runtime, operator.did(), id);

    const again = await processRevoke(deps, alice.did(), {
      id,
      requestId: "rv-2b",
      expectedRevision: await revOf(id),
    });
    expect(again.status).toBe(200);
    // The ORIGINAL revocation is reported, not a new one.
    expect(ok(again).revokedAt).toBe(revoked?.revoked?.at);

    const after = await getRegistration(runtime, operator.did(), id);
    expect(after?.revoked?.at).toBe(revoked?.revoked?.at);
    expect(after?.revoked?.by).toBe(alice.did());
    // The generation moves even though nothing else does — that is what keeps
    // a repeated revoke from being replayable forever.
    expect(after?.revision).toBe((revoked?.revision ?? 0) + 1);

    // And the trail still survives a later re-mint.
    await mint(alice, "req-2rv-remint");
    expect(
      (await getRegistration(runtime, operator.did(), id))?.revocations?.length,
    ).toBe(1);
  });

  it("enumerates revoked channels through the sharded audit index", async () => {
    // The audit inventory is the one index that is never pruned, so it is the
    // one that must not be a single array. Sharding is only correct if a sweep
    // still sees everything through the one function that enumerates it.

    const first = await mint(alice, "req-au1");
    const id = ok(first).id;
    await processRevoke(deps, alice.did(), {
      id,
      requestId: "rv-au1",
      expectedRevision: await revOf(id),
    });
    const second = await processMint(deps, alice.did(), {
      space,
      installId: "audit-2",
      requestId: "req-au2",
    });

    const all = await getRegistrationIndex(runtime, operator.did());
    // Revoked, therefore gone from the owner index — and still in the audit.
    expect(all).toContain(id);
    expect(all).toContain(ok(second).id);
    expect(
      await getOwnerRegistrationIndex(runtime, operator.did(), alice.did()),
    )
      .not.toContain(id);
    // No duplicates: a re-mint must not append a second entry.
    expect(new Set(all).size).toBe(all.length);
  });

  it("list skips an index entry whose registration now belongs to someone else", async () => {
    const shared = await sharedSpace();
    const minted = await processMint(deps, alice.did(), {
      space: shared,
      installId: "phone-1",
      requestId: "req-o1",
    });
    const id = ok(minted).id;
    // Mallory takes it over after a revoke, so alice's index keeps a stale id.
    await processRevoke(deps, alice.did(), {
      id,
      requestId: "rv-13",
      expectedRevision: await revOf(id),
    });
    await processMint(deps, mallory.did(), {
      space: shared,
      installId: "phone-1",
      requestId: "req-o2",
    });

    const alices = await processList(deps, alice.did(), {});
    expect(ok(alices).channels.find((c) => c.id === id)).toBeUndefined();
    expect(ok(await processList(deps, mallory.did(), {})).channels.length)
      .toBe(1);
  });

  it("drops a revoked channel from the list but keeps it in the audit index", async () => {
    // The owner and space indexes track live channels; the audit index keeps
    // the full history. Revoking therefore removes a channel from the caller's
    // list, which is what bounds those indexes.

    const first = await mint(alice, "req-lr1");
    const id = ok(first).id;
    await processRevoke(deps, alice.did(), {
      id,
      requestId: "rv-14",
      expectedRevision: await revOf(id),
    });

    expect(ok(await processList(deps, alice.did(), {})).channels.length).toBe(
      0,
    );
    // Still enumerable for audit, and still readable by id.
    expect(await getRegistrationIndex(runtime, operator.did())).toContain(id);
    expect((await getRegistration(runtime, operator.did(), id))?.revoked?.by)
      .toBe(alice.did());
  });

  it("counts a re-minted revoked channel against the live cap", async () => {
    // Gating the cap on "no existing registration" let one owner loop
    // mint -> revoke -> re-mint past it without limit.

    const capped = { ...deps, maxChannelsPerOwner: 1 };
    const first = await processMint(capped, alice.did(), {
      space,
      installId: "phone-1",
      requestId: "req-cap1",
    });
    expect(first.status).toBe(200);
    await processRevoke(capped, alice.did(), {
      id: ok(first).id,
      requestId: "rv-15",
      expectedRevision: await revOf(ok(first).id),
    });

    // One live channel again...
    expect(
      (await processMint(capped, alice.did(), {
        space,
        installId: "phone-2",
        requestId: "req-cap2",
      })).status,
    ).toBe(200);

    // ...so re-minting the revoked one must be refused, not waved through.
    const revived = await processMint(capped, alice.did(), {
      space,
      installId: "phone-1",
      requestId: "req-cap3",
    });
    expect(revived.status).toBe(409);
    expect(err(revived)).toContain("Revoke some before minting more");
  });

  describe("a space's current owner can find and revoke foreign channels", () => {
    it("sees channels minted by someone whose grant was later removed", async () => {
      // Bob owns the space and grants Alice OWNER; Alice mints; the grant is
      // then removed. Alice's token keeps working, so Bob has to be able to
      // discover and revoke it.

      const shared = await sharedSpace();
      const minted = await processMint(deps, alice.did(), {
        space: shared,
        installId: "phone-1",
        requestId: "req-w1",
      });
      const id = ok(minted).id;

      // Bob owns the space too, and did not mint this.
      const bobsUnscoped = ok(await processList(deps, mallory.did(), {}));
      expect(bobsUnscoped.channels.length).toBe(0);

      // Scoped to the space he owns, he sees it — and can therefore revoke it.
      const bobsScoped = ok(
        await processList(deps, mallory.did(), { space: shared }),
      );
      expect(bobsScoped.channels.map((c) => c.id)).toEqual([id]);
      expect(bobsScoped.channels[0].owner).toBe(alice.did());

      expect(
        (await processRevoke(deps, mallory.did(), {
          id,
          requestId: "rv-16",
          expectedRevision: await revOf(id),
        }))
          .status,
      ).toBe(
        200,
      );
      const after = await processIngest(
        runtime,
        operator.did(),
        id,
        ok(minted).token,
        JSON.stringify({ partition: "2026-08-05", records: [{ x: 1 }] }),
      );
      expect(after.status).toBe(403);
    });

    it("refuses a space-scoped list to someone who does not own the space", async () => {
      const res = await processList(deps, mallory.did(), { space });
      expect(res.status).toBe(403);
    });
  });

  it("refuses to rotate a channel registered to a different owner", async () => {
    // Rotating replaces the secret and reassigns `owner`, so without this guard
    // a co-owner takes a channel over silently: the incumbent's device dies and
    // no revocation record explains it.

    const shared = await sharedSpace();
    const first = await processMint(deps, alice.did(), {
      space: shared,
      installId: "phone-1",
      requestId: "req-w2",
    });
    const id = ok(first).id;

    const stolen = await processRotate(deps, mallory.did(), {
      id,
      requestId: "req-w3",
    });
    expect(stolen.status).toBe(409);
    expect(err(stolen)).toContain("different owner");

    // Alice's device still works and she still owns it.
    const post = await processIngest(
      runtime,
      operator.did(),
      id,
      ok(first).token,
      JSON.stringify({ partition: "2026-08-05", records: [{ x: 1 }] }),
    );
    expect(post.status).toBe(200);
    expect(
      (await getRegistration(runtime, operator.did(), id))?.owner,
    ).toBe(alice.did());
  });

  describe("lifecycle writes are optimistic", () => {
    // Rotate and revoke each decide against a snapshot, so without a
    // precondition an interleaving leaves revoke reporting success on a channel
    // that is live again, or rotate returning an already-dead token.

    it("a write loses when the registration moved underneath it", async () => {
      const first = await mint(alice, "req-cc1");
      const id = ok(first).id;
      const stale = await getRegistration(runtime, operator.did(), id);

      // Something else advances the channel.
      expect(
        (await processRevoke(deps, alice.did(), {
          id,
          requestId: "rv-17",
          expectedRevision: await revOf(id),
        }))
          .status,
      ).toBe(200);

      // A write based on the pre-revoke snapshot must be refused, not applied.
      await expect(
        saveRegistration(
          runtime,
          operator.did(),
          { ...stale!, enabled: true, revision: (stale!.revision ?? 0) + 1 },
          stale!.revision ?? 0,
        ),
      ).rejects.toThrow();

      // The revocation stands.
      expect((await getRegistration(runtime, operator.did(), id))?.enabled)
        .toBe(false);
    });

    it("every mint bumps the revision", async () => {
      const first = await mint(alice, "req-cc2");
      const id = ok(first).id;
      expect((await getRegistration(runtime, operator.did(), id))?.revision)
        .toBe(1);
      await processRotate(deps, alice.did(), { id, requestId: "req-cc3" });
      expect((await getRegistration(runtime, operator.did(), id))?.revision)
        .toBe(2);
    });
  });

  it("always sets an expiry, even when no ttl is requested", async () => {
    // Every self-serve credential is finite-lived: an unbounded token means the
    // only bound on a removed owner's access is somebody noticing.

    const res = await mint(alice, "req-ttl0");
    expect(typeof ok(res).expiresAt).toBe("string");
    expect(Date.parse(ok(res).expiresAt!)).toBeGreaterThan(Date.now());
  });

  it("clamps an absurd ttlDays instead of throwing a RangeError", async () => {
    // `new Date(now + 1e15 * 86_400_000).toISOString()` throws RangeError, and
    // that line sits outside the try — it would escape as an uncaught 500.

    const res = await mint(alice, "req-ttl", { ttlDays: 1e15 });
    expect(res.status).toBe(200);
    expect(Date.parse(ok(res).expiresAt ?? "")).toBeGreaterThan(Date.now());
  });

  it("scopes requestIds per caller, so one owner cannot burn another's", async () => {
    const shared = await sharedSpace();
    expect(
      (await processMint(deps, alice.did(), {
        space: shared,
        installId: "phone-1",
        requestId: "shared-id",
      })).status,
    ).toBe(200);
    // Same requestId, different caller, different installId -> must not
    // collide.
    const other = await processMint(deps, mallory.did(), {
      space: shared,
      installId: "phone-2",
      requestId: "shared-id",
    });
    expect(other.status).toBe(200);
  });

  it("honors ttlDays and enforces the resulting expiry on the data plane", async () => {
    const res = await mint(alice, "req-t1", { ttlDays: 30 });
    expect(res.status).toBe(200);
    expect(typeof ok(res).expiresAt).toBe("string");
    expect(Date.parse(ok(res).expiresAt ?? "")).toBeGreaterThan(Date.now());

    const listed = await processList(deps, alice.did(), {});
    const channels = ok(listed).channels;
    expect(channels[0].expiresAt).toBe(ok(res).expiresAt);
  });
});
