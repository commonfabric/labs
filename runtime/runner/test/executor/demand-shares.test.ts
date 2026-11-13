import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { SessionDemand } from "@commonfabric/memory/v2/server";
import {
  DemandShareCache,
  type SessionOfShare,
} from "../../src/executor/demand-shares.ts";

const space = "did:key:z6MkDemandSharesSpace";

const share = (sessionId: string): SessionDemand => ({
  sessionId,
  rows: new Map(),
});

/** A reader that returns from `shares` and records what it was asked for. */
const reader = (shares: Record<string, SessionDemand>) => {
  const asked: string[][] = [];
  return {
    asked,
    read: (sessionIds: string[]) => {
      asked.push([...sessionIds]);
      return Promise.resolve(
        sessionIds.flatMap((id) =>
          shares[id] === undefined ? [] : [shares[id]]
        ),
      );
    },
  };
};

/**
 * Live sessions by id, each with its principal, and marked as a serving
 * loop's own when its entry says `"serving"`.
 */
const live = (
  ...entries: Array<[string, string | undefined, "serving"?]>
) =>
  new Map<string, SessionOfShare>(
    entries.map(([id, principal, serving]) => [
      id,
      serving === undefined ? { principal } : { principal, servingOwn: true },
    ]),
  );

describe("demand-shares", () => {
  for (const wholeSpace of [false, true]) {
    it(`retains ${wholeSpace ? "space" : "session"} invalidations arriving during a read`, async () => {
      const cache = new DemandShareCache();
      const sessions = live(["a", undefined]);
      const pending = Promise.withResolvers<SessionDemand[]>();
      const first = cache.sharesFor(
        space,
        sessions,
        undefined,
        () => pending.promise,
      );
      cache.noteChanged(space, wholeSpace ? undefined : "a");
      const old = share("a");
      pending.resolve([old]);
      expect(await first).toEqual([old]);
      const next = share("a");
      const r = reader({ a: next });
      expect((await cache.sharesFor(space, sessions, undefined, r.read))[0])
        .toBe(next);
      expect(r.asked).toEqual([["a"]]);
    });
  }

  it("retains invalidation when a refresh rejects", async () => {
    const cache = new DemandShareCache();
    const sessions = live(["a", undefined]);
    await cache.sharesFor(
      space,
      sessions,
      undefined,
      reader({ a: share("a") }).read,
    );
    cache.noteChanged(space, "a");
    await expect(
      cache.sharesFor(
        space,
        sessions,
        undefined,
        () => Promise.reject(new Error("read failed")),
      ),
    ).rejects.toThrow("read failed");
    const r = reader({ a: share("a") });
    await cache.sharesFor(space, sessions, undefined, r.read);
    expect(r.asked).toEqual([["a"]]);
  });

  it("reads every live session's share once and hands the same objects to the next pass", async () => {
    const cache = new DemandShareCache();
    const shares = { a: share("a"), b: share("b") };
    const r = reader(shares);
    const sessions = live(["a", "did:key:alice"], ["b", "did:key:bob"]);

    const first = await cache.sharesFor(space, sessions, undefined, r.read);
    const second = await cache.sharesFor(space, sessions, undefined, r.read);

    expect(first).toEqual([shares.a, shares.b]);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(r.asked).toEqual([["a", "b"]]);
  });

  it("re-reads only the session whose demand changed", async () => {
    const cache = new DemandShareCache();
    const shares = { a: share("a"), b: share("b") };
    const r = reader(shares);
    const sessions = live(["a", undefined], ["b", undefined]);
    const first = await cache.sharesFor(space, sessions, undefined, r.read);

    shares.b = share("b");
    cache.noteChanged(space, "b");
    const second = await cache.sharesFor(space, sessions, undefined, r.read);

    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(shares.b);
    expect(r.asked).toEqual([["a", "b"], ["b"]]);
  });

  it("re-reads every session when the change names none", async () => {
    const cache = new DemandShareCache();
    const r = reader({ a: share("a"), b: share("b") });
    const sessions = live(["a", undefined], ["b", undefined]);
    await cache.sharesFor(space, sessions, undefined, r.read);

    cache.noteChanged(space);
    await cache.sharesFor(space, sessions, undefined, r.read);

    expect(r.asked).toEqual([["a", "b"], ["a", "b"]]);
  });

  it("leaves out the excluded principal's sessions and the ones no longer live or held", async () => {
    const cache = new DemandShareCache();
    const r = reader({ a: share("a"), c: share("c") });
    const first = await cache.sharesFor(
      space,
      live(["a", "did:key:alice"], ["svc", "did:key:service", "serving"], [
        "c",
        undefined,
      ]),
      "did:key:service",
      r.read,
    );
    const second = await cache.sharesFor(
      space,
      live(["a", "did:key:alice"], ["gone", undefined]),
      "did:key:service",
      r.read,
    );

    expect(first.map((s) => s.sessionId)).toEqual(["a", "c"]);
    expect(second.map((s) => s.sessionId)).toEqual(["a"]);
    expect(r.asked).toEqual([["a", "c"], ["gone"]]);
  });

  it("keeps the share of a client session signed by the excluded principal", async () => {
    // A client that signs with the serving loop's own key is still a
    // client; only the loop's own sessions are left out.

    const cache = new DemandShareCache();
    const r = reader({ svc: share("svc"), cli: share("cli") });
    const shares = await cache.sharesFor(
      space,
      live(["svc", "did:key:service", "serving"], ["cli", "did:key:service"]),
      "did:key:service",
      r.read,
    );

    expect(shares.map((s) => s.sessionId)).toEqual(["cli"]);
    expect(r.asked).toEqual([["cli"]]);
  });

  it("re-reads a share that changed while its principal was excluded once a pass includes it", async () => {
    const cache = new DemandShareCache();
    const r = reader({ a: share("a"), svc: share("svc") });
    const sessions = live(["a", "did:key:alice"], [
      "svc",
      "did:key:service",
      "serving",
    ]);
    await cache.sharesFor(space, sessions, undefined, r.read);

    cache.noteChanged(space, "svc");
    await cache.sharesFor(space, sessions, "did:key:service", r.read);
    const included = await cache.sharesFor(space, sessions, undefined, r.read);

    expect(included.map((s) => s.sessionId)).toEqual(["a", "svc"]);
    expect(r.asked).toEqual([["a", "svc"], ["svc"]]);
  });

  it("reads a forgotten session's share again when it is live", async () => {
    const cache = new DemandShareCache();
    const r = reader({ a: share("a") });
    const sessions = live(["a", undefined]);
    await cache.sharesFor(space, sessions, undefined, r.read);

    cache.forget(space, "a");
    await cache.sharesFor(space, sessions, undefined, r.read);

    expect(r.asked).toEqual([["a"], ["a"]]);
  });

  it("leaves out a share whose session closed during the read, and reads it again once live", async () => {
    const cache = new DemandShareCache();
    const sessions = live(["a", undefined], ["b", undefined]);
    const asked: string[][] = [];
    const read = (sessionIds: string[]) => {
      asked.push([...sessionIds]);
      if (asked.length === 1) sessions.delete("b");
      return Promise.resolve(sessionIds.map(share));
    };

    const during = await cache.sharesFor(space, sessions, undefined, read);
    sessions.set("b", { principal: undefined });
    const after = await cache.sharesFor(space, sessions, undefined, read);

    expect(during.map((s) => s.sessionId)).toEqual(["a"]);
    expect(after.map((s) => s.sessionId)).toEqual(["a", "b"]);
    expect(asked).toEqual([["a", "b"], ["b"]]);
  });

  describe("forget()", () => {
    it("holds no stale mark for a space once its last stale session is forgotten", () => {
      const cache = new DemandShareCache();
      cache.noteChanged(space, "a");
      cache.noteChanged(space, "b");

      cache.forget(space, "a");
      expect(cache.accessForTestingOnly.stale.get(space)).toEqual(
        new Set(["b"]),
      );
      cache.forget(space, "b");
      expect(cache.accessForTestingOnly.stale.has(space)).toBe(false);
    });
  });
});
