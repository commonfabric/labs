import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance } from "../executor.ts";

// The executor of `execution-and-storage.md` (ES) on the artifacts of the
// fixtures of the comparison: `compare/fixtures/<name>.emit.json` is the
// output of `pattern-compiler emit` for `<name>.tsx`.

const artifactOf = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(`../../compare/fixtures/${name}.emit.json`, import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find((pattern) => pattern.name === "default") ??
    patterns[patterns.length - 1];
};

type ViewNode = {
  name: string;
  props: Record<string, unknown>;
  children: unknown[];
};

describe("an instance", () => {
  it("computes each kept output from the slots its cone reads", async () => {
    const instance = new Instance(await artifactOf("small"), {
      secret: "s3cret",
      note: "n",
      flag: false,
      items: [{ title: "a", done: false }, { title: "b", done: true }],
    });

    expect(instance.result()).toEqual({
      shout: "S3CRET",
      echo: "S3CRET?",
      greeting: "hi n",
      chosen: "n",
      direct: "n",
      both: "s3cretn",
      count: 2,
      titles: ["a", "b"],
      loud: ["a!", "b!"],
      note: "n",
      secret: "s3cret",
    });
    // The value code reads no slot its cone does not list, and no output
    // over no edge.
    expect(instance.counts.slotsNotListed).toBe(0);
    expect(instance.counts.readsWithoutSlot).toBe(0);
    expect(instance.counts.outputsWithoutEdge).toBe(0);
  });

  it("stores no document for a state cell until something writes it", async () => {
    const instance = new Instance(await artifactOf("handler"), {
      secret: "s3cret",
      note: "n",
    });

    // A constant first value is the default of the cell's schema: a read
    // of the cell reads it, and nothing is written at creation.
    expect(instance.documents()).toEqual({ "argument": 1, "result": 1 });
    expect(instance.stateCells()).toEqual([
      { name: "last", keys: [], value: "" },
      { name: "log", keys: [], value: [] },
    ]);
    expect(instance.result()).toEqual({
      last: "",
      log: [],
      note: "n",
      record: { $stream: true },
    });

    instance.send(0, { text: "hello", extra: "x" });

    expect(instance.documents()).toEqual({
      "argument": 1,
      "result": 1,
      "state cell": 2,
    });
  });

  it("starts a write below the root of an empty cell from the default", async () => {
    const instance = new Instance(await artifactOf("state-first"), {
      start: 3,
      items: [],
    });
    const draft = () =>
      instance.stateCells().find(({ name }) => name === "draft")?.value;
    expect(draft()).toEqual({ text: "", tags: ["new"] });

    // As a writer through a handle to the cell would write one member.
    instance.writeState("draft", ["text"], "hello");

    expect(draft()).toEqual({ text: "hello", tags: ["new"] });
  });

  it("writes a first value that is not a constant once, at creation", async () => {
    const instance = new Instance(await artifactOf("state-first"), {
      start: 3,
      items: ["a", "b"],
    });

    // `count` and the `at` of each element have a document, and `label`
    // and `draft`, whose first value is a constant, have none.
    expect(instance.documents()).toEqual({
      "argument": 1,
      "result": 1,
      "state cell": 3,
    });
    const result = () =>
      instance.result() as {
        label: string;
        count: number;
        rows: { item: string; at: number }[];
      };
    expect(result().label).toBe("none");
    expect(result().count).toBe(3);
    expect(result().rows).toEqual([{ item: "a", at: 0 }, { item: "b", at: 1 }]);

    // The cell holds the value and no reference to the input: a write of
    // the cell leaves the input, and a change of the input the cell.
    instance.send(0, {});
    expect(result().count).toBe(4);
    instance.writeArgument(["start"], 9);
    expect(result().count).toBe(4);

    // A move changes the index, and the cell of a key keeps its value.
    instance.writeArgument(["items"], ["b", "a"]);
    expect(result().rows).toEqual([{ item: "b", at: 1 }, { item: "a", at: 0 }]);
  });

  it("reads the default of a slot's schema where nothing is stored", async () => {
    const instance = new Instance(await artifactOf("defaulted"), {
      profile: { name: "ada" },
    });

    expect((instance.result() as { whole: unknown }).whole).toEqual({
      name: "ada",
      nick: "anon",
    });
  });
});

describe("an event", () => {
  it("runs the handler's body and evaluates again what read a written cell", async () => {
    const instance = new Instance(await artifactOf("handler"), {
      secret: "s3cret",
      note: "n",
    });
    const before = instance.counts.evaluations;

    const outcome = instance.send(0, { text: "hello", extra: "x" });

    expect(outcome).toEqual({ binding: 0, committed: true });
    expect(instance.result()).toEqual({
      last: "hellos3cret",
      log: [{ text: "hello" }],
      note: "n",
      record: { $stream: true },
    });
    // Each write is one a write edge of the handler's body names.
    expect(instance.counts.writesCovered).toBe(2);
    expect(instance.counts.writesNotCovered).toBe(0);
    // The result passes the two cells on by reference, so no cone read
    // what the handler wrote, and nothing is evaluated again.
    expect(instance.counts.evaluations).toBe(before);
  });

  it("evaluates again the cones that read what the handler wrote, and no other", async () => {
    const instance = new Instance(await artifactOf("outer-stream"), {
      items: ["a", "b"],
      shown: true,
    });
    const before = instance.counts.evaluations;

    instance.send(0, { by: 2 });

    expect((instance.result() as { count: number }).count).toBe(2);
    // The tree holds the stream and not the count.
    expect(instance.counts.evaluations).toBe(before);
  });

  it("commits nothing of a handler that throws", async () => {
    const instance = new Instance(await artifactOf("handler-throws"), {
      label: "l",
    });

    const outcome = instance.send(0, {});

    expect(outcome.committed).toBe(false);
    expect(outcome.error).toBe("nothing recorded yet");
    expect((instance.result() as { last?: string }).last).toBeUndefined();
  });

  it("reaches the handler a handler sends to", async () => {
    const instance = new Instance(await artifactOf("stream-target"), {
      start: 1,
    });

    // Binding 1 is the inline handler, which sends to the stream of
    // binding 0.
    instance.send(1, {});

    expect((instance.result() as { count: number }).count).toBe(2);
  });
});

describe("an element construct", () => {
  it("keys two equal plain values by their value and their count", async () => {
    const instance = new Instance(await artifactOf("equal-values"), {
      tags: ["a", "a"],
    });

    // A state cell per occurrence (PL §1.3, "A state cell is per
    // occurrence").
    expect(instance.stateCells().map(({ keys }) => keys)).toEqual([
      ['value:"a"#0'],
      ['value:"a"#1'],
    ]);

    // The event names the second occurrence, and its cell alone is set.
    instance.send(0, {}, [1]);

    expect(instance.stateCells().map(({ value }) => value)).toEqual([
      false,
      true,
    ]);
    const tree = (instance.result() as { $UI: ViewNode }).$UI;
    expect((tree.children as ViewNode[]).map((row) => row.children)).toEqual([
      ["a", false],
      ["a", true],
    ]);
  });

  it("keeps an element's state with its value when the element moves", async () => {
    const instance = new Instance(await artifactOf("equal-values"), {
      tags: ["a", "b"],
    });
    instance.send(0, {}, [1]);
    const before = instance.counts.elementEvaluations;

    instance.writeArgument(["tags"], ["b", "a"]);

    const tree = (instance.result() as { $UI: ViewNode }).$UI;
    expect((tree.children as ViewNode[]).map((row) => row.children)).toEqual([
      ["b", true],
      ["a", false],
    ]);
    // The results of a key move with it, and nothing is evaluated for
    // the element (ruling Z6).
    expect(instance.counts.elementEvaluations).toBe(before);
    // One cell per key, and a document for the one the event wrote.
    expect(instance.stateCells().length).toBe(2);
    expect(instance.documents()["state cell"]).toBe(1);
  });

  it("evaluates again, after a move, the cones that read the index", async () => {
    const instance = new Instance(await artifactOf("index-nodes"), {
      items: [{ title: "a" }, { title: "b" }, { title: "c" }],
    });
    expect((instance.result() as { numbered: number[] }).numbered).toEqual([
      1,
      2,
      3,
    ]);
    const before = { ...instance.counts };

    // The last element stays at its position.
    instance.writeArgument(["items"], [
      { title: "b" },
      { title: "a" },
      { title: "c" },
    ]);

    expect((instance.result() as { numbered: number[] }).numbered).toEqual([
      1,
      2,
      3,
    ]);
    const tree = (instance.result() as { $UI: ViewNode }).$UI;
    expect(
      (tree.children as ViewNode[]).map((row) =>
        (row.children[0] as ViewNode).children
      ),
    ).toEqual([["b"], ["a"], ["c"]]);
    // Evaluated again for an element: the function that reads the index,
    // for each of the two moved keys. The function that reads the element
    // is not, for no key: its result moves with the key (ruling Z6).
    expect(instance.counts.elementEvaluations - before.elementEvaluations)
      .toBe(2);
    // The runtime's own steps: the two collections are assembled again.
    expect(instance.counts.assemblies - before.assemblies).toBe(2);
  });

  it("stores the value where a cone passes on an element that is a plain value", async () => {
    const instance = new Instance(await artifactOf("equal-values"), {
      tags: ["a", "b"],
    });

    // No row holds a link to a position of the array.
    const stored = JSON.stringify(instance.store.docs.get("result")?.value);
    expect(stored).not.toContain('"path":["tags"');
    expect(stored).toContain('"children":["a",');
  });

  it("gives a handler bound in the body the index its element has at the event", async () => {
    const instance = new Instance(await artifactOf("index-nodes"), {
      items: [{ title: "a" }, { title: "b" }],
    });

    instance.send(0, {}, [1]);

    expect((instance.result() as { chosen: number }).chosen).toBe(1);
  });
});

describe("a pattern compiled in", () => {
  it("binds a path the call leaves out to the callee's default", async () => {
    const instance = new Instance(await artifactOf("callee-default"), {
      amount: 420,
      sign: "€",
    });

    const result = instance.result() as Record<string, string>;
    expect(result.omitted).toBe("$420");
    expect(result.omittedSpelled).toBe("$");
    expect(result.bound).toBe("€420");
  });

  it("reads the callee's default where the caller's slot holds nothing", async () => {
    const instance = new Instance(await artifactOf("callee-default"), {
      amount: 420,
    });

    // Expression code and a sandboxed body both read the default.
    expect(instance.result()).toEqual({
      omitted: "$420",
      omittedSpelled: "$",
      bound: "$420",
      boundSpelled: "$",
    });

    // A value stored at the slot later is read in place of the default.
    instance.writeArgument(["sign"], "kr");

    expect((instance.result() as { bound: string }).bound).toBe("kr420");
    expect((instance.result() as { boundSpelled: string }).boundSpelled)
      .toBe("k-r");
  });
});

// Ruling Z6 on `fixtures/chain.tsx`: a `map` over a `filter` over a `map`.
// An element of the result of a per-element construct has the key of the
// upstream element it came from.
describe("a chain of element constructs", () => {
  const link = (name: string) => ({
    $link: { doc: "argument", path: ["pool", name] },
  });
  // The elements of `items` are references to cells, and those of `tags`
  // are plain values stored in place.
  const argument = () => ({
    pool: {
      a: { title: "a", done: false },
      b: { title: "b", done: true },
      c: { title: "c", done: false },
    },
    items: [link("a"), link("b"), link("c")],
    tags: ["x", "skip", "y"],
  });
  type Chains = { open: string[]; loud: string[] };

  it("computes the chain over references and over plain values", async () => {
    const instance = new Instance(await artifactOf("chain"), argument());

    expect(instance.result()).toEqual({
      open: ["a!?", "c!?"],
      loud: ["x!?", "y!?"],
    });
    // Three bodies for each of three elements of `items`, less the last
    // body for the element the filter drops, and the same for `tags`.
    expect(instance.counts.elementEvaluations).toBe(16);
  });

  it("evaluates, for a change behind one reference, that element's cone instances alone", async () => {
    const instance = new Instance(await artifactOf("chain"), argument());
    const before = instance.counts.elementEvaluations;

    instance.writeArgument(["pool", "a", "title"], "z");

    expect((instance.result() as Chains).open).toEqual(["z!?", "c!?"]);
    // The first `map` and the last, for the key of `a`. The predicate of
    // the `filter` read `done`, which did not change.
    expect(instance.counts.elementEvaluations - before).toBe(2);
  });

  it("evaluates the predicate alone where the element leaves the result", async () => {
    const instance = new Instance(await artifactOf("chain"), argument());
    const before = instance.counts.elementEvaluations;

    instance.writeArgument(["pool", "a", "done"], true);

    expect((instance.result() as Chains).open).toEqual(["c!?"]);
    expect(instance.counts.elementEvaluations - before).toBe(1);
  });

  it("evaluates, for a plain value that changed in place, the new key down the chain", async () => {
    const instance = new Instance(await artifactOf("chain"), argument());
    const before = instance.counts.elementEvaluations;

    instance.writeArgument(["tags"], ["w", "skip", "y"]);

    expect((instance.result() as Chains).loud).toEqual(["w!?", "y!?"]);
    // The old key leaves and a new key enters: one cone instance in each
    // of the three bodies, and none for `skip` or `y`.
    expect(instance.counts.elementEvaluations - before).toBe(3);
  });

  it("evaluates nothing for an element when the elements move", async () => {
    const instance = new Instance(await artifactOf("chain"), argument());
    const before = { ...instance.counts };

    instance.writeArgument(["items"], [link("c"), link("b"), link("a")]);
    instance.writeArgument(["tags"], ["y", "skip", "x"]);

    expect(instance.result()).toEqual({
      open: ["c!?", "a!?"],
      loud: ["y!?", "x!?"],
    });
    expect(instance.counts.elementEvaluations - before.elementEvaluations)
      .toBe(0);
    // Each of the six collections is assembled again, once.
    expect(instance.counts.assemblies - before.assemblies).toBe(6);
  });
});

// Ruling Z7 on `fixtures/side-writes.tsx`: a cone with side-writes is of
// one of two kinds, which `Cone.sideWrites` holds.
describe("a cone with side-writes", () => {
  type Result = {
    last: string;
    shown: string;
    tallied: string;
    counts: Record<string, number>;
    total: number;
  };

  it("is demanded through a write target the result passes on by reference", async () => {
    const instance = new Instance(await artifactOf("side-writes"), {
      flavor: "mint",
    });

    // No kept output is computed by `_upper`, and the result reads
    // nothing of `last`: it holds the cell.
    expect((instance.result() as Result).last).toBe("A");
    // The writing cone is evaluated before the result is stored.
    expect(instance.trace.indexOf("_upper")).toBeLessThan(
      instance.trace.indexOf("result"),
    );

    instance.send(0, { to: "b" });

    expect((instance.result() as Result).last).toBe("B");
  });

  it("is evaluated before a cone that reads its write target", async () => {
    const instance = new Instance(await artifactOf("side-writes"), {
      flavor: "mint",
    });

    expect((instance.result() as Result).shown).toBe("seen a!");
    expect(instance.trace.indexOf("_marked")).toBeLessThan(
      instance.trace.indexOf("shown"),
    );
    // The reader is evaluated once: it read what the writer had written.
    expect(instance.trace.filter((entry) => entry === "shown").length).toBe(1);

    instance.send(0, { to: "b" });

    expect((instance.result() as Result).shown).toBe("seen b!");
  });

  it("is evaluated after the rest of the wave where it is a materializer", async () => {
    const instance = new Instance(await artifactOf("side-writes"), {
      flavor: "mint",
    });

    const result = instance.result() as Result;
    expect(result.tallied).toBe("mint");
    expect(result.counts).toEqual({ mint: 4 });
    expect(result.total).toBe(1);
    // The materializer runs after the result of the first wave, and what
    // it wrote makes its reader stale, which a further wave evaluates.
    const { trace } = instance;
    expect(trace.indexOf("tallied")).toBeGreaterThan(trace.indexOf("result"));
    expect(trace.indexOf("total")).toBeLessThan(trace.indexOf("tallied"));
    expect(trace.filter((entry) => entry === "total").length).toBe(2);
    expect(trace.filter((entry) => entry === "tallied").length).toBe(1);
  });

  it("is evaluated again as a materializer when an input changed", async () => {
    const instance = new Instance(await artifactOf("side-writes"), {
      flavor: "mint",
    });
    const before = instance.trace.length;

    instance.writeArgument(["flavor"], "lime");

    expect((instance.result() as Result).counts).toEqual({ mint: 4, lime: 4 });
    expect((instance.result() as Result).total).toBe(2);
    expect(instance.trace.slice(before).filter((entry) => entry === "tallied"))
      .toEqual(["tallied"]);
  });

  it("is not evaluated where nothing demanded reads its write target", async () => {
    const instance = new Instance(await artifactOf("side-write-undemanded"), {
      note: "n",
    });

    expect(instance.trace).not.toContain("_copy");
    expect(instance.stateCells()).toEqual([
      { name: "unseen", keys: [], value: "" },
    ]);
    expect(instance.documents()).toEqual({ "argument": 1, "result": 1 });
  });
});

describe("a value read under a schema", () => {
  it("keeps the address of a member, so a handler finds it again", async () => {
    // The handler of `fixtures/element-resolved.tsx` and the like read a
    // list through a handle whose schema describes the members. A member
    // read that way is the stored one: `equals` and `remove` find it.
    const { Ref, Store } = await import("../store.ts");
    const store = new Store();
    store.create("d", "argument", { items: [{ title: "a" }, { title: "b" }] });
    const schema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          done: { type: "boolean", default: false },
        },
      },
    };

    const read = store.read(new Ref("d", ["items"], schema)) as object[];

    expect(read).toEqual([{ title: "a", done: false }, {
      title: "b",
      done: false,
    }]);
    expect(store.addresses.get(read[1])?.path).toEqual(["items", "1"]);
  });
});
