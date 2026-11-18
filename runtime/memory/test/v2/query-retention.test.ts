import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  collectedMemory,
  exposeGarbageCollector,
} from "@commonfabric/runner/collected-memory";

import type { GraphQueryRoot } from "../../v2.ts";
import { applyCommit, close, open } from "../../v2/engine.ts";
import {
  extendTrackedGraph,
  refreshTrackedGraph,
  releaseTrackedRoots,
  rootReferrersOf,
  toDirtyKey,
  trackGraph,
} from "../../v2/query.ts";

describe("query", () => {
  it("keeps a fixed watch corpus bounded through schema churn and still delivers changes", async () => {
    exposeGarbageCollector();
    const engine = await open({ url: new URL("memory://query-retention") });
    const space = "did:key:query-retention";
    const identity = { principal: "did:key:reader", sessionId: "reader" };
    const count = 1000;
    const rootFor = (minimum: number): GraphQueryRoot => ({
      id: "of:board",
      selector: {
        path: [],
        schema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: { rank: { type: "number", minimum } },
              },
            },
          },
        },
      },
    });
    try {
      applyCommit(engine, {
        ...identity,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [
            ...Array.from({ length: count }, (_, rank) => ({
              op: "set" as const,
              id: `of:item:${rank}`,
              value: { value: { rank } },
            })),
            {
              op: "set",
              id: "of:board",
              value: {
                value: {
                  items: Array.from({ length: count }, (_, rank) => ({
                    "/": {
                      "link@1": {
                        space,
                        scope: "space",
                        id: `of:item:${rank}`,
                        path: [],
                      },
                    },
                  })),
                },
              },
            },
          ],
        },
      });
      const base = rootFor(-1);
      const query = { roots: [base] };
      const state = trackGraph(space, engine, query, undefined, identity).state;
      const churn = (cycle: number) => {
        const extra = rootFor(-cycle - 2);
        extendTrackedGraph(space, engine, state, { roots: [extra] });
        releaseTrackedRoots(
          space,
          engine,
          state,
          rootReferrersOf(space, [extra], identity),
        );
        expect(state.roots.size).toBe(1);
        expect(state.entities.size).toBe(count + 1);
        expect(state.tracker.size).toBe(count + 1);
      };
      for (let cycle = 0; cycle < 3; cycle++) churn(cycle);
      const before = collectedMemory().heapUsed;
      for (let cycle = 3; cycle < 33; cycle++) churn(cycle);
      const retained = collectedMemory().heapUsed - before;
      // The corpus stays fixed. Allow allocator and schema-interning noise,
      // but not a retained traversal result per document per removed schema.
      expect(retained).toBeLessThan(8 * 1024 * 1024);
      const fresh = trackGraph(space, engine, query, undefined, identity).state;
      expect([...state.entities]).toEqual([...fresh.entities]);

      applyCommit(engine, {
        ...identity,
        commit: {
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:item:0",
            value: { value: { rank: 42 } },
          }],
        },
      });
      const refreshed = refreshTrackedGraph(
        space,
        engine,
        state,
        new Set([toDirtyKey("of:item:0")]),
      );
      expect([...refreshed!.updates.values()].map((doc) => doc.document))
        .toContainEqual({ value: { rank: 42 } });
      releaseTrackedRoots(
        space,
        engine,
        state,
        rootReferrersOf(space, [base], identity),
      );
      expect(state.entities.size).toBe(0);
      expect(state.tracker.size).toBe(0);
      expect(state.manager.loadedAddresses()).toEqual([]);
    } finally {
      close(engine);
    }
  });
});
