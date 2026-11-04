/**
 * A value reachable twice by different paths is SHARED, not circular. The
 * conversion returns a back-link for an ancestor -- that is what makes a cycle
 * representable -- and must not do the same for a sibling, which would
 * rewrite one of the two positions into a pointer at the other.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { type FabricConvertibleJsValue } from "@commonfabric/data-model";
import { FabricEpochNsec } from "@commonfabric/data-model/fabric-primitives";

import { convertCellsToLinks } from "../src/cell.ts";

describe("convert-cells-to-links-sharing", () => {
  it("converts a twice-reachable object at both of its positions", () => {
    const shared = { n: 1 };
    const result = convertCellsToLinks({ a: shared, b: shared }) as {
      a: unknown;
      b: unknown;
    };

    expect(result.a).toEqual({ n: 1 });
    expect(result.b).toEqual({ n: 1 });
  });

  it("converts a twice-reachable empty array at both of its positions", () => {
    // The shape that makes this matter. A serialized pattern graph aliases one
    // empty `path: []` from every alias in it, so a walk that reads sharing as
    // circularity rewrites all but the first into back-links.
    const path: string[] = [];
    const result = convertCellsToLinks({
      result: { $alias: { path } },
      outputs: { $alias: { path } },
    }) as Record<string, { $alias: { path: unknown } }>;

    expect(result.result.$alias.path).toEqual([]);
    expect(result.outputs.$alias.path).toEqual([]);
  });

  it("converts a value shared between two array elements at both", () => {
    const shared = { n: 1 };
    const result = convertCellsToLinks([shared, shared]) as unknown[];

    expect(result[0]).toEqual({ n: 1 });
    expect(result[1]).toEqual({ n: 1 });
  });

  it("converts a twice-reachable value that converts to a primitive", () => {
    // A `Date` becomes a `FabricEpochNsec`, which the walk returns without
    // descending. Every exit has to leave the ancestor set as it found it, or
    // the second position sees an ancestor that is really a sibling.
    const shared = new Date(1234);
    const result = convertCellsToLinks({ a: shared, b: shared }) as {
      a: unknown;
      b: unknown;
    };

    expect(result.a).toBeInstanceOf(FabricEpochNsec);
    expect(result.b).toBeInstanceOf(FabricEpochNsec);
  });

  it("returns a back-link for an ancestor, so a cycle stays representable", () => {
    const cyclic: Record<string, FabricConvertibleJsValue> = { n: 1 };
    cyclic.self = cyclic;
    const result = convertCellsToLinks(cyclic) as Record<string, unknown>;

    expect(result.n).toBe(1);
    // The self-edge is a link back to the root, by the path it was reached
    // from. Asserting the shape is the point: an object of any other shape --
    // including a link naming the wrong path -- is a different answer.
    expect(result.self).toEqual({ "/": { "link@1": { path: [] } } });
  });

  it("returns a back-link naming the ancestor's own path, not the root's", () => {
    // The root case above cannot tell a path that was computed from one that
    // was assumed, its answer being the empty path either way.

    const inner: Record<string, FabricConvertibleJsValue> = { depth: 2 };
    const cyclic = { outer: { inner }, sibling: "untouched" };

    inner.back = inner;

    const result = convertCellsToLinks(cyclic) as {
      outer: { inner: Record<string, unknown> };
      sibling: unknown;
    };

    expect(result.outer.inner.depth).toBe(2);
    expect(result.outer.inner.back).toEqual({
      "/": { "link@1": { path: ["outer", "inner"] } },
    });
    expect(result.sibling).toBe("untouched");
  });

  it("returns a back-link whose path names the array index it was reached through", () => {
    const element: Record<string, FabricConvertibleJsValue> = { tag: "first" };
    const cyclic = { items: [element] };

    element.owner = element;

    const result = convertCellsToLinks(cyclic) as {
      items: Record<string, unknown>[];
    };

    expect(result.items[0]!.owner).toEqual({
      "/": { "link@1": { path: ["items", "0"] } },
    });
  });

  it("returns each of two sibling cycles at its own path", () => {
    // What this pins is that walking out of a subtree leaves the path as it
    // was found. A walk that carried the first branch's segments into the
    // second would name `left` somewhere under `right`.

    const left: Record<string, FabricConvertibleJsValue> = { side: "left" };
    const right: Record<string, FabricConvertibleJsValue> = { side: "right" };

    left.loop = left;
    right.loop = right;

    const result = convertCellsToLinks({ left, right }) as {
      left: Record<string, unknown>;
      right: Record<string, unknown>;
    };

    expect(result.left.loop).toEqual({
      "/": { "link@1": { path: ["left"] } },
    });
    expect(result.right.loop).toEqual({
      "/": { "link@1": { path: ["right"] } },
    });
  });

  it("returns a back-link at its own depth after an array sibling was walked", () => {
    // The array branch's own bookkeeping. A walk that left the index it
    // descended through behind would carry `items` into the path taken for a
    // cycle in the following member, where the object branch's sibling case
    // cannot reach.

    const inner: Record<string, FabricConvertibleJsValue> = { kind: "inner" };
    const cyclic = { items: ["x"], inner };

    inner.loop = inner;

    const result = convertCellsToLinks(cyclic) as {
      inner: Record<string, unknown>;
    };

    expect(result.inner.loop).toEqual({
      "/": { "link@1": { path: ["inner"] } },
    });
  });

  it("returns a back-link at its own path after a conversion that threw", () => {
    // Each call walks with state of its own. A conversion that throws part
    // way leaves none of it behind for the next one, whose back-link paths
    // are taken from where its own walk has reached.

    expect(() => convertCellsToLinks({ bad: () => {} } as never)).toThrow();

    const cyclic: Record<string, FabricConvertibleJsValue> = { kind: "after" };

    cyclic.loop = cyclic;

    const result = convertCellsToLinks({ outer: cyclic }) as {
      outer: Record<string, unknown>;
    };

    expect(result.outer.loop).toEqual({
      "/": { "link@1": { path: ["outer"] } },
    });
  });

  it("returns a back-link at its own depth after a deeper subtree was walked", () => {
    // The deep branch is walked first and must be fully unwound before the
    // shallow cycle's path is taken, so this fails where the first one does
    // not.

    const shallow: Record<string, FabricConvertibleJsValue> = {
      kind: "shallow",
    };
    const deep = { a: { b: { c: { d: "bottom" } } } };

    shallow.loop = shallow;

    const result = convertCellsToLinks({ deep, shallow }) as {
      shallow: Record<string, unknown>;
    };

    expect(result.shallow.loop).toEqual({
      "/": { "link@1": { path: ["shallow"] } },
    });
  });
});
