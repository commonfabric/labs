import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Host, Instance } from "../executor.ts";
import { Ref, Store } from "../store.ts";

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

// `fixtures/flat-keys.tsx`: an element of the result of a `flatMap` has
// the key of the element its segment came from, with the position in the
// segment (PL §1.3, assumed there under question 101).
describe("the keys of the result of a `flatMap`", () => {
  const link = (name: string) => ({
    $link: { doc: "argument", path: ["pool", name] },
  });
  // The elements of `groups` are references to cells, and each segment is
  // an array the element holds. Those of `words` are plain values stored
  // in place, and each segment is an array the callback writes.
  const argument = () => ({
    pool: {
      g: { name: "g", members: ["a", "b"] },
      h: { name: "h", members: ["c"] },
    },
    groups: [link("g"), link("h")],
    words: ["x", "y"],
  });
  type Flat = {
    names: string[];
    loudNames: string[];
    halves: string[];
    loudHalves: string[];
  };
  const coneOf = (artifact: Artifact, entry: string) =>
    artifact.plan.cones.findIndex((cone) => cone.entry === entry);
  const g = 'cell:argument:["pool","g"]#0';
  const h = 'cell:argument:["pool","h"]#0';

  it("keys an element by its source element and its position, over references", async () => {
    const artifact = await artifactOf("flat-keys");
    const instance = new Instance(artifact, argument());

    expect((instance.result() as Flat).loudNames).toEqual(["a!", "b!", "c!"]);
    // The cone instances of the body over the result of the `flatMap`.
    expect(instance.coneInstances(coneOf(artifact, "loudNames"))).toEqual([
      [`${g}/0`],
      [`${g}/1`],
      [`${h}/0`],
    ]);
  });

  it("keys an element by its source element and its position, over plain values", async () => {
    const artifact = await artifactOf("flat-keys");
    const instance = new Instance(artifact, argument());

    expect((instance.result() as Flat).loudHalves).toEqual([
      "x1!",
      "x2!",
      "y1!",
      "y2!",
    ]);
    expect(instance.coneInstances(coneOf(artifact, "loudHalves"))).toEqual([
      ['value:"x"#0/0'],
      ['value:"x"#0/1'],
      ['value:"y"#0/0'],
      ['value:"y"#0/1'],
    ]);
  });

  it("evaluates the new position alone where a segment behind a reference grows", async () => {
    const instance = new Instance(await artifactOf("flat-keys"), argument());
    const before = instance.counts.elementEvaluations;

    instance.writeArgument(["pool", "h", "members", "1"], "d");

    expect((instance.result() as Flat).loudNames).toEqual([
      "a!",
      "b!",
      "c!",
      "d!",
    ]);
    // The callback of the `flatMap` passes the element's array on and
    // reads nothing, so the one evaluation is of the new key `h/1`.
    expect(instance.counts.elementEvaluations - before).toBe(1);
  });

  it("evaluates nothing for an element when the source elements move, over references", async () => {
    const instance = new Instance(await artifactOf("flat-keys"), argument());
    const before = instance.counts.elementEvaluations;

    instance.writeArgument(["groups"], [link("h"), link("g")]);

    expect((instance.result() as Flat).loudNames).toEqual(["c!", "a!", "b!"]);
    expect(instance.counts.elementEvaluations - before).toBe(0);
  });

  it("evaluates nothing for an element when the source elements move, over plain values", async () => {
    const instance = new Instance(await artifactOf("flat-keys"), argument());
    const before = instance.counts.elementEvaluations;

    instance.writeArgument(["words"], ["y", "x"]);

    expect((instance.result() as Flat).loudHalves).toEqual([
      "y1!",
      "y2!",
      "x1!",
      "x2!",
    ]);
    expect(instance.counts.elementEvaluations - before).toBe(0);
  });

  it("evaluates the segment of a plain value that entered, and no other", async () => {
    const artifact = await artifactOf("flat-keys");
    const instance = new Instance(artifact, argument());
    const before = instance.counts.elementEvaluations;

    instance.writeArgument(["words"], ["x", "z"]);

    expect((instance.result() as Flat).loudHalves).toEqual([
      "x1!",
      "x2!",
      "z1!",
      "z2!",
    ]);
    // The callback of the `flatMap` for `z`, and the two positions of its
    // segment. The instances of the key that left are dropped.
    expect(instance.counts.elementEvaluations - before).toBe(3);
    expect(instance.coneInstances(coneOf(artifact, "loudHalves"))).toEqual([
      ['value:"x"#0/0'],
      ['value:"x"#0/1'],
      ['value:"z"#0/0'],
      ['value:"z"#0/1'],
    ]);
  });

  it("evaluates both positions where two members of one segment change places", async () => {
    const instance = new Instance(await artifactOf("flat-keys"), argument());
    const before = instance.counts.elementEvaluations;

    instance.writeArgument(["pool", "g", "members"], ["b", "a"]);

    expect((instance.result() as Flat).loudNames).toEqual(["b!", "a!", "c!"]);
    // The position in the segment is in the key, so a move inside a
    // segment is a change of what two keys hold, and not a move of two
    // keys: the instances of `g/0` and `g/1` are evaluated again.
    expect(instance.counts.elementEvaluations - before).toBe(2);
  });
});

// Ruling Z10 on `fixtures/within.tsx`: the executor takes which instances
// of a cone exist, and where what an instance holds is kept, from the
// `element` steps of `Cone.within`. Each callback of the fixture declares
// `fixed`, whose cone lists no slot of root `element` or `index`.
describe("the `within` of a cone", () => {
  const link = (name: string) => ({
    $link: { doc: "argument", path: ["pool", name] },
  });
  // The elements of `items` are references to cells. Those of `tags` are
  // plain values stored in place, and `loud` is over the result of a
  // `filter` of them.
  const argument = () => ({
    pool: { a: { title: "a" }, b: { title: "b" } },
    items: [link("a"), link("b")],
    tags: ["x", "skip", "y"],
    note: "n",
  });
  const cones = (artifact: Artifact, entry: string) =>
    artifact.plan.cones.flatMap((cone, index) =>
      cone.entry === entry ? [index] : []
    );

  it("is in the plan, and the artifact holds no list beside it", async () => {
    const artifact = await artifactOf("within");

    expect("coneWithin" in artifact.code).toBe(false);
    expect(
      cones(artifact, "fixed").map((cone) => artifact.plan.cones[cone].within),
    ).toEqual([[{ element: 0 }], [{ element: 1 }], [{ element: 3 }]]);
  });

  it("gives a cone that reads no element an instance per key over references", async () => {
    const artifact = await artifactOf("within");
    const instance = new Instance(artifact, argument());
    const [fixed] = cones(artifact, "fixed");

    expect((instance.result() as { rows: string[] }).rows).toEqual([
      "an?",
      "bn?",
    ]);
    expect(instance.coneInstances(fixed)).toEqual([
      ['cell:argument:["pool","a"]#0'],
      ['cell:argument:["pool","b"]#0'],
    ]);
  });

  it("gives such a cone an instance per key over plain values in place", async () => {
    const artifact = await artifactOf("within");
    const instance = new Instance(artifact, argument());
    const [, fixed] = cones(artifact, "fixed");

    expect((instance.result() as { marks: string[] }).marks).toEqual([
      "xn?",
      "skipn?",
      "yn?",
    ]);
    expect(instance.coneInstances(fixed)).toEqual([
      ['value:"x"#0'],
      ['value:"skip"#0'],
      ['value:"y"#0'],
    ]);
  });

  it("gives such a cone an instance per key over the result of a `filter`", async () => {
    const artifact = await artifactOf("within");
    const instance = new Instance(artifact, argument());
    const [, , fixed] = cones(artifact, "fixed");

    expect((instance.result() as { loud: string[] }).loud).toEqual([
      "xn?",
      "yn?",
    ]);
    // The keys are those of the elements the `filter` kept.
    expect(instance.coneInstances(fixed)).toEqual([
      ['value:"x"#0'],
      ['value:"y"#0'],
    ]);
  });

  it("evaluates every instance of such a cone when what it reads changes", async () => {
    const artifact = await artifactOf("within");
    const instance = new Instance(artifact, argument());
    // Two cones for each of 2, 3 and 2 keys, and the predicate for 3.
    expect(instance.counts.elementEvaluations).toBe(17);
    const before = instance.counts.elementEvaluations;

    instance.writeArgument(["note"], "m");

    expect(instance.result()).toEqual({
      rows: ["am?", "bm?"],
      marks: ["xm?", "skipm?", "ym?"],
      loud: ["xm?", "ym?"],
    });
    // `fixed` once per key, and the cone that reads it once per key.
    expect(instance.counts.elementEvaluations - before).toBe(14);
  });

  it("makes the instances of a key when the key is added, and drops them when it is removed", async () => {
    const artifact = await artifactOf("within");
    const instance = new Instance(artifact, argument());
    const [rows, marks, loud] = cones(artifact, "fixed");
    const before = instance.counts.elementEvaluations;

    instance.writeArgument(["items"], [link("b")]);
    instance.writeArgument(["tags"], ["skip", "y", "z"]);

    expect(instance.coneInstances(rows)).toEqual([
      ['cell:argument:["pool","b"]#0'],
    ]);
    expect(instance.coneInstances(marks)).toEqual([
      ['value:"skip"#0'],
      ['value:"y"#0'],
      ['value:"z"#0'],
    ]);
    expect(instance.coneInstances(loud)).toEqual([
      ['value:"y"#0'],
      ['value:"z"#0'],
    ]);
    // For the key `z`: two cones of `marks`, the predicate, and two cones
    // of `loud`. Nothing is evaluated for a key that stayed or left.
    expect(instance.counts.elementEvaluations - before).toBe(5);

    // A key that comes back has new instances, which are evaluated.
    instance.writeArgument(["tags"], ["skip", "y", "z", "x"]);

    expect(instance.counts.elementEvaluations - before).toBe(10);
  });
});

// Ruling Z11 on `fixtures/stream-marker.tsx`: `host.stream` gives value
// code a marker, and the executor replaces it when it stores the value
// and checks the position against `Binding.result`.
describe("the stream of a binding in a computed value", () => {
  const link = (name: string) => ({
    $link: { doc: "argument", path: ["pool", name] },
  });
  // The elements of `items` are references to cells. Those of `tags` are
  // plain values stored in place, and the last list is over the result of
  // a `filter` of them.
  const argument = (shown = false) => ({
    pool: { a: { title: "a" }, b: { title: "b" } },
    items: [link("a"), link("b")],
    tags: ["x", "skip", "y"],
    shown,
  });
  type Stored = {
    props: Record<string, unknown>;
    children: Stored[];
  };
  const tree = (instance: Instance) =>
    (instance.store.docs.get("result")?.value as { $UI: Stored }).$UI;
  const streamsOf = (rows: Stored[]) => rows.map((row) => row.props.onClick);
  const without = (artifact: Artifact, binding: number, path: string[]) => {
    const copy = structuredClone(artifact);
    const record = copy.plan.bindings[binding];
    record.result = (record.result ?? []).filter((listed) =>
      JSON.stringify(listed) !== JSON.stringify(path)
    );
    return copy;
  };

  it("is a marker that value code can do nothing with", async () => {
    const instance = new Instance(
      await artifactOf("stream-marker"),
      argument(),
    );
    const host = new Host(instance, new Map(), undefined);

    const marker = host.stream(0) as Record<string, unknown>;

    // No member to send an event with, none to read through, and none
    // that names the binding or a key.
    expect(Object.isFrozen(marker)).toBe(true);
    expect(Reflect.ownKeys(marker)).toEqual([]);
    for (const name of ["send", "get", "set", "key", "binding", "keys"]) {
      expect(name in marker).toBe(false);
    }
    expect(JSON.stringify(marker)).toBe("{}");
    // A read of it and a read below it give no value of the stream.
    expect(host.v(marker)).toBe(marker);
    expect(host.at(marker, ["count"])).toBe(undefined);
  });

  it("is stored as the one stream of a binding outside every element body", async () => {
    const instance = new Instance(
      await artifactOf("stream-marker"),
      argument(true),
    );
    const stored = instance.store.docs.get("result")?.value as {
      inc: unknown;
    };
    const one = { $stream: { binding: 0, keys: [] } };

    // At a member of the result, below the conditional, and after the
    // spread of a collection.
    expect(stored.inc).toEqual(one);
    expect(tree(instance).children[0].props.onClick).toEqual(one);
    expect(tree(instance).children[1].children[2].props.onClick).toEqual(one);
    expect(instance.failures).toEqual([]);
  });

  it("is stored as the stream of the instance's key over references", async () => {
    const instance = new Instance(
      await artifactOf("stream-marker"),
      argument(),
    );

    expect(streamsOf(tree(instance).children[1].children.slice(0, 2)))
      .toEqual([
        { $stream: { binding: 1, keys: ['cell:argument:["pool","a"]#0'] } },
        { $stream: { binding: 1, keys: ['cell:argument:["pool","b"]#0'] } },
      ]);

    // An event for the stream of the second key reads that element.
    instance.send(1, {}, [1]);

    expect((instance.result() as { chosen: string }).chosen).toBe("b");
  });

  it("is stored as the stream of the instance's key over plain values in place", async () => {
    const instance = new Instance(
      await artifactOf("stream-marker"),
      argument(),
    );

    expect(streamsOf(tree(instance).children[2].children)).toEqual([
      { $stream: { binding: 2, keys: ['value:"x"#0'] } },
      { $stream: { binding: 2, keys: ['value:"skip"#0'] } },
      { $stream: { binding: 2, keys: ['value:"y"#0'] } },
    ]);

    instance.send(2, {}, [1]);

    expect((instance.result() as { chosen: string }).chosen).toBe("skip");
  });

  it("is stored as the stream of the instance's key over the result of a `filter`", async () => {
    const instance = new Instance(
      await artifactOf("stream-marker"),
      argument(),
    );

    // The keys are those of the elements the `filter` kept.
    expect(streamsOf(tree(instance).children[3].children)).toEqual([
      { $stream: { binding: 3, keys: ['value:"x"#0'] } },
      { $stream: { binding: 3, keys: ['value:"y"#0'] } },
    ]);

    instance.send(3, {}, [1]);

    expect((instance.result() as { chosen: string }).chosen).toBe("y");
  });

  it("fails the evaluation that stores a marker at a position no listed path covers", async () => {
    const artifact = without(await artifactOf("stream-marker"), 0, ["inc"]);

    const instance = new Instance(artifact, argument());

    expect(instance.failures).toEqual([{
      evaluation: "result",
      binding: 0,
      path: ["inc"],
    }]);
    // No link is stored: the result holds what it held before.
    expect(instance.store.docs.get("result")?.value).toBe(undefined);
  });

  it("matches a `*` of a listed path at any element, in each of the three bodies", async () => {
    const artifact = await artifactOf("stream-marker");
    const paths = [1, 2, 3].map((binding) =>
      artifact.plan.bindings[binding].result
    );

    expect(paths).toEqual([
      [["$UI", "children", "1", "children", "*", "props", "onClick"]],
      [["$UI", "children", "2", "children", "*", "props", "onClick"]],
      [["$UI", "children", "3", "children", "*", "props", "onClick"]],
    ]);
    expect(new Instance(artifact, argument()).failures).toEqual([]);
    // Without its path, each fails at the first element that holds it.
    for (const binding of [1, 2, 3]) {
      const instance = new Instance(
        without(artifact, binding, paths[binding - 1]![0]),
        argument(),
      );
      expect(instance.failures).toEqual([{
        evaluation: "result",
        binding,
        path: [
          "$UI",
          "children",
          `${binding}`,
          "children",
          "0",
          "props",
          "onClick",
        ],
      }]);
    }
  });

  it("matches a path below a conditional under either selection", async () => {
    const artifact = await artifactOf("stream-marker");
    const below = ["$UI", "children", "0", "props", "onClick"];
    expect(artifact.plan.bindings[0].result).toContainEqual(below);

    // The branch that writes the stream is selected, or the other one.
    expect(new Instance(artifact, argument(true)).failures).toEqual([]);
    expect(new Instance(artifact, argument(false)).failures).toEqual([]);
    // Without the path, the evaluation fails under the selection that
    // stores the marker, and under the other one it does not.
    const unlisted = without(artifact, 0, below);
    expect(new Instance(unlisted, argument(false)).failures).toEqual([]);
    expect(new Instance(unlisted, argument(true)).failures).toEqual([{
      evaluation: "result",
      binding: 0,
      path: below,
    }]);
  });

  it("passes a stream that is an input of the pattern on as an input", async () => {
    const artifact = await artifactOf("stream-marker");
    const instance = new Instance(artifact, argument());
    const stored = instance.store.docs.get("result")?.value as {
      outside: { $link: { doc: string; path: string[] } };
    };

    // The stored position holds a link to the place of the input, and no
    // stream of a binding: no path of `Binding.result` names it, and the
    // check does not apply.
    expect(stored.outside.$link.doc).toBe("argument");
    expect(stored.outside.$link.path).toEqual(["outside"]);
    const passed = tree(instance).children[4].props.onClick as {
      $link: { doc: string; path: string[] };
    };
    expect(passed.$link.path).toEqual(["outside"]);
    expect(instance.failures).toEqual([]);
    // A read of the position gives a stream, as a read of a binding's
    // stream does.
    expect((instance.result() as { outside: unknown }).outside).toEqual({
      $stream: true,
    });
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
  it("keeps the address of a member, so a handler finds it again", () => {
    // The handler of `fixtures/element-resolved.tsx` and the like read a
    // list through a handle whose schema describes the members. A member
    // read that way is the stored one: `equals` and `remove` find it.
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
