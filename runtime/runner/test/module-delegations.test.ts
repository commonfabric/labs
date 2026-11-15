import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  addDirectEdges,
  closeDelegationsFor,
  inheritedThrough,
} from "../src/module-delegations.ts";

const edgesOf = (
  entries: Record<string, readonly string[]>,
): Map<string, Set<string>> =>
  new Map(
    Object.entries(entries).map(([identity, predecessors]) => [
      identity,
      new Set(predecessors),
    ]),
  );

/** `edges` as a canonical string, for comparing two relations. */
const canonical = (edges: ReadonlyMap<string, ReadonlySet<string>>): string =>
  JSON.stringify(
    [...edges].filter(([, predecessors]) => predecessors.size > 0)
      .map(([identity, predecessors]) => [identity, [...predecessors].sort()])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

/** A deterministic generator of numbers in [0, 1), from `seed`. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * A random relation over `size` identities `m0`… and a random identity and
 * input list over them, from `seed`: cycles, chains and closed lists alike.
 */
const randomCase = (seed: number, size: number) => {
  const next = random(seed);
  const name = (index: number) => `m${index}`;
  const edges = new Map<string, Set<string>>();
  for (let index = 0; index < size; index++) {
    const predecessors = new Set<string>();
    for (let other = 0; other < size; other++) {
      if (other !== index && next() < 0.15) predecessors.add(name(other));
    }
    if (predecessors.size > 0) edges.set(name(index), predecessors);
  }
  const identity = name(Math.floor(next() * size));
  const inputs = Array.from(
    { length: Math.floor(next() * size) },
    () => name(Math.floor(next() * size)),
  );
  return { edges, identity, inputs };
};

const copy = (edges: ReadonlyMap<string, ReadonlySet<string>>) =>
  new Map([...edges].map(([identity, set]) => [identity, new Set(set)]));

const shuffled = <T>(values: readonly T[], seed: number): T[] => {
  const next = random(seed);
  const out = [...values];
  for (let index = out.length - 1; index > 0; index--) {
    const swap = Math.floor(next() * (index + 1));
    [out[index], out[swap]] = [out[swap], out[index]];
  }
  return out;
};

describe("module-delegations", () => {
  describe("inheritedThrough()", () => {
    it("returns every identity reached, itself excepted, and ends on a cycle", () => {
      const edges = edgesOf({ a: ["b"], b: ["c"], c: ["a", "d"] });

      expect([...inheritedThrough(edges, "a")].sort()).toEqual(["b", "c", "d"]);
    });
  });

  describe("closeDelegationsFor()", () => {
    it("closes only the identities named, leaving out those that reach nothing", () => {
      const edges = edgesOf({ a: ["b"], b: ["c"], stray: ["elsewhere"] });

      expect(closeDelegationsFor(edges, ["a", "c"])).toStrictEqual(
        new Map([["a", new Set(["b", "c"])]]),
      );
    });
  });

  describe("addDirectEdges()", () => {
    it("adds an edge only to the input the rest of a closed list is reached through", () => {
      const edges = edgesOf({ p: ["q"], q: ["r"] });

      addDirectEdges(edges, "n", ["r", "q", "p", "foreign"]);

      expect(canonical(edges)).toBe(
        canonical(edgesOf({ p: ["q"], q: ["r"], n: ["foreign", "p"] })),
      );
    });

    it("keeps one input of a cycle the inputs form, the first in UTF-8 order", () => {
      const edges = edgesOf({ x: ["y"], y: ["x"] });

      addDirectEdges(edges, "n", ["y", "x"]);

      expect([...edges.get("n")!]).toEqual(["x"]);
    });

    it("leaves every identity reaching what it reached before, and the identity reaching every input", () => {
      // The property the design rests on: an input is left out only when
      // something kept reaches it, and nothing is ever removed.
      for (let seed = 1; seed <= 500; seed++) {
        const { edges, identity, inputs } = randomCase(seed, 12);
        const before = new Map(
          [...new Set([...edges.keys(), identity, ...inputs])].map((node) => [
            node,
            inheritedThrough(edges, node),
          ]),
        );
        const added = copy(edges);

        addDirectEdges(added, identity, inputs);

        const expected = new Set(before.get(identity));
        for (const input of inputs) {
          if (input === identity) continue;
          expected.add(input);
          for (const reached of before.get(input) ?? []) expected.add(reached);
        }
        expected.delete(identity);
        expect([...inheritedThrough(added, identity)].sort(), `seed ${seed}`)
          .toEqual([...expected].sort());
        for (const [node, reached] of before) {
          for (const ancestor of reached) {
            expect(inheritedThrough(added, node).has(ancestor), `seed ${seed}`)
              .toBe(true);
          }
        }
        for (const [node, predecessors] of edges) {
          for (const predecessor of predecessors) {
            expect(added.get(node)?.has(predecessor), `seed ${seed}`).toBe(
              true,
            );
          }
        }
        for (const [node, predecessors] of added) {
          for (const predecessor of predecessors) {
            if (edges.get(node)?.has(predecessor)) continue;
            expect(node, `seed ${seed}`).toBe(identity);
            expect(inputs, `seed ${seed}`).toContain(predecessor);
          }
        }
      }
    });

    it("adds one edge for a forged dense relation whose inputs all reach one another", () => {
      // Two thousand identities, each with twenty edges, all in one cycle:
      // the walks are linear in the edges, so this is as cheap as the size of
      // the relation, and every input but one is left out.
      const size = 2000;
      const edges = new Map<string, Set<string>>();
      for (let index = 0; index < size; index++) {
        edges.set(
          `d${index}`,
          new Set(
            Array.from(
              { length: 20 },
              (_, step) => `d${(index + step * 97 + 1) % size}`,
            ),
          ),
        );
      }
      const inputs = Array.from({ length: size }, (_, index) => `d${index}`);

      addDirectEdges(edges, "forged", inputs);

      expect([...edges.get("forged")!]).toEqual(["d0"]);
      expect(inheritedThrough(edges, "forged").size).toBe(size);
    });

    it("adds the same edges whatever order the inputs and the recorded edges come in", () => {
      for (let seed = 1; seed <= 200; seed++) {
        const { edges, identity, inputs } = randomCase(seed, 12);
        const reference = copy(edges);
        addDirectEdges(reference, identity, inputs);

        const reordered = new Map(
          shuffled([...edges], seed).map(([node, predecessors]) => [
            node,
            new Set(shuffled([...predecessors], seed + 1)),
          ]),
        );
        addDirectEdges(reordered, identity, shuffled(inputs, seed + 2));

        expect(canonical(reordered), `seed ${seed}`).toBe(canonical(reference));
      }
    });
  });
});
