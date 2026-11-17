import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type Artifact,
  coversPosition,
  Handle,
  Host,
  Instance,
} from "../executor.ts";
import { keySegment, Ref, Store } from "../store.ts";

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

    // The record the handler pushed onto `log` has a document of its own.
    expect(instance.documents()).toEqual({
      "argument": 1,
      "result": 1,
      "state cell": 2,
      "element record": 1,
    });
  });

  it("starts a write below the root of an empty cell from the default", async () => {
    const instance = new Instance(await artifactOf("state-first"), {
      start: 3,
      items: [],
      seed: { name: "s", tags: [] },
      stops: [],
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
      seed: { name: "s", tags: [] },
      stops: [],
    });

    // `count`, `kept` and the `at` of each element have a document, and
    // `label` and `draft`, whose first value is a constant, have none.
    expect(instance.documents()).toEqual({
      "argument": 1,
      "result": 1,
      "state cell": 4,
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
    instance.send(
      instance.plan.bindings.findIndex((binding) => binding.name === "bump"),
      {},
    );
    expect(result().count).toBe(4);
    instance.writeArgument(["start"], 9);
    expect(result().count).toBe(4);

    // A move changes the index, and the cell of a key keeps its value.
    instance.writeArgument(["items"], ["b", "a"]);
    expect(result().rows).toEqual([{ item: "b", at: 1 }, { item: "a", at: 0 }]);
  });

  // Ruling Z14: a write below the root of an empty state cell creates
  // the document from the default with the write applied.
  // `fixtures/state-below.tsx` has such a cell in the pattern's body and
  // in three element bodies.
  describe("a write below the root of a state cell that has no document", () => {
    const link = (name: string) => ({
      $link: { doc: "argument", path: ["pool", name] },
    });
    const start = async () =>
      new Instance(await artifactOf("state-below"), {
        pool: { a: { title: "a" }, b: { title: "b" } },
        // References to cells.
        items: [link("a"), link("b")],
        // Plain values in place.
        words: ["x", "skip", "y"],
      });
    // The bindings named `retitle`, in the order of the plan: of the
    // three element bodies, and then of the pattern's body.
    const retitles = (instance: Instance) =>
      instance.plan.bindings.flatMap((binding, index) =>
        binding.name === "retitle" ? [index] : []
      );
    type Memo = { memo: unknown };
    type Result = {
      draft: unknown;
      marks: unknown;
      rows: Memo[];
      labels: Memo[];
      kept: Memo[];
    };

    it("starts the document from the default, for a member of a record", async () => {
      const instance = await start();
      expect(instance.documents()["state cell"]).toBe(undefined);
      const own = retitles(instance).find((index) =>
        instance.plan.bindings[index].within.length === 0
      )!;

      instance.send(own, { text: "hello" });

      expect(instance.documents()["state cell"]).toBe(1);
      expect((instance.result() as Result).draft).toEqual({
        text: "hello",
        tags: ["new"],
      });
    });

    it("starts the document from the default, for a `push` onto an array that is not empty", async () => {
      const instance = await start();
      const add = instance.plan.bindings.findIndex((binding) =>
        binding.name === "add"
      );

      instance.send(add, { tag: "second" });

      expect((instance.result() as Result).marks).toEqual(["first", "second"]);
    });

    it("does the same for a cell of an element body, over references", async () => {
      const instance = await start();

      instance.send(retitles(instance)[0], { text: "t" }, [1]);

      expect((instance.result() as Result).rows.map((row) => row.memo))
        .toEqual([{ text: "", tags: ["row"] }, { text: "t", tags: ["row"] }]);
      // The cell of the other key has no document still.
      expect(instance.documents()["state cell"]).toBe(1);
    });

    it("does the same for a cell of an element body, over plain values in place", async () => {
      const instance = await start();

      instance.send(retitles(instance)[1], { text: "t" }, [0]);

      expect((instance.result() as Result).labels.map((row) => row.memo))
        .toEqual([
          { text: "t", tags: ["label"] },
          { text: "", tags: ["label"] },
          { text: "", tags: ["label"] },
        ]);
    });

    it("does the same for a cell of an element body, over the result of a `filter`", async () => {
      const instance = await start();

      instance.send(retitles(instance)[2], { text: "t" }, [1]);

      expect((instance.result() as Result).kept.map((row) => row.memo))
        .toEqual([{ text: "", tags: ["kept"] }, { text: "t", tags: ["kept"] }]);
    });
  });

  // Ruling Z15: a computed first value is stored as a value, never as a
  // reference, so a write to the cell never lands in the input.
  describe("a first value that is an input whole", () => {
    const stop = (title: string) => ({ title, done: false });
    const link = (name: string) => ({
      $link: { doc: "argument", path: ["pool", name] },
    });
    const start = async (stops: unknown[], pool = {}) =>
      new Instance(await artifactOf("state-first"), {
        start: 3,
        items: [],
        seed: { name: "s", tags: ["t"] },
        stops,
        pool,
      });
    const cells = (instance: Instance, name: string) =>
      [...instance.store.docs].filter(([id]) =>
        id.startsWith(
          `state:${
            instance.plan.stateCells.findIndex((cell) => cell.name === name)
          }:`,
        )
      ).map(([, document]) => document.value);
    const bindingOf = (instance: Instance, name: string) =>
      instance.plan.bindings.findIndex((binding) => binding.name === name);

    it("is stored as the value, and a write below the root of the cell leaves the input", async () => {
      const instance = await start([]);

      expect(cells(instance, "kept")).toEqual([{ name: "s", tags: ["t"] }]);

      instance.send(bindingOf(instance, "rename_seed"), { to: "renamed" });

      expect(cells(instance, "kept")).toEqual([
        { name: "renamed", tags: ["t"] },
      ]);
      expect(
        (instance.store.docs.get("argument")?.value as { seed: unknown }).seed,
      ).toEqual({ name: "s", tags: ["t"] });
    });

    it("is the element's value for a cell of an element body, over references", async () => {
      const instance = await start([link("a"), link("b")], {
        a: stop("a"),
        b: stop("b"),
      });

      // The value behind each link, and no link.
      expect(cells(instance, "mine")).toEqual([stop("a"), stop("b")]);

      instance.send(bindingOf(instance, "finish"), {}, [0]);

      expect(cells(instance, "mine")).toEqual([
        { ...stop("a"), done: true },
        stop("b"),
      ]);
      expect(
        (instance.store.docs.get("argument")?.value as {
          pool: Record<string, unknown>;
        }).pool.a,
      ).toEqual(stop("a"));
    });

    it("is the element's value for a cell of an element body, over plain values in place", async () => {
      const instance = await start([stop("a"), stop("b")]);

      // The value, and no reference by key to the element.
      expect(cells(instance, "mine")).toEqual([stop("a"), stop("b")]);

      instance.send(bindingOf(instance, "finish"), {}, [0]);

      expect(cells(instance, "mine")).toEqual([
        { ...stop("a"), done: true },
        stop("b"),
      ]);
      expect(
        (instance.store.docs.get("argument")?.value as { stops: unknown[] })
          .stops,
      ).toEqual([stop("a"), stop("b")]);
    });

    it("is stored as the value where the value function returns the reference", async () => {
      const artifact = structuredClone(await artifactOf("state-first"));
      // The value code of `kept` with the read of the slot's value left
      // out: the function returns the reference the slot yields.
      const main = artifact.code.modules[0];
      const kept = artifact.plan.stateCells.findIndex((cell) =>
        cell.name === "kept"
      );
      const pattern = new RegExp(
        `\\$rt\\.state\\(${kept}, \\(\\$h\\) => \\(\\$h\\.v\\((\\$h\\.slot\\(\\d+\\))\\)\\)\\)`,
      );
      expect(pattern.test(main.source)).toBe(true);
      main.source = main.source.replace(
        pattern,
        `$rt.state(${kept}, ($h) => ($1))`,
      );
      // The slot is read as a reference.
      const slot = Number(
        /slot\((\d+)\)/.exec(
          pattern.exec(
            (await artifactOf("state-first")).code.modules[0].source,
          )![1],
        )![1],
      );
      artifact.plan.slots[slot].observes = "identity";
      const instance = new Instance(artifact, {
        start: 3,
        items: [],
        seed: { name: "s", tags: ["t"] },
        stops: [],
      });

      expect(cells(instance, "kept")).toEqual([{ name: "s", tags: ["t"] }]);
    });
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

  it("hands a handler nothing at a state path whose value is nothing, also where the body reads a member below it", async () => {
    // `fixtures/absent-state.tsx`: the body has an entry at `card` and
    // one at `card.id`, and `card` is bound to a computed value.
    const absent = new Instance(await artifactOf("absent-state"), {
      items: [{ id: "a" }],
      wanted: "z",
    });
    absent.send(0, {});
    expect((absent.result() as { log: string[] }).log).toEqual(["none"]);

    const present = new Instance(await artifactOf("absent-state"), {
      items: [{ id: "a" }],
      wanted: "a",
    });
    present.send(0, {});
    expect((present.result() as { log: string[] }).log).toEqual(["a"]);
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
    expect((tree.children[0] as ViewNode[]).map((row) => row.children)).toEqual(
      [
        ["a", false],
        ["a", true],
      ],
    );
  });

  it("keeps an element's state with its value when the element moves", async () => {
    const instance = new Instance(await artifactOf("equal-values"), {
      tags: ["a", "b"],
    });
    instance.send(0, {}, [1]);
    const before = instance.counts.elementEvaluations;

    instance.writeArgument(["tags"], ["b", "a"]);

    const tree = (instance.result() as { $UI: ViewNode }).$UI;
    expect((tree.children[0] as ViewNode[]).map((row) => row.children)).toEqual(
      [
        ["b", true],
        ["a", false],
      ],
    );
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
      (tree.children[0] as ViewNode[]).map((row) =>
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

  it("stores a reference by key where a cone passes on an element that is a plain value in place", async () => {
    const instance = new Instance(await artifactOf("equal-values"), {
      tags: ["a", "b"],
    });

    // No row holds a link to a position of the array, and none a copy of
    // the value: each holds the array, the key, and no path below it.
    const stored = JSON.stringify(instance.store.docs.get("result")?.value);
    expect(stored).not.toContain('"path":["tags","0"');
    expect(stored).not.toContain('"children":[["a",');
    expect(stored).toContain(
      JSON.stringify({
        $link: { doc: "argument", path: ["tags", keySegment('value:"a"#0')] },
      }).slice(0, -2),
    );
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
      rows: [],
      words: [],
    });

    const result = instance.result() as Record<string, string>;
    expect(result.omitted).toBe("$420");
    expect(result.omittedSpelled).toBe("$");
    expect(result.bound).toBe("€420");
  });

  it("reads the callee's default where the caller's slot holds nothing", async () => {
    const instance = new Instance(await artifactOf("callee-default"), {
      amount: 420,
      rows: [],
      words: [],
    });

    // Expression code and a sandboxed body both read the default.
    expect(instance.result()).toMatchObject({
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

  // Ruling Z16.
  it("holds the callee's default in the entry of `Body.reads`, and value code passes none", async () => {
    const artifact = await artifactOf("callee-default");
    const defaults = artifact.plan.bodies.flatMap((body) =>
      body.reads.flatMap((entry) =>
        entry.default === undefined ? [] : [entry.default]
      )
    );

    // The body of each call that binds the path to a slot of the caller.
    expect(defaults.length).toBeGreaterThan(0);
    expect(new Set(defaults)).toEqual(new Set(["$"]));
    expect(artifact.code.modules[0].source).not.toMatch(
      /\$h\.invoke\(\d+, [^\n]*\), \[\[/,
    );
  });

  it("puts no default where the entry holds none", async () => {
    const artifact = structuredClone(await artifactOf("callee-default"));
    for (const body of artifact.plan.bodies) {
      for (const entry of body.reads) delete entry.default;
    }
    const start = () =>
      new Instance(artifact, { amount: 420, rows: [], words: [] });

    // Expression code has the default as a constant still. The
    // sandboxed body is handed nothing at the path: `x.symbol.split`
    // throws, and the result that reads its value is not stored.
    expect(start).toThrow(TypeError);
  });

  it("reads the default of the caller's place before the callee's", async () => {
    const instance = new Instance(await artifactOf("callee-default"), {
      amount: 420,
      rows: [],
      words: [],
    });

    // `mark` of the caller declares the default `#`.
    expect(instance.result()).toMatchObject({
      defaulted: "#420",
      defaultedSpelled: "#",
      markedDefaulted: { symbol: "#" },
    });
  });

  it("stores a reference with the callee's default where the callee passes the path on", async () => {
    const instance = new Instance(await artifactOf("callee-default"), {
      amount: 420,
      rows: [],
      words: [],
    });

    // The result holds a link to the caller's slot, and the link holds
    // the default the callee declares.
    type Marked = { marked: { symbol: unknown } };
    expect(
      (instance.store.docs.get("result")?.value as Marked).marked.symbol,
    ).toMatchObject({
      $link: { doc: "argument", path: ["sign"], schema: { default: "$" } },
    });
    expect((instance.result() as Marked).marked.symbol).toBe("$");

    instance.writeArgument(["sign"], "kr");

    expect((instance.result() as Marked).marked.symbol).toBe("kr");
  });

  it("reads, through a chain of links, the default declared nearest the end", () => {
    const store = new Store();
    store.create("d", "argument", {
      // A link whose schema declares a default, to a link whose schema
      // declares another, to a place that holds nothing.
      first: { $link: { doc: "d", path: ["second"], schema: { default: 1 } } },
      second: { $link: { doc: "d", path: ["empty"], schema: { default: 2 } } },
      plain: { $link: { doc: "d", path: ["bare"], schema: { default: 1 } } },
      bare: { $link: { doc: "d", path: ["empty"] } },
    });

    // The last link that declares one, and the reader's own only where
    // no link does (ruling Z8).
    expect(store.read(new Ref("d", ["first"], { default: 0 }))).toBe(2);
    expect(store.read(new Ref("d", ["plain"], { default: 0 }))).toBe(1);
    expect(store.read(new Ref("d", ["bare"], { default: 0 }))).toBe(0);
    expect(store.read(new Ref("d", ["bare"]))).toBe(undefined);
  });

  it("gives a handler of the callee the default at a state path bound to the caller's empty slot", async () => {
    const instance = new Instance(await artifactOf("callee-default"), {
      amount: 420,
      rows: [],
      words: [],
    });
    const append = instance.plan.bindings.findIndex((binding) =>
      binding.result !== undefined
    );
    expect(instance.plan.bindings[append].state[0].default).toBe("$");

    // `symbol.set(symbol.get() + "!")`: the read gives the default.
    instance.send(append, {});

    expect(
      (instance.store.docs.get("argument")?.value as { sign: string }).sign,
    ).toBe("$!");
  });

  it("does the same for a callee in an element body, over references", async () => {
    const instance = new Instance(await artifactOf("callee-default"), {
      amount: 420,
      pool: { a: { amount: 1 }, b: { amount: 20, sign: "kr" } },
      rows: [
        { $link: { doc: "argument", path: ["pool", "a"] } },
        { $link: { doc: "argument", path: ["pool", "b"] } },
      ],
      words: [],
    });

    expect((instance.result() as { priced: unknown }).priced).toEqual([
      { shown: "$1", spelled: "$" },
      { shown: "kr20", spelled: "k-r" },
    ]);
  });

  it("does the same for a callee in an element body, over plain values in place", async () => {
    const instance = new Instance(await artifactOf("callee-default"), {
      amount: 420,
      rows: [{ amount: 1 }, { amount: 20, sign: "kr" }],
      words: ["x"],
    });

    expect((instance.result() as { priced: unknown }).priced).toEqual([
      { shown: "$1", spelled: "$" },
      { shown: "kr20", spelled: "k-r" },
    ]);
    // The path is bound to the caller's slot outside the body.
    expect((instance.result() as { tagged: unknown }).tagged).toEqual([
      { word: "x", shown: "$420", spelled: "$" },
    ]);
  });

  it("does the same for a callee in an element body, over the result of a `filter`", async () => {
    const instance = new Instance(await artifactOf("callee-default"), {
      amount: 420,
      rows: [{ amount: 1 }, { amount: 20, sign: "kr" }, { amount: 2 }],
      words: [],
    });

    expect((instance.result() as { cheap: unknown }).cheap).toEqual([
      { shown: "$1", spelled: "$" },
      { shown: "$2", spelled: "$" },
    ]);
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

// `fixtures/reduce.tsx`: a `reduce` in the reactive tier. The executor
// evaluates the step once per element, in order, with the accumulator as
// the value of the slot of root `operation`.
describe("a `reduce` in the reactive tier", () => {
  const link = (name: string) => ({
    $link: { doc: "argument", path: ["pool", name] },
  });
  // The elements of `items` are references to cells, and those of
  // `amounts` are plain values stored in place. `doubled` is over the
  // result of a `map` of `amounts`.
  const argument = () => ({
    pool: { a: { title: "a", amount: 3 }, b: { title: "b", amount: 4 } },
    items: [link("a"), link("b")],
    amounts: [5, 6, 7],
    bonus: 1,
  });
  type Sums = { total: number; weighted: number; doubled: number };

  it("folds over references", async () => {
    const instance = new Instance(await artifactOf("reduce"), argument());

    expect((instance.result() as Sums).total).toBe(7);

    instance.writeArgument(["pool", "b", "amount"], 10);

    expect((instance.result() as Sums).total).toBe(13);
  });

  it("folds over plain values in place, with the index", async () => {
    const instance = new Instance(await artifactOf("reduce"), argument());

    // 5 * 0, 6 * 1, 7 * 2.
    expect((instance.result() as Sums).weighted).toBe(20);

    // The order is part of what the step reads.
    instance.writeArgument(["amounts"], [7, 6, 5]);

    expect((instance.result() as Sums).weighted).toBe(16);
  });

  it("folds over the result of another per-element construct", async () => {
    const instance = new Instance(await artifactOf("reduce"), argument());

    // The initial value is an input of the pattern.
    expect((instance.result() as Sums).doubled).toBe(37);

    instance.writeArgument(["amounts"], [5, 6]);

    expect((instance.result() as Sums).doubled).toBe(23);

    instance.writeArgument(["bonus"], 0);

    expect((instance.result() as Sums).doubled).toBe(22);
  });

  it("reads no slot its cones do not list", async () => {
    const instance = new Instance(await artifactOf("reduce"), argument());

    expect(instance.counts.slotsNotListed).toBe(0);
    expect(instance.counts.readsWithoutSlot).toBe(0);
    expect(instance.counts.pendingOperations).toBe(0);
  });
});

// `fixtures/keyed.tsx`: the handle methods of a function body that name
// the record of a key (`elementById`) and change the membership of a list
// by value (`addUnique`, `removeByValue`), and a cell constructed with
// `new`. The list holds references to the records.
describe("the record of a key", () => {
  type Pins = { pins: { id: string; title: string }[]; last: string };

  it("is written once, and is a member of the list once", async () => {
    const instance = new Instance(await artifactOf("keyed"), { note: "n" });

    expect(instance.send(0, { id: "a", title: "first" }).committed).toBe(true);
    instance.send(0, { id: "b", title: "second" });
    // The same key again: the record keeps its title, and the list holds
    // it once.
    instance.send(0, { id: "a", title: "again" });

    expect((instance.result() as Pins).pins).toEqual([
      { id: "a", title: "first" },
      { id: "b", title: "second" },
    ]);
    // The list holds a reference to each record, and each record is a
    // document of its own.
    expect(instance.documents()["keyed element"]).toBe(2);
    // Every write is one a write edge or an envelope of the body covers.
    expect(instance.counts.writesNotCovered).toBe(0);
  });

  it("leaves the list by value, and is cleared", async () => {
    const instance = new Instance(await artifactOf("keyed"), { note: "n" });
    instance.send(0, { id: "a", title: "first" });
    instance.send(0, { id: "b", title: "second" });

    expect(instance.send(1, { id: "a" }).committed).toBe(true);

    expect((instance.result() as Pins).pins).toEqual([
      { id: "b", title: "second" },
    ]);
    // A later record of the key starts from nothing.
    instance.send(0, { id: "a", title: "later" });
    expect((instance.result() as Pins).pins).toEqual([
      { id: "b", title: "second" },
      { id: "a", title: "later" },
    ]);
  });

  // Ruling Z23: the record is a cell of its own, named by the address of
  // the list and the key, and it is no member of the list until a
  // reference to it is added. The list holds references to the records,
  // which is the case of an array of references.
  it("is a cell of its own, named by the address of the list and the key", async () => {
    const instance = new Instance(await artifactOf("keyed"), { note: "n" });
    const list = instance.stateCell(
      0,
      new Host(instance, new Map(), undefined),
    );
    const pins = new Handle(instance, list, undefined, undefined, []);

    const record = pins.elementById("z");

    // It has no document until something writes it.
    expect(instance.documents()["keyed element"]).toBe(undefined);
    expect(record.get()).toBe(undefined);
    record.set({ id: "z", title: "t" });
    expect([...instance.store.docs.keys()]).toContain(
      `keyed:${list.doc}:[]:z`,
    );
    // The same key of the same list is the same cell.
    expect(pins.elementById("z").equals(record)).toBe(true);
    expect(pins.elementById("y").equals(record)).toBe(false);
  });

  it("is no member of the list, and a write to it makes no reader of the list stale, until it is added", async () => {
    const instance = new Instance(await artifactOf("keyed"), { note: "n" });
    const list = instance.stateCell(
      0,
      new Host(instance, new Map(), undefined),
    );
    const pins = new Handle(instance, list, undefined, undefined, []);
    const record = pins.elementById("z");
    const before = instance.counts.evaluations;

    record.set({ id: "z", title: "t" });
    instance.settle();

    // The write is a write to the record and not at a position of the
    // list: the list holds nothing, its document was not made, and the
    // result, which read the list, is not evaluated again.
    expect((instance.result() as Pins).pins).toEqual([]);
    expect(instance.store.docs.has(list.doc)).toBe(false);
    expect(instance.counts.evaluations).toBe(before);

    // Once a reference to the record is a member, a reader that follows
    // the reference reads the record, and a write to the record makes
    // that reader stale.
    pins.addUnique(record);
    instance.settle();
    expect((instance.result() as Pins).pins).toEqual([{ id: "z", title: "t" }]);
    expect(instance.store.docs.get(list.doc)?.value).toEqual([
      { $link: { doc: `keyed:${list.doc}:[]:z`, path: [] } },
    ]);
    record.key("title").set("u");
    instance.settle();
    expect((instance.result() as Pins).pins).toEqual([{ id: "z", title: "u" }]);
  });

  it("has, in the plan, a write edge and an envelope at `*` below the list", async () => {
    const { plan } = await artifactOf("keyed");
    const pin = plan.bodies.find((body) => body.name === "pin")!;

    // `footprint-analysis.md` §7 records the handle at `*` below the
    // list, and the plan has no record that names the record of a key:
    // the executor counts a write through the handle as covered by that
    // edge, and stores it in the record's own cell.
    expect(pin.writes.map(({ target }) => [target.kind, target.path])).toEqual(
      [["handle", ["*"]]],
    );
    expect(pin.envelopes.map(({ kind, path }) => [kind, path])).toEqual([
      ["handle", ["*"]],
    ]);
  });

  it("can be made with `new` in a function body, as any cell", async () => {
    const instance = new Instance(await artifactOf("keyed"), { note: "n" });

    expect(instance.send(2, { title: "t" }).committed).toBe(true);

    expect((instance.result() as Pins).last).toBe("t!");
  });
});

// Ruling Z22 on `fixtures/flat-keys.tsx`: an element of the result of a
// `flatMap` has the key of the element its segment came from, together
// with a part formed from the member itself: the identity of the cell
// for a member that is a reference, and the value for a member that is a
// plain value, with the count of the earlier equal members of the same
// segment (PL §1.3, "The key of an element that a `flatMap` contributes").
describe("the keys of the result of a `flatMap`", () => {
  const link = (name: string) => ({
    $link: { doc: "argument", path: ["pool", name] },
  });
  // The elements of `groups` are references to cells, and each segment is
  // an array the element holds: `members` of plain values, and `people`
  // of references to cells. The elements of `words` are plain values
  // stored in place, and each segment is an array of plain values that
  // the callback writes.
  const argument = () => ({
    pool: {
      g: { name: "g", members: ["a", "b"], people: [link("p"), link("q")] },
      h: { name: "h", members: ["c"], people: [link("r")] },
      p: { name: "p" },
      q: { name: "q" },
      r: { name: "r" },
    },
    groups: [link("g"), link("h")],
    words: ["x", "y"],
    flip: false,
  });
  type Flat = {
    names: string[];
    loudNames: string[];
    people: { name: string }[];
    loudPeople: string[];
    halves: string[];
    loudHalves: string[];
  };
  const coneOf = (artifact: Artifact, entry: string) =>
    artifact.plan.cones.findIndex((cone) => cone.entry === entry);
  const cell = (name: string) => `cell:argument:["pool","${name}"]#0`;
  const g = cell("g");
  const h = cell("h");
  const start = async () => {
    const artifact = await artifactOf("flat-keys");
    const instance = new Instance(artifact, argument());
    return { artifact, instance };
  };

  it("keys a member that is a plain value by its source element and its value", async () => {
    const { artifact, instance } = await start();

    expect((instance.result() as Flat).loudNames).toEqual(["a!", "b!", "c!"]);
    // The cone instances of the body over the result of the `flatMap`.
    expect(instance.coneInstances(coneOf(artifact, "loudNames"))).toEqual([
      [`${g}/value:"a"#0`],
      [`${g}/value:"b"#0`],
      [`${h}/value:"c"#0`],
    ]);
  });

  it("keys a member that is a reference by its source element and the identity of its cell", async () => {
    const { artifact, instance } = await start();

    expect((instance.result() as Flat).loudPeople).toEqual(["p!", "q!", "r!"]);
    expect(instance.coneInstances(coneOf(artifact, "loudPeople"))).toEqual([
      [`${g}/${cell("p")}`],
      [`${g}/${cell("q")}`],
      [`${h}/${cell("r")}`],
    ]);
  });

  it("keys a member the callback computes by its source element and its value, over plain values", async () => {
    const { artifact, instance } = await start();

    expect((instance.result() as Flat).loudHalves).toEqual([
      "x1!",
      "x2!",
      "y1!",
      "y2!",
    ]);
    expect(instance.coneInstances(coneOf(artifact, "loudHalves"))).toEqual([
      ['value:"x"#0/value:"x1"#0'],
      ['value:"x"#0/value:"x2"#0'],
      ['value:"y"#0/value:"y1"#0'],
      ['value:"y"#0/value:"y2"#0'],
    ]);
  });

  it("counts equal members within their own segment", async () => {
    const { artifact, instance } = await start();

    instance.writeArgument(["pool", "g", "members"], ["a", "a"]);
    instance.writeArgument(["pool", "h", "members"], ["a"]);

    // Two equal members of one segment are occurrences 0 and 1. An equal
    // member of another segment has another key, since the source keys
    // differ, and its count does not depend on the first segment.
    expect(instance.coneInstances(coneOf(artifact, "loudNames"))).toEqual([
      [`${g}/value:"a"#0`],
      [`${g}/value:"a"#1`],
      [`${h}/value:"a"#0`],
    ]);
    expect((instance.result() as Flat).loudNames).toEqual(["a!", "a!", "a!"]);
  });

  it("evaluates the new member alone where a segment behind a reference grows", async () => {
    const { instance } = await start();
    const before = instance.counts.elementEvaluations;

    instance.writeArgument(["pool", "h", "members", "1"], "d");

    expect((instance.result() as Flat).loudNames).toEqual([
      "a!",
      "b!",
      "c!",
      "d!",
    ]);
    // The callback of the `flatMap` passes the element's array on and
    // reads nothing, so the one evaluation is of the new key.
    expect(instance.counts.elementEvaluations - before).toBe(1);
  });

  it("evaluates nothing for an element when the source elements move, over references", async () => {
    const { instance } = await start();
    const before = instance.counts.elementEvaluations;

    instance.writeArgument(["groups"], [link("h"), link("g")]);

    expect((instance.result() as Flat).loudNames).toEqual(["c!", "a!", "b!"]);
    expect((instance.result() as Flat).loudPeople).toEqual(["r!", "p!", "q!"]);
    expect(instance.counts.elementEvaluations - before).toBe(0);
  });

  it("evaluates nothing for an element when the source elements move, over plain values", async () => {
    const { instance } = await start();
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
    const { artifact, instance } = await start();
    const before = instance.counts.elementEvaluations;

    instance.writeArgument(["words"], ["x", "z"]);

    expect((instance.result() as Flat).loudHalves).toEqual([
      "x1!",
      "x2!",
      "z1!",
      "z2!",
    ]);
    // The callback of the `flatMap` for `z`, and the two members of its
    // segment. The instances of the key that left are dropped.
    expect(instance.counts.elementEvaluations - before).toBe(3);
    expect(instance.coneInstances(coneOf(artifact, "loudHalves"))).toEqual([
      ['value:"x"#0/value:"x1"#0'],
      ['value:"x"#0/value:"x2"#0'],
      ['value:"z"#0/value:"z1"#0'],
      ['value:"z"#0/value:"z2"#0'],
    ]);
  });

  it("evaluates nothing where two members of one segment change places, for plain values", async () => {
    const { artifact, instance } = await start();
    const before = instance.counts.elementEvaluations;
    const keys = instance.coneInstances(coneOf(artifact, "loudNames"));

    instance.writeArgument(["pool", "g", "members"], ["b", "a"]);

    // The position in the segment is in no key: the two members keep
    // their keys and their results, and the result has them in the new
    // order.
    expect((instance.result() as Flat).names).toEqual(["b", "a", "c"]);
    expect((instance.result() as Flat).loudNames).toEqual(["b!", "a!", "c!"]);
    expect(instance.counts.elementEvaluations - before).toBe(0);
    expect(instance.coneInstances(coneOf(artifact, "loudNames"))).toEqual(
      keys,
    );
  });

  it("evaluates nothing where two members of one segment change places, for references", async () => {
    const { artifact, instance } = await start();
    const before = instance.counts.elementEvaluations;
    const keys = instance.coneInstances(coneOf(artifact, "loudPeople"));

    instance.writeArgument(["pool", "g", "people"], [link("q"), link("p")]);

    expect((instance.result() as Flat).loudPeople).toEqual(["q!", "p!", "r!"]);
    expect(instance.counts.elementEvaluations - before).toBe(0);
    expect(instance.coneInstances(coneOf(artifact, "loudPeople"))).toEqual(
      keys,
    );
  });

  it("evaluates the callback alone where the members it computes change places, over plain values", async () => {
    const { artifact, instance } = await start();
    const before = instance.counts.elementEvaluations;
    const keys = instance.coneInstances(coneOf(artifact, "loudHalves"));

    instance.writeArgument(["flip"], true);

    expect((instance.result() as Flat).loudHalves).toEqual([
      "x2!",
      "x1!",
      "y2!",
      "y1!",
    ]);
    // The callback of the `flatMap` read `flip`, once per source element.
    // The body over the result is evaluated for no member.
    expect(instance.counts.elementEvaluations - before).toBe(2);
    expect(instance.coneInstances(coneOf(artifact, "loudHalves"))).toEqual(
      keys,
    );
  });

  it("makes a member whose value changed another key, for plain values", async () => {
    const { artifact, instance } = await start();
    const before = instance.counts.elementEvaluations;

    instance.writeArgument(["pool", "g", "members", "0"], "z");

    expect((instance.result() as Flat).loudNames).toEqual(["z!", "b!", "c!"]);
    expect(instance.counts.elementEvaluations - before).toBe(1);
    expect(instance.coneInstances(coneOf(artifact, "loudNames"))).toEqual([
      [`${g}/value:"b"#0`],
      [`${h}/value:"c"#0`],
      [`${g}/value:"z"#0`],
    ]);
  });

  it("keeps the key of a member that is a reference when the value of its cell changes", async () => {
    const { artifact, instance } = await start();
    const before = instance.counts.elementEvaluations;
    const keys = instance.coneInstances(coneOf(artifact, "loudPeople"));

    instance.writeArgument(["pool", "p", "name"], "pp");

    expect((instance.result() as Flat).loudPeople).toEqual([
      "pp!",
      "q!",
      "r!",
    ]);
    // The cone instance of the key read the cell and is evaluated again.
    expect(instance.counts.elementEvaluations - before).toBe(1);
    expect(instance.coneInstances(coneOf(artifact, "loudPeople"))).toEqual(
      keys,
    );
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
  // The collection among the children of a list is one nested child, the
  // first of the list (ruling Z31).
  const rowsOf = (list: Stored) => list.children[0] as unknown as Stored[];
  const streamsOf = (rows: Stored[]) => rows.map((row) => row.props.onClick);
  const without = (artifact: Artifact, binding: number, path: string[]) => {
    const copy = structuredClone(artifact);
    const record = copy.plan.bindings[binding];
    record.result = (record.result ?? []).filter((listed) =>
      JSON.stringify(listed.path) !== JSON.stringify(path)
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

    // At a member of the result, below the conditional, and at the child
    // written after a collection, which is the second child of the list.
    expect(stored.inc).toEqual(one);
    expect(tree(instance).children[0].props.onClick).toEqual(one);
    expect(tree(instance).children[1].children[1].props.onClick).toEqual(one);
    expect(instance.failures).toEqual([]);
  });

  it("is stored as the stream of the instance's key over references", async () => {
    const instance = new Instance(
      await artifactOf("stream-marker"),
      argument(),
    );

    expect(streamsOf(rowsOf(tree(instance).children[1])))
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

    expect(streamsOf(rowsOf(tree(instance).children[2]))).toEqual([
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
    expect(streamsOf(rowsOf(tree(instance).children[3]))).toEqual([
      { $stream: { binding: 3, keys: ['value:"x"#0'] } },
      { $stream: { binding: 3, keys: ['value:"y"#0'] } },
    ]);

    instance.send(3, {}, [1]);

    expect((instance.result() as { chosen: string }).chosen).toBe("y");
  });

  // Ruling Z19: the evaluation that fails is the one that stores the
  // value. The output that holds the position keeps what was stored, and
  // the other outputs are stored.
  it("fails the evaluation that stores a marker at a position no listed path covers", async () => {
    const artifact = without(await artifactOf("stream-marker"), 0, ["inc"]);

    const instance = new Instance(artifact, argument());

    // No output of the plan is at `inc`: what fails is the store of the
    // position itself.
    expect(instance.failures).toEqual([{
      evaluation: "result",
      held: ["inc"],
      binding: 0,
      path: ["inc"],
    }]);
    // No link is stored at the position, which held nothing before, and
    // the other outputs of the result are stored.
    const stored = instance.store.docs.get("result")?.value as Record<
      string,
      unknown
    >;
    expect("inc" in stored).toBe(false);
    expect(instance.result()).toMatchObject({ chosen: "", count: 0 });
    expect(tree(instance).children[1].children[1].props.onClick).toEqual({
      $stream: { binding: 0, keys: [] },
    });
  });

  it("leaves the output that holds the position with what was stored, and stores the others", async () => {
    const below = ["$UI", "children", "0", "props", "onClick"];
    const artifact = without(await artifactOf("stream-marker"), 0, below);
    // The other branch is selected, and the position holds its value.
    const instance = new Instance(artifact, argument(false));
    expect(instance.failures).toEqual([]);
    expect(tree(instance).children[0]).toBe(null);

    // The branch that writes the stream is selected: the marker is at a
    // position no listed path covers.
    instance.writeArgument(["shown"], true);

    // The kept output at `$UI/children/0` holds the position. The cone
    // that placed the marker computed the whole tree, and the evaluation
    // that fails is the one that stores that output.
    const holder = artifact.plan.outputs.findIndex((output) =>
      JSON.stringify(output.path) === JSON.stringify(below.slice(0, 3))
    );
    expect(instance.failures).toEqual([{
      evaluation: artifact.plan.cones[artifact.plan.outputs[holder].cone]
        .entry,
      output: holder,
      held: below.slice(0, 3),
      binding: 0,
      path: below,
    }]);
    expect(tree(instance).children[0]).toBe(null);

    // An event changes another output, which is stored. The output that
    // failed keeps what it held.
    instance.send(0, { by: 2 });

    expect((instance.result() as { count: number }).count).toBe(2);
    expect(tree(instance).children[0]).toBe(null);
    expect(tree(instance).children[1].children.length).toBe(2);
    expect(rowsOf(tree(instance).children[1]).length).toBe(2);
  });

  it("matches a `*` of a listed path at any element, in each of the three bodies", async () => {
    const artifact = await artifactOf("stream-marker");
    const paths = [1, 2, 3].map((binding) =>
      artifact.plan.bindings[binding].result?.map(({ path }) => path)
    );

    expect(paths).toEqual([
      [["$UI", "children", "1", "children", "0", "*", "props", "onClick"]],
      [["$UI", "children", "2", "children", "0", "*", "props", "onClick"]],
      [["$UI", "children", "3", "children", "0", "*", "props", "onClick"]],
    ]);
    // Each `*` is of kind `element`: the binding has the `element` step
    // of the collection, over references, over plain values in place,
    // and over the result of a `filter` (ruling Z21).
    expect(
      [1, 2, 3].map((binding) => artifact.plan.bindings[binding].result),
    ).toEqual(paths.map((listed) => [
      { path: listed![0], stars: [{ kind: "element" }] },
    ]));
    expect(new Instance(artifact, argument()).failures).toEqual([]);
    // Without its path, the marker of each key is at a position no
    // listed path covers. The output that holds those positions is the
    // collection, the nested child of the list: it keeps what was stored
    // for it, which is nothing, and the outputs beside it are stored
    // (ruling Z19).
    const lengths = [2, 3, 2];
    for (const binding of [1, 2, 3]) {
      const instance = new Instance(
        without(artifact, binding, paths[binding - 1]![0]),
        argument(),
      );
      const list = ["$UI", "children", `${binding}`, "children", "0"];
      expect(instance.failures.map(({ held, path }) => [held, path])).toEqual(
        Array.from({ length: lengths[binding - 1] }, (_, index) => [
          list,
          [...list, `${index}`, "props", "onClick"],
        ]),
      );
      expect(instance.failures.every((failure) => failure.binding === binding))
        .toBe(true);
      expect(rowsOf(tree(instance).children[binding]) ?? null).toBe(null);
      // The child written after the collection, and the other lists.
      if (binding === 1) {
        expect(tree(instance).children[1].children[1].props.onClick).toEqual({
          $stream: { binding: 0, keys: [] },
        });
      }
      const other = binding === 2 ? 3 : 2;
      expect(streamsOf(rowsOf(tree(instance).children[other])).length).toBe(
        lengths[other - 1],
      );
    }
  });

  it("matches a path below a conditional under either selection", async () => {
    const artifact = await artifactOf("stream-marker");
    const below = ["$UI", "children", "0", "props", "onClick"];
    expect(artifact.plan.bindings[0].result).toContainEqual({
      path: below,
      stars: [],
    });

    // The branch that writes the stream is selected, or the other one.
    expect(new Instance(artifact, argument(true)).failures).toEqual([]);
    expect(new Instance(artifact, argument(false)).failures).toEqual([]);
    // Without the path, the evaluation fails under the selection that
    // stores the marker, and under the other one it does not.
    const unlisted = without(artifact, 0, below);
    expect(new Instance(unlisted, argument(false)).failures).toEqual([]);
    expect(
      new Instance(unlisted, argument(true)).failures.map((
        { binding, path },
      ) => [binding, path]),
    ).toEqual([[0, below]]);
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

// Ruling Z12: an element that is a plain value in place is named by its
// collection and its key. `fixtures/value-identity.tsx` has a `map` over
// `stops`, records, and one over `tags`, strings. Each test says which
// case it is about: an array of plain values in place, where the ruling
// applies, or an array of references, where nothing changes.
describe("an element that is a plain value in place", () => {
  const stop = (title: string, at: number) => ({
    title,
    done: false,
    position: { lat: at, lng: at },
  });
  const inPlace = () => ({
    stops: [stop("a", 1), stop("b", 2), stop("c", 3)],
    tags: ["x", "y", "x"],
  });
  const link = (name: string) => ({
    $link: { doc: "argument", path: ["pool", name] },
  });
  const references = () => ({
    pool: { a: stop("a", 1), b: stop("b", 2), c: stop("c", 3) },
    stops: [link("a"), link("b"), link("c")],
    tags: ["x", "y", "x"],
  });
  const keyOf = (title: string, at: number, count = 0) =>
    `value:${
      JSON.stringify({
        done: false,
        position: { lat: at, lng: at },
        title,
      })
    }#${count}`;
  type Row = {
    title: string;
    stop: unknown;
    position: unknown;
    isSelected: boolean;
    open: boolean;
    check: ViewNode;
  };
  type Result = {
    rows: Row[];
    words: { item: ViewNode }[];
    selected: unknown;
    center: unknown;
    chosen: unknown;
  };
  const result = (instance: Instance) => instance.result() as Result;
  const stored = (instance: Instance) =>
    instance.store.docs.get("result")?.value as {
      rows: { $link: { doc: string } }[] | Record<string, unknown>[];
      words: Record<string, unknown>[];
    };
  const bindingOf = (instance: Instance, name: string) =>
    instance.plan.bindings.findIndex((binding) => binding.name === name);
  const cellOf = (instance: Instance, name: string) =>
    instance.store.docs.get(
      `state:${
        instance.plan.stateCells.findIndex((cell) => cell.name === name)
      }:[]`,
    )?.value;
  const start = async (argument: unknown = inPlace()) =>
    new Instance(await artifactOf("value-identity"), argument);

  it("is passed on as the collection, the key and the path, over plain values in place", async () => {
    const instance = await start();

    const row = stored(instance).rows[1] as Record<string, unknown>;
    const element = ["stops", keySegment(keyOf("b", 2))];
    expect(row.stop).toMatchObject({
      $link: { doc: "argument", path: element },
    });
    expect(row.position).toMatchObject({
      $link: { doc: "argument", path: [...element, "position"] },
    });
    // The member bound both ways holds the reference with the member's
    // path.
    expect((row.check as ViewNode).props.$checked).toMatchObject({
      $link: { doc: "argument", path: [...element, "done"] },
    });
    // A string: the second `x` is occurrence 1.
    expect(
      (stored(instance).words[2].item as ViewNode).children[0],
    ).toMatchObject({
      $link: { doc: "argument", path: ["tags", keySegment('value:"x"#1')] },
    });
    expect(result(instance).rows.map((each) => each.stop)).toEqual(
      inPlace().stops,
    );
    expect(
      result(instance).words.map((word) => word.item.children[0]),
    ).toEqual(["x", "y", "x"]);
  });

  it("is passed on as the link to its cell, over references", async () => {
    const instance = await start(references());

    const row = stored(instance).rows[1] as Record<string, unknown>;
    expect(row.stop).toMatchObject({
      $link: { doc: "argument", path: ["pool", "b"] },
    });
    expect(row.position).toMatchObject({
      $link: { doc: "argument", path: ["pool", "b", "position"] },
    });
  });

  it("is read at its new position after a move, and nothing is evaluated for it, over plain values in place", async () => {
    const instance = await start();
    const before = instance.counts.elementEvaluations;
    const rowBefore = JSON.stringify(stored(instance).rows[0]);

    instance.send(bindingOf(instance, "reverse"), {});

    expect(instance.counts.elementEvaluations).toBe(before);
    expect(result(instance).rows.map((row) => row.title)).toEqual([
      "c",
      "b",
      "a",
    ]);
    expect(result(instance).rows.map((row) => row.position)).toEqual([
      { lat: 3, lng: 3 },
      { lat: 2, lng: 2 },
      { lat: 1, lng: 1 },
    ]);
    // The row of `a` holds what it held, at the last position now.
    expect(JSON.stringify(stored(instance).rows[2])).toBe(rowBefore);
  });

  it("is found by `equals` among the rows, before and after a move, over plain values in place", async () => {
    const instance = await start();
    // The row of `b` stores its element in `selected`.
    instance.send(bindingOf(instance, "pick"), {}, [1]);

    expect(cellOf(instance, "selected")).toMatchObject({
      $link: {
        doc: "argument",
        path: ["stops", keySegment(keyOf("b", 2))],
      },
    });
    expect(result(instance).rows.map((row) => row.isSelected)).toEqual([
      false,
      true,
      false,
    ]);

    instance.send(bindingOf(instance, "removeFirst"), {});

    expect(result(instance).rows.map((row) => [row.title, row.isSelected]))
      .toEqual([["b", true], ["c", false]]);
    expect(result(instance).selected).toEqual(stop("b", 2));
  });

  it("is found by `equals` among the rows, over references", async () => {
    const instance = await start(references());
    instance.send(bindingOf(instance, "pick"), {}, [1]);

    expect(cellOf(instance, "selected")).toMatchObject({
      $link: { doc: "argument", path: ["pool", "b"] },
    });
    instance.send(bindingOf(instance, "reverse"), {});
    expect(result(instance).rows.map((row) => [row.title, row.isSelected]))
      .toEqual([["c", false], ["b", true], ["a", false]]);
  });

  it("is told from an equal value by its occurrence, over plain values in place", async () => {
    const instance = await start();
    const chosen = new Ref(
      `state:${
        instance.plan.stateCells.findIndex((cell) => cell.name === "chosen")
      }:[]`,
      [],
    );
    const occurrence = (count: number) =>
      new Ref("argument", ["tags", keySegment(`value:"x"#${count}`)]);
    // The row of the second `x` stores a reference to its element.
    instance.send(bindingOf(instance, "choose"), {}, [2]);

    expect(instance.same(chosen, occurrence(1))).toBe(true);
    expect(instance.same(chosen, occurrence(0))).toBe(false);
    expect(result(instance).chosen).toBe("x");

    // The first `x` leaves. The one that remains is occurrence 0, and
    // the reference to occurrence 1 names nothing.
    instance.send(bindingOf(instance, "removeFirst"), {});

    expect(result(instance).chosen).toBe(undefined);

    // An equal value is added: a position holds occurrence 1 again, and
    // the reference resolves to it.
    instance.send(bindingOf(instance, "addTag"), { tag: "x" });

    expect(result(instance).chosen).toBe("x");
  });

  it("is not equal to a handle that names its position", async () => {
    const instance = await start();
    const element = new Ref("argument", ["stops", keySegment(keyOf("a", 1))]);
    const position = new Ref("argument", ["stops", "0"]);

    expect(instance.store.read(element)).toEqual(instance.store.read(position));
    expect(instance.same(element, position)).toBe(false);
    expect(instance.same(element, new Ref(element.doc, element.path))).toBe(
      true,
    );
  });

  it("reads as nothing through a stored reference to a member after it is removed, over plain values in place", async () => {
    const instance = await start();
    instance.send(bindingOf(instance, "pick"), {}, [0]);
    expect(result(instance).center).toEqual({ lat: 1, lng: 1 });

    instance.send(bindingOf(instance, "reverse"), {});
    // The reference followed the element.
    expect(result(instance).center).toEqual({ lat: 1, lng: 1 });

    instance.writeArgument(["stops"], [stop("b", 2), stop("c", 3)]);

    // Today's runtime reads the element that moved to the position here
    // (`cpp/probe26`): the difference is the ruling's.
    expect(result(instance).center).toBe(undefined);
    expect(result(instance).selected).toBe(undefined);
  });

  it("keeps the value readable through a stored reference to a member after it is removed, over references", async () => {
    const instance = await start(references());
    instance.send(bindingOf(instance, "pick"), {}, [0]);

    instance.writeArgument(["stops"], [link("b"), link("c")]);

    expect(result(instance).center).toEqual({ lat: 1, lng: 1 });
  });

  it("is written at the position that holds its key, through a member bound both ways, over plain values in place", async () => {
    const instance = await start();
    instance.send(bindingOf(instance, "reverse"), {});

    // As the rendered checkbox of the row of `a` writes its attribute.
    instance.writeThrough(
      ["rows", "2", "check", "props", "$checked"],
      true,
    );

    expect(
      (instance.store.docs.get("argument")?.value as { stops: unknown[] })
        .stops,
    ).toEqual([stop("c", 3), stop("b", 2), { ...stop("a", 1), done: true }]);
  });

  it("is written through a handler bound in the body, and the row then has another key, over plain values in place", async () => {
    const instance = await start();
    // The state cell of the row of `b` is set, and its element stored.
    instance.send(bindingOf(instance, "toggle"), {}, [1]);
    instance.send(bindingOf(instance, "pick"), {}, [1]);
    expect(result(instance).rows[1].open).toBe(true);
    const before = instance.counts.elementEvaluations;

    // One write through the reference: `stop.key("done").set(true)`.
    const outcome = instance.send(bindingOf(instance, "finish"), {}, [1]);

    expect(outcome.committed).toBe(true);
    const changed = { ...stop("b", 2), done: true };
    expect(
      (instance.store.docs.get("argument")?.value as { stops: unknown[] })
        .stops[1],
    ).toEqual(changed);
    // The position holds another key: the cone instances of that key are
    // evaluated, and its row holds the reference with the new key.
    expect(instance.counts.elementEvaluations - before).toBeGreaterThan(0);
    const key = `value:${
      JSON.stringify({ done: true, position: { lat: 2, lng: 2 }, title: "b" })
    }#0`;
    expect((stored(instance).rows[1] as Record<string, unknown>).stop)
      .toMatchObject({
        $link: { doc: "argument", path: ["stops", keySegment(key)] },
      });
    // The state cell of the body is that of the new key, and reads its
    // first value. The cell of the old key keeps its document.
    expect(result(instance).rows[1].open).toBe(false);
    expect(
      instance.stateCells().filter(({ name }) => name === "open").map((
        { keys, value },
      ) => [keys[0], value]),
    ).toContainEqual([keyOf("b", 2), true]);
    // The reference `selected` holds keeps the key it was made with, and
    // reads as nothing (PL §8, question 112, assumed).
    expect(result(instance).selected).toBe(undefined);
    expect(result(instance).rows.map((row) => row.isSelected)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("refuses a second write through the same reference after a write that changed the value, over plain values in place", async () => {
    const instance = await start();
    const before = structuredClone(instance.store.docs.get("argument")?.value);

    // `stop.key("done").set(true)` and then `stop.key("title").set(...)`.
    const outcome = instance.send(
      bindingOf(instance, "finishAndRename"),
      {},
      [1],
    );

    // The second write finds no position that holds the key, and the
    // event commits nothing, the first write included.
    expect(outcome.committed).toBe(false);
    expect(outcome.error).toBe(
      "a write through a reference by key that no position holds",
    );
    expect(instance.store.docs.get("argument")?.value).toEqual(before);
    expect(result(instance).rows.map((row) => row.title)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("takes two members in one `update`, over plain values in place", async () => {
    const instance = await start();

    const outcome = instance.send(bindingOf(instance, "update"), {}, [1]);

    expect(outcome.committed).toBe(true);
    expect(result(instance).rows.map((row) => row.title)).toEqual([
      "a",
      "updated",
      "c",
    ]);
  });

  it("takes two writes through one reference, and keeps the state of its row, over references", async () => {
    const instance = await start(references());
    instance.send(bindingOf(instance, "toggle"), {}, [1]);

    const outcome = instance.send(
      bindingOf(instance, "finishAndRename"),
      {},
      [1],
    );

    expect(outcome.committed).toBe(true);
    expect(result(instance).rows[1]).toMatchObject({
      title: "renamed",
      open: true,
      stop: { title: "renamed", done: true },
    });
  });
});

// Ruling Z13: an output that passes a derived collection on unchanged is
// the same collection for keying, and the plan marks it
// (`Output.passesCollection`). `fixtures/passes-collection.tsx` has a
// `map` over a `computed` that returns the result of a `filter`, twice.
describe("an output that passes a derived collection on", () => {
  const link = (name: string) => ({
    $link: { doc: "argument", path: ["pool", name] },
  });
  const argument = () => ({
    pool: {
      a: { title: "a", done: false },
      b: { title: "b", done: true },
      c: { title: "c", done: false },
    },
    // References to cells.
    items: [link("a"), link("b"), link("c")],
    // Plain values in place, two of them equal.
    tags: ["x", "x", "y"],
  });
  // The cone of the body of the `map` over the marked output of `name`.
  const keysOf = (instance: Instance, nth: number) => {
    const maps = instance.plan.collections.flatMap((record, index) =>
      record.construct === "map" ? [index] : []
    );
    const cone = instance.plan.cones.findIndex((record) =>
      record.within.some((step) => step.element === maps[nth])
    );
    return instance.coneInstances(cone).map(([key]) => key).sort();
  };

  it("is marked in the plan with the collection it passes on", async () => {
    const { plan } = await artifactOf("passes-collection");
    const marked = plan.outputs.flatMap((output) =>
      output.passesCollection === undefined ? [] : [output.passesCollection]
    );

    expect(marked.map((index) => plan.collections[index].construct)).toEqual([
      "filter",
      "filter",
    ]);
  });

  it("gives a construct applied to it the keys of the source elements, over references", async () => {
    const instance = new Instance(
      await artifactOf("passes-collection"),
      argument(),
    );

    expect(instance.result()).toEqual({
      rows: ["a!", "c!"],
      words: ["x!", "y!"],
    });
    expect(keysOf(instance, 0)).toEqual([
      'cell:argument:["pool","a"]#0',
      'cell:argument:["pool","c"]#0',
    ]);
  });

  it("gives a construct applied to it the keys of the source elements, over plain values in place", async () => {
    const instance = new Instance(
      await artifactOf("passes-collection"),
      argument(),
    );

    // The `filter` dropped the first `x`. The one it kept is occurrence
    // 1 of the source, and that is its key downstream.
    expect(keysOf(instance, 1)).toEqual(['value:"x"#1', 'value:"y"#0']);
  });

  it("keys by what the positions hold where the output has no mark, which loses the count", async () => {
    const artifact = structuredClone(await artifactOf("passes-collection"));
    for (const output of artifact.plan.outputs) delete output.passesCollection;
    const instance = new Instance(artifact, argument());

    expect(instance.result()).toEqual({
      rows: ["a!", "c!"],
      words: ["x!", "y!"],
    });
    // Over references the keys are those of the cells either way.
    expect(keysOf(instance, 0)).toEqual([
      'cell:argument:["pool","a"]#0',
      'cell:argument:["pool","c"]#0',
    ]);
    // Over plain values in place the kept `x` is keyed as the first one
    // of the array the output holds.
    expect(keysOf(instance, 1)).not.toEqual(['value:"x"#1', 'value:"y"#0']);
  });

  it("evaluates nothing downstream for an element when the source elements move", async () => {
    const instance = new Instance(
      await artifactOf("passes-collection"),
      argument(),
    );
    const before = instance.counts.elementEvaluations;

    instance.writeArgument(["items"], [link("c"), link("b"), link("a")]);

    expect((instance.result() as { rows: string[] }).rows).toEqual([
      "c!",
      "a!",
    ]);
    expect(instance.counts.elementEvaluations).toBe(before);
  });
});

// Ruling Z17: the name a pattern binds to `[SELF]` is a reference to the
// result cell of the instance. `fixtures/self.tsx` places it at a path of
// the result, in a row over `items` and in a row over `tags`.
describe("the name bound to `[SELF]`", () => {
  const toResult = { $link: { doc: "result", path: [] } };
  const link = (name: string) => ({
    $link: { doc: "argument", path: ["pool", name] },
  });
  type Stored = {
    other: unknown;
    rows: { owner: unknown }[];
    words: { owner: unknown }[];
  };
  const stored = (instance: Instance) =>
    instance.store.docs.get("result")?.value as Stored;

  it("is stored as a link to the result document where value code places it", async () => {
    const instance = new Instance(await artifactOf("self"), {
      title: "t",
      items: [],
      tags: [],
    });

    expect(stored(instance).other).toEqual(toResult);
    // A read through the reference at a path reads that path of the
    // result.
    expect(instance.store.read(new Ref("result", ["other", "title"]))).toBe(
      "t",
    );
    instance.writeArgument(["title"], "u");
    expect(instance.store.read(new Ref("result", ["other", "title"]))).toBe(
      "u",
    );
  });

  it("is the same reference in an element body, over references", async () => {
    const instance = new Instance(await artifactOf("self"), {
      title: "t",
      pool: { a: { title: "a" }, b: { title: "b" } },
      items: [link("a"), link("b")],
      tags: [],
    });

    expect(stored(instance).rows.map((row) => row.owner)).toEqual([
      toResult,
      toResult,
    ]);
  });

  it("is the same reference in an element body, over plain values in place", async () => {
    const instance = new Instance(await artifactOf("self"), {
      title: "t",
      items: [],
      tags: ["x", "y"],
    });

    expect(stored(instance).words.map((word) => word.owner)).toEqual([
      toResult,
      toResult,
    ]);
  });

  it("has no place in the state of a binding, so a handler is handed nothing for it", async () => {
    const instance = new Instance(await artifactOf("self"), {
      title: "t",
      items: [],
      tags: [],
    });
    const keep = instance.plan.bindings.findIndex((binding) =>
      binding.name === "keep"
    );
    const entry = instance.plan.bindings[keep].state.find(({ path }) =>
      path[0] === "self"
    );

    // No record of the plan holds the name (PL §1.1), and
    // `Binding.state.place` has no form for the result of the instance.
    expect(entry?.place).toBe(undefined);
    // `kept.set(self)` stores what the handler was handed: nothing.
    instance.send(keep, {});
    expect((instance.result() as { kept: unknown }).kept).toBe(undefined);
  });
});

describe("a record a handler writes into a list", () => {
  // `fixtures/list-records.tsx`: `stops` is a list of records and `names`
  // a list of strings, both state cells, and the handler of a row stores
  // `stop.position` in the cell `center`. Today's runtime gives a plain
  // object that `Cell.set` or `Cell.push` puts into an array a document of
  // its own (`anchorValueAsEntity` in `runtime/runner/src/data-updating.ts`).
  const start = async () =>
    new Instance(await artifactOf("list-records"), { note: "n" });
  const held = (instance: Instance, cell: string) => {
    const index = instance.plan.stateCells.findIndex(({ name }) =>
      name === cell
    );
    return instance.store.docs.get(`state:${index}:[]`)?.value as unknown[];
  };
  const bindingOf = (instance: Instance, name: string) =>
    instance.plan.bindings.findIndex((binding) => binding.name === name);

  it("gets a document of its own where it is pushed, and the list stores a link", async () => {
    const instance = await start();
    instance.send(bindingOf(instance, "add"), { title: "a" });

    const [slot] = held(instance, "stops") as { $link: { doc: string } }[];
    expect(slot.$link.doc).toMatch(/^record:/);
    expect(instance.store.docs.get(slot.$link.doc)).toEqual({
      kind: "element record",
      value: { title: "a", position: { lat: 1, lng: 7 } },
    });
    expect(instance.documents()["element record"]).toBe(1);
  });

  it("gets a document of its own where it is a member of a list that is set, and a record the list held keeps its document", async () => {
    const instance = await start();
    instance.send(bindingOf(instance, "add"), { title: "a" });
    const [first] = held(instance, "stops") as { $link: { doc: string } }[];
    instance.send(bindingOf(instance, "append"), { title: "bb" });

    const slots = held(instance, "stops") as { $link: { doc: string } }[];
    expect(slots.length).toBe(2);
    expect(slots[0].$link.doc).toBe(first.$link.doc);
    expect(slots[1].$link.doc).toMatch(/^record:/);
    expect(slots[1].$link.doc).not.toBe(first.$link.doc);
    expect(instance.documents()["element record"]).toBe(2);
  });

  it("gives two equal records two documents", async () => {
    const instance = await start();
    instance.send(bindingOf(instance, "add"), { title: "a" });
    instance.send(bindingOf(instance, "add"), { title: "a" });

    const slots = held(instance, "stops") as { $link: { doc: string } }[];
    expect(slots[0].$link.doc).not.toBe(slots[1].$link.doc);
  });

  it("stores a pushed string in the list", async () => {
    const instance = await start();
    instance.send(bindingOf(instance, "name"), { name: "x" });

    expect(held(instance, "names")).toEqual(["x"]);
    expect(instance.documents()["element record"]).toBe(undefined);
  });

  it("keeps a reference to a member of the record readable after the record left the list", async () => {
    const instance = await start();
    instance.send(bindingOf(instance, "add"), { title: "a" });
    instance.send(bindingOf(instance, "append"), { title: "bb" });
    // The row of `bb` stores `stop.position` in `center`.
    instance.send(bindingOf(instance, "go"), {});
    const center = () => (instance.result() as { center: unknown }).center;
    expect(center()).toEqual({ lat: 2, lng: 7 });

    instance.send(bindingOf(instance, "removeLast"), {});

    expect((instance.result() as { rows: unknown[] }).rows.length).toBe(1);
    expect(center()).toEqual({ lat: 2, lng: 7 });
  });

  it("keeps the link to a record's document where a body writes the list back from handles to its positions", async () => {
    const instance = await start();
    instance.send(bindingOf(instance, "add"), { title: "a" });
    instance.send(bindingOf(instance, "add"), { title: "bb" });
    const before = held(instance, "stops");
    const index = instance.plan.stateCells.findIndex(({ name }) =>
      name === "stops"
    );
    const list = new Ref(`state:${index}:[]`, []);

    // What `stops.set(stops.get().toReversed())` writes where `get` gives
    // a handle for each position: a link to each position of the list.
    const written = instance.detached(list, [
      { $link: { doc: list.doc, path: ["1"] } },
      { $link: { doc: list.doc, path: ["0"] } },
    ]);

    expect(written).toEqual([before[1], before[0]]);
  });

  it("leaves a record of the argument in the argument document", async () => {
    const instance = new Instance(await artifactOf("small"), {
      secret: "s",
      note: "n",
      flag: false,
      items: [{ title: "a", done: false }],
    });

    expect(instance.store.docs.get("argument")?.value).toMatchObject({
      items: [{ title: "a", done: false }],
    });
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
    // The member is a plain value in place, so its address names it by
    // the array and its key (ruling Z12).
    expect(store.addresses.get(read[1])?.path).toEqual([
      "items",
      keySegment('value:{"title":"b"}#0'),
    ]);
  });
});

// Ruling Z18 on `fixtures/key-returns.tsx`: the removal of an element
// deletes nothing that is stored under its key. The cone instances of the
// key are dropped, its state cells stay stored, and an element that
// returns under the same key reads what its state cells held. `memo` is
// a state cell of the body of the `map` over the result of a `filter`.
describe("a key that left its collection", () => {
  type Returned = {
    rows: { title: string; memo: string }[];
    labels: { word: string; memo: string }[];
  };
  const NOTE_ROW = 0;
  const NOTE_LABEL = 1;
  const ADD = 2;
  const HIDE = 3;
  const start = async () => {
    const artifact = await artifactOf("key-returns");
    const instance = new Instance(artifact, { words: ["x", "y"] });
    // The records a handler pushes are cells: `items` is an array of
    // references.
    instance.send(ADD, { title: "a" });
    instance.send(ADD, { title: "b" });
    const cone = (entry: string, nth: number) =>
      artifact.plan.cones.flatMap((record, index) =>
        record.entry === entry ? [index] : []
      )[nth];
    return { instance, rowsCone: cone("map", 0), labelsCone: cone("map", 1) };
  };
  const result = (instance: Instance) => instance.result() as Returned;
  const memos = (instance: Instance) =>
    instance.stateCells().filter(({ name }) => name === "memo").map((
      { keys, value },
    ) => [keys[0], value]);
  const stored = (instance: Instance) =>
    (instance.store.docs.get("state:0:[]")?.value ?? []) as unknown[];

  it("keeps the state cell of a reference that leaves the source and returns", async () => {
    const { instance, rowsCone } = await start();
    instance.send(NOTE_ROW, { text: "kept" }, [1]);
    expect(result(instance).rows).toEqual([
      { title: "a", memo: "", note: { $stream: true } },
      { title: "b", memo: "kept", note: { $stream: true } },
    ]);
    const [a, b] = stored(instance);
    const documents = instance.documents();
    const [, keyOfB] = instance.coneInstances(rowsCone);

    // The link to the cell of `b` leaves the array of references.
    instance.writeState("items", [], [a]);

    expect(result(instance).rows.map(({ title }) => title)).toEqual(["a"]);
    // The cone instances of the key are dropped, and nothing stored
    // under the key is deleted: the cell of the key holds its value.
    expect(instance.coneInstances(rowsCone)).not.toContainEqual(keyOfB);
    expect(instance.documents()).toEqual(documents);
    expect(memos(instance)).toContainEqual([keyOfB[0], "kept"]);

    // The same link stands in the array again: the key returns, new
    // cone instances are evaluated, and they read what the cell held.
    const before = instance.counts.elementEvaluations;
    instance.writeState("items", [], [a, b]);

    expect(result(instance).rows.map(({ title, memo }) => [title, memo]))
      .toEqual([["a", ""], ["b", "kept"]]);
    expect(instance.coneInstances(rowsCone)).toContainEqual(keyOfB);
    // The predicate and the body, for the key that returned.
    expect(instance.counts.elementEvaluations - before).toBe(2);
    expect(instance.documents()).toEqual(documents);
  });

  it("keeps the state cell of a plain value that leaves the source and returns", async () => {
    const { instance, labelsCone } = await start();
    instance.send(NOTE_LABEL, { text: "kept" }, [1]);
    const documents = instance.documents();
    const keyOfY = ['value:"y"#0'];
    expect(instance.coneInstances(labelsCone)).toContainEqual(keyOfY);

    // The value leaves the array of plain values in place.
    instance.writeArgument(["words"], ["x"]);

    expect(result(instance).labels.map(({ word }) => word)).toEqual(["x"]);
    expect(instance.coneInstances(labelsCone)).not.toContainEqual(keyOfY);
    expect(instance.documents()).toEqual(documents);
    expect(memos(instance)).toContainEqual([keyOfY[0], "kept"]);

    // The same value with the same occurrence count stands in the array
    // again, at another position.
    instance.writeArgument(["words"], ["y", "x"]);

    expect(result(instance).labels.map(({ word, memo }) => [word, memo]))
      .toEqual([["y", "kept"], ["x", ""]]);
    expect(instance.documents()).toEqual(documents);
  });

  it("keeps the state cell of the last occurrence of two equal plain values", async () => {
    const { instance } = await start();
    instance.writeArgument(["words"], ["x", "x"]);
    instance.send(NOTE_LABEL, { text: "first" }, [0]);
    instance.send(NOTE_LABEL, { text: "second" }, [1]);

    // The key that leaves is that of the last occurrence, whichever of
    // the two positions is removed (PL §1.3).
    instance.writeArgument(["words"], ["x"]);

    expect(result(instance).labels.map(({ memo }) => memo)).toEqual(["first"]);
    expect(memos(instance)).toContainEqual(['value:"x"#1', "second"]);

    instance.writeArgument(["words"], ["x", "x"]);

    expect(result(instance).labels.map(({ memo }) => memo)).toEqual([
      "first",
      "second",
    ]);
  });

  it("keeps the state cell of an upstream key that leaves the result of a `filter` and returns, over references", async () => {
    const { instance, rowsCone } = await start();
    instance.send(NOTE_ROW, { text: "kept" }, [1]);
    const documents = instance.documents();
    const [, keyOfB] = instance.coneInstances(rowsCone);

    // The element stays in the source and leaves the result of the
    // `filter`, which is the collection of the body that declares `memo`.
    instance.send(HIDE, { title: "b" });

    expect(result(instance).rows.map(({ title }) => title)).toEqual(["a"]);
    expect(instance.coneInstances(rowsCone)).not.toContainEqual(keyOfB);
    expect(memos(instance)).toContainEqual([keyOfB[0], "kept"]);

    instance.send(HIDE, { title: "" });

    expect(result(instance).rows.map(({ title, memo }) => [title, memo]))
      .toEqual([["a", ""], ["b", "kept"]]);
    // `hidden` got its document with the first `hide`, and nothing else
    // was made or deleted.
    expect(instance.documents()).toEqual({
      ...documents,
      "state cell": documents["state cell"] + 1,
    });
  });

  it("keeps the state cell of an upstream key that leaves the result of a `filter` and returns, over plain values", async () => {
    const { instance, labelsCone } = await start();
    instance.send(NOTE_LABEL, { text: "kept" }, [1]);
    const keyOfY = ['value:"y"#0'];

    instance.send(HIDE, { title: "y" });

    expect(result(instance).labels.map(({ word }) => word)).toEqual(["x"]);
    expect(instance.coneInstances(labelsCone)).not.toContainEqual(keyOfY);
    expect(memos(instance)).toContainEqual([keyOfY[0], "kept"]);

    instance.send(HIDE, { title: "" });

    expect(result(instance).labels.map(({ word, memo }) => [word, memo]))
      .toEqual([["x", ""], ["y", "kept"]]);
  });

  it("refuses an event for the stream of a key that left", async () => {
    const { instance } = await start();

    instance.send(HIDE, { title: "b" });

    // The binding of the key is named from the key and has the stream it
    // had (ES §2.6), and the executor finds an element for a stream in
    // its element tables alone: no position holds the key now.
    expect(instance.send(NOTE_ROW, { text: "late" }, [1]).committed).toBe(
      false,
    );
  });
});

// Ruling Z20 on `fixtures/stream-returned.tsx`: a stream that a function
// body returns into the result is allowed and not checked. The body is
// handed the stream of a binding as a handle, and what it returns holds
// a reference, which is stored as a link as any reference a body returns
// is. No path of `Binding.result` names the position.
describe("a stream a function body returns into the result", () => {
  const link = (name: string) => ({
    $link: { doc: "argument", path: ["pool", name] },
  });
  // The elements of `items` are references to cells, and those of `tags`
  // plain values stored in place.
  const start = async () => {
    const artifact = await artifactOf("stream-returned");
    const instance = new Instance(artifact, {
      pool: { a: { title: "a" }, b: { title: "b" } },
      items: [link("a"), link("b")],
      tags: ["x", "y"],
    });
    return { artifact, instance };
  };
  type Stored = {
    wrapped: { again: unknown };
    rows: { again: unknown }[];
    labels: { again: unknown }[];
  };
  const stored = (instance: Instance) =>
    instance.store.docs.get("result")?.value as Stored;

  it("stores the link to the stream of a binding outside every element body, and checks nothing", async () => {
    const { artifact, instance } = await start();

    expect(artifact.plan.bindings[0].result).toEqual([
      { path: ["inc"], stars: [] },
    ]);
    expect(stored(instance).wrapped.again).toEqual({
      $stream: { binding: 0, keys: [] },
    });
    expect(instance.failures).toEqual([]);
    // An event sent through the stored link is handled by the binding.
    instance.send(0, { by: 3 });
    expect((instance.result() as { count: number }).count).toBe(3);
  });

  it("stores the link to the stream of the element's key over references", async () => {
    const { artifact, instance } = await start();

    expect(artifact.plan.bindings[1].result).toBe(undefined);
    expect(stored(instance).rows.map((row) => row.again)).toEqual([
      { $stream: { binding: 1, keys: ['cell:argument:["pool","a"]#0'] } },
      { $stream: { binding: 1, keys: ['cell:argument:["pool","b"]#0'] } },
    ]);
    expect(instance.failures).toEqual([]);
  });

  it("stores the link to the stream of the element's key over plain values in place", async () => {
    const { artifact, instance } = await start();

    expect(artifact.plan.bindings[2].result).toBe(undefined);
    expect(stored(instance).labels.map((row) => row.again)).toEqual([
      { $stream: { binding: 2, keys: ['value:"x"#0'] } },
      { $stream: { binding: 2, keys: ['value:"y"#0'] } },
    ]);
    expect(instance.failures).toEqual([]);
  });

  it("counts the positions as held at no listed path", async () => {
    const { instance } = await start();

    // `inc` is at its listed path. The five streams the bodies returned
    // are at no listed path, and none fails a check.
    expect(instance.streamPositions()).toMatchObject({
      atListedPath: 1,
      atNoListedPath: 5,
    });
  });
});

// Ruling Z21 on `fixtures/star-kinds.tsx`: each `*` of a path of
// `Binding.result` states what it stands for, and the check accepts a
// marker only at a position of the stated kind. The executor knows which
// position of an array is an element of which collection, and which is a
// member written beside them, from how it assembled the array.
describe("what a `*` of a result path stands for", () => {
  const link = (name: string) => ({
    $link: { doc: "argument", path: ["pool", name] },
  });
  // The elements of `items` are references to cells, and those of `tags`
  // plain values stored in place.
  const argument = () => ({
    pool: { a: { title: "a" }, b: { title: "b" } },
    items: [link("a"), link("b")],
    tags: ["x", "y", "z"],
  });
  type Star = { kind: "element" | "every" | "inside" } | {
    kind: "member";
    index: number;
  };
  /** The artifact with the kinds of the first path of a binding changed. */
  const restated = (artifact: Artifact, binding: number, stars: Star[]) => {
    const copy = structuredClone(artifact);
    copy.plan.bindings[binding].result![0].stars = stars;
    return copy;
  };
  const INC = 0;
  const MORE = 1;
  const STORY = 2;
  const ROW_PICK = 4;
  const ITEM_PICK = 5;
  const TAG_PICK = 6;
  const failed = (artifact: Artifact) =>
    new Instance(artifact, argument()).failures.map(({ binding, path }) => [
      binding,
      path.slice(1, 6).join("/"),
    ]);

  it("states the kind of each `*`", async () => {
    const { plan } = await artifactOf("star-kinds");
    const stars = (binding: number) =>
      plan.bindings[binding].result?.map((listed) => listed.stars);

    // The callback writes the stream of a binding made outside it, over
    // references and over plain values in place.
    expect(stars(INC)).toEqual([[{ kind: "every" }], [{ kind: "every" }]]);
    // A child written after a collection has a position of its own and
    // no `*` (ruling Z31).
    expect(plan.bindings[MORE].result).toEqual([{
      path: ["$UI", "children", "2", "children", "2", "props", "onClick"],
      stars: [],
    }]);
    // One element of an array of plain values written in place holds the
    // stream inside its value.
    expect(stars(STORY)).toEqual([[{ kind: "inside" }]]);
    // Over the result of another per-element construct, whose keys the
    // collection has.
    expect(stars(ROW_PICK)).toEqual([[{ kind: "element" }]]);
    // Two collections among the children of one node, over references
    // and over plain values in place.
    expect(stars(ITEM_PICK)).toEqual([[{ kind: "element" }]]);
    expect(stars(TAG_PICK)).toEqual([[{ kind: "element" }]]);
  });

  it("accepts each marker at a position of the stated kind", async () => {
    const instance = new Instance(await artifactOf("star-kinds"), argument());

    expect(instance.failures).toEqual([]);
    expect(instance.streamPositions().atNoListedPath).toBe(0);
  });

  it("accepts a marker of kind `every` at an element of the collection alone", async () => {
    const artifact = await artifactOf("star-kinds");

    // Stated as a member written at the first entry: the markers stand
    // at the elements of the collection, over references.
    expect(failed(restated(artifact, INC, [{ kind: "member", index: 0 }])))
      .toEqual([
        [INC, "children/0/children/0/0"],
        [INC, "children/0/children/0/1"],
      ]);
    // And over plain values in place, with the second path of `inc`.
    const second = structuredClone(artifact);
    second.plan.bindings[INC].result![1].stars = [{ kind: "member", index: 0 }];
    expect(failed(second)).toEqual([
      [INC, "children/1/children/0/0"],
      [INC, "children/1/children/0/1"],
      [INC, "children/1/children/0/2"],
    ]);
  });

  // Kind `member` arises in an array value with a spread alone, since a
  // collection among the children of a view node is one child (ruling
  // Z31). `fixtures/member-kind.tsx` has it after a spread over
  // references and after one over plain values in place.
  it("accepts a marker of kind `member` at the position of that member alone", async () => {
    const artifact = await artifactOf("member-kind");
    const [AFTER, TAIL] = [0, 1];
    const failures = (changed: Artifact) =>
      new Instance(changed, argument()).failures.map(({ binding, path }) => [
        binding,
        path.join("/"),
      ]);
    expect(artifact.plan.bindings[AFTER].result).toEqual([{
      path: ["rows", "*", "pick"],
      stars: [{ kind: "member", index: 2 }],
    }]);
    expect(artifact.plan.bindings[TAIL].result).toEqual([{
      path: ["words", "*", "pick"],
      stars: [{ kind: "member", index: 1 }],
    }]);
    expect(failures(artifact)).toEqual([]);
    // `rows` holds the first member, the two elements, and the member.
    const position = [AFTER, "rows/3/pick"];

    // Stated as every position of a collection, or as another member.
    expect(failures(restated(artifact, AFTER, [{ kind: "every" }]))).toEqual([
      position,
    ]);
    expect(failures(restated(artifact, AFTER, [{ kind: "inside" }]))).toEqual([
      position,
    ]);
    expect(failures(restated(artifact, AFTER, [{ kind: "member", index: 1 }])))
      .toEqual([position]);
    expect(failures(restated(artifact, AFTER, [{ kind: "member", index: 3 }])))
      .toEqual([position]);
    // Over plain values in place, `words` holds three elements first.
    expect(failures(restated(artifact, TAIL, [{ kind: "every" }]))).toEqual([
      [TAIL, "words/3/pick"],
    ]);
  });

  it("accepts a marker of kind `inside` at an element of the collection alone", async () => {
    const artifact = await artifactOf("star-kinds");

    expect(failed(restated(artifact, STORY, [{ kind: "member", index: 0 }])))
      .toEqual([[STORY, "children/4/children/0/0"]]);
    // The binding has no `element` step, so no key of it is at a
    // position.
    expect(failed(restated(artifact, STORY, [{ kind: "element" }]))).toEqual([
      [STORY, "children/4/children/0/0"],
    ]);
  });

  it("accepts a marker of kind `element` at the position that holds its key alone", async () => {
    const artifact = await artifactOf("star-kinds");

    // Over the result of another per-element construct, the position
    // has the key of the upstream element.
    expect(
      failed(restated(artifact, ROW_PICK, [{ kind: "member", index: 0 }])),
    ).toEqual([
      [ROW_PICK, "children/5/children/0/0"],
      [ROW_PICK, "children/5/children/0/1"],
      [ROW_PICK, "children/5/children/0/2"],
    ]);
    const listed = artifact.plan.bindings[ITEM_PICK].result![0];
    const position = [...listed.path];
    position[position.indexOf("*")] = "1";
    const at = (key: string | undefined) =>
      position.map((_, index) =>
        index === listed.path.indexOf("*")
          ? { entry: 0, spread: true, key }
          : undefined
      );
    const b = 'cell:argument:["pool","b"]#0';
    // The position holds the key of the instance that placed the marker,
    // another key, or it is an element of a collection with no key.
    expect(coversPosition(listed, position, at(b), [b])).toBe(true);
    expect(coversPosition(listed, position, at('value:"x"#0'), [b])).toBe(
      false,
    );
    expect(coversPosition(listed, position, at(undefined), [b])).toBe(false);
  });

  it("stores two collections among the children of one node as two children", async () => {
    const instance = new Instance(await artifactOf("star-kinds"), argument());
    type Row = { props: { onClick: unknown } };
    const menu = (instance.store.docs.get("result")?.value as {
      $UI: { children: { children: Row[][] }[] };
    }).$UI.children[3].children;

    // Each binding lists the `*` below the position of its own
    // collection, of kind `element`: over references in the first and
    // over plain values in place in the second.
    expect(menu.length).toBe(2);
    expect(menu[0].map((row) => row.props.onClick)).toEqual([
      { $stream: { binding: 5, keys: ['cell:argument:["pool","a"]#0'] } },
      { $stream: { binding: 5, keys: ['cell:argument:["pool","b"]#0'] } },
    ]);
    expect(menu[1].map((row) => row.props.onClick)).toEqual([
      { $stream: { binding: 6, keys: ['value:"x"#0'] } },
      { $stream: { binding: 6, keys: ['value:"y"#0'] } },
      { $stream: { binding: 6, keys: ['value:"z"#0'] } },
    ]);
    expect(instance.failures).toEqual([]);
  });
});

// `fixtures/instantiate.tsx`: a pattern instantiated in a function body
// and a handler bound in one (ES §2.8; PL §3.14, §3.15). The value code
// names the callee by its identity, and the executor is given the
// artifacts of the program to find it among.
describe("an instance a function body makes", () => {
  const start = async () => {
    const [{ patterns }] = JSON.parse(
      await Deno.readTextFile(
        new URL(
          "../../compare/fixtures/instantiate.emit.json",
          import.meta.url,
        ),
      ),
    ) as { patterns: Artifact[] }[];
    const artifacts = (id: string) =>
      patterns.find((pattern) => pattern.plan.patterns?.[0] === id);
    const main = patterns.find((pattern) => pattern.name === "default")!;
    return new Instance(main, { note: "n" }, { artifacts });
  };
  type Rows = {
    rows: { title: string; count: number }[];
    total: number;
    pressed: number;
    buttons: { by: number; press: unknown }[];
  };
  const ADD = 1;
  const result = (instance: Instance) => instance.result() as Rows;
  /** A handle to the stream the result stores at a path. */
  const streamAt = (instance: Instance, path: string[]) =>
    new Handle(instance, new Ref("result", path), undefined, undefined, []);

  it("is an instance of the callee's plan, with documents of its own in the same store", async () => {
    const instance = await start();
    const before = instance.documents();

    expect(instance.send(ADD, { title: "a" }).committed).toBe(true);
    expect(instance.send(ADD, { title: "b" }).committed).toBe(true);

    // Each event's run makes an instance, and the list holds a
    // reference to its result.
    expect(result(instance).rows).toEqual([
      {
        title: "a",
        count: 0,
        bump: { $stream: true },
        tally: {
          $stream: true,
        },
      },
      {
        title: "b",
        count: 0,
        bump: { $stream: true },
        tally: {
          $stream: true,
        },
      },
    ]);
    const stored = instance.store.docs.get("state:0:[]")?.value as {
      $link: { doc: string; path: string[] };
    }[];
    expect(stored.map(({ $link }) => $link.path)).toEqual([[], []]);
    expect(new Set(stored.map(({ $link }) => $link.doc)).size).toBe(2);
    // An argument and a result document for each instance, and the
    // state cell of the list.
    expect(instance.documents()).toEqual({
      ...before,
      "argument": 3,
      "result": 3,
      "state cell": 1,
    });
  });

  it("handles an event for a binding of the instance, in the instance", async () => {
    const instance = await start();
    instance.send(ADD, { title: "a" });
    instance.send(ADD, { title: "b" });

    streamAt(instance, ["rows", "1", "bump"]).send({ by: 2 });
    instance.dispatch();

    // The state cell of the second instance, and of no other.
    expect(result(instance).rows.map(({ count }) => count)).toEqual([0, 2]);
  });

  it("is handed a cell of the caller by reference, and a binding of it writes that cell", async () => {
    const instance = await start();
    instance.send(ADD, { title: "a" });

    streamAt(instance, ["rows", "0", "tally"]).send({ by: 5 });
    instance.dispatch();

    expect(result(instance).total).toBe(5);
    expect(result(instance).rows[0].count).toBe(0);
  });

  it("is not made when the handler's run fails", async () => {
    const [{ patterns }] = JSON.parse(
      await Deno.readTextFile(
        new URL(
          "../../compare/fixtures/instantiate.emit.json",
          import.meta.url,
        ),
      ),
    ) as { patterns: Artifact[] }[];
    const main = patterns.find((pattern) => pattern.name === "default")!;
    // With no artifact for the callee, the instantiation fails, and the
    // event commits nothing.
    const instance = new Instance(main, { note: "n" });
    const before = instance.documents();

    const outcome = instance.send(ADD, { title: "a" });

    expect(outcome.committed).toBe(false);
    expect(outcome.error).toBe("a pattern called in a function body");
    expect(instance.documents()).toEqual(before);
  });

  it("binds a handler in a function body, and an event for its stream runs the handler with the state the body bound", async () => {
    const instance = await start();

    expect(result(instance).buttons).toEqual([
      { by: 1, press: { $stream: true } },
      { by: 2, press: { $stream: true } },
    ]);
    // The stored positions hold a link to a stream each, which no path
    // of `Binding.result` names and no check concerns (ruling Z20).
    const stored = instance.store.docs.get("result")?.value as {
      buttons: { press: { $stream: { binding: number; keys: string[] } } }[];
    };
    const [first, second] = stored.buttons.map(({ press }) => press.$stream);
    expect(first.binding).toBe(-1);
    expect(first.keys).not.toEqual(second.keys);
    expect(instance.failures).toEqual([]);

    streamAt(instance, ["buttons", "1", "press"]).send({ by: 4 });
    instance.dispatch();

    expect(result(instance).pressed).toBe(4);
    // The body read nothing that changed: it is not evaluated again, and
    // the streams are the ones it bound.
    expect(
      (instance.store.docs.get("result")?.value as typeof stored).buttons.map((
        { press },
      ) => press.$stream),
    ).toEqual([first, second]);
  });
});
