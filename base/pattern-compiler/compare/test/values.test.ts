import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { compareFixtures } from "../values-fixtures.ts";
import { firstDifference, normalize } from "../values.ts";

// The value comparison (`../values.ts`): the values the executor of
// `../../exec/` computes for a compiled plan against the values today's
// runtime computes for the same pattern, argument, and events.

describe("normalize", () => {
  it("compares the children of a view node as one flat list", () => {
    const nested = {
      type: "vnode",
      name: "ul",
      props: {},
      children: ["a", [{ type: "vnode", name: "li", props: {}, children: [] }]],
    };
    const flat = { ...nested, children: nested.children.flat() };

    expect(normalize(nested)).toEqual(normalize(flat));
  });

  it("compares the result of a pattern at a child position as its tree", () => {
    const tree = { type: "vnode", name: "span", props: {}, children: ["x"] };
    const holding = (child: unknown) => ({
      type: "vnode",
      name: "div",
      props: {},
      children: [child],
    });

    expect(normalize(holding({ $UI: tree, count: 1 }))).toEqual(
      normalize(holding(tree)),
    );
  });

  it("compares a stream as the empty record today's runtime reads", () => {
    expect(normalize({ add: { $stream: true } })).toEqual({ add: {} });
  });

  it("leaves out a member that holds nothing", () => {
    expect(normalize({ a: 1, b: undefined })).toEqual({ a: 1 });
  });
});

describe("firstDifference", () => {
  it("names the path of the first member that differs", () => {
    expect(firstDifference({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] }))
      .toEqual({ path: "a/1/b", a: "2", b: "3" });
  });

  it("finds none between two equal values", () => {
    expect(firstDifference({ a: [1, "x"] }, { a: [1, "x"] })).toBeUndefined();
  });
});

describe("the values of a fixture", () => {
  it("are equal for a handler that sets a cell and pushes onto a list", async () => {
    const [{ comparison }] = await compareFixtures("handler");

    expect(comparison.notExecuted).toBeUndefined();
    expect(comparison.differences).toEqual([]);
    expect(comparison.failedEvents).toEqual([]);
    // Four members of the result and two state cells, after the instance
    // settled and after the event.
    expect(comparison.compared).toBe(12);
    expect(comparison.equal).toBe(12);
  });

  it("are equal for a handler bound in an element body that reads the index", async () => {
    const [{ comparison }] = await compareFixtures("index-nodes");

    expect(comparison.notExecuted).toBeUndefined();
    expect(comparison.differences).toEqual([]);
    expect(comparison.failedEvents).toEqual([]);
    // Every position that holds a stream is one `Binding.result` lists.
    expect(comparison.streams?.atNoListedPath).toBe(0);
  });

  it("are equal where a pattern compiled in declares a default for a path", async () => {
    // Ruling Z4: with the caller's slot given, and with nothing stored
    // there, where both runs read the callee's default.
    const rows = await compareFixtures("callee-default");

    expect(rows.length).toBe(2);
    for (const { comparison } of rows) {
      expect(comparison.notExecuted).toBeUndefined();
      expect(comparison.differences).toEqual([]);
      expect(comparison.compared).toBe(4);
    }
  });
});
