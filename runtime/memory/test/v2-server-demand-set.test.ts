import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/api";

import type { EntityDocument, WatchSpec } from "../v2.ts";
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

  /**
   * Mounts a session of the space as `principal`, over a connection the
   * server takes as one from this process unless `inProcess` is `false`,
   * declaring the serving binding when `actingAs` names it.
   */
  async function mount(
    principal?: string,
    { inProcess = true, actingAs }: {
      inProcess?: boolean;
      actingAs?: "space-owner";
    } = {},
  ): Promise<SpaceSession> {
    const client = await connect({
      transport: loopback(server, { inProcess }),
    });
    clients.push(client);
    return await client.mount(
      space,
      actingAs === undefined ? {} : { actingAs },
      openAs(principal),
    );
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

  /**
   * Writes `docs`, links each from `of:root`, and returns the rows of a session
   * watching `of:root`, once its kept share is checked against a fresh build.
   */
  async function rowsWatchedThrough(
    docs: Array<{ id: string; value: EntityDocument }>,
  ): Promise<SessionDemand["rows"]> {
    localSeq += 1;
    await writer.transact({
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [
        ...docs.map(({ id, value }) => ({ op: "set" as const, id, value })),
        {
          op: "set",
          id: "of:root",
          value: { value: { items: docs.map(({ id }) => link(id)) } },
        },
      ],
    });
    const watcher = await mount(alice);
    await watcher.watchSet([follow("of:root")]);
    const rows = shareOf(watcher).rows;
    expectKeptSharesCurrent();
    return rows;
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

      it("marks the rows whose documents are a piece's values", async () => {
        // A piece's result document is what a link to the piece names, and its
        // argument holds its inputs, so neither is one of its values. A
        // document a handler wrote names the handling's receipt, not a piece.

        localSeq += 1;
        await writer.transact({
          localSeq,
          reads: { confirmed: [], pending: [] },
          operations: [
            {
              op: "set",
              id: "of:piece",
              value: {
                value: { v: 1 },
                patternIdentity: { identity: "a-pattern", symbol: "default" },
                argument: link("of:piece-argument"),
              },
            },
            {
              op: "set",
              id: "of:piece-argument",
              value: { value: { v: 1 }, result: link("of:piece") },
            },
            {
              op: "set",
              id: "of:piece-input",
              value: { value: { v: 1 }, result: link("of:piece") },
            },
            {
              op: "set",
              id: "of:handled",
              value: { value: { v: 1 }, result: link("receipt:a-handling") },
            },
            {
              op: "set",
              id: "of:root",
              value: {
                value: {
                  items: [
                    link("of:leaf-a"),
                    link("of:piece"),
                    link("of:piece-input"),
                    link("of:piece-argument"),
                    link("of:handled"),
                  ],
                },
              },
            },
          ],
        });
        const watcher = await mount(alice);
        await watcher.watchSet([follow("of:root")]);

        const rows = shareOf(watcher).rows;
        expect(rows.get("space\0of:piece-input")?.piece).toBe(true);
        expect(rows.has("space\0of:piece")).toBe(true);
        expect(rows.get("space\0of:piece")?.piece).toBeUndefined();
        expect(rows.has("space\0of:piece-argument")).toBe(true);
        expect(rows.get("space\0of:piece-argument")?.piece).toBeUndefined();
        expect(rows.has("space\0of:handled")).toBe(true);
        expect(rows.get("space\0of:handled")?.piece).toBeUndefined();
        expect(rows.get("space\0of:leaf-a")?.piece).toBeUndefined();
        expect(rows.get("space\0of:root")?.piece).toBeUndefined();
        expectKeptSharesCurrent();
      });

      it("marks a row that a document without a pattern pointer names as its argument", async () => {
        const rows = await rowsWatchedThrough([
          {
            id: "of:piece-input",
            value: { value: { v: 1 }, result: link("of:piece") },
          },
          {
            id: "of:not-a-piece",
            value: { value: { v: 1 }, argument: link("of:piece-input") },
          },
        ]);

        expect(rows.get("space\0of:piece-input")?.piece).toBe(true);
      });

      it("marks a row whose id a piece names as an argument in another scope", async () => {
        const rows = await rowsWatchedThrough([
          {
            id: "of:piece",
            value: {
              value: { v: 1 },
              patternIdentity: { identity: "a-pattern", symbol: "default" },
              argument: {
                "/": {
                  "link@1": { id: "of:piece-input", path: [], scope: "user" },
                },
              },
            },
          },
          {
            id: "of:piece-input",
            value: { value: { v: 1 }, result: link("of:piece") },
          },
        ]);

        expect(rows.get("space\0of:piece-input")?.piece).toBe(true);
      });

      it("leaves unmarked a piece's result, and a row whose `result` names no document", async () => {
        const rows = await rowsWatchedThrough([
          {
            id: "of:bare-piece",
            value: {
              value: { v: 1 },
              patternIdentity: { identity: "a-pattern", symbol: "default" },
            },
          },
          { id: "of:plain-result", value: { value: { v: 1 }, result: 1 } },
          {
            id: "of:relative-result",
            value: {
              value: { v: 1 },
              result: { "/": { "link@1": { path: [] } } },
            },
          },
        ]);

        expect(rows.has("space\0of:bare-piece")).toBe(true);
        expect(rows.get("space\0of:bare-piece")?.piece).toBeUndefined();
        expect(rows.has("space\0of:plain-result")).toBe(true);
        expect(rows.get("space\0of:plain-result")?.piece).toBeUndefined();
        expect(rows.has("space\0of:relative-result")).toBe(true);
        expect(rows.get("space\0of:relative-result")?.piece).toBeUndefined();
      });

      it("rebuilds a share when a push makes a held document a piece's value", async () => {
        const watcher = await mount(alice);
        const view = await watcher.watchSet([follow("of:root")]);
        const before = shareOf(watcher);
        expect(before.rows.get("space\0of:leaf-a")?.piece).toBeUndefined();

        const updates = view.subscribe();
        const pushed = updates.next();
        localSeq += 1;
        await writer.transact({
          localSeq,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:leaf-a",
            value: { value: { v: 1 }, result: link("of:piece") },
          }],
        });
        await pushed;

        const after = shareOf(watcher);
        expect(after).not.toBe(before);
        expect(after.rows.get("space\0of:leaf-a")?.piece).toBe(true);
        expectKeptSharesCurrent();
      });

      it("rebuilds a share when a push gives a held piece's result another argument", async () => {
        const piece = (argument: string) => ({
          value: { v: 1 },
          patternIdentity: { identity: "a-pattern", symbol: "default" },
          argument: link(argument),
        });
        localSeq += 1;
        await writer.transact({
          localSeq,
          reads: { confirmed: [], pending: [] },
          operations: [
            { op: "set", id: "of:piece", value: piece("of:first-input") },
            {
              op: "set",
              id: "of:first-input",
              value: { value: { v: 1 }, result: link("of:piece") },
            },
            {
              op: "set",
              id: "of:second-input",
              value: { value: { v: 1 }, result: link("of:piece") },
            },
            {
              op: "set",
              id: "of:root",
              value: {
                value: {
                  items: [
                    link("of:piece"),
                    link("of:first-input"),
                    link("of:second-input"),
                  ],
                },
              },
            },
          ],
        });
        const watcher = await mount(alice);
        const view = await watcher.watchSet([follow("of:root")]);
        const before = shareOf(watcher);
        expect(before.rows.get("space\0of:first-input")?.piece)
          .toBeUndefined();
        expect(before.rows.get("space\0of:second-input")?.piece).toBe(true);

        const updates = view.subscribe();
        const pushed = updates.next();
        localSeq += 1;
        await writer.transact({
          localSeq,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:piece",
            value: piece("of:second-input"),
          }],
        });
        await pushed;

        const after = shareOf(watcher);
        expect(after).not.toBe(before);
        expect(after.rows.get("space\0of:first-input")?.piece).toBe(true);
        expect(after.rows.get("space\0of:second-input")?.piece)
          .toBeUndefined();
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

      it("keeps the share of the excluded principal's session from another process", async () => {
        // A client signed with the serving loop's own key is still a client:
        // only that principal's sessions from this process are the loop's.

        const local = await mount(bob);
        await local.watchSet([follow("of:root")]);
        const remote = await mount(bob, { inProcess: false });
        await remote.watchSet([follow("of:root")]);

        const shares = server.demandForSpace(space, { excludePrincipal: bob });

        expect(shares.map((share) => share.sessionId)).toContain(
          remote.sessionId,
        );
        expect(shares.map((share) => share.sessionId)).not.toContain(
          local.sessionId,
        );
      });

      it("omits the share of the excluded principal's session from another process that declares the serving binding", async () => {
        // A serving runtime of another process reaches the space's owner
        // over the network, and is no more a client than the local one.

        const routed = await mount(bob, {
          inProcess: false,
          actingAs: "space-owner",
        });
        await routed.watchSet([follow("of:root")]);

        const shares = server.demandForSpace(space, { excludePrincipal: bob });

        expect(shares.map((share) => share.sessionId)).not.toContain(
          routed.sessionId,
        );
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
