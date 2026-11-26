import { expect } from "@std/expect";

import {
  type GraphQuery,
  resolveScopeKey,
  toValuePath,
  type WatchSpec,
} from "../v2.ts";
import { partitionGraphQuery } from "../v2/query.ts";
import { watchGraphGroups } from "../v2/server-sync.ts";
import { describe, it } from "@commonfabric/test-support/test";

const service = { principal: "did:key:service", sessionId: "session:service" };
const alice = { principal: "did:key:alice", sessionId: "session:alice" };
const aliceUser = resolveScopeKey("user", alice);
const aliceSession = resolveScopeKey("session", alice);
const serviceUser = resolveScopeKey("user", service);

const selector = { path: [], schema: true };

/** A user-scoped root of `id`, naming `entityScopeKey` when one is given. */
const userRoot = (
  id: string,
  entityScopeKey?: GraphQuery["roots"][number]["entityScopeKey"],
): GraphQuery["roots"][number] => ({
  id,
  scope: "user",
  ...(entityScopeKey === undefined ? {} : { entityScopeKey }),
  selector,
});

describe("v2-instance-partitions", () => {
  describe("partitionGraphQuery()", () => {
    it("returns one partition under the caller's identity for roots naming no instance", () => {
      const query = { roots: [userRoot("of:a"), { id: "of:b", selector }] };

      expect(partitionGraphQuery(query, service)).toEqual([
        { instance: undefined, identity: service, query },
      ]);
    });

    it("returns a partition under a principal alone for a root naming another principal's `user` instance", () => {
      const own = userRoot("of:a");
      const named = userRoot("of:a", aliceUser);

      expect(partitionGraphQuery({ roots: [own, named] }, service)).toEqual([
        { instance: undefined, identity: service, query: { roots: [own] } },
        {
          instance: aliceUser,
          identity: { principal: alice.principal },
          query: { roots: [named] },
        },
      ]);
    });

    it("returns a partition under a principal and a session for a root naming a `session` instance", () => {
      const named = {
        ...userRoot("of:a", aliceSession),
        scope: "session" as const,
      };

      expect(partitionGraphQuery({ roots: [named] }, service)).toEqual([
        { instance: aliceSession, identity: alice, query: { roots: [named] } },
      ]);
    });

    it("keeps a root naming the caller's own instance, or the `space` instance, in the caller's partition", () => {
      const query = {
        branch: "feature",
        roots: [
          userRoot("of:a", serviceUser),
          { id: "of:b", entityScopeKey: "space" as const, selector },
        ],
      };

      expect(partitionGraphQuery(query, service)).toEqual([
        { instance: undefined, identity: service, query },
      ]);
    });

    it("returns one partition under the caller's identity for a query with no roots", () => {
      const query = { branch: "feature", roots: [] };

      expect(partitionGraphQuery(query, service)).toEqual([
        { instance: undefined, identity: service, query },
      ]);
    });
  });

  describe("watchGraphGroups()", () => {
    const watchOf = (
      id: string,
      branch: string | undefined,
      roots: GraphQuery["roots"],
    ): WatchSpec => ({
      id,
      kind: "graph",
      query: { ...(branch === undefined ? {} : { branch }), roots },
    });

    it("keys the caller's own roots by their branch, and a named instance's by the instance and the branch", () => {
      const own = userRoot("of:a");
      const named = userRoot("of:a", aliceUser);
      const featured = userRoot("of:b", aliceUser);

      const groups = watchGraphGroups([
        watchOf("w1", undefined, [own, named]),
        watchOf("w2", "feature", [featured]),
      ], service);

      expect([...groups]).toEqual([
        ["", {
          key: "",
          branch: "",
          identity: service,
          instance: undefined,
          query: { branch: "", roots: [own] },
        }],
        [`instance\0${aliceUser}\0`, {
          key: `instance\0${aliceUser}\0`,
          branch: "",
          identity: { principal: alice.principal },
          instance: aliceUser,
          query: { branch: "", roots: [named] },
        }],
        [`instance\0${aliceUser}\0feature`, {
          key: `instance\0${aliceUser}\0feature`,
          branch: "feature",
          identity: { principal: alice.principal },
          instance: aliceUser,
          query: { branch: "feature", roots: [featured] },
        }],
      ]);
    });

    it("gathers the roots of every watch on a branch into one group, in watch order", () => {
      const first = userRoot("of:a");
      const second = userRoot("of:b");

      const groups = watchGraphGroups([
        watchOf("w1", undefined, [first]),
        watchOf("w2", undefined, [second]),
      ], service);

      expect([...groups.values()].map((group) => group.query.roots)).toEqual([
        [first, second],
      ]);
    });

    it("returns no group for an operation watch", () => {
      const groups = watchGraphGroups([{
        id: "w1",
        kind: "operation",
        query: { id: "of:a", path: toValuePath([]) },
      }], service);

      expect(groups.size).toBe(0);
    });
  });
});
