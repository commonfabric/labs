import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { applyCommit, close, open } from "../v2/engine.ts";
import {
  extendTrackedGraph,
  partitionGraphQuery,
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
  // The service's session tracks Alice's user instance of `of:root`, named
  // explicitly, and its own. Alice's links to `of:x` and the service's to
  // `of:y`. The roots are walked as the server walks them: each under the
  // identity its instance belongs to, in a graph of its own
  // (`partitionGraphQuery()`), so the walk of Alice's instance records
  // nothing under the session's own.

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

  type Root = Parameters<typeof trackGraph>[2]["roots"][number];
  type Tracked = ReturnType<typeof trackGraph>;

  const withEngine = async (
    fn: (engine: Awaited<ReturnType<typeof open>>) => void,
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
      fn(engine);
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  };

  /**
   * Tracks `tracking` for the service's session, and hands `fn` one graph
   * for each identity the roots are walked under, in the roots' order.
   */
  const withTrackedInstances = (
    fn: (
      engine: Awaited<ReturnType<typeof open>>,
      graphs: Tracked[],
    ) => void,
    tracking: readonly Root[] = roots,
  ): Promise<void> =>
    withEngine((engine) =>
      fn(
        engine,
        partitionGraphQuery({ roots: [...tracking] }, service).map((part) =>
          trackGraph(space, engine, part.query, undefined, part.identity)
        ),
      )
    );

  /** The ids of the documents `graphs` deliver between them, sorted. */
  const deliveredIds = (graphs: readonly Tracked[]): string[] =>
    graphs.flatMap((tracked) =>
      [...tracked.state.entities.values()].map((entity) => entity.id)
    ).toSorted();

  describe("trackGraph()", () => {
    it("attributes what each instance of a root reaches to that instance", async () => {
      await withTrackedInstances((_engine, graphs) => {
        // Each referrer is the record, one instance under one selector,
        // whose walk reached the document; its key leads with the
        // instance's document key.
        const referrersOf = (id: string) =>
          graphs.flatMap((tracked) => [...tracked.state.trackedBy.entries()])
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
      // walked under one selector.

      await withTrackedInstances((_engine, graphs) => {
        expect(deliveredIds(graphs)).toEqual([
          "of:root",
          "of:root",
          "of:x",
          "of:y",
        ]);
      }, [{ ...roots[1], selector: roots[0].selector }, roots[0]]);
    });

    it("delivers what the session's own instance reaches when it follows another instance under one selector", async () => {
      // Alice's instance, named explicitly, and then the session's own are
      // walked under one selector. `of:y` is reached from the session's own
      // instance alone.

      await withTrackedInstances((_engine, graphs) => {
        expect(deliveredIds(graphs)).toEqual([
          "of:root",
          "of:root",
          "of:x",
          "of:y",
        ]);
      }, [roots[0], { ...roots[1], selector: roots[0].selector }]);
    });

    it("reaches the session's own instance through a link from a root walked after another instance's", async () => {
      // `of:e` links to `of:root` in the user scope, which the session's own
      // walk reads as the session's own instance.

      await withTrackedInstances((_engine, graphs) => {
        expect(deliveredIds(graphs)).toEqual([
          "of:e",
          "of:root",
          "of:root",
          "of:x",
          "of:y",
        ]);
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

    it("throws for a root naming an instance of a scope other than the one it declares", async () => {
      await withEngine((engine) => {
        expect(() =>
          trackGraph(
            space,
            engine,
            { roots: [{ ...roots[0], scope: "session" }] },
            undefined,
            { principal: alice.principal },
          )
        ).toThrow("declares the `session` scope");
      });
    });

    it("throws for a root naming an instance of an identity other than the one it walks under", async () => {
      await withEngine((engine) => {
        expect(() =>
          trackGraph(space, engine, { roots: [roots[0]] }, undefined, service)
        ).toThrow("names a scope instance of another identity");
      });
    });
  });

  describe("extendTrackedGraph()", () => {
    it("throws for a root naming an instance of an identity other than the graph's", async () => {
      await withEngine((engine) => {
        const { state } = trackGraph(
          space,
          engine,
          { roots: [roots[1]] },
          undefined,
          service,
        );

        expect(() =>
          extendTrackedGraph(space, engine, state, { roots: [roots[0]] })
        ).toThrow("names a scope instance of another identity");
      });
    });
  });

  describe("releaseTrackedRoots()", () => {
    it("retracts what the released instance reaches", async () => {
      await withTrackedInstances((engine, [ofAlice]) => {
        const released = releaseTrackedRoots(
          space,
          engine,
          ofAlice.state,
          rootReferrersOf(space, [roots[0]], { principal: alice.principal }),
        );

        expect([...released.removed].toSorted()).toEqual([
          `${space}/space/of:x`,
          `${space}/${aliceKey}/of:root`,
        ]);
        expect(deliveredIds([ofAlice])).toEqual([]);
      });
    });
  });
});
