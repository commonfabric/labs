import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { hasInvalidUpstream } from "../../src/scheduler/dependency-graph.ts";
import { NodeRegistry } from "../../src/scheduler/node-record.ts";
import type { Action } from "../../src/scheduler/types.ts";

/** Counts graph lookups so the cone bound is independent of timing. */
class CountingEdges extends WeakMap<Action, Set<Action>> {
  #reads = 0;

  /** Number of upstream adjacency lists requested. */
  get reads(): number {
    return this.#reads;
  }

  /** Returns a node's upstream edges and records the lookup. */
  override get(action: Action): Set<Action> | undefined {
    this.#reads++;
    return super.get(action);
  }
}

describe("hasInvalidUpstream()", () => {
  it("returns true for an invalid or never-run transitive writer", () => {
    const nodes = new NodeRegistry();
    const writer: Action = () => {};
    const middle: Action = () => {};
    const reader: Action = () => {};
    const reverseDependencies = new WeakMap<Action, Set<Action>>([
      [reader, new Set([middle])],
      [middle, new Set([writer])],
    ]);
    nodes.register(writer, "computation");
    expect(hasInvalidUpstream({ nodes, reverseDependencies }, reader))
      .toBe(true);
    nodes.setStatus(writer, "clean");
    expect(hasInvalidUpstream({ nodes, reverseDependencies }, reader))
      .toBe(false);
    nodes.setStatus(writer, "invalid");
    expect(hasInvalidUpstream({ nodes, reverseDependencies }, reader))
      .toBe(true);
  });

  it("excludes the reader itself even when it belongs to a cycle", () => {
    const nodes = new NodeRegistry();
    const reader: Action = () => {};
    const other: Action = () => {};
    const reverseDependencies = new WeakMap<Action, Set<Action>>([
      [reader, new Set([other])],
      [other, new Set([reader])],
    ]);
    nodes.register(reader, "computation");
    expect(hasInvalidUpstream({ nodes, reverseDependencies }, reader))
      .toBe(false);
    nodes.register(other, "computation");
    expect(hasInvalidUpstream({ nodes, reverseDependencies }, reader))
      .toBe(true);
  });

  it("returns false without a lookup when nothing is invalid", () => {
    const nodes = new NodeRegistry();
    const reverseDependencies = new CountingEdges();
    const reader: Action = () => {};
    const writer: Action = () => {};
    reverseDependencies.set(reader, new Set([writer]));
    nodes.register(writer, "computation");
    nodes.setStatus(writer, "clean");
    expect(hasInvalidUpstream({ nodes, reverseDependencies }, reader))
      .toBe(false);
    expect(reverseDependencies.reads).toBe(0);
  });

  it("stops at the first invalid writer rather than walking the cone", () => {
    const nodes = new NodeRegistry();
    const reverseDependencies = new CountingEdges();
    const reader: Action = () => {};
    const near: Action = () => {};
    const chain: Action[] = Array.from({ length: 64 }, () => () => {});
    reverseDependencies.set(reader, new Set([near]));
    reverseDependencies.set(near, new Set([chain[0]]));
    for (let i = 0; i < chain.length; i++) {
      reverseDependencies.set(
        chain[i],
        new Set([chain[(i + 1) % chain.length]]),
      );
      nodes.register(chain[i], "computation");
      nodes.setStatus(chain[i], "clean");
    }
    nodes.register(near, "computation");
    expect(hasInvalidUpstream({ nodes, reverseDependencies }, reader))
      .toBe(true);
    expect(reverseDependencies.reads).toBe(1);
  });

  it("visits each node of a shared upstream cone once", () => {
    const nodes = new NodeRegistry();
    const reverseDependencies = new CountingEdges();
    const reader: Action = () => {};
    const shared: Action = () => {};
    const readers: Action[] = Array.from({ length: 64 }, () => () => {});
    reverseDependencies.set(reader, new Set(readers));
    for (const middle of readers) {
      reverseDependencies.set(middle, new Set([shared]));
      nodes.register(middle, "computation");
      nodes.setStatus(middle, "clean");
    }
    nodes.register(shared, "computation");
    nodes.setStatus(shared, "clean");
    expect(hasInvalidUpstream({ nodes, reverseDependencies }, reader))
      .toBe(false);
    expect(reverseDependencies.reads).toBeLessThanOrEqual(readers.length + 2);
    nodes.setStatus(shared, "invalid");
    expect(hasInvalidUpstream({ nodes, reverseDependencies }, reader))
      .toBe(true);
  });

  it("walks a 20k-deep cyclic graph without recursive stack growth", () => {
    const depth = 20_000;
    const nodes = new NodeRegistry();
    const chain: Action[] = Array.from({ length: depth + 1 }, () => () => {});
    const invalid: Action = () => {};
    const reverseDependencies = new WeakMap<Action, Set<Action>>();
    for (let index = 0; index < depth; index++) {
      reverseDependencies.set(chain[index], new Set([chain[index + 1]]));
      nodes.register(chain[index], "computation");
      nodes.setStatus(chain[index], "clean");
    }
    reverseDependencies.set(chain[depth], new Set([chain[depth / 2]]));
    nodes.register(chain[depth], "computation");
    nodes.setStatus(chain[depth], "clean");
    nodes.register(invalid, "computation");

    expect(hasInvalidUpstream({ nodes, reverseDependencies }, chain[0]))
      .toBe(false);
    reverseDependencies.get(chain[depth])!.add(invalid);
    expect(hasInvalidUpstream({ nodes, reverseDependencies }, chain[0]))
      .toBe(true);
  });

  it("passes over a writer that writes nothing of its own", () => {
    // The cone ends at a writer with no upstream edges. Something invalid
    // elsewhere in the graph keeps the walk running rather than answering
    // from the empty invalid set.
    const nodes = new NodeRegistry();
    const source: Action = () => {};
    const reader: Action = () => {};
    const unrelated: Action = () => {};
    const reverseDependencies = new WeakMap<Action, Set<Action>>([
      [reader, new Set([source])],
    ]);
    nodes.register(source, "computation");
    nodes.setStatus(source, "clean");
    nodes.register(unrelated, "computation");

    expect(hasInvalidUpstream({ nodes, reverseDependencies }, reader))
      .toBe(false);
  });
});
