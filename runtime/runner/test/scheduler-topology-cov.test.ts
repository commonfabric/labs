import { expect } from "@std/expect";

import { CycleBreaks } from "../src/scheduler/topology.ts";
import type { Action } from "../src/scheduler/types.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** Actions named for the test, registered in the order given. */
function actions(...names: string[]): Record<string, Action> {
  return Object.fromEntries(
    names.map((name) => [name, Object.assign((): void => {}, { label: name })]),
  );
}

/**
 * The `CycleBreaks` over `edges` (`"a>b"` is an edge from `a` to `b`), with
 * nothing yet visited, each action's in-degree counted from the edges, and
 * the actions registered in the order `order` lists them.
 */
function breaksOver(
  named: Record<string, Action>,
  edges: string[],
  order: string[],
): CycleBreaks {
  const graph = new Map<Action, Set<Action>>();
  const inDegree = new Map<Action, number>();
  for (const action of Object.values(named)) {
    graph.set(action, new Set());
    inDegree.set(action, 0);
  }
  for (const edge of edges) {
    const [from, to] = edge.split(">");
    graph.get(named[from])!.add(named[to]);
    inDegree.set(named[to], inDegree.get(named[to])! + 1);
  }
  const rank = new Map(order.map((name, index) => [named[name], index]));
  return new CycleBreaks(
    new Set(Object.values(named)),
    new Set(),
    graph,
    inDegree,
    new Map(),
    (a, b) => rank.get(a)! - rank.get(b)!,
  );
}

describe("CycleBreaks", () => {
  describe("instance members", () => {
    describe("take()", () => {
      it("returns the member of a cycle with the lowest in-degree, ahead of an earlier-registered member", () => {
        const { a, b, c } = actions("a", "b", "c");
        const breaks = breaksOver(
          { a, b, c },
          ["a>b", "b>a", "b>c", "c>b"],
          ["b", "a", "c"],
        );

        expect(breaks.take()).toBe(a);
      });

      it("returns the earlier-registered member of a cycle when in-degrees tie, and never an action that only reads from it", () => {
        const { reader, a, b } = actions("reader", "a", "b");
        const breaks = breaksOver(
          { reader, a, b },
          ["a>b", "b>a", "b>reader"],
          ["reader", "b", "a"],
        );

        expect(breaks.take()).toBe(b);
      });

      it("throws when no unplaced action is on a cycle", () => {
        const { a, b } = actions("a", "b");
        const breaks = breaksOver({ a, b }, ["a>b"], ["a", "b"]);

        expect(() => breaks.take()).toThrow(
          "A cycle break found no cycle to break.",
        );
      });
    });
  });
});
