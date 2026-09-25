import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { encodeMemoryBoundary } from "../v2.ts";
import { applyCommit, close, type Engine, open } from "../v2/engine.ts";
import {
  refreshTrackedGraph,
  toDirtyKey,
  type TrackedGraphState,
  trackGraph,
} from "../v2/query.ts";

const identity = { principal: "did:key:alice", sessionId: "session:alice" };
const space = "did:key:z6Mk-memory-v2-refresh-schema-closure";
const carrier = "of:refresh-closure-carrier";
const tally = "of:refresh-closure-tally";

const leafSchema = { type: "string", title: "refresh-closure-leaf" } as const;
const leafHash = internSchemaAsTaggedHashString(leafSchema);
const outerSchema = {
  type: "object",
  properties: { x: { $ref: `cid:${leafHash}` } },
} as const;
const outerHash = internSchemaAsTaggedHashString(outerSchema);

// `fresh` references a schema document of its own and the established
// `leaf`, so delivering it shows where the walk stops.
const freshLeafSchema = {
  type: "number",
  title: "refresh-closure-fresh-leaf",
} as const;
const freshLeafHash = internSchemaAsTaggedHashString(freshLeafSchema);
const freshSchema = {
  type: "object",
  properties: {
    x: { $ref: `cid:${leafHash}` },
    y: { $ref: `cid:${freshLeafHash}` },
  },
} as const;
const freshHash = internSchemaAsTaggedHashString(freshSchema);

const docKey = (id: string) => `${space}/space/${id}` as const;

/** A link to `of:refresh-closure-target` whose schema references `hash`. */
const linkWithSchemaRef = (hash: string) => ({
  "/": {
    "link@1": {
      id: "of:refresh-closure-target",
      path: [],
      schema: { $ref: `cid:${hash}` },
    },
  },
});

const commit = (
  engine: Engine,
  localSeq: number,
  operations: Parameters<typeof applyCommit>[1]["commit"]["operations"],
): void => {
  applyCommit(engine, {
    sessionId: identity.sessionId,
    principal: identity.principal,
    commit: { localSeq, reads: { confirmed: [], pending: [] }, operations },
  });
};

/**
 * Opens an engine holding a carrier whose link schema references `outer`,
 * which references `leaf`, plus an unrelated tally document; tracks both
 * documents under selectors that read nothing through a link, so the
 * closure pass is the only route by which a schema document arrives; and
 * hands the graph state to `fn`.
 */
const withTrackedCarrier = async (
  fn: (engine: Engine, state: TrackedGraphState) => void,
): Promise<void> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  try {
    commit(engine, 1, [
      { op: "set", id: `cid:${leafHash}`, value: { value: leafSchema } },
      { op: "set", id: `cid:${outerHash}`, value: { value: outerSchema } },
      {
        op: "set",
        id: carrier,
        value: { value: { x: linkWithSchemaRef(outerHash) } },
      },
      { op: "set", id: tally, value: { value: { votes: 1 } } },
    ]);
    const tracked = trackGraph(
      space,
      engine,
      {
        roots: [
          { id: carrier, selector: { path: [], schema: false } },
          { id: tally, selector: { path: [], schema: false } },
        ],
      },
      undefined,
      identity,
    );
    expect(tracked.state.entities.has(docKey(`cid:${leafHash}`))).toBe(true);
    expect(tracked.state.entities.has(docKey(`cid:${outerHash}`))).toBe(true);
    fn(engine, tracked.state);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
};

describe("v2-refresh-schema-closure", () => {
  describe("refreshTrackedGraph()", () => {
    // A case that counts reads takes `stats.managerReads`, which counts
    // every document the refresh read from the engine: the dirty document's
    // re-walk is one read, and every schema document the closure pass loads
    // is one more.

    it("reads only the changed document when a document without schema refs changes", async () => {
      await withTrackedCarrier((engine, state) => {
        commit(engine, 2, [
          { op: "set", id: tally, value: { value: { votes: 2 } } },
        ]);
        const refreshed = refreshTrackedGraph(
          space,
          engine,
          state,
          new Set([toDirtyKey(tally)]),
        );
        expect(refreshed).not.toBeNull();
        expect([...refreshed!.updates.keys()]).toEqual([docKey(tally)]);
        expect(refreshed!.stats.managerReads).toBe(1);
      });
    });

    it("reads no established schema document when a changed document still references it", async () => {
      await withTrackedCarrier((engine, state) => {
        commit(engine, 2, [{
          op: "set",
          id: carrier,
          value: { value: { x: linkWithSchemaRef(outerHash), n: 2 } },
        }]);
        const refreshed = refreshTrackedGraph(
          space,
          engine,
          state,
          new Set([toDirtyKey(carrier)]),
        );
        expect(refreshed).not.toBeNull();
        expect([...refreshed!.updates.keys()]).toEqual([docKey(carrier)]);
        expect(refreshed!.stats.managerReads).toBe(1);
      });
    });

    it("delivers and tracks the closure a changed document newly references, up to the established schema documents", async () => {
      await withTrackedCarrier((engine, state) => {
        commit(engine, 2, [
          {
            op: "set",
            id: `cid:${freshLeafHash}`,
            value: { value: freshLeafSchema },
          },
          { op: "set", id: `cid:${freshHash}`, value: { value: freshSchema } },
          {
            op: "set",
            id: carrier,
            value: { value: { x: linkWithSchemaRef(freshHash) } },
          },
        ]);
        const refreshed = refreshTrackedGraph(
          space,
          engine,
          state,
          new Set([toDirtyKey(carrier)]),
        );
        expect(refreshed).not.toBeNull();
        expect([...refreshed!.updates.keys()].sort()).toEqual(
          [
            docKey(carrier),
            docKey(`cid:${freshHash}`),
            docKey(`cid:${freshLeafHash}`),
          ].sort(),
        );
        expect(state.tracker.has(docKey(`cid:${freshHash}`))).toBe(true);
        expect(state.tracker.has(docKey(`cid:${freshLeafHash}`))).toBe(true);
        // The carrier and the two new schema documents; `leaf` is
        // established, so it is neither read nor delivered again.
        expect(refreshed!.stats.managerReads).toBe(3);
      });
    });

    it("throws when a changed document references a schema document whose stored content does not hash to its id", async () => {
      await withTrackedCarrier((engine, state) => {
        commit(engine, 2, [
          {
            op: "set",
            id: `cid:${freshLeafHash}`,
            value: { value: freshLeafSchema },
          },
          { op: "set", id: `cid:${freshHash}`, value: { value: freshSchema } },
          {
            op: "set",
            id: carrier,
            value: { value: { x: linkWithSchemaRef(freshHash) } },
          },
        ]);
        // The commit boundary refuses a forged `cid:` document, so only an
        // out-of-band write to the store can hold one.
        engine.database.prepare(
          `UPDATE revision SET data = :data WHERE id = :id`,
        ).run({
          data: encodeMemoryBoundary({
            value: { type: "boolean", title: "forged" },
          }),
          id: `cid:${freshLeafHash}`,
        });
        expect(() =>
          refreshTrackedGraph(
            space,
            engine,
            state,
            new Set([toDirtyKey(carrier)]),
          )
        ).toThrow("did not verify in this space");
      });
    });

    it("throws when a changed document references a schema document the space does not hold", async () => {
      await withTrackedCarrier((engine, state) => {
        const absentHash = internSchemaAsTaggedHashString({
          type: "null",
          title: "refresh-closure-never-installed",
        });
        // A patch inside an existing link's schema introduces a reference
        // the commit boundary does not collect, so the store accepts it.
        commit(engine, 2, [{
          op: "patch",
          id: carrier,
          patches: [{
            op: "replace",
            path: "/value/x/~1/link@1/schema/$ref",
            value: `cid:${absentHash}`,
          }],
        }]);
        expect(() =>
          refreshTrackedGraph(
            space,
            engine,
            state,
            new Set([toDirtyKey(carrier)]),
          )
        ).toThrow("is not stored in this space");
      });
    });
  });
});
