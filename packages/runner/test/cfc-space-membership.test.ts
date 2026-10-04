import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { ACL } from "@commonfabric/memory/acl";
import {
  createRuntimeSpaceMembershipProvider,
  spaceReaderRole,
} from "../src/cfc/space-membership.ts";
import { Identity } from "@commonfabric/identity";
import type { Cancel } from "../src/cancel.ts";
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";

// §4.9.3 render membership lookup — the client-side capability resolver
// (design: docs/history/specs/cfc-render-membership-lookup.md §3.1). `spaceReaderRole`
// shares valid-ACL capability resolution with the server while deliberately
// treating absent/unsynced ACL state as no positive render-membership evidence.

const ALICE = "did:key:alice";
const MALLORY = "did:key:mallory";
const SPACE_TEAM = "did:key:team-space";
const SERVICE = "did:web:commonfabric.org#runtime";

describe("spaceReaderRole (§4.9.3 capability resolver)", () => {
  it("resolves a principal's own identity space through its ACL", () => {
    // A Home space's genesis ACL names its user OWNER; without an ACL, being
    // the space's DID grants nothing.
    expect(spaceReaderRole({ [ALICE]: "OWNER" }, ALICE)).toBe("owner");
    expect(spaceReaderRole(undefined, ALICE)).toBeNull();
  });

  it("grants implicit OWNER to a configured service DID", () => {
    expect(spaceReaderRole(undefined, SERVICE, [SERVICE])).toBe(
      "owner",
    );
  });

  it("maps a READ grant to the reader role", () => {
    const acl: ACL = { [MALLORY]: "OWNER", [ALICE]: "READ" };
    expect(spaceReaderRole(acl, ALICE)).toBe("reader");
  });

  it("maps a WRITE grant to the writer role (WRITE implies READ)", () => {
    const acl: ACL = { [MALLORY]: "OWNER", [ALICE]: "WRITE" };
    expect(spaceReaderRole(acl, ALICE)).toBe("writer");
  });

  it("maps an OWNER grant to the owner role", () => {
    const acl: ACL = { [ALICE]: "OWNER" };
    expect(spaceReaderRole(acl, ALICE)).toBe("owner");
  });

  it("falls back to the ANYONE ('*') grant when the principal is unlisted", () => {
    const acl: ACL = { [MALLORY]: "OWNER", "*": "READ" };
    expect(spaceReaderRole(acl, ALICE)).toBe("reader");
  });

  it("prefers an explicit principal entry over the ANYONE grant", () => {
    // `acl[principal] ?? acl["*"]` — the explicit entry wins even when it is
    // narrower than the public grant.
    const acl: ACL = {
      [MALLORY]: "OWNER",
      [ALICE]: "READ",
      "*": "OWNER",
    };
    expect(spaceReaderRole(acl, ALICE)).toBe("reader");
  });

  it("returns null for a principal absent from a `*`-less ACL (fail closed)", () => {
    const acl: ACL = { [MALLORY]: "OWNER" };
    expect(spaceReaderRole(acl, ALICE)).toBeNull();
  });

  it("returns null for a missing ACL document (fail closed)", () => {
    // The whole soundness point: an unread/absent ACL grants NOTHING, so the
    // Space label stays blocked. Residency is not read authority.
    expect(spaceReaderRole(undefined, ALICE)).toBeNull();
  });

  it("returns null for a malformed ACL value (fail closed)", () => {
    expect(spaceReaderRole("not-an-acl" as unknown as ACL, ALICE))
      .toBeNull();
    expect(
      spaceReaderRole({ [ALICE]: "SUDO" } as unknown as ACL, ALICE),
    ).toBeNull();
  });

  it("returns null for a syntactically valid but ownerless ACL", () => {
    expect(spaceReaderRole({ [ALICE]: "READ" }, ALICE)).toBeNull();
    expect(spaceReaderRole({ "*": "OWNER" }, ALICE)).toBeNull();
  });

  it("does not grant a service role to a non-service principal", () => {
    expect(spaceReaderRole(undefined, ALICE, [SERVICE])).toBeNull();
  });
});

// A minimal runtime double: one ACL doc per space id, plus per-space sink
// callbacks so a test can drive a reactive change. `get()` records calls so
// the sync-read + background-sync-kick contract is observable.
const fakeRuntime = (aclBySpace: Record<string, unknown>) => {
  const sinks = new Map<string, Set<() => void>>();
  const getCalls: string[] = [];
  const runtime = {
    getCellFromLink(link: { id: string; path: readonly []; space: string }) {
      return {
        get() {
          getCalls.push(link.id);
          return aclBySpace[link.id];
        },
        sink(cb: () => void): Cancel {
          let set = sinks.get(link.id);
          if (set === undefined) {
            set = new Set();
            sinks.set(link.id, set);
          }
          set.add(cb);
          cb(); // real Cell.sink runs the action once synchronously at subscribe
          return () => set!.delete(cb);
        },
      };
    },
  } as unknown as Runtime;
  const fire = (space: string) => {
    for (const cb of sinks.get(`of:${space}`) ?? []) cb();
  };
  return { runtime, getCalls, fire, sinks };
};

describe("createRuntimeSpaceMembershipProvider (§4.9.3 provider)", () => {
  it("does not report an access list held when its sync finished without it", async () => {
    const reader = await Identity.fromPassphrase("membership reader");
    const space = (await Identity.fromPassphrase("membership space")).did();
    const server = newLoopbackServer();
    const runtime = new Runtime({
      apiUrl: new URL("http://localhost"),
      storageManager: EmulatedStorageManager.connectTo(server, { as: reader }),
    });
    const provider = createRuntimeSpaceMembershipProvider(
      runtime,
      reader.did(),
    );
    try {
      const loaded = provider.whenHeld?.(space).then(
        () => "loaded",
        (error: unknown) => `${error}`,
      );
      // Disposed while the access list loads, the sync finishes without it.
      await runtime.dispose();
      expect(await loaded).toContain("did not load");
      expect(provider.held?.(space)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("reads a granted ACL synchronously and returns the reader role", () => {
    const { runtime, getCalls } = fakeRuntime({
      [`of:${SPACE_TEAM}`]: { [MALLORY]: "OWNER", [ALICE]: "READ" },
    });
    const provider = createRuntimeSpaceMembershipProvider(runtime, ALICE);
    expect(provider.readerRole(SPACE_TEAM)).toBe("reader");
    // The ACL doc for the queried space was read (a Cell.get() sync read that
    // also kicks a background sync when unsynced).
    expect(getCalls).toContain(`of:${SPACE_TEAM}`);
  });

  it("fails closed when the ACL doc is absent (residency is not authority)", () => {
    // The runtime may have synced the space's bytes without the acting user
    // being an authorized reader; an absent/unread ACL grants NOTHING.
    const { runtime } = fakeRuntime({});
    const provider = createRuntimeSpaceMembershipProvider(runtime, ALICE);
    expect(provider.readerRole(SPACE_TEAM)).toBeNull();
  });

  it("resolves the acting user's own space through its ACL", () => {
    // A Home space's user owns it because its genesis ACL says so; being the
    // space's DID grants nothing without that entry.
    const { runtime, getCalls } = fakeRuntime({
      [`of:${ALICE}`]: { [ALICE]: "OWNER" },
    });
    const provider = createRuntimeSpaceMembershipProvider(runtime, ALICE);
    expect(provider.readerRole(ALICE)).toBe("owner");
    expect(getCalls).toContain(`of:${ALICE}`);
    const { runtime: unread } = fakeRuntime({});
    expect(
      createRuntimeSpaceMembershipProvider(unread, ALICE).readerRole(ALICE),
    )
      .toBeNull();
  });

  it("fails closed on a malformed ACL value", () => {
    const { runtime } = fakeRuntime({ [`of:${SPACE_TEAM}`]: "not-an-acl" });
    const provider = createRuntimeSpaceMembershipProvider(runtime, ALICE);
    expect(provider.readerRole(SPACE_TEAM)).toBeNull();
  });

  it("reflects the latest replica across reads (no stale memo on revoke)", () => {
    // Soundness under revoke: a later read must see the ACL as it now stands.
    const acl: Record<string, unknown> = {
      [`of:${SPACE_TEAM}`]: { [MALLORY]: "OWNER", [ALICE]: "READ" },
    };
    const { runtime } = fakeRuntime(acl);
    const provider = createRuntimeSpaceMembershipProvider(runtime, ALICE);
    expect(provider.readerRole(SPACE_TEAM)).toBe("reader");
    delete acl[`of:${SPACE_TEAM}`]; // ACL revoked / doc dropped
    expect(provider.readerRole(SPACE_TEAM)).toBeNull();
  });

  it("subscribe fires onChange on CHANGE only (skips the at-subscribe fire), and cancels cleanly", () => {
    const { runtime, fire, sinks } = fakeRuntime({
      [`of:${SPACE_TEAM}`]: { [MALLORY]: "OWNER", [ALICE]: "READ" },
    });
    const provider = createRuntimeSpaceMembershipProvider(runtime, ALICE);
    let changes = 0;
    // subscribe triggers the underlying Cell.sink's synchronous at-subscribe
    // fire, which the provider skips — so no onChange yet.
    const cancel = provider.subscribe(SPACE_TEAM, () => changes++);
    expect(changes).toBe(0);
    fire(SPACE_TEAM); // a real change
    expect(changes).toBe(1);
    cancel();
    fire(SPACE_TEAM);
    expect(changes).toBe(1); // no further callbacks after cancel
    expect(sinks.get(`of:${SPACE_TEAM}`)?.size ?? 0).toBe(0);
  });

  it("honors service DIDs for implicit OWNER", () => {
    const { runtime } = fakeRuntime({});
    const provider = createRuntimeSpaceMembershipProvider(runtime, SERVICE, [
      SERVICE,
    ]);
    expect(provider.readerRole(SPACE_TEAM)).toBe("owner");
  });
});
