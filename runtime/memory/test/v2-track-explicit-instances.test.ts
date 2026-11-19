import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { applyCommit, close, open } from "../v2/engine.ts";
import {
  EngineObjectManager,
  releaseTrackedRoots,
  rootReferrersOf,
  trackGraph,
} from "../v2/query.ts";

const space = "did:key:z6Mk-memory-v2-track-explicit-instances";
const service = { principal: "did:key:service", sessionId: "session:service" };
const alice = { principal: "did:key:alice", sessionId: "session:alice" };
const serviceKey = "user:did%3Akey%3Aservice";
const aliceKey = "user:did%3Akey%3Aalice";

/** A link to the space-scoped `id`: a link without a scope of its own is
 * read in the scope of the document holding it. */
const link = (id: string) => ({
  "/": { "link@1": { id, path: [], space, scope: "space" } },
});

const userRoot = (id: string, child: string) => ({
  op: "set" as const,
  id,
  scope: "user" as const,
  value: { value: { child: link(child) } },
});

describe("v2-track-explicit-instances", () => {
  // One walk visits Alice's user instance of `of:root` and then the
  // session's own, under selectors of their own, and each instance's links
  // are attributed to the instance holding them.

  const roots = [
    {
      id: "of:root",
      scope: "user",
      entityScopeKey: aliceKey,
      selector: {
        path: [],
        schema: { type: "object", properties: { child: { type: "object" } } },
      },
    },
    { id: "of:root", scope: "user", selector: { path: [], schema: true } },
  ] as const;

  const withTrackedInstances = async (
    fn: (
      engine: Awaited<ReturnType<typeof open>>,
      tracked: ReturnType<typeof trackGraph>,
    ) => void,
    tracking: readonly Parameters<typeof trackGraph>[2]["roots"][number][] =
      roots,
  ): Promise<void> => {
    const path = await Deno.makeTempFile({ suffix: ".sqlite" });
    const engine = await open({ url: toFileUrl(path) });
    try {
      applyCommit(engine, {
        ...alice,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [
            userRoot("of:root", "of:x"),
            { op: "set", id: "of:x", value: { value: { name: "x" } } },
            { op: "set", id: "of:y", value: { value: { name: "y" } } },
            {
              op: "set",
              id: "of:e",
              value: {
                value: {
                  r: {
                    "/": {
                      "link@1": {
                        id: "of:root",
                        path: [],
                        space,
                        scope: "user",
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      });
      applyCommit(engine, {
        ...service,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [userRoot("of:root", "of:y")],
        },
      });
      fn(
        engine,
        trackGraph(space, engine, { roots: [...tracking] }, undefined, service),
      );
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  };

  describe("trackGraph()", () => {
    it("attributes what each instance of a root reaches to that instance", async () => {
      await withTrackedInstances((_engine, tracked) => {
        // Each referrer is the record, one instance under one selector,
        // whose walk reached the document; its key leads with the
        // instance's document key.
        const referrersOf = (id: string) =>
          [...tracked.state.trackedBy.entries()]
            .filter(([entry]) => entry.startsWith(`${space}/space/${id}\0`))
            .flatMap(([, referrers]) => [...referrers])
            .map((referrer) => referrer.split("\0"));
        expect(referrersOf("of:x")).toEqual([
          [`${space}/${aliceKey}/of:root`, expect.any(String)],
        ]);
        expect(referrersOf("of:y")).toEqual([
          [`${space}/${serviceKey}/of:root`, expect.any(String)],
        ]);
      });
    });

    it("delivers what each instance of a root reaches when both are walked under one selector", async () => {
      // The session's own instance and then Alice's, named explicitly, are
      // walked under one selector. They are one document by scope name, so
      // each instance's positions are memoized apart.

      await withTrackedInstances((_engine, tracked) => {
        expect(
          [...tracked.state.entities.values()].map((entity) => entity.id)
            .toSorted(),
        ).toEqual(["of:root", "of:root", "of:x", "of:y"]);
      }, [{ ...roots[1], selector: roots[0].selector }, roots[0]]);
    });

    it("reaches the session's own instance through a link from a root walked after another instance's", async () => {
      // `of:e` links to `of:root` in the user scope, which a walk reads as
      // the session's own instance, after the walk of Alice's instance.

      await withTrackedInstances((_engine, tracked) => {
        expect(
          [...tracked.state.entities.values()].map((entity) => entity.id)
            .toSorted(),
        ).toEqual(["of:e", "of:root", "of:root", "of:x", "of:y"]);
      }, [roots[0], {
        id: "of:e",
        selector: {
          path: [],
          schema: {
            type: "object",
            properties: {
              r: {
                type: "object",
                properties: {
                  child: { type: "object" },
                  other: { type: "string" },
                },
              },
            },
          },
        },
      }]);
    });

    it("delivers what the session's own instance reaches when it follows another instance under one selector", async () => {
      // Alice's instance, named explicitly, and then the session's own are
      // walked under one selector, so the walk of Alice's instance records
      // only Alice's instance under it.

      await withTrackedInstances((_engine, tracked) => {
        expect(
          [...tracked.state.entities.values()].map((entity) => entity.id)
            .toSorted(),
        ).toEqual(["of:root", "of:root", "of:x", "of:y"]);
      }, [roots[0], { ...roots[1], selector: roots[0].selector }]);
    });

    it("reaches the session's own instance through a link inside another instance's walk", async () => {
      // Alice's instance of `of:root` links to `of:root` in the user scope,
      // which a walk reads as the session's own instance, under the schema
      // Alice's instance is walked under.

      const path = await Deno.makeTempFile({ suffix: ".sqlite" });
      const engine = await open({ url: toFileUrl(path) });
      try {
        applyCommit(engine, {
          ...alice,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [
              {
                op: "set",
                id: "of:root",
                scope: "user",
                value: {
                  value: {
                    child: link("of:x"),
                    next: {
                      "/": {
                        "link@1": {
                          id: "of:root",
                          path: [],
                          space,
                          scope: "user",
                        },
                      },
                    },
                  },
                },
              },
              { op: "set", id: "of:x", value: { value: { name: "x" } } },
              { op: "set", id: "of:y", value: { value: { name: "y" } } },
            ],
          },
        });
        applyCommit(engine, {
          ...service,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [userRoot("of:root", "of:y")],
          },
        });
        const tracked = trackGraph(
          space,
          engine,
          {
            roots: [{
              id: "of:root",
              scope: "user",
              entityScopeKey: aliceKey,
              selector: {
                path: [],
                schema: {
                  $ref: "#/$defs/Node",
                  $defs: {
                    Node: {
                      type: "object",
                      properties: {
                        child: { type: "object" },
                        next: { $ref: "#/$defs/Node" },
                      },
                    },
                  },
                },
              },
            }],
          },
          undefined,
          service,
        );

        expect(
          [...tracked.state.entities.values()].map((entity) => entity.id)
            .toSorted(),
        ).toEqual(["of:root", "of:root", "of:x", "of:y"]);
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });
  });

  describe("EngineObjectManager.load()", () => {
    it("names the instance on a loaded address only where it is not the manager's own", async () => {
      // The session's own instance is loaded first under its explicit key,
      // and then as the session's own, and both name it the same way.

      await withTrackedInstances((engine) => {
        const manager = new EngineObjectManager(
          engine,
          "",
          service.principal,
          service.sessionId,
        );
        const scopeKeyOf = (scopeKey?: typeof aliceKey | typeof serviceKey) =>
          manager.load({
            id: "of:root",
            scope: "user",
            ...(scopeKey === undefined ? {} : { scopeKey }),
          })?.address.scopeKey;

        expect(scopeKeyOf(serviceKey)).toBeUndefined();
        expect(scopeKeyOf()).toBeUndefined();
        expect(scopeKeyOf(aliceKey)).toBe(aliceKey);
      });
    });
  });

  describe("releaseTrackedRoots()", () => {
    it("retracts what the released instance reaches and keeps what the session's own instance reaches", async () => {
      await withTrackedInstances((engine, tracked) => {
        const released = releaseTrackedRoots(
          space,
          engine,
          tracked.state,
          rootReferrersOf(space, [roots[0]], service),
        );
        expect([...released.removed].toSorted()).toEqual([
          `${space}/space/of:x`,
          `${space}/${aliceKey}/of:root`,
        ]);
        expect(
          [...tracked.state.entities.values()].map((entity) => entity.id)
            .toSorted(),
        ).toEqual(["of:root", "of:y"]);
        // The session's own instance keeps the record its own walk made,
        // and the walk of Alice's instance made none under its key.
        expect(
          [...tracked.state.tracker.values(`${space}/${serviceKey}/of:root`)]
            .map((selector) => selector.schema),
        ).toEqual([true]);
      });
    });
  });
});
