import { expect } from "@std/expect";
import {
  assertLivenessEquivalence,
  type DependencyGraphState,
  isLive,
  livenessWork,
  notifyNodeLivenessChange,
  recomputeLiveRefs,
  registerDependentEdge,
  resetLivenessWork,
  setNodeProvisionalDemand,
  unregisterDependentEdge,
} from "../../src/scheduler/dependency-graph.ts";
import { NodeRegistry } from "../../src/scheduler/node-record.ts";
import type { Action } from "../../src/scheduler/types.ts";
import { describe, it } from "@commonfabric/test-support/test";

/**
 * A liveness graph with a materializer set a test can toggle, the way the
 * production index is toggled by registration.
 */
function createGraph() {
  const nodes = new NodeRegistry();
  const materializers = new Set<Action>();
  const state = {
    nodes,
    dependents: new WeakMap<Action, Set<Action>>(),
    reverseDependencies: new WeakMap<Action, Set<Action>>(),
    materializerIndex: {
      isMaterializer: (action: Action) => materializers.has(action),
    },
    getSchedulingWrites: () => undefined,
  } as unknown as DependencyGraphState;

  /** Change materializer status the way `SchedulerMaterializers` does. */
  const setMaterializer = (action: Action, value: boolean): void => {
    const record = nodes.get(action);
    const wasLive = record ? isLive(state, record) : false;
    if (value) materializers.add(action);
    else materializers.delete(action);
    notifyNodeLivenessChange(state, action, wasLive);
  };

  const toggleMaterializer = (action: Action): void =>
    setMaterializer(action, !materializers.has(action));

  return { nodes, state, setMaterializer, toggleMaterializer };
}

/**
 * Compare the incrementally maintained refcounts against a rebuild from the
 * demand roots, which is the definition they implement. The rebuild overwrites,
 * so each step is checked against a correct prior state.
 */
function expectMatchesFullRebuild(
  state: DependencyGraphState,
  label: string,
): void {
  const records = [...state.nodes.nodes()];
  const incremental = records.map((record) => ({
    action: record.action.name,
    liveRefs: record.liveRefs,
  }));
  recomputeLiveRefs(state);
  const rebuilt = records.map((record) => ({
    action: record.action.name,
    liveRefs: record.liveRefs,
  }));
  expect(incremental, label).toEqual(rebuilt);
}

/** Deterministic xorshift, so a failing sequence is reproducible. */
function createRandom(seed: number) {
  let value = seed;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    value >>>= 0;
    return value / 0x100000000;
  };
}

function named(name: string): Action {
  return { [name]: () => {} }[name];
}

/** Registers a chain of `length` computations that `reader` reads the end of. */
function addUpstreamChain(
  nodes: NodeRegistry,
  state: DependencyGraphState,
  reader: Action,
  length: number,
  prefix: string,
): void {
  let below = reader;
  for (let i = 0; i < length; i++) {
    const source = named(`${prefix}Source${i}`);
    nodes.register(source, "computation");
    registerDependentEdge(state, source, below);
    below = source;
  }
}

describe("dependency-graph", () => {
  describe("registerDependentEdge()", () => {
    it("gives the writer a reference when the reader is live", () => {
      const { nodes, state } = createGraph();
      const writer = named("writer");
      const reader = named("reader");
      nodes.register(writer, "computation");
      nodes.register(reader, "effect");

      registerDependentEdge(state, writer, reader);

      expect(nodes.get(writer)?.liveRefs).toBe(1);
      expect(isLive(state, nodes.get(writer)!)).toBe(true);
    });

    it("gives the writer no reference when the reader is dormant", () => {
      const { nodes, state } = createGraph();
      const writer = named("writer");
      const reader = named("reader");
      nodes.register(writer, "computation");
      nodes.register(reader, "computation");

      registerDependentEdge(state, writer, reader);

      expect(nodes.get(writer)?.liveRefs).toBe(0);
      expect(isLive(state, nodes.get(writer)!)).toBe(false);
    });

    it("carries demand upstream through a chain when the far end becomes live", () => {
      const { nodes, state } = createGraph();
      const source = named("source");
      const middle = named("middle");
      const sink = named("sink");
      nodes.register(source, "computation");
      nodes.register(middle, "computation");
      nodes.register(sink, "effect");

      // Wire from the dormant end, so demand only arrives with the last edge.
      registerDependentEdge(state, source, middle);
      expect(isLive(state, nodes.get(source)!)).toBe(false);

      registerDependentEdge(state, middle, sink);

      expect(nodes.get(middle)?.liveRefs).toBe(1);
      expect(nodes.get(source)?.liveRefs).toBe(1);
      expect(isLive(state, nodes.get(source)!)).toBe(true);
    });
  });

  describe("unregisterDependentEdge()", () => {
    it("drops the reference a departing reader held on a root writer", () => {
      const { nodes, state } = createGraph();
      // An effect can itself be read, so its refcount has to stay accurate even
      // though its own liveness never depends on it.
      const writer = named("rootWriter");
      const reader = named("reader");
      nodes.register(writer, "effect");
      nodes.register(reader, "effect");
      registerDependentEdge(state, writer, reader);
      expect(nodes.get(writer)?.liveRefs).toBe(1);

      unregisterDependentEdge(state, writer, reader);

      expect(nodes.get(writer)?.liveRefs).toBe(0);
      expect(isLive(state, nodes.get(writer)!)).toBe(true);
    });

    it("leaves an unrelated branch untouched when a sibling branch dies", () => {
      const { nodes, state } = createGraph();
      const shared = named("shared");
      const keptReader = named("keptReader");
      const lostReader = named("lostReader");
      nodes.register(shared, "computation");
      nodes.register(keptReader, "effect");
      nodes.register(lostReader, "effect");
      registerDependentEdge(state, shared, keptReader);
      registerDependentEdge(state, shared, lostReader);

      unregisterDependentEdge(state, shared, lostReader);

      expect(nodes.get(shared)?.liveRefs).toBe(1);
      expect(isLive(state, nodes.get(shared)!)).toBe(true);
    });

    it("does work independent of the writer's upstream and its reader count when a root still reaches the writer", () => {
      // Each kept reader is a computation an effect reads, so the writer's
      // support is a path rather than a root reading it directly.
      const departWork = (upstream: number, readers: number) => {
        const { nodes, state } = createGraph();
        const shared = named("shared");
        nodes.register(shared, "computation");
        let below = shared;
        for (let i = 0; i < upstream; i++) {
          const source = named(`source${i}`);
          nodes.register(source, "computation");
          registerDependentEdge(state, source, below);
          below = source;
        }
        for (let i = 0; i < readers; i++) {
          const reader = named(`reader${i}`);
          const sink = named(`sink${i}`);
          nodes.register(reader, "computation");
          nodes.register(sink, "effect");
          registerDependentEdge(state, reader, sink);
          registerDependentEdge(state, shared, reader);
        }
        const departing = named("departing");
        const departingSink = named("departingSink");
        nodes.register(departing, "computation");
        nodes.register(departingSink, "effect");
        registerDependentEdge(state, departing, departingSink);
        registerDependentEdge(state, shared, departing);

        resetLivenessWork();
        unregisterDependentEdge(state, shared, departing);
        const work = { ...livenessWork };
        expect(nodes.get(shared)?.liveRefs).toBe(readers);
        expectMatchesFullRebuild(state, `${upstream} upstream`);
        return work;
      };

      const small = departWork(4, 4);
      expect(departWork(400, 400)).toEqual(small);
      expect(small.nodeWrites).toBe(1);
    });

    it("does work independent of the upstream it shares with live rows when a row's last reader departs", () => {
      // The departing row dies, but the hub it reads stays live through the
      // other rows, and so does everything upstream of the hub.
      const departWork = (upstream: number, rows: number) => {
        const { nodes, state } = createGraph();
        const hub = named("hub");
        nodes.register(hub, "computation");
        let below = hub;
        for (let i = 0; i < upstream; i++) {
          const source = named(`source${i}`);
          nodes.register(source, "computation");
          registerDependentEdge(state, source, below);
          below = source;
        }
        const row = (name: string) => {
          const card = named(name);
          const sink = named(`${name}Sink`);
          nodes.register(card, "computation");
          nodes.register(sink, "effect");
          registerDependentEdge(state, card, sink);
          registerDependentEdge(state, hub, card);
          return { card, sink };
        };
        for (let i = 0; i < rows; i++) row(`row${i}`);
        const departing = row("departing");

        resetLivenessWork();
        unregisterDependentEdge(state, departing.card, departing.sink);
        const work = { ...livenessWork };
        expect(isLive(state, nodes.get(departing.card)!)).toBe(false);
        expect(nodes.get(hub)?.liveRefs).toBe(rows);
        expectMatchesFullRebuild(state, `${upstream} upstream`);
        return work;
      };

      expect(departWork(400, 400)).toEqual(departWork(4, 4));
    });

    it("walks a dead end its writers share at most once when a row dies", () => {
      // A dying row reads `writers` writers and the end of a chain of `depth`
      // computations. Each writer is read first by the chain's head, whose
      // walk dead-ends at the dying row, and then by a computation an effect
      // reads.
      const deadEndWork = (writers: number, depth: number) => {
        const { nodes, state } = createGraph();
        const dying = named("dying");
        const reader = named("dyingReader");
        nodes.register(dying, "computation");
        nodes.register(reader, "effect");
        registerDependentEdge(state, dying, reader);
        const chain: Action[] = [];
        for (let i = 0; i < depth; i++) {
          const link = named(`link${i}`);
          nodes.register(link, "computation");
          if (i > 0) registerDependentEdge(state, chain[i - 1], link);
          chain.push(link);
        }
        registerDependentEdge(state, chain[depth - 1], dying);
        for (let i = 0; i < writers; i++) {
          const writer = named(`writer${i}`);
          nodes.register(writer, "computation");
          registerDependentEdge(state, writer, chain[0]);
          registerDependentEdge(state, writer, dying);
          const sink = named(`sink${i}`);
          const via = named(`via${i}`);
          nodes.register(sink, "effect");
          nodes.register(via, "computation");
          registerDependentEdge(state, via, sink);
          registerDependentEdge(state, writer, via);
        }

        resetLivenessWork();
        unregisterDependentEdge(state, dying, reader);
        const work = livenessWork.edgeVisits;
        expect(isLive(state, nodes.get(dying)!)).toBe(false);
        expect(isLive(state, nodes.get(chain[0])!)).toBe(false);
        expectMatchesFullRebuild(state, `${writers} writers, ${depth} deep`);
        return work;
      };

      expect(deadEndWork(40, 200) - deadEndWork(20, 200)).toBe(
        deadEndWork(40, 2) - deadEndWork(20, 2),
      );
    });

    it("releases a writer whose remaining reader reaches a root only through the writer", () => {
      const { nodes, state } = createGraph();
      // The writer and its reader read each other, so the reader holds a live
      // reference only because the writer is live.
      const writer = named("cycleWriter");
      const reader = named("cycleReader");
      const departing = named("departingEffect");
      nodes.register(writer, "computation");
      nodes.register(reader, "computation");
      nodes.register(departing, "effect");
      registerDependentEdge(state, writer, departing);
      registerDependentEdge(state, writer, reader);
      registerDependentEdge(state, reader, writer);
      expect(isLive(state, nodes.get(reader)!)).toBe(true);

      unregisterDependentEdge(state, writer, departing);

      expect(isLive(state, nodes.get(writer)!)).toBe(false);
      expect(isLive(state, nodes.get(reader)!)).toBe(false);
      expectMatchesFullRebuild(state, "released cycle");
    });

    it("does no work when a reader that was not live stops reading a node", () => {
      // The writer stays live through an effect, above an upstream chain of
      // `upstream` nodes. The departing reader was never live, so it held no
      // reference and its departure can change nothing.
      const removeWork = (upstream: number) => {
        const { nodes, state } = createGraph();
        const writer = named("writer");
        const dormant = named("dormant");
        const sink = named("sink");
        nodes.register(writer, "computation");
        nodes.register(dormant, "computation");
        nodes.register(sink, "effect");
        registerDependentEdge(state, writer, dormant);
        registerDependentEdge(state, writer, sink);
        addUpstreamChain(nodes, state, writer, upstream, "writer");
        expect(isLive(state, nodes.get(dormant)!)).toBe(false);

        resetLivenessWork();
        unregisterDependentEdge(state, writer, dormant);
        const work = livenessWork.edgeVisits;
        expect(isLive(state, nodes.get(writer)!)).toBe(true);
        expectMatchesFullRebuild(state, `${upstream} upstream`);
        return work;
      };

      expect(removeWork(400)).toBe(0);
      expect(removeWork(4)).toBe(0);
    });
  });

  describe("setNodeProvisionalDemand()", () => {
    it("leaves the graph as it was when a dormant node without demand is cleared", () => {
      // The node reads a writer that an effect keeps live, and holds no
      // reference on it, so clearing a demand it never had gives none back.
      const { nodes, state } = createGraph();
      const dormant = named("dormant");
      const writer = named("writer");
      const sink = named("sink");
      nodes.register(dormant, "computation");
      nodes.register(writer, "computation");
      nodes.register(sink, "effect");
      registerDependentEdge(state, writer, dormant);
      registerDependentEdge(state, writer, sink);
      expect(nodes.get(writer)?.liveRefs).toBe(1);

      resetLivenessWork();
      setNodeProvisionalDemand(state, nodes.get(dormant)!, false);

      expect(livenessWork.edgeVisits).toBe(0);
      expect(isLive(state, nodes.get(dormant)!)).toBe(false);
      expect(nodes.get(writer)?.liveRefs).toBe(1);
      expect(isLive(state, nodes.get(writer)!)).toBe(true);
      expectMatchesFullRebuild(state, "dormant node cleared");

      // The same node with demand gives its reference back when cleared.
      setNodeProvisionalDemand(state, nodes.get(dormant)!, true);
      expect(nodes.get(writer)?.liveRefs).toBe(2);
      setNodeProvisionalDemand(state, nodes.get(dormant)!, false);
      expect(nodes.get(writer)?.liveRefs).toBe(1);
      expectMatchesFullRebuild(state, "demanded node cleared");
    });

    it("walks the path that keeps a dying node's writers live once, however many writers share it", () => {
      // A provisional node reads `writers` writers, which a chain of `depth`
      // computations also reads on its way to an effect. Each writer reads a
      // chain of `upstream` computations of its own. When the node loses its
      // demand, each writer stays live through the shared chain, and nothing
      // above a writer needs visiting.
      const withdrawWork = (writers: number, depth: number, upstream = 2) => {
        const { nodes, state } = createGraph();
        const dying = named("dying");
        nodes.register(dying, "computation");
        const chain: Action[] = [];
        for (let i = 0; i < depth; i++) {
          const link = named(`link${i}`);
          nodes.register(link, "computation");
          if (i > 0) registerDependentEdge(state, chain[i - 1], link);
          chain.push(link);
        }
        const sink = named("sink");
        nodes.register(sink, "effect");
        registerDependentEdge(state, chain[depth - 1], sink);
        for (let i = 0; i < writers; i++) {
          const writer = named(`writer${i}`);
          nodes.register(writer, "computation");
          registerDependentEdge(state, writer, dying);
          registerDependentEdge(state, writer, chain[0]);
          addUpstreamChain(nodes, state, writer, upstream, `writer${i}`);
        }
        setNodeProvisionalDemand(state, nodes.get(dying)!, true);

        resetLivenessWork();
        setNodeProvisionalDemand(state, nodes.get(dying)!, false);
        const work = livenessWork.edgeVisits;
        expect(isLive(state, nodes.get(dying)!)).toBe(false);
        expectMatchesFullRebuild(state, `${writers} writers`);
        return work;
      };

      expect(withdrawWork(40, 200) - withdrawWork(20, 200)).toBe(
        withdrawWork(40, 2) - withdrawWork(20, 2),
      );
      expect(withdrawWork(20, 200, 400)).toBe(withdrawWork(20, 200, 2));
    });

    it("does work independent of the writers' upstream when a dying node's writers share one root reading them directly", () => {
      // One effect reads every writer, so the first writer's walk finds it,
      // and each later writer's walk ends there too.
      const withdrawWork = (writers: number, upstream: number) => {
        const { nodes, state } = createGraph();
        const dying = named("dying");
        const sink = named("sharedSink");
        nodes.register(dying, "computation");
        nodes.register(sink, "effect");
        for (let i = 0; i < writers; i++) {
          const writer = named(`writer${i}`);
          nodes.register(writer, "computation");
          registerDependentEdge(state, writer, dying);
          registerDependentEdge(state, writer, sink);
          addUpstreamChain(nodes, state, writer, upstream, `writer${i}`);
        }
        setNodeProvisionalDemand(state, nodes.get(dying)!, true);

        resetLivenessWork();
        setNodeProvisionalDemand(state, nodes.get(dying)!, false);
        const work = livenessWork.edgeVisits;
        expect(isLive(state, nodes.get(dying)!)).toBe(false);
        expectMatchesFullRebuild(state, `${upstream} upstream`);
        return work;
      };

      expect(withdrawWork(20, 400)).toBe(withdrawWork(20, 4));
    });

    it("does work independent of how far below a node with no writers its root lies when the node loses its demand", () => {
      // The node stays live through a chain of `depth` readers ending at an
      // effect, and with no writer above it, nothing else can change.
      const withdrawWork = (depth: number) => {
        const { nodes, state } = createGraph();
        const node = named("node");
        nodes.register(node, "computation");
        let above = node;
        for (let i = 0; i < depth; i++) {
          const link = named(`link${i}`);
          nodes.register(link, "computation");
          registerDependentEdge(state, above, link);
          above = link;
        }
        const sink = named("sink");
        nodes.register(sink, "effect");
        registerDependentEdge(state, above, sink);
        setNodeProvisionalDemand(state, nodes.get(node)!, true);

        resetLivenessWork();
        setNodeProvisionalDemand(state, nodes.get(node)!, false);
        const work = livenessWork.edgeVisits;
        expect(isLive(state, nodes.get(node)!)).toBe(true);
        expectMatchesFullRebuild(state, `${depth} deep`);
        return work;
      };

      expect(withdrawWork(400)).toBe(withdrawWork(4));
    });
  });

  describe("notifyNodeLivenessChange()", () => {
    it("carries demand upstream when a dormant node becomes a materializer", () => {
      const { nodes, state, setMaterializer } = createGraph();
      const source = named("source");
      const materializer = named("materializer");
      nodes.register(source, "computation");
      nodes.register(materializer, "computation");
      registerDependentEdge(state, source, materializer);
      expect(nodes.get(source)?.liveRefs).toBe(0);

      setMaterializer(materializer, true);

      expect(nodes.get(source)?.liveRefs).toBe(1);
      expect(isLive(state, nodes.get(source)!)).toBe(true);
    });

    it("releases a cycle that loses its last materializer root", () => {
      const { nodes, state, setMaterializer } = createGraph();
      // The two read each other, so each holds a reference from the other. Only
      // a walk from the remaining roots can tell that support apart from a
      // rootless cycle propping itself up.
      const root = named("cycleRoot");
      const other = named("cycleOther");
      nodes.register(root, "computation");
      nodes.register(other, "computation");
      setMaterializer(root, true);
      registerDependentEdge(state, root, other);
      registerDependentEdge(state, other, root);
      expect(isLive(state, nodes.get(other)!)).toBe(true);

      setMaterializer(root, false);

      expect(nodes.get(root)?.liveRefs).toBe(0);
      expect(nodes.get(other)?.liveRefs).toBe(0);
      expect(isLive(state, nodes.get(root)!)).toBe(false);
      expect(isLive(state, nodes.get(other)!)).toBe(false);
    });

    it("recovers the references a registering node's live readers already hold", () => {
      const { nodes, state } = createGraph();
      // Edges can name a node before it registers, and a reference is only
      // granted while the writer is registered, so registration has to collect
      // what its readers already owe it.
      const writer = named("writer");
      const reader = named("reader");
      nodes.register(reader, "effect");
      registerDependentEdge(state, writer, reader);
      expect(nodes.get(writer)).toBeUndefined();

      nodes.register(writer, "computation");
      notifyNodeLivenessChange(state, writer, false);

      expect(nodes.get(writer)?.liveRefs).toBe(1);
      expect(isLive(state, nodes.get(writer)!)).toBe(true);
    });

    it("passes a recovered registration's demand further upstream", () => {
      const { nodes, state } = createGraph();
      const source = named("source");
      const middle = named("middle");
      const reader = named("reader");
      nodes.register(source, "computation");
      nodes.register(reader, "effect");
      registerDependentEdge(state, source, middle);
      registerDependentEdge(state, middle, reader);
      expect(nodes.get(source)?.liveRefs).toBe(0);

      nodes.register(middle, "computation");
      notifyNodeLivenessChange(state, middle, false);

      expect(nodes.get(middle)?.liveRefs).toBe(1);
      expect(nodes.get(source)?.liveRefs).toBe(1);
    });
  });

  describe("recomputeLiveRefs()", () => {
    it("makes a node it finds live a seed candidate again", () => {
      const { nodes, state } = createGraph();
      const writer = named("writer");
      const reader = named("reader");
      nodes.register(writer, "computation");
      nodes.register(reader, "effect");
      registerDependentEdge(state, writer, reader);
      // Counts that drifted: the writer reads as dormant, and a scan parks it.
      nodes.get(writer)!.liveRefs = 0;
      nodes.parkSeedCandidate(writer);

      recomputeLiveRefs(state);

      expect(isLive(state, nodes.get(writer)!)).toBe(true);
      expect(nodes.getSeedCandidates().has(writer)).toBe(true);
    });
  });

  describe("assertLivenessEquivalence()", () => {
    it("returns without checking when not enabled", () => {
      const { nodes, state } = createGraph();
      const writer = named("writer");
      nodes.register(writer, "computation");
      nodes.get(writer)!.liveRefs = 3;

      expect(() => assertLivenessEquivalence(state, "a site", false)).not
        .toThrow();
      expect(nodes.get(writer)?.liveRefs).toBe(3);
    });

    it("returns without throwing when the refcounts match a full rebuild", () => {
      const { nodes, state } = createGraph();
      const writer = named("writer");
      const reader = named("reader");
      nodes.register(writer, "computation");
      nodes.register(reader, "effect");
      registerDependentEdge(state, writer, reader);

      expect(() => assertLivenessEquivalence(state, "a site", true)).not
        .toThrow();
      expect(nodes.get(writer)?.liveRefs).toBe(1);
    });

    it("throws naming the site and each drifted node, and leaves the rebuilt counts", () => {
      const { nodes, state } = createGraph();
      const writer = named("writer");
      const reader = named("reader");
      nodes.register(writer, "computation");
      nodes.register(reader, "effect");
      registerDependentEdge(state, writer, reader);
      nodes.get(writer)!.liveRefs = 3;

      expect(() => assertLivenessEquivalence(state, "a site", true)).toThrow(
        "liveness drift after a site: writer: incremental=3 rebuilt=1",
      );
      expect(nodes.get(writer)?.liveRefs).toBe(1);
    });
  });

  describe("resetLivenessWork()", () => {
    it("zeroes the work counters a mutation advanced", () => {
      const { nodes, state } = createGraph();
      const writer = named("writer");
      const reader = named("reader");
      nodes.register(writer, "computation");
      nodes.register(reader, "effect");
      registerDependentEdge(state, writer, reader);
      expect(livenessWork.operations).toBeGreaterThan(0);
      expect(livenessWork.nodeWrites).toBeGreaterThan(0);

      resetLivenessWork();

      expect(livenessWork).toEqual({
        nodeWrites: 0,
        edgeVisits: 0,
        operations: 0,
      });
    });
  });

  describe("incremental maintenance", () => {
    // Which roots a run is allowed to create decides which shapes it can reach.
    // A run that registers effects makes almost every node root-reachable, so
    // rootless cycles never form and the release path goes unexercised; the
    // root-free runs below are the ones that reach it.
    const runs = [
      { name: "with effect roots", effectShare: 0.25, provisional: true },
      { name: "with no effect roots", effectShare: 0, provisional: true },
      {
        name: "with materializer roots only",
        effectShare: 0,
        provisional: false,
      },
    ];

    for (const run of runs) {
      it(`matches a full rebuild after every mutation ${run.name}`, () => {
        for (let seed = 1; seed <= 20; seed++) {
          const random = createRandom(seed * 7919);
          const { nodes, state, toggleMaterializer } = createGraph();
          const actions: Action[] = [];
          for (let i = 0; i < 10; i++) {
            const action = named(`node${i}`);
            actions.push(action);
            nodes.register(
              action,
              random() < run.effectShare ? "effect" : "computation",
            );
          }
          const pick = () => actions[Math.floor(random() * actions.length)];

          for (let step = 0; step < 300; step++) {
            const roll = random();
            const writer = pick();
            const reader = pick();
            if (roll < 0.4) {
              registerDependentEdge(state, writer, reader);
            } else if (roll < 0.75) {
              unregisterDependentEdge(state, writer, reader);
            } else if (roll < 0.9 && run.provisional) {
              const record = nodes.get(writer)!;
              setNodeProvisionalDemand(
                state,
                record,
                !record.provisionalDemand,
              );
            } else {
              toggleMaterializer(writer);
            }
            expectMatchesFullRebuild(
              state,
              `${run.name} seed ${seed} step ${step}`,
            );
          }
        }
      });
    }

    // What a pull seed scan does to the registry: it parks each candidate
    // that is not live. Nothing here is pending.
    const parkDormant = (
      nodes: NodeRegistry,
      state: DependencyGraphState,
    ): void => {
      for (const action of nodes.getSeedCandidates()) {
        if (!isLive(state, nodes.get(action)!)) nodes.parkSeedCandidate(action);
      }
    };

    for (const run of runs) {
      it(`keeps every live invalid node a seed candidate after every mutation ${run.name}`, () => {
        let returned = 0;
        let liveChecked = 0;
        for (let seed = 1; seed <= 20; seed++) {
          const random = createRandom(seed * 15485863);
          const { nodes, state, toggleMaterializer } = createGraph();
          const actions: Action[] = [];
          for (let i = 0; i < 10; i++) {
            const action = named(`node${i}`);
            actions.push(action);
            nodes.register(
              action,
              random() < run.effectShare ? "effect" : "computation",
            );
          }
          const pick = () => actions[Math.floor(random() * actions.length)];

          for (let step = 0; step < 300; step++) {
            parkDormant(nodes, state);
            const parked = actions.filter((action) =>
              nodes.isInvalid(action) && !nodes.getSeedCandidates().has(action)
            );
            const roll = random();
            const writer = pick();
            const reader = pick();
            if (roll < 0.4) {
              registerDependentEdge(state, writer, reader);
            } else if (roll < 0.7) {
              unregisterDependentEdge(state, writer, reader);
            } else if (roll < 0.8 && run.provisional) {
              const record = nodes.get(writer)!;
              setNodeProvisionalDemand(
                state,
                record,
                !record.provisionalDemand,
              );
            } else if (roll < 0.9) {
              toggleMaterializer(writer);
            } else {
              // A node that ran: it leaves the invalid nodes, and joins
              // them again on its next invalidation.
              nodes.setStatus(
                writer,
                nodes.isInvalid(writer) ? "clean" : "invalid",
              );
            }
            for (const action of nodes.getInvalidNodes()) {
              if (!isLive(state, nodes.get(action)!)) continue;
              liveChecked++;
              expect(
                nodes.getSeedCandidates().has(action),
                `${run.name} seed ${seed} step ${step}: ${action.name}`,
              ).toBe(true);
            }
            returned += parked.filter((action) =>
              nodes.isInvalid(action) && isLive(state, nodes.get(action)!)
            ).length;
          }
        }
        // The comparison above says nothing unless parked nodes came alive.
        expect(liveChecked).toBeGreaterThan(1000);
        expect(returned).toBeGreaterThan(100);
      });
    }

    it("matches a full rebuild when edges are wired before their writer registers", () => {
      for (let seed = 1; seed <= 20; seed++) {
        const random = createRandom(seed * 104729);
        const { nodes, state } = createGraph();
        const actions: Action[] = [];
        for (let i = 0; i < 8; i++) actions.push(named(`late${i}`));
        // One standing root, so demand has somewhere to come from.
        nodes.register(actions[0], "effect");
        const pick = () => actions[Math.floor(random() * actions.length)];

        for (let step = 0; step < 200; step++) {
          const roll = random();
          const target = pick();
          if (roll < 0.5) {
            registerDependentEdge(state, pick(), pick());
          } else if (roll < 0.8) {
            unregisterDependentEdge(state, pick(), pick());
          } else if (!nodes.get(target)) {
            nodes.register(target, "computation");
            notifyNodeLivenessChange(state, target, false);
          }
          expectMatchesFullRebuild(state, `late seed ${seed} step ${step}`);
        }
      }
    });
  });
});
