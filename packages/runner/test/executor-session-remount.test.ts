// THE SESSION REMOUNT — the fifth face of the profile-starvation family
// (store-proven on CI run 33021643751, shards 2 and 6 of PR #6248).
//
// The boot order is activation-before-genesis: the serving plane opens a
// session on a space whose ACL does not exist yet (admitted under the
// fresh-space authenticated-READ floor), the genesis ACL `{user: OWNER}`
// lands, and `#revokeDeauthorizedSessions` (memory/v2/server.ts) de-
// authorizes that pre-genesis session BY DESIGN — the service principal
// holds no READ under the landed ACL, and there is no `"*"` grant.
//
// Nothing then re-established it. `SpaceReplica.#memoizedSessionHandle()`
// memoizes the mount and drops it only in close(), so every later
// cross-space read into that space reused the dead session and failed
// `ConnectionError: memory session revoked: unauthorized`, forever. In
// the capture that starved one trusted user click for 5m47s across 350
// deferrals: #6365's deferral arm correctly held the event pending, and
// the heal it waits for did not exist.
//
// Two docstrings disagreed and the capture settled it. `scheduler/
// facade.ts` said the failure was "healing by design on the next mount";
// `storage/rejection.ts` said "the convergence argument is sound, only
// the remount is missing". rejection.ts was right.
//
// The fix mirrors the space-root ensure's own precedent for the SAME
// boot order (executor/space-server.ts `#rootEnsureAwaitingOwner`):
// latch the owed work at the fail-closed refusal, and let an ADMITTED
// COMMIT TOUCHING THAT SPACE'S ACL DOC (`of:<space>`) re-arm it. Here
// the owed work is a fresh `session.open`, which under OW31's ruled read
// posture re-resolves the `actingAs: "space-owner"` binding against the
// ACL AS IT NOW STANDS.
//
// The pins:
//   1. the reproduction — pre-genesis session, genesis revokes it, eight
//      reads fail with zero successes, the ACL-change notice heals it and
//      the durable doc reads through;
//   2. fail-closed — the remount RE-RUNS `session.open`, it does not
//      decide it: one trigger, two outcomes, and only the ACL chooses
//      between them;
//   3. ownership change — the serving plane re-binds the NEW owner
//      (OW31), which is the outcome the revocation sweep's own comment
//      asks for, and reads as no one the memory server did not admit;
//   4. no churn — an ACL commit that terminated nothing mints no new
//      `session.open`, which is why the teardown is guarded on the
//      session's own close verdict rather than on the ACL event;
//   5. the live glue — a real ExecutorHost whose own admission observer
//      carries the genesis notice, nothing hand-fed.
//
// One correction the build made to its own brief, recorded because it
// changes what "fail closed" means here. Under OW31 a SERVING mount's
// READ decisions resolve as whoever OWNS the space, so removing the user
// from an ACL does not de-authorize the serving plane — it re-binds the
// new owner (pin 3), exactly as `#revokeDeauthorizedSessions`'s own
// comment says it should. A denial the remount must respect is
// constructible on a principal the ACL does not grant (pin 2), which is
// the general statement anyway: the remount never decides.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { LoopbackStorageManager } from "../src/executor/loopback-storage.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace, URI } from "../src/storage/interface.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import { createSignedSessionOpenAuth } from "../src/storage/v2-remote-session.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { ACLManager } from "../src/index.ts";
import { TEST_SESSION_OPEN_AUDIENCE } from "./memory-v2-test-utils.ts";
import { ArrivalLog } from "./support/serving-waits.ts";

const serviceSigner = await Identity.fromPassphrase("session remount service");
const homeSigner = await Identity.fromPassphrase("session remount home");
const homeSpace = homeSigner.did() as MemorySpace;
const strangerSigner = await Identity.fromPassphrase(
  "session remount stranger",
);
const servingSigner = await Identity.fromPassphrase("session remount serving");
const servingSpace = servingSigner.did() as MemorySpace;

/**
 * The optional IStorageManager hook the fix adds. Read through a
 * structural cast rather than the interface so this suite compiles —
 * and RUNS — against a tree without the fix: pre-fix the property is
 * undefined, `?.()` is a no-op, and the pins fail on their assertions
 * (the genuine red) instead of on a missing symbol.
 */
type AclChangeNotifier = {
  noteSpaceAclChanged?: (space: MemorySpace) => void;
};

/** Mounts `manager`'s session on `space`, before anything reads there. */
async function mountSession(
  manager: StorageManager,
  space: MemorySpace,
): Promise<void> {
  const provider = manager.open(space);
  if (provider.ensureSession === undefined) {
    throw new Error("This storage provider cannot mount a session on its own");
  }
  await provider.ensureSession();
}

/**
 * A gate on the frames a storage manager's sessions send to the memory server.
 * While it is held, each frame waits, in the order it was sent, until the gate
 * is released.
 */
class RequestGate {
  #held: PromiseWithResolvers<void> | undefined;

  #heldFrames = new ArrivalLog<string>();

  /** Each frame the gate has held, as it arrives. */
  get heldFrames(): ArrivalLog<string> {
    return this.#heldFrames;
  }

  /** Holds every frame sent from now until `release()`. */
  hold(): void {
    this.#held = Promise.withResolvers<void>();
  }

  /** Lets the held frames through, in the order they were sent. */
  release(): void {
    this.#held?.resolve();
    this.#held = undefined;
  }

  /** Resolves once `frame` may go to the server. */
  async pass(frame: string): Promise<void> {
    if (this.#held === undefined) return;
    this.#heldFrames.record(frame);
    await this.#held.promise;
  }
}

/**
 * Like `LoopbackStorageManager`, except that every frame its sessions send
 * passes through a `RequestGate`, so a test can keep a read in flight while a
 * commit on another connection lands.
 */
class GatedLoopbackManager extends StorageManager {
  /** Connects to `server` with `options`, behind `gate`. */
  static connect(
    server: MemoryV2Server.Server,
    gate: RequestGate,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): GatedLoopbackManager {
    const factory: SessionFactory = {
      supportsAclBootstrap: true,
      async create(space, signer, mountOptions = {}) {
        if (signer === undefined) {
          throw new Error("A loopback session needs a signer.");
        }
        const loopback = MemoryV2Client.loopback(server);
        const client = await MemoryV2Client.connect({
          transport: {
            ...loopback,
            send: async (payload) => {
              await gate.pass(payload);
              await loopback.send(payload);
            },
          },
        });
        const session = await client.mount(
          space,
          mountOptions,
          (_targetSpace, descriptor, context) =>
            createSignedSessionOpenAuth(signer, space, descriptor, context),
        );
        return { client, session };
      },
    };
    return new GatedLoopbackManager(
      { ...options, memoryHost: new URL("memory://loopback") },
      factory,
    );
  }
}

describe("the session remount (profile-starvation fifth face)", () => {
  let server: MemoryV2Server.Server;
  let cleanups: Array<() => Promise<void>>;
  let storeSeq = 0;
  /** Every `session.open` attempt, by issuing principal — the observable
   * for "did this remount actually mint a new session?", and the event a
   * test waits on when it has to act after one. The ACL-setting client
   * runtimes open sessions of their own on the same server, which is why
   * the counts below name a principal. */
  let sessionOpens: ArrivalLog<string>;
  /** How many the SERVING identity has minted. */
  const servingOpens = (): number =>
    sessionOpens.count((iss) => iss === serviceSigner.did());

  beforeEach(() => {
    storeSeq += 1;
    sessionOpens = new ArrivalLog<string>();
    server = new MemoryV2Server.Server({
      store: new URL(`memory://session-remount-${storeSeq}`),
      subscriptionRefreshDelayMs: 0,
      // Both shapes: the signed loopback invocation carries `iss` (the
      // production serving plane), the emulated client factory carries
      // `authorization.principal`.
      authorizeSessionOpen: (message) => {
        const iss = (message.invocation as { iss?: unknown } | undefined)?.iss;
        if (typeof iss === "string") {
          sessionOpens.record(iss);
          return iss;
        }
        const principal =
          (message.authorization as { principal?: unknown } | undefined)
            ?.principal;
        if (typeof principal === "string") sessionOpens.record(principal);
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: { audience: TEST_SESSION_OPEN_AUDIENCE },
      // The production posture this defect lives in: ACL enforced, and
      // the co-hosted process identity in the OW31 delegating class (it
      // is NOT a service DID — it holds no implicit capability).
      acl: {
        mode: "enforce",
        delegatingDids: [serviceSigner.did()],
      },
    });
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await server.close();
  });

  /** A client runtime — a real browser-shaped session for `as`. */
  const clientRuntime = (as: Identity): Runtime => {
    const manager = EmulatedStorageManager.connectTo(server, { as });
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: manager,
    });
    cleanups.push(async () => {
      await runtime.dispose();
      await manager.close();
    });
    return runtime;
  };

  /** The SERVING plane's storage manager: signed loopback sessions, the
   * service identity, and `servingHomeSpace` set — which is what makes
   * its mounts carry OW31's `actingAs: "space-owner"` binding. The home
   * space is FOREIGN to it, exactly the cross-space shape that starves
   * (ProfileCreateSurface's argument link into the viewer's home). */
  const servingManager = (): LoopbackStorageManager => {
    const manager = LoopbackStorageManager.connect(server, {
      as: serviceSigner,
      servingHomeSpace: servingSpace,
    });
    cleanups.push(() => manager.close());
    return manager;
  };

  /** Set `space`'s ACL through the SPACE IDENTITY via ACLManager — the
   * sanctioned whole-document mutation path. */
  const setAcl = async (
    as: Identity,
    space: MemorySpace,
    acl: Record<string, "READ" | "WRITE" | "OWNER">,
  ): Promise<void> => {
    const runtime = clientRuntime(as);
    const manager = new ACLManager(runtime, space as never);
    for (const [who, capability] of Object.entries(acl)) {
      await manager.set(who as never, capability);
    }
    await runtime.idle();
    await runtime.storageManager.synced();
  };

  /** Write a durable doc into `space` as its owner, and return its id.
   * The refused read's target is PRESENT and durable — an authorization
   * outcome, never an absence. */
  const seedDoc = async (
    as: Identity,
    space: MemorySpace,
    cause: string,
    value: string,
  ): Promise<URI> => {
    const runtime = clientRuntime(as);
    const cell = runtime.getCell<string>(space, cause, undefined);
    const tx = runtime.edit();
    cell.withTx(tx).set(value);
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();
    await runtime.storageManager.synced();
    return cell.getAsNormalizedFullLink().id as URI;
  };

  /** REMOVE a principal's grant. `setAcl` only ever adds or upgrades — a
   * pin that needs an actual de-authorization has to call this, and a pin
   * that assumes `setAcl` removes what it omits is vacuous (this one was,
   * until a diagnostic probe caught it). */
  const revokeAcl = async (
    as: Identity,
    space: MemorySpace,
    who: string,
  ): Promise<void> => {
    const runtime = clientRuntime(as);
    const manager = new ACLManager(runtime, space as never);
    await manager.remove(who as never);
    await runtime.idle();
    await runtime.storageManager.synced();
  };

  /** Overwrite an existing doc as its owner. */
  const writeDoc = async (
    as: Identity,
    space: MemorySpace,
    cause: string,
    value: string,
  ): Promise<void> => {
    const runtime = clientRuntime(as);
    const cell = runtime.getCell<string>(space, cause, undefined);
    await cell.sync();
    const tx = runtime.edit();
    cell.withTx(tx).set(value);
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();
    await runtime.storageManager.synced();
  };

  /** What the replica has materialized for `id`, or undefined. */
  const materialized = (
    manager: StorageManager,
    space: MemorySpace,
    id: URI,
  ): unknown => {
    const document = (manager.open(space) as unknown as {
      get(uri: URI): { value?: unknown } | undefined;
    }).get(id);
    return document?.value;
  };

  /** One serving-plane read of a foreign doc: the pull's own verdict. */
  const probeRead = async (
    manager: StorageManager,
    space: MemorySpace,
    id: URI,
  ): Promise<{ error?: { name?: string; message?: string } }> => {
    const result = await manager.open(space).sync(id, {
      path: [],
      schema: false,
    });
    return result as { error?: { name?: string; message?: string } };
  };

  /** A valid doc id nothing has written, minted locally from a cause. A
   * SUCCEEDED pull registers its selector in the replica's watch tracker
   * and later pulls for the same address are answered from it WITHOUT a
   * round trip — so a probe that must actually reach the wire (to observe
   * a session's live verdict) has to name an address the replica has never
   * pulled. An absent doc is a perfectly good wire read: the pull is
   * issued, and a revoked session refuses it exactly as it refuses any
   * other. */
  let probeCounter = 0;

  const mintProbeId = (runtime: Runtime, space: MemorySpace): URI => {
    probeCounter += 1;
    return runtime.getCell<string>(
      space,
      `wire-probe-${probeCounter}`,
      undefined,
    )
      .getAsNormalizedFullLink().id as URI;
  };

  it("a session revoked by the genesis ACL is REMOUNTED when a commit touches the ACL doc, and the starved cross-space read lands", async () => {
    const serving = servingManager();

    // (1) Activation before genesis: the serving plane opens its session
    // on a space with no ACL at all. Admitted — a fresh space grants
    // authenticated READ, and OW31's binding resolves nothing to bind.
    await mountSession(serving, homeSpace);

    // (2) The genesis ACL lands, naming the user OWNER and no `"*"`.
    // `#revokeDeauthorizedSessions` de-authorizes the pre-genesis
    // session: correct, by design, and the whole defect's premise.
    await setAcl(homeSigner, homeSpace, { [homeSigner.did()]: "OWNER" });

    // (3) The doc the starved read wants — durable, present, refused.
    const docId = await seedDoc(homeSigner, homeSpace, "remount-target", "v1");

    // (4) The pre-fix steady state, bounded: every re-drain's load fails
    // identically. The capture observed 350 of these over 5m47s with
    // ZERO successes; eight is enough to prove there is no self-heal
    // hiding in the retry path.
    const failures: string[] = [];
    let successes = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await probeRead(serving, homeSpace, docId);
      if (result.error === undefined) successes += 1;
      else failures.push(`${result.error.name}: ${result.error.message}`);
    }
    expect(successes, "no load may succeed while the session is revoked")
      .toBe(0);
    expect(failures.length).toBe(8);
    expect(
      failures.every((message) => message.includes("revoked")),
      `every failure is the revoked session, got: ${failures[0]}`,
    ).toBe(true);

    // (5) THE FIX. An admitted commit touched `of:<space>` — the ACL
    // this space's authorization is a function of — so the verdict that
    // killed the session can have changed. Re-establish it. Post-fix the
    // very next load opens a fresh session, whose OW31 binding now
    // resolves the landed ACL's OWNER (the user), and reads through.
    (serving as AclChangeNotifier).noteSpaceAclChanged?.(homeSpace);

    const healed = await probeRead(serving, homeSpace, docId);
    expect(
      healed.error,
      `the remounted session must read the durable doc; got ` +
        `${healed.error?.name}: ${healed.error?.message}`,
    ).toBeUndefined();
    const document = (serving.open(homeSpace) as unknown as {
      get(uri: URI): unknown;
    }).get(docId);
    expect(document, "the durable doc materialized on the replica")
      .toBeDefined();

    // The remount is not a one-shot: the healed session keeps serving a
    // FRESH address (one the replica has never pulled, so the read has to
    // reach the wire rather than the watch tracker).
    const minter = clientRuntime(homeSigner);
    const again = await probeRead(
      serving,
      homeSpace,
      mintProbeId(minter, homeSpace),
    );
    expect(again.error, "the healed session keeps serving").toBeUndefined();
  });

  it("FAIL-CLOSED: the remount re-runs session.open, it does not decide it — an unauthorized principal is denied there and the read keeps failing, while the SAME trigger heals it the moment the ACL grants READ", async () => {
    // The soundness property, and the pin that makes it falsifiable: the
    // remount hands the decision back to `session.open` every time. One
    // trigger, two outcomes, and only the ACL chooses between them.
    //
    // The principal here is a STRANGER on a plain (non-serving) mount, so
    // no OW31 binding applies and admission resolves against the envelope
    // — the shape where a denial is actually constructible. (Under OW31 a
    // SERVING mount reads a space as whoever owns it, so moving ownership
    // does not de-authorize the serving plane; it re-binds the new owner,
    // which is exactly what memory/v2/server.ts's revocation comment says
    // it wants — pinned separately below.)
    const stranger = LoopbackStorageManager.connect(server, {
      as: strangerSigner,
    });
    cleanups.push(() => stranger.close());
    const minter = clientRuntime(homeSigner);

    // Pre-genesis open, then the genesis ACL revokes it: the stranger
    // holds no READ and there is no `"*"` grant.
    await mountSession(stranger, homeSpace);
    await setAcl(homeSigner, homeSpace, { [homeSigner.did()]: "OWNER" });
    const docId = await seedDoc(homeSigner, homeSpace, "fail-closed", "v1");
    expect(
      (await probeRead(stranger, homeSpace, docId)).error,
      "the genesis revoked the pre-genesis session",
    ).toBeDefined();

    // An ACL commit lands that does NOT grant the stranger anything. The
    // trigger fires — and must not rescue the read: `session.open`
    // re-evaluates and denies. The load keeps failing, the served event
    // keeps deferring (the ratified wedge), and OW54's give-up arm is
    // what covers a load that never heals.
    await setAcl(homeSigner, homeSpace, { [servingSigner.did()]: "READ" });
    (stranger as AclChangeNotifier).noteSpaceAclChanged?.(homeSpace);
    for (let attempt = 0; attempt < 4; attempt++) {
      expect(
        (await probeRead(stranger, homeSpace, mintProbeId(minter, homeSpace)))
          .error,
        "the remount must never widen authority",
      ).toBeDefined();
    }

    // The other half of the same trigger: grant the stranger READ and the
    // NEXT remount is admitted. Without this the pin above would pass on
    // a fix that simply never remounts.
    await setAcl(homeSigner, homeSpace, { [strangerSigner.did()]: "READ" });
    (stranger as AclChangeNotifier).noteSpaceAclChanged?.(homeSpace);
    // The remount is lazy — the next load opens the fresh session — so
    // one load is the whole observation.
    expect(
      (await probeRead(stranger, homeSpace, mintProbeId(minter, homeSpace)))
        .error,
      "the ACL grant admits the remounted session",
    ).toBeUndefined();
  });

  it("an ownership CHANGE re-binds the new owner rather than reading on under a stale identity — the outcome the revocation sweep's own comment asks for", async () => {
    // NOT a de-authorization of the serving plane, and worth pinning
    // because it reads like one. Under OW31 a serving mount's READ
    // decisions resolve as the space's OWNER, so `#revokeDeauthorizedSessions`
    // revokes a bound session whose acting principal is no longer the
    // owner "so the serving plane's next mount re-binds the new owner
    // instead of reading indefinitely under a stale identity"
    // (memory/v2/server.ts). That next mount is what did not exist. The
    // authority does not widen: the memory server re-decides, and it
    // decides in favour of the space's current owner.
    const serving = servingManager();
    const minter = clientRuntime(homeSigner);
    await mountSession(serving, homeSpace);
    await setAcl(homeSigner, homeSpace, { [homeSigner.did()]: "OWNER" });
    const docId = await seedDoc(homeSigner, homeSpace, "rebind", "v1");

    (serving as AclChangeNotifier).noteSpaceAclChanged?.(homeSpace);
    expect((await probeRead(serving, homeSpace, docId)).error).toBeUndefined();

    // Ownership moves. The session bound to the OLD owner is revoked.
    await setAcl(homeSigner, homeSpace, {
      [strangerSigner.did()]: "OWNER",
      [homeSigner.did()]: "READ",
    });
    // `setAcl` flushed the commit, and the sweep that revokes runs with
    // the ACL's own admission, so the next load already sees the verdict.
    expect(
      (await probeRead(serving, homeSpace, mintProbeId(minter, homeSpace)))
        .error,
      "the ownership change revoked the bound session",
    ).toBeDefined();

    // The remount re-resolves the binding from the landed ACL and serves
    // as the NEW owner.
    (serving as AclChangeNotifier).noteSpaceAclChanged?.(homeSpace);
    expect(
      (await probeRead(serving, homeSpace, mintProbeId(minter, homeSpace)))
        .error,
      "the remount re-bound the new owner",
    ).toBeUndefined();
  });

  it("a doc watched on the DEAD session is refetched after the remount, not answered stale from the watch tracker", async () => {
    // Cubic P1 (three violations, one property). A pull whose selector the
    // watch tracker already covers returns WITHOUT reaching
    // `#memoizedSessionHandle()` — so for such a doc the remount's latch is
    // never consumed, and worse, the read is answered from a replica whose
    // watch died with the revoked session. My first pass flagged this as
    // a residual and claimed "each address re-installs on its next pull";
    // that claim was FALSE for exactly the tracker-covered case, which is
    // every doc the replica had successfully read before the revocation.
    //
    // Note this was never a REGRESSION — the staleness starts at the
    // revocation, which the remount does not cause — but "the session is
    // re-established" has to mean the replica can read again, including
    // what it was already watching. So the remount drops the tracker.
    /** This session's own revocation, reported once the session has taken
     * the frame. The remount latch is consumed only against a session the
     * revocation has already terminated. */
    const revocations = new ArrivalLog<void>();
    const stranger = LoopbackStorageManager.connect(
      server,
      { as: strangerSigner },
      (frame) => {
        if (frame.includes('"session/revoked"')) revocations.record();
      },
    );
    cleanups.push(() => stranger.close());

    // Authorized from the start, so the doc is read SUCCESSFULLY and its
    // selector enters the tracker as covered.
    await setAcl(homeSigner, homeSpace, {
      [homeSigner.did()]: "OWNER",
      [strangerSigner.did()]: "READ",
    });
    const docId = await seedDoc(homeSigner, homeSpace, "tracker-stale", "v1");
    expect((await probeRead(stranger, homeSpace, docId)).error).toBeUndefined();
    expect(materialized(stranger, homeSpace, docId)).toEqual("v1");

    // The stranger loses READ — an actual REMOVAL, not an omission: the
    // session is revoked and stops receiving pushes. Nothing pulls in this
    // window, so the tracker still holds the doc's selector as covered.
    await revokeAcl(homeSigner, homeSpace, strangerSigner.did());
    // The revocation has reached THIS client: the latch below is consumed
    // only against a session whose termination has landed, and a probe
    // that runs first reads the tracker and answers the stale value.
    await revocations.reached(1);
    // The value moves while the replica is deaf to it.
    await writeDoc(homeSigner, homeSpace, "tracker-stale", "v2");

    // READ comes back, and the trigger fires.
    await setAcl(homeSigner, homeSpace, {
      [homeSigner.did()]: "OWNER",
      [strangerSigner.did()]: "READ",
    });
    (stranger as AclChangeNotifier).noteSpaceAclChanged?.(homeSpace);

    // The pin, and note WHAT it asserts: not that the read errors, but
    // that it returns the CURRENT value. Pre-fix the pull returned
    // `{ok:{}}` — a successful read — while the replica still held "v1".
    // A silent stale answer is the worst shape this could take, which is
    // why the assertion is on the materialized value and not on the
    // pull's verdict.
    expect(
      (await probeRead(stranger, homeSpace, docId)).error,
      "the remounted session read the doc it had been watching",
    ).toBeUndefined();
    expect(
      materialized(stranger, homeSpace, docId),
      "the refetch replaced the stale materialization",
    ).toBe("v2");
  });

  it("a HEALTHY session is never churned: an ACL commit that did not terminate it mints no new session.open", async () => {
    // The other half of the trigger's discipline, and the reason the
    // teardown is guarded on the session's own close verdict rather than
    // on the ACL event alone. ACL documents are written for reasons that
    // have nothing to do with this replica; re-mounting on each one would
    // trade a starving session for a churning one — a fresh handshake,
    // a fresh watch install, and a re-pull of everything the replica had
    // already tracked, per ACL write.
    const serving = servingManager();
    const minter = clientRuntime(homeSigner);
    await setAcl(homeSigner, homeSpace, { [homeSigner.did()]: "OWNER" });
    // Opened AFTER the genesis, so it is authorized from the start and
    // nothing ever revokes it.
    await mountSession(serving, homeSpace);
    expect(
      (await probeRead(serving, homeSpace, mintProbeId(minter, homeSpace)))
        .error,
    ).toBeUndefined();

    const before = servingOpens();
    // An ACL commit that changes nothing about this session's standing.
    await setAcl(homeSigner, homeSpace, { [servingSigner.did()]: "READ" });
    (serving as AclChangeNotifier).noteSpaceAclChanged?.(homeSpace);
    expect(
      (await probeRead(serving, homeSpace, mintProbeId(minter, homeSpace)))
        .error,
    ).toBeUndefined();
    expect(
      servingOpens() - before,
      "a live session must survive an ACL commit untouched",
    ).toBe(0);
  });

  it("HOST GLUE: the genesis ACL rides the host's OWN admission feed and heals a registered space server's foreign session — nothing hand-fed", async () => {
    // The wiring pin. A real ExecutorHost, a real SpaceServer for the
    // SERVING space, and the starved session on a FOREIGN space (the
    // viewer's home). The only thing that happens after the revocation
    // is a client committing the genesis ACL: the host's own
    // `commitAdmitted` observer has to carry it to the serving
    // runtime's storage manager.
    // The construction hook is the event that says the host activated a
    // serving runtime.
    const servingUp = new ArrivalLog<LoopbackStorageManager>();
    const host = new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      // The ensure is not under test here and needs pattern fetches.
      ensureSpaceRoots: false,
      // deno-lint-ignore require-await
      createRuntime: async (space) => {
        const manager = LoopbackStorageManager.connect(server, {
          as: serviceSigner,
          servingHomeSpace: space,
        });
        servingUp.record(manager);
        const runtime = new Runtime({
          apiUrl: new URL("http://toolshed.test"),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
    });
    cleanups.push(() => host.close());

    // The serving space needs its own ACL so a SpaceServer can serve it,
    // and a live client session is the activation trigger.
    await setAcl(servingSigner, servingSpace, {
      [servingSigner.did()]: "OWNER",
    });
    const client = clientRuntime(servingSigner);
    await client.storageManager.open(servingSpace).sync(
      `of:${servingSpace}` as URI,
      { path: [], schema: false },
    );
    const serving = await servingUp.matching(() => true);

    // Activation before genesis, on the FOREIGN home space.
    await mountSession(serving, homeSpace);
    // The genesis lands through a real client transact — the host's own
    // admission observer is the only thing that learns of it.
    await setAcl(homeSigner, homeSpace, { [homeSigner.did()]: "OWNER" });
    const docId = await seedDoc(homeSigner, homeSpace, "host-glue", "v1");

    // The host's observer runs with the ACL commit's own admission, which
    // `setAcl` flushed, so the heal is already owed by the time the load
    // below opens its session.
    expect(
      (await probeRead(serving, homeSpace, docId)).error,
      "the host's ACL admission healed the foreign session",
    ).toBeUndefined();
  });

  it("lands a read that was in flight when the genesis ACL revoked its session", async () => {
    // The read is issued on the pre-genesis session and reaches the memory
    // server only after the genesis ACL has revoked that session and the ACL
    // notice has latched the remount. The server refuses it as a request on
    // a session it no longer holds. Nothing else reads the space, so the
    // read that failed is the only load that can consume the latch.

    const gate = new RequestGate();
    const serving = GatedLoopbackManager.connect(server, gate, {
      as: serviceSigner,
      servingHomeSpace: servingSpace,
    });
    cleanups.push(() => serving.close());
    const docId = mintProbeId(clientRuntime(homeSigner), homeSpace);

    await mountSession(serving, homeSpace);
    gate.hold();
    const read = probeRead(serving, homeSpace, docId);
    await gate.heldFrames.reached(1);

    await setAcl(homeSigner, homeSpace, { [homeSigner.did()]: "OWNER" });
    (serving as AclChangeNotifier).noteSpaceAclChanged?.(homeSpace);
    gate.release();

    const result = await read;
    expect(
      result.error,
      `the in-flight read must land; got ` +
        `${result.error?.name}: ${result.error?.message}`,
    ).toBeUndefined();
    expect(
      servingOpens(),
      "one session before the genesis and one remount after it",
    ).toBe(2);
  });

  it("fails a read that was in flight when the genesis ACL revoked its session, when the ACL grants its principal nothing", async () => {
    // The stranger mounts plainly, so no owner binding applies and the
    // remounted session is judged as the stranger, whom the genesis ACL does
    // not name. The one remount the failure makes is refused at
    // `session.open`, and that refusal is what the read returns.

    const gate = new RequestGate();
    const stranger = GatedLoopbackManager.connect(server, gate, {
      as: strangerSigner,
    });
    cleanups.push(() => stranger.close());
    const strangerOpens = () =>
      sessionOpens.count((iss) => iss === strangerSigner.did());
    const docId = mintProbeId(clientRuntime(homeSigner), homeSpace);

    await mountSession(stranger, homeSpace);
    gate.hold();
    const read = probeRead(stranger, homeSpace, docId);
    await gate.heldFrames.reached(1);

    await setAcl(homeSigner, homeSpace, { [homeSigner.did()]: "OWNER" });
    (stranger as AclChangeNotifier).noteSpaceAclChanged?.(homeSpace);
    gate.release();

    expect((await read).error?.name).toBe("AuthorizationError");
    expect(
      strangerOpens(),
      "one session before the genesis and one refused remount after it",
    ).toBe(2);
  });

  it("lands every read that joined a fetch in flight when the genesis ACL revoked its session", async () => {
    // The second read of the same document joins the first read's fetch, so
    // both see it fail, and only one of them can be the one that consumes the
    // latch.

    const gate = new RequestGate();
    const serving = GatedLoopbackManager.connect(server, gate, {
      as: serviceSigner,
      servingHomeSpace: servingSpace,
    });
    cleanups.push(() => serving.close());
    const docId = mintProbeId(clientRuntime(homeSigner), homeSpace);

    await mountSession(serving, homeSpace);
    gate.hold();
    const reads = [
      probeRead(serving, homeSpace, docId),
      probeRead(serving, homeSpace, docId),
    ];
    await gate.heldFrames.reached(1);

    await setAcl(homeSigner, homeSpace, { [homeSigner.did()]: "OWNER" });
    (serving as AclChangeNotifier).noteSpaceAclChanged?.(homeSpace);
    gate.release();

    const errors = (await Promise.all(reads)).map((result) => result.error);
    expect(errors).toEqual([undefined, undefined]);
    expect(servingOpens()).toBe(2);
  });

  it("returns the server's refusal for a read that was in flight when its session was revoked, when no ACL change was noted", async () => {
    // With no ACL notice there is no remount owed, so the read that failed is
    // not made again: it returns the refusal of the request itself, rather
    // than the terminated session's own error.

    const gate = new RequestGate();
    const serving = GatedLoopbackManager.connect(server, gate, {
      as: serviceSigner,
      servingHomeSpace: servingSpace,
    });
    cleanups.push(() => serving.close());
    const docId = mintProbeId(clientRuntime(homeSigner), homeSpace);

    await mountSession(serving, homeSpace);
    gate.hold();
    const read = probeRead(serving, homeSpace, docId);
    await gate.heldFrames.reached(1);

    await setAcl(homeSigner, homeSpace, { [homeSigner.did()]: "OWNER" });
    gate.release();

    expect((await read).error?.message).toBe(
      "Session is not open on this connection",
    );
    expect(servingOpens()).toBe(1);
  });
});
