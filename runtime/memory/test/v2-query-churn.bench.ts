/**
 * Watch extension and removal on a fixed corpus, with either a repeated schema
 * or a distinct schema each cycle. Each sample owns a fresh graph. Fixture
 * creation, five warm-up cycles, and delivery checks are outside the timer.
 * Separate diagnostic runs collect the surviving heap every ten cycles; those
 * collections are excluded from the latency samples.
 */

import { expect } from "@std/expect";

import {
  collectedMemory,
  exposeGarbageCollector,
} from "@commonfabric/runner/collected-memory";

import type { GraphQueryRoot } from "../v2.ts";
import { applyCommit, close, open } from "../v2/engine.ts";
import {
  extendTrackedGraph,
  refreshTrackedGraph,
  releaseTrackedRoots,
  rootReferrersOf,
  toDirtyKey,
  trackGraph,
} from "../v2/query.ts";

const DOCS = sizeFromEnv("V2_QUERY_CHURN_DOCS", 1000);
const CYCLES = sizeFromEnv("V2_QUERY_CHURN_CYCLES", 100);
const WARMUP = 5;
const SPACE = "did:key:query-churn-bench";
const IDENTITY = { principal: "did:key:reader", sessionId: "reader" };
type Mode = "repeated" | "distinct";

function sizeFromEnv(name: string, fallback: number): number {
  const value = Number(Deno.env.get(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function rootFor(minimum: number): GraphQueryRoot {
  return {
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
  };
}

async function fixture() {
  const engine = await open({ url: new URL("memory://query-churn-bench") });
  applyCommit(engine, {
    ...IDENTITY,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [
        ...Array.from({ length: DOCS }, (_, rank) => ({
          op: "set" as const,
          id: `of:item:${rank}`,
          value: { value: { rank } },
        })),
        {
          op: "set",
          id: "of:board",
          value: {
            value: {
              items: Array.from({ length: DOCS }, (_, rank) => ({
                "/": {
                  "link@1": {
                    space: SPACE,
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
  const state = trackGraph(SPACE, engine, query, undefined, IDENTITY).state;
  return { engine, base, query, state };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function cycle({ engine, state }: Fixture, index: number, mode: Mode): void {
  const extra = rootFor(mode === "distinct" ? -index - 2 : -2);
  extendTrackedGraph(SPACE, engine, state, { roots: [extra] });
  releaseTrackedRoots(
    SPACE,
    engine,
    state,
    rootReferrersOf(SPACE, [extra], IDENTITY),
  );
}

function verify({ engine, state, base, query }: Fixture): void {
  expect(state.roots.size).toBe(1);
  expect(state.entities.size).toBe(DOCS + 1);
  expect(state.tracker.size).toBe(DOCS + 1);
  const fresh = trackGraph(SPACE, engine, query, undefined, IDENTITY).state;
  expect([...state.entities]).toEqual([...fresh.entities]);
  releaseTrackedRoots(
    SPACE,
    engine,
    fresh,
    rootReferrersOf(SPACE, [base], IDENTITY),
  );
  applyCommit(engine, {
    ...IDENTITY,
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
    SPACE,
    engine,
    state,
    new Set([toDirtyKey("of:item:0")]),
  );
  expect([...refreshed!.updates.values()].map((doc) => doc.document))
    .toContainEqual({ value: { rank: 42 } });
  releaseTrackedRoots(
    SPACE,
    engine,
    state,
    rootReferrersOf(SPACE, [base], IDENTITY),
  );
  expect(state.entities.size).toBe(0);
  expect(state.tracker.size).toBe(0);
  expect(state.manager.loadedAddresses()).toEqual([]);
}

exposeGarbageCollector();
for (const mode of ["repeated", "distinct"] as const) {
  // Diagnostics own a separate graph, so explicit collection cannot change a
  // timed sample's allocation pressure. Heap bytes cover the whole isolate.
  const f = await fixture();
  try {
    for (let i = 0; i < WARMUP; i++) cycle(f, i, mode);
    const samples = [{ cycle: 0, ...collectedMemory() }];
    let sampledMaxHeap = 0;
    let sampledMaxRss = 0;
    for (let i = 0; i < CYCLES; i++) {
      cycle(f, WARMUP + i, mode);
      const memory = Deno.memoryUsage();
      sampledMaxHeap = Math.max(sampledMaxHeap, memory.heapUsed);
      sampledMaxRss = Math.max(sampledMaxRss, memory.rss);
      if ((i + 1) % 10 === 0 || i + 1 === CYCLES) {
        expect(f.state.roots.size).toBe(1);
        expect(f.state.entities.size).toBe(DOCS + 1);
        expect(f.state.tracker.size).toBe(DOCS + 1);
        samples.push({ cycle: i + 1, ...collectedMemory() });
      }
    }
    console.error(JSON.stringify({
      benchmark: "v2-query-churn",
      mode,
      documents: DOCS + 1,
      cycles: CYCLES,
      samples,
      sampledMaxHeap,
      sampledMaxRss,
      retainedGrowthBytes: samples.at(-1)!.heapUsed - samples[0].heapUsed,
    }));
    verify(f);
  } finally {
    close(f.engine);
  }

  Deno.bench({
    name: `${mode} schema - docs=${DOCS + 1}, cycles=${CYCLES}`,
    group: "v2-query-churn",
    n: 1,
    warmup: 1,
    async fn(b) {
      const f = await fixture();
      try {
        for (let i = 0; i < WARMUP; i++) cycle(f, i, mode);
        b.start();
        for (let i = 0; i < CYCLES; i++) cycle(f, WARMUP + i, mode);
        b.end();
        verify(f);
      } finally {
        close(f.engine);
      }
    },
  });
}
