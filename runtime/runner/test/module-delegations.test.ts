import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  closeDelegationsFor,
  composeRecordedEdges,
  inheritedAlongStamps,
  recordEdge,
  type StampedEdges,
} from "../src/module-delegations.ts";

/** Stamped edges from `[successor, predecessor, stamp]` triples. */
const stamped = (
  triples: readonly (readonly [string, string, number])[],
): Map<string, Map<string, number[]>> => {
  const edges = new Map<string, Map<string, number[]>>();
  for (const [identity, predecessor, stamp] of triples) {
    recordEdge(edges, identity, predecessor, stamp);
  }
  return edges;
};

const sorted = (values: Iterable<string>) => [...values].sort();

/** `edges` as a canonical string, stamps included. */
const canonical = (edges: StampedEdges): string =>
  JSON.stringify(
    [...edges].map(([identity, predecessors]) => [
      identity,
      [...predecessors].map(([predecessor, stamps]) => [predecessor, stamps])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

/** A deterministic generator of numbers in [0, 1), from `seed`. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Random stamped triples over `size` identities `m0`…, from `seed`. */
const randomTriples = (seed: number, size: number, count: number) => {
  const next = random(seed);
  return Array.from({ length: count }, () =>
    [
      `m${Math.floor(next() * size)}`,
      `m${Math.floor(next() * size)}`,
      Math.floor(next() * 6),
    ] as const);
};

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
  describe("inheritedAlongStamps()", () => {
    // Each case is a piece's history as its source updates record it: the
    // successor's edge to the module it succeeds, stamped with the history
    // position. The expected set is what a fresh `main` runtime grants from
    // the records those updates stage.
    for (
      const { name, triples, module, expected } of [
        {
          name: "follows an edge only through edges recorded at or before it",
          // X to A to Y to X; then a move back to A that derives nothing.
          triples: [["A", "X", 1], ["Y", "A", 2], ["X", "Y", 3]],
          module: "A",
          expected: ["X"],
        },
        {
          name:
            "follows a later edge once the same edge is recorded again after it",
          // The move back to A is a source update, recording A <- X at 4.
          triples: [["A", "X", 1], ["Y", "A", 2], ["X", "Y", 3], ["A", "X", 4]],
          module: "A",
          expected: ["X", "Y"],
        },
        {
          name:
            "follows an edge recorded early and again late from an edge between the two",
          triples: [["A", "X", 1], ["B", "A", 2], ["A", "X", 4]],
          module: "B",
          expected: ["A", "X"],
        },
        {
          name: "follows a chain whose stamps only fall",
          triples: [["w1", "w0", 1], ["w2", "w1", 2], ["w3", "w2", 3]],
          module: "w3",
          expected: ["w0", "w1", "w2"],
        },
        {
          name:
            "follows a revert by a source update to the module the successor replaced",
          triples: [["w1", "w0", 1], ["w2", "w1", 2], ["w1", "w2", 3]],
          module: "w1",
          expected: ["w0", "w2"],
        },
        {
          name: "follows every edge recorded at 0 from wherever it is reached",
          triples: [["n", "p", 5], ["p", "listed", 0], ["listed", "more", 0]],
          module: "n",
          expected: ["listed", "more", "p"],
        },
      ] as const
    ) {
      it(`${name}`, () => {
        expect(sorted(inheritedAlongStamps(stamped(triples), module)))
          .toEqual(expected);
      });
    }

    it("ends on a cycle, itself excepted", () => {
      const edges = stamped([["a", "b", 3], ["b", "c", 2], ["c", "a", 1]]);

      expect(sorted(inheritedAlongStamps(edges, "a"))).toEqual(["b", "c"]);
    });

    it("reaches every other identity of a forged dense relation, each expanded once", () => {
      // Two thousand identities, twenty edges each, each edge with every
      // stamp up to ten: the walk is linear in the edges and their stamps.
      const triples: [string, string, number][] = [];
      for (let index = 0; index < 2000; index++) {
        for (let step = 0; step < 20; step++) {
          const target = `d${(index + step * 97 + 1) % 2000}`;
          for (let stamp = 0; stamp <= 10; stamp++) {
            triples.push([`d${index}`, target, stamp]);
          }
        }
      }

      expect(inheritedAlongStamps(stamped(triples), "d0").size).toBe(1999);
    });

    it("never inherits less once an edge or a stamp is added", () => {
      // Edges and stamps are only ever added, so what a module inherits only
      // grows: the invariant the record rests on.
      for (let seed = 1; seed <= 300; seed++) {
        const triples = randomTriples(seed, 10, 25);
        const edges = stamped(triples);
        const nodes = [...new Set(triples.flatMap(([a, b]) => [a, b]))];
        const before = new Map(
          nodes.map((node) => [node, inheritedAlongStamps(edges, node)]),
        );
        for (
          const [identity, predecessor, stamp] of randomTriples(seed + 7, 10, 5)
        ) {
          recordEdge(edges, identity, predecessor, stamp);
        }
        for (const [node, inherited] of before) {
          const after = inheritedAlongStamps(edges, node);
          for (const identity of inherited) {
            expect(after.has(identity), `seed ${seed}`).toBe(true);
          }
        }
      }
    });
  });

  describe("recordEdge()", () => {
    it("keeps every stamp an edge was recorded at, once and ascending, whatever their order", () => {
      for (let seed = 1; seed <= 100; seed++) {
        const triples = randomTriples(seed, 6, 30);
        expect(canonical(stamped(shuffled(triples, seed))), `seed ${seed}`)
          .toBe(canonical(stamped(triples)));
      }
      expect([
        ...stamped([["a", "b", 4], ["a", "b", 1], ["a", "b", 4]])
          .get("a")!.get("b")!,
      ]).toEqual([1, 4]);
    });
  });

  describe("closeDelegationsFor()", () => {
    it("closes only the identities named, leaving out those that inherit nothing", () => {
      const edges = stamped([["a", "b", 2], ["b", "c", 1], ["stray", "s", 1]]);

      expect(closeDelegationsFor(edges, ["a", "c"])).toStrictEqual(
        new Map([["a", new Set(["b", "c"])]]),
      );
    });
  });

  describe("composeRecordedEdges()", () => {
    it("stamps each successor's edge with the position, and a listed entry the edges do not reach with 0", () => {
      const recorded = {
        edges: stamped([["p", "older", 2], ["older", "oldest", 1]]),
        position: 4,
      };
      const matched = new Map([
        ["n", { predecessor: "p", inherited: ["older", "oldest", "foreign"] }],
      ]);

      const { delegations, edges } = composeRecordedEdges(
        matched,
        recorded,
        ["n"],
      );

      expect(canonical(edges)).toBe(canonical(stamped([
        ["p", "older", 2],
        ["older", "oldest", 1],
        ["n", "p", 4],
        ["p", "foreign", 0],
      ])));
      expect(sorted(delegations.get("n")!)).toEqual([
        "foreign",
        "older",
        "oldest",
        "p",
      ]);
    });

    it("composes the same edges whatever order the matches and the recorded edges come in", () => {
      for (let seed = 1; seed <= 100; seed++) {
        const triples = randomTriples(seed, 8, 20);
        const next = random(seed + 3);
        const matched = Array.from({ length: 4 }, (_, index) =>
          [
            `n${index}`,
            {
              predecessor: `m${Math.floor(next() * 8)}`,
              inherited: Array.from(
                { length: 3 },
                () => `m${Math.floor(next() * 10)}`,
              ),
            },
          ] as const);
        const candidate = matched.map(([identity]) => identity);
        const reference = composeRecordedEdges(
          new Map(matched),
          { edges: stamped(triples), position: 9 },
          candidate,
        );
        const reordered = composeRecordedEdges(
          new Map(shuffled(matched, seed)),
          { edges: stamped(shuffled(triples, seed + 1)), position: 9 },
          shuffled(candidate, seed + 2),
        );

        expect(canonical(reordered.edges), `seed ${seed}`)
          .toBe(canonical(reference.edges));
      }
    });
  });
});
