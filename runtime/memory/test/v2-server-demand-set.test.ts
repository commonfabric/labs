import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/api";

import type { WatchSpec } from "../v2.ts";
import {
  type Client,
  connect,
  loopback,
  type SessionOpenAuthFactory,
  type SpaceSession,
  type WatchView,
} from "../v2/client.ts";
import { Server, type SessionDemand } from "../v2/server.ts";
import { testSessionOpenAuth } from "./v2-auth-test-helpers.ts";

const space = "did:key:z6Mk-demand-set-space";
const alice = "did:key:z6Mk-demand-set-alice";
const bob = "did:key:z6Mk-demand-set-bob";

/** Opens a session as `principal`, or as an anonymous session without one. */
const openAs = (principal?: string): SessionOpenAuthFactory =>
(
  _space,
  _session,
  context,
) => ({
  invocation: {
    ...(principal === undefined ? {} : { iss: principal }),
    aud: context.audience,
    challenge: context.challenge.value,
  },
  authorization: {},
});

/** A graph watch following every link below `id`. */
const follow = (id: string): WatchSpec => ({
  id,
  kind: "graph",
  query: { roots: [{ id, selector: { path: [], schema: true } }] },
});

const link = (id: string) => ({ "/": { "link@1": { id, path: [] } } });

describe("Server", () => {
  let server: Server;
  let clients: Client[];
  let writer: SpaceSession;
  let localSeq: number;

  /** Mounts a session of the space as `principal`. */
  async function mount(principal?: string): Promise<SpaceSession> {
    const client = await connect({ transport: loopback(server) });
    clients.push(client);
    return await client.mount(space, {}, openAs(principal));
  }

  /** Commits `value` to `id` and resolves once `view` has the push. */
  async function write(
    view: WatchView,
    id: string,
    value: FabricValue,
  ): Promise<void> {
    const updates = view.subscribe();
    const pushed = updates.next();
    localSeq += 1;
    await writer.transact({
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id, value: { value } }],
    });
    await pushed;
  }

  /** The share of `session` the server hands out now. */
  function shareOf(session: SpaceSession): SessionDemand {
    const share = server.demandForSpace(space).find((candidate) =>
      candidate.sessionId === session.sessionId
    );
    expect(share).toBeDefined();
    return share!;
  }

  /** Expects every kept share of the space to equal an uncached build. */
  function expectKeptSharesCurrent(): void {
    const sessions = server.accessForTestingOnly.sessionsForSpace(space);
    const kept = server.demandForSpace(space);
    expect(kept.map((share) => share.sessionId)).toEqual(
      sessions.map((session) => session.id),
    );
    for (const [index, session] of sessions.entries()) {
      const fresh = server.accessForTestingOnly.buildSessionDemand(session);
      expect([...kept[index].rows]).toEqual([...fresh.rows]);
    }
  }

  beforeEach(async () => {
    clients = [];
    localSeq = 0;
    server = new Server({
      store: new URL("memory://demand-set"),
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen: (message) =>
        typeof message.invocation?.iss === "string"
          ? message.invocation.iss
          : undefined,
      sessionOpenAuth: testSessionOpenAuth,
    });
    writer = await mount(bob);
    localSeq += 1;
    await writer.transact({
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [
        { op: "set", id: "of:leaf-a", value: { value: { v: 1 } } },
        { op: "set", id: "of:leaf-b", value: { value: { v: 1 } } },
        {
          op: "set",
          id: "of:root",
          value: { value: { items: [link("of:leaf-a")] } },
        },
      ],
    });
  });

  afterEach(async () => {
    for (const client of clients) await client.close();
    await server.close();
  });

  describe("instance members", () => {
    describe("demandForSpace()", () => {
      it("returns the same share, built once, on a read with nothing written since the last", async () => {
        const watcher = await mount(alice);
        await watcher.watchSet([follow("of:root")]);
        const builds = server.accessForTestingOnly.sessionDemandBuilds;

        const first = shareOf(watcher);
        const second = shareOf(watcher);

        expect(second).toBe(first);
        // One build for the watcher and one for the writer, on the first read
        // alone.
        expect(server.accessForTestingOnly.sessionDemandBuilds).toBe(
          builds + 2,
        );
        expect([...first.rows.keys()].toSorted()).toEqual([
          "space\0of:leaf-a",
          "space\0of:root",
        ]);
        expectKeptSharesCurrent();
      });

      it("keeps a share across a push that changes only a value", async () => {
        const watcher = await mount(alice);
        const view = await watcher.watchSet([follow("of:root")]);
        const before = shareOf(watcher);
        const builds = server.accessForTestingOnly.sessionDemandBuilds;

        await write(view, "of:leaf-a", { v: 2 });

        expect(shareOf(watcher)).toBe(before);
        expect(server.accessForTestingOnly.sessionDemandBuilds).toBe(builds);
        expectKeptSharesCurrent();
      });

      it("rebuilds a share when a push reaches a new document", async () => {
        const watcher = await mount(alice);
        const view = await watcher.watchSet([follow("of:root")]);
        const before = shareOf(watcher);

        await write(view, "of:root", {
          items: [link("of:leaf-a"), link("of:leaf-b")],
        });

        const after = shareOf(watcher);
        expect(after).not.toBe(before);
        expect([...after.rows.keys()].toSorted()).toEqual([
          "space\0of:leaf-a",
          "space\0of:leaf-b",
          "space\0of:root",
        ]);
        expectKeptSharesCurrent();
      });

      it("rebuilds a share when its watches are replaced by fewer", async () => {
        const watcher = await mount(alice);
        await watcher.watchSet([follow("of:root")]);
        shareOf(watcher);

        await watcher.watchSet([follow("of:leaf-b")]);

        const after = shareOf(watcher);
        expect([...after.rows.values()]).toEqual([{
          id: "of:leaf-b",
          scope: "space",
          scopeKey: "space",
          identity: { principal: alice, sessionId: watcher.sessionId },
          root: true,
        }]);
        expectKeptSharesCurrent();
      });

      it("keeps one session's share when another session's watches change", async () => {
        const first = await mount(alice);
        const second = await mount(alice);
        await first.watchSet([follow("of:root")]);
        await second.watchSet([follow("of:leaf-a")]);
        const firstBefore = shareOf(first);
        const secondBefore = shareOf(second);

        await second.watchSet([follow("of:leaf-a"), follow("of:leaf-b")]);

        expect(shareOf(first)).toBe(firstBefore);
        expect(shareOf(second)).not.toBe(secondBefore);
        expectKeptSharesCurrent();
      });

      it("rebuilds a reopened session's share on a write made through the object the reopen replaced", async () => {
        const watcher = await mount(alice);
        await watcher.watchSet([follow("of:root")]);
        const replaced = server.accessForTestingOnly.sessionsForSpace(space)
          .find((session) => session.id === watcher.sessionId)!;
        const client = await connect({ transport: loopback(server) });
        clients.push(client);
        await client.mount(space, {
          sessionId: watcher.sessionId,
          sessionToken: watcher.sessionToken,
        }, openAs(alice));
        const current = server.accessForTestingOnly.sessionsForSpace(space)
          .find((session) => session.id === watcher.sessionId)!;
        expect(current).not.toBe(replaced);
        expect(current.watches).toBe(replaced.watches);
        const before = shareOf(watcher);

        // What a watch addition that read the session before the reopen
        // publishes: the watch list it extends in place is the replacement's
        // too.
        replaced.watches.push(follow("of:leaf-b"));
        server.accessForTestingOnly.touchDemand(replaced);

        const after = shareOf(watcher);
        expect(after).not.toBe(before);
        expect(after.rows.has("space\0of:leaf-b")).toBe(true);
        expectKeptSharesCurrent();
      });

      it("omits the shares of the excluded principal's sessions", async () => {
        const watcher = await mount(alice);
        await watcher.watchSet([follow("of:root")]);

        const shares = server.demandForSpace(space, { excludePrincipal: bob });

        expect(shares.map((share) => share.sessionId)).toEqual([
          watcher.sessionId,
        ]);
      });

      it("returns an anonymous session's rows with no principal in their identity", async () => {
        const watcher = await mount();
        await watcher.watchSet([follow("of:leaf-a")]);

        expect([...shareOf(watcher).rows.values()]).toEqual([{
          id: "of:leaf-a",
          scope: "space",
          scopeKey: "space",
          identity: { sessionId: watcher.sessionId },
          root: true,
        }]);
      });
    });

    describe("demandedInstancesForSpace()", () => {
      it("returns the rows of every share, in session order", async () => {
        const watcher = await mount(alice);
        await watcher.watchSet([follow("of:root")]);

        expect(server.demandedInstancesForSpace(space)).toEqual(
          server.demandForSpace(space).flatMap((share) => [
            ...share.rows.values(),
          ]),
        );
      });
    });
  });
});
