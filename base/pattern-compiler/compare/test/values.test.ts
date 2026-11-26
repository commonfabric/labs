import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { compareFixtures } from "../values-fixtures.ts";
import {
  firstDifference,
  inFileForm,
  normalize,
  outOfFileForm,
} from "../values.ts";

// The value comparison (`../values.ts`): the values the executor of
// `../../exec/` computes for a compiled plan against the values today's
// runtime computes for the same pattern, argument, and events.

describe("the values of a run, as a results file holds them", () => {
  it("read back with each member and each position that holds nothing", () => {
    const values = {
      settled: {
        result: { $UI: { children: ["a", undefined, null] } },
        state: { open: undefined, count: 0 },
      },
      events: [undefined, { result: {}, state: {} }],
    };

    const read = outOfFileForm(
      JSON.parse(JSON.stringify(inFileForm(values))),
    ) as typeof values;

    // JSON alone drops `open` and reads the second child as `null`.
    expect(Object.keys(read.settled.state)).toEqual(["open", "count"]);
    expect(read.settled.state.open).toBe(undefined);
    expect(read.settled.result.$UI.children).toEqual(["a", undefined, null]);
    expect(read.settled.result.$UI.children[1]).toBe(undefined);
    expect(read.events[0]).toBe(undefined);
    expect(read.events.length).toBe(2);
  });

  it("read a file that holds no such member as it is", () => {
    const stored = { settled: { result: { a: [1, null] }, state: {} } };

    expect(outOfFileForm(stored)).toEqual(stored);
  });
});

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

  it("compares an error state as nothing, which is what today's runtime stores", () => {
    expect(
      normalize({ a: 1, b: { $error: { message: "negative" } } }),
    ).toEqual({ a: 1 });
    expect(normalize([1, { $error: { message: "negative" } }])).toEqual([
      1,
      undefined,
    ]);
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

  it("names the length of two arrays where one holds further positions that hold nothing", () => {
    expect(firstDifference({ a: [] }, { a: [undefined] }))
      .toEqual({ path: "a/length", a: "0", b: "1" });
    expect(firstDifference([1], [1, undefined]))
      .toEqual({ path: "length", a: "1", b: "2" });
  });

  it("names the first position that differs in two arrays of two lengths", () => {
    expect(firstDifference([1], [1, 2]))
      .toEqual({ path: "1", a: "undefined", b: "2" });
  });
});

describe("the values of a fixture", () => {
  it("are equal for a handler that draws from `Math.random`, which is seeded on both sides", async () => {
    const [{ comparison }] = await compareFixtures("random");

    expect(comparison.notExecuted).toBeUndefined();
    expect(comparison.failedEvents).toEqual([]);
    expect(comparison.differences).toEqual([]);
    // The settled values and those after each of the two events.
    expect(comparison.compared).toBe(18);
  });

  it("lists the identifier of each document that the executor stored, in order", async () => {
    const [{ comparison }] = await compareFixtures("handler");
    const identifiers = comparison.documentIds ?? [];

    // The result, the argument, and the cells that the event wrote.
    expect(identifiers).toContain("result");
    expect(identifiers.length).toBeGreaterThan(2);
    expect(identifiers).toEqual([...new Set(identifiers)].sort());
  });

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
    // Each of the two rows holds the link to its stream of `pickAt` and
    // to its stream of `clear`.
    expect(comparison.storedStreams).toBe(4);
  });

  it("are equal where a pattern compiled in declares a default for a path", async () => {
    // Rulings Z4 and Z16: with the caller's slot given, and with nothing
    // stored there, where both runs read the callee's default.
    const rows = await compareFixtures("callee-default");

    expect(rows.length).toBe(2);
    const [given, empty] = rows.map(({ comparison }) => comparison);
    expect(given.notExecuted).toBeUndefined();
    expect(given.differences).toEqual([]);
    expect(given.compared).toBe(11);
    // One value differs where the slot is empty: the path the callee
    // passes on by reference. A read of today's runtime addressed at the
    // path gives the callee's default, as the executor's does. The
    // comparison reads the whole result at once, and today's whole read
    // drops a default that the schema of a link declares for a member
    // (the first of the two rows the measurement of ruling Z8 excepts).
    expect(empty.notExecuted).toBeUndefined();
    expect(empty.compared).toBe(11);
    expect(
      empty.differences.map(({ value, path, runtime, executor }) => ({
        value,
        path,
        runtime,
        executor,
      })),
    ).toEqual([{
      value: "result/marked",
      path: "symbol",
      runtime: "undefined",
      executor: '"$"',
    }]);
  });

  it("are equal for a map over a filter over a map", async () => {
    // Ruling Z6: over records and over plain values.
    const [{ comparison }] = await compareFixtures("chain");

    expect(comparison.notExecuted).toBeUndefined();
    expect(comparison.differences).toEqual([]);
    expect(comparison.compared).toBe(2);
  });

  it("are equal for a stream at a member written after a spread and at a child written after a JSX spread child, in a `computed`", async () => {
    // The arrays hold plain values in place, which each `computed`
    // reads whole.
    const [{ comparison }] = await compareFixtures("spread-stream");

    expect(comparison.notExecuted).toBeUndefined();
    expect(comparison.differences).toEqual([]);
    expect(comparison.failedEvents).toEqual([]);
    expect(comparison.notSent ?? []).toEqual([]);
    // Four members of the result and one state cell, after the instance
    // settled and after each of the two events.
    expect(comparison.compared).toBe(15);
    expect(comparison.equal).toBe(15);
    // The links of `after` in `rows` and in the tree, and of `tail` in
    // `words`.
    expect(comparison.storedStreams).toBe(3);
  });

  it("are equal for cones with side-writes of both kinds", async () => {
    // Ruling Z7: two cones that write a named cell, one of them demanded
    // by a path that passes the cell on, and a materializer.
    const [{ comparison }] = await compareFixtures("side-writes");

    expect(comparison.notExecuted).toBeUndefined();
    expect(comparison.differences).toEqual([]);
    expect(comparison.failedEvents).toEqual([]);
    // Six members of the result and four state cells, after the instance
    // settled and after the event.
    expect(comparison.compared).toBe(20);
  });
});
