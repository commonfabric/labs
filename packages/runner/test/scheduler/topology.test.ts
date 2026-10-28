import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { NodeRegistry } from "../../src/scheduler/node-record.ts";
import { topologicalSort } from "../../src/scheduler/topology.ts";
import type { Action } from "../../src/scheduler/types.ts";

/**
 * A registry that counts how often the sort reads an action's parent, which
 * is what a cycle break spends when it ranks the whole unvisited set each
 * time.
 */
class CountingRegistry extends NodeRegistry {
  parentLookups = 0;

  override parentActionOf(action: Action): Action | undefined {
    this.parentLookups++;
    return super.parentActionOf(action);
  }
}

/** `count` actions registered in order, each named by its index. */
function registerActions(
  nodes: NodeRegistry,
  count: number,
  parentOf?: (index: number) => number | undefined,
): Action[] {
  const actions: Action[] = [];
  for (let index = 0; index < count; index++) {
    const action: Action = () => {};
    Object.defineProperty(action, "name", { value: `a${index}` });
    actions.push(action);
    nodes.register(action, "computation");
  }
  for (let index = 0; index < count; index++) {
    const parent = parentOf?.(index);
    if (parent !== undefined) nodes.linkParent(actions[index], actions[parent]);
  }
  return actions;
}

/** The pull-mode data edges of a sort: `from` runs before each of `to`. */
function edges(
  pairs: readonly (readonly [Action, readonly Action[]])[],
): WeakMap<Action, Set<Action>> {
  const dependents = new WeakMap<Action, Set<Action>>();
  for (const [from, to] of pairs) dependents.set(from, new Set(to));
  return dependents;
}

const names = (order: readonly Action[]) => order.map((action) => action.name);

/**
 * The ordering rule stated directly, so the randomized case below holds the
 * sort to the rule rather than to itself: data edges first, a parent before
 * its child unless a data edge opposes it, registration order among the
 * ready, and where a cycle leaves none ready, a member of a cycle that no
 * unvisited action outside it feeds. Among those members the preference is
 * no unvisited parent, then the lowest remaining in-degree, then the
 * earliest registration. What each unvisited action reaches is worked out
 * again at every break, which is the cost the sort itself must not pay.
 */
function referenceOrder(
  actions: readonly Action[],
  dependents: WeakMap<Action, Set<Action>>,
  nodes: NodeRegistry,
): Action[] {
  const set = new Set(actions);
  const graph = new Map<Action, Set<Action>>();
  const inDegree = new Map<Action, number>();
  for (const action of actions) {
    graph.set(action, new Set());
    inDegree.set(action, 0);
  }
  for (const from of actions) {
    for (const to of dependents.get(from) ?? []) {
      graph.get(from)!.add(to);
      inDegree.set(to, inDegree.get(to)! + 1);
    }
  }
  for (const child of actions) {
    const parent = nodes.parentActionOf(child);
    if (!parent || !set.has(parent)) continue;
    if (graph.get(parent)!.has(child) || graph.get(child)!.has(parent)) {
      continue;
    }
    graph.get(parent)!.add(child);
    inDegree.set(child, inDegree.get(child)! + 1);
  }
  const ordinal = (action: Action) => nodes.getRegistrationOrdinal(action)!;
  const byRegistration = (a: Action, b: Action) => ordinal(a) - ordinal(b);
  const visited = new Set<Action>();
  const result: Action[] = [];

  // The unvisited actions `from` reaches over one or more edges.
  const reachedFrom = (from: Action): Set<Action> => {
    const reached = new Set<Action>();
    const pending = [from];
    while (pending.length > 0) {
      for (const next of graph.get(pending.pop()!)!) {
        if (visited.has(next) || reached.has(next)) continue;
        reached.add(next);
        pending.push(next);
      }
    }
    return reached;
  };

  let queue = actions.filter((action) => inDegree.get(action) === 0)
    .sort(byRegistration);
  while (queue.length > 0 || visited.size < actions.length) {
    if (queue.length === 0) {
      const unvisited = actions.filter((action) => !visited.has(action));
      const reach = new Map(
        unvisited.map((action) => [action, reachedFrom(action)]),
      );
      // On a cycle, and reaching every unvisited action that reaches it.
      const onUnfedCycle = (action: Action) =>
        reach.get(action)!.has(action) &&
        unvisited.every((other) =>
          !reach.get(other)!.has(action) || reach.get(action)!.has(other)
        );
      const blocked = (action: Action) => {
        const parent = nodes.parentActionOf(action);
        return parent !== undefined && set.has(parent) &&
          !visited.has(parent);
      };
      const candidates = unvisited.filter(onUnfedCycle);
      candidates.sort((a, b) => {
        if (blocked(a) !== blocked(b)) return blocked(a) ? 1 : -1;
        const byDegree = inDegree.get(a)! - inDegree.get(b)!;
        return byDegree !== 0 ? byDegree : byRegistration(a, b);
      });
      queue.push(candidates[0]);
    }
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    result.push(current);
    for (const next of graph.get(current)!) {
      inDegree.set(next, inDegree.get(next)! - 1);
      if (inDegree.get(next) === 0) {
        queue = [...queue, next].sort(byRegistration);
      }
    }
  }
  return result;
}

/** A small deterministic generator, so a failing seed can be rerun. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("topologicalSort()", () => {
  describe("cycle break", () => {
    // Each case holds a read/write cycle the sort cannot order by edges.
    // The expected orders are worked out by hand from the rule.

    describe("where the break falls", () => {
      // A break is taken at a member of a cycle that no unvisited action
      // outside it feeds, whatever the preference order would make of the
      // actions around the cycle.

      it("places an action that reads from a cycle after the member it reads", () => {
        const nodes = new NodeRegistry();
        const [a0, a1, a2, a3] = registerActions(nodes, 4);
        // `a1`, `a2` and `a3` each feed the other two, so each has
        // in-degree two. `a0` reads `a1` alone: it registered first and has
        // the lowest in-degree, and is on no cycle.
        const order = topologicalSort(
          new Set([a0, a1, a2, a3]),
          new WeakMap(),
          new WeakMap(),
          nodes,
          edges([[a1, [a2, a3, a0]], [a2, [a1, a3]], [a3, [a1, a2]]]),
        );

        expect(names(order)).toEqual(["a1", "a0", "a2", "a3"]);
      });

      it("places a cycle that feeds another before the one it feeds", () => {
        const nodes = new NodeRegistry();
        const [a0, a1, a2, a3] = registerActions(nodes, 4);
        // `a0`/`a1` and `a2`/`a3` are cycles, and `a3` feeds `a0`, so the
        // first break falls in `a2`/`a3` although `a0` and `a1` registered
        // first.
        const order = topologicalSort(
          new Set([a0, a1, a2, a3]),
          new WeakMap(),
          new WeakMap(),
          nodes,
          edges([[a0, [a1]], [a1, [a0]], [a2, [a3]], [a3, [a2, a0]]]),
        );

        expect(names(order)).toEqual(["a2", "a3", "a0", "a1"]);
      });

      it("places an action that a break left reading from a smaller cycle after the member it reads", () => {
        const nodes = new NodeRegistry();
        const [a0, a1, a2, a3] = registerActions(nodes, 4);
        // One cycle over all four: `a0` feeds `a2`, `a2` and `a3` feed each
        // other, `a2` feeds `a1`, and `a1` feeds `a0`. The first break
        // places `a0`, which leaves `a2`/`a3` a cycle and `a1` reading from
        // it, on no cycle of its own and registered before both.
        const order = topologicalSort(
          new Set([a0, a1, a2, a3]),
          new WeakMap(),
          new WeakMap(),
          nodes,
          edges([[a0, [a2]], [a2, [a3, a1]], [a3, [a2]], [a1, [a0]]]),
        );

        expect(names(order)).toEqual(["a0", "a2", "a1", "a3"]);
      });

      it("places an action listed as its own dependent without a break", () => {
        const nodes = new NodeRegistry();
        const [a0, a1] = registerActions(nodes, 2);
        const order = topologicalSort(
          new Set([a1, a0]),
          new WeakMap(),
          new WeakMap(),
          nodes,
          edges([[a0, [a0, a1]]]),
        );

        expect(names(order)).toEqual(["a0", "a1"]);
      });
    });

    describe("which member it takes", () => {
      it("prefers a member whose parent is visited over an earlier-registered member whose parent is not", () => {
        const nodes = new NodeRegistry();
        // `a0` is the child of `a1`, registered first.
        const [child, parent] = registerActions(
          nodes,
          2,
          (index) => index === 0 ? 1 : undefined,
        );
        const order = topologicalSort(
          new Set([child, parent]),
          new WeakMap(),
          new WeakMap(),
          nodes,
          edges([[child, [parent]], [parent, [child]]]),
        );

        expect(names(order)).toEqual(["a1", "a0"]);
      });

      it("prefers the lowest remaining in-degree over registration order", () => {
        const nodes = new NodeRegistry();
        const [a0, a1, a2] = registerActions(nodes, 3);
        // `a0` feeds `a1` and `a2`, and each feeds it back, so `a0` alone
        // has in-degree two and `a1` is placed first although `a0`
        // registered first.
        const order = topologicalSort(
          new Set([a0, a1, a2]),
          new WeakMap(),
          new WeakMap(),
          nodes,
          edges([[a0, [a1, a2]], [a1, [a0]], [a2, [a0]]]),
        );

        expect(names(order)).toEqual(["a1", "a0", "a2"]);
      });

      it("breaks ties of parent state and in-degree by registration order", () => {
        const nodes = new NodeRegistry();
        const [a0, a1, a2, a3] = registerActions(nodes, 4);
        // Two independent cycles with equal in-degrees: registration order
        // picks `a0`, and the second break then picks `a2` over `a3`.
        const order = topologicalSort(
          new Set([a3, a2, a1, a0]),
          new WeakMap(),
          new WeakMap(),
          nodes,
          edges([[a0, [a1]], [a1, [a0]], [a2, [a3]], [a3, [a2]]]),
        );

        expect(names(order)).toEqual(["a0", "a1", "a2", "a3"]);
      });
    });

    describe("against the rule stated directly", () => {
      // Two kinds of random work set. One-way edges at random give cycles
      // that a break mostly takes apart. Edges laid both ways give cycles
      // that mostly stay whole when a member is placed, which is the case
      // the sort recognizes without searching the cycle again.

      const expectReferenceOrder = (
        seed: number,
        random: () => number,
        count: number,
        targetsOf: (index: number) => number[],
      ) => {
        const nodes = new NodeRegistry();
        const actions = registerActions(
          nodes,
          count,
          (index) =>
            index > 0 && random() < 0.4
              ? Math.floor(random() * index)
              : undefined,
        );
        const lists = actions.map((_, index) => targetsOf(index));
        const dependents = edges(
          actions.map((from, index) => [
            from,
            lists[index].filter((to) => to !== index).map((to) => actions[to]),
          ]),
        );
        const shuffled = [...actions].sort(() => random() - 0.5);

        const order = topologicalSort(
          new Set(shuffled),
          new WeakMap(),
          new WeakMap(),
          nodes,
          dependents,
        );

        expect(names(order), `seed ${seed}`).toEqual(
          names(referenceOrder(shuffled, dependents, nodes)),
        );
      };

      it("orders work sets of one-way edges as the rule does", () => {
        for (let seed = 1; seed <= 60; seed++) {
          const random = lcg(seed);
          const count = 30 + Math.floor(random() * 90);
          expectReferenceOrder(seed, random, count, () => {
            const fanOut = Math.floor(random() * (3 + seed % 3));
            return Array.from(
              { length: fanOut },
              () => Math.floor(random() * count),
            );
          });
        }
      });

      it("orders work sets of two-way edges as the rule does", () => {
        for (let seed = 1; seed <= 60; seed++) {
          const random = lcg(seed + 1000);
          const count = 20 + Math.floor(random() * 60);
          const targets: number[][] = Array.from({ length: count }, () => []);
          const pairs = Math.floor(count * (0.6 + random()));
          for (let n = 0; n < pairs; n++) {
            const a = Math.floor(random() * count);
            // Mostly a near neighbor, so the pairs chain into paths and
            // rings; sometimes any action, so some of them close up.
            const b = random() < 0.7
              ? (a + 1 + Math.floor(random() * 3)) % count
              : Math.floor(random() * count);
            targets[a].push(b);
            if (random() < 0.85) targets[b].push(a);
          }
          expectReferenceOrder(seed, random, count, (index) => targets[index]);
        }
      });
    });

    it("reads each action's parent once while breaking thousands of cycles", () => {
      // Pairs of mutually dependent actions, so every pair is a break. A
      // break that ranks the unvisited set again each time reads a parent
      // for every comparison, millions of times over this set.
      const nodes = new CountingRegistry();
      const count = 4000;
      const actions = registerActions(nodes, count);
      const pairs: [Action, Action[]][] = [];
      for (let index = 0; index < count; index += 2) {
        pairs.push([actions[index], [actions[index + 1]]]);
        pairs.push([actions[index + 1], [actions[index]]]);
      }

      const order = topologicalSort(
        new Set(actions),
        new WeakMap(),
        new WeakMap(),
        nodes,
        edges(pairs),
      );

      expect(order).toEqual(actions);
      expect(nodes.parentLookups).toBe(count);
    });

    it("places the members of a ring with edges both ways in registration order", () => {
      // The first break opens the ring into a path, and each break after
      // it takes the path's earlier-registered end, which the break before
      // left with one unmet input.
      const nodes = new NodeRegistry();
      const count = 2000;
      const actions = registerActions(nodes, count);
      const order = topologicalSort(
        new Set([...actions].reverse()),
        new WeakMap(),
        new WeakMap(),
        nodes,
        edges(
          actions.map((from, index) => [
            from,
            [
              actions[(index + 1) % count],
              actions[(index + count - 1) % count],
            ],
          ]),
        ),
      );

      expect(order).toEqual(actions);
    });

    it("places the members of one fully connected cycle in registration order", () => {
      // Every action feeds every other, so each break leaves one cycle a
      // member smaller, with every in-degree equal.
      const nodes = new NodeRegistry();
      const actions = registerActions(nodes, 200);
      const order = topologicalSort(
        new Set([...actions].reverse()),
        new WeakMap(),
        new WeakMap(),
        nodes,
        edges(
          actions.map((from) => [from, actions.filter((to) => to !== from)]),
        ),
      );

      expect(order).toEqual(actions);
    });
  });
});
