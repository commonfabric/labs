import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { applyCommit, close, open } from "../v2/engine.ts";
import {
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
  // session's own, and each instance's links are attributed to the
  // instance holding them: the second visit, being the session's own,
  // takes down the override the first installed. The two are walked under
  // selectors of their own, since the traversal memo keys a document by
  // its scope's name and under one selector the second instance would be
  // answered by the first's traversal.

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
        trackGraph(space, engine, { roots: [...roots] }, undefined, service),
      );
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  };

  describe("trackGraph()", () => {
    it("attributes what each instance of a root reaches to that instance", async () => {
      await withTrackedInstances((_engine, tracked) => {
        const referrersOf = (id: string) =>
          [...tracked.state.trackedBy.entries()]
            .filter(([entry]) => entry.startsWith(`${space}/space/${id}\0`))
            .flatMap(([, referrers]) => [...referrers]);
        expect(referrersOf("of:x")).toEqual([`${space}/${aliceKey}/of:root`]);
        expect(referrersOf("of:y")).toEqual([
          `${space}/${serviceKey}/of:root`,
        ]);
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
        // The traversal of Alice's instance recorded the root under the
        // session's own key as well, attributed to Alice's instance, so
        // that record went with it.
        expect(
          [...tracked.state.tracker.values(`${space}/${serviceKey}/of:root`)]
            .map((selector) => selector.schema),
        ).toEqual([true]);
      });
    });
  });
});
