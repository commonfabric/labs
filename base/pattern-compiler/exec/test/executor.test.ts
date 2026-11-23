import {
  type FabricValue,
  hashOf,
  isDeepFrozen,
  toCompactDebugString,
  toIndentedDebugString,
} from "@commonfabric/data-model";
import {
  fabricFromJsonValue,
  jsonFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type Artifact,
  Handle,
  Host,
  Instance,
  targetOf,
} from "../executor.ts";
import {
  argumentOf as argumentDocument,
  ComputedOutput,
  fieldsOfKey,
  identifierOf,
  keySegment,
  memberKey,
  Ref,
  type Schema,
  Store,
  StreamRef,
} from "../store.ts";

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

/** The argument document of an instance that is given no identifier. */
const ARGUMENT = argumentDocument("result");

/** The key of a plain value that is keyed whole, in a store's space. */
const whole = (at: Instance | Store, value: unknown, count = 0): string =>
  (at instanceof Store ? at : at.store).keyOf(value, [], count);

/** The key of a record that is keyed by all of the members given. */
const byFields = (
  at: Instance | Store,
  value: Record<string, unknown>,
  count = 0,
): string =>
  (at instanceof Store ? at : at.store).keyOf(value, Object.keys(value), count);

/**
 * The key of a position that holds a link to a path of a document: the
 * record of the address, with the space where the store was given one.
 */
const cellKey = (
  document: string,
  path: string[],
  occurrence = 0,
  space?: string,
): string =>
  jsonFromFabricValue({
    element: { ...(space === undefined ? {} : { space }), document, path },
    occurrence,
  });

/**
 * The documents of an instance by kind, without the documents of the
 * streams that received an event.
 */
const besideStreams = (instance: Instance): Record<string, number> => {
  const { stream: _stream, ...kinds } = instance.documents();
  return kinds;
};

/** Keys in the order of their text, as a helper that sorts keys gives them. */
const sorted = (keys: string[]): string[] => [...keys].sort();

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
    expect(instance.stateCells()).toMatchObject([
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

    // The record the handler pushed onto `log` has a document of its
    // own, and the stream has one with the first event.
    expect(instance.documents()).toEqual({
      "argument": 1,
      "result": 1,
      "state cell": 2,
      "element record": 1,
      "stream": 1,
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
      $link: { doc: ARGUMENT, path: ["pool", name] },
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
      $link: { doc: ARGUMENT, path: ["pool", name] },
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
      instance.stateCells().filter((cell) =>
        cell.name === name && instance.store.docs.has(cell.id)
      ).map(({ id }) => instance.store.docs.get(id)?.value);
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
        (instance.store.docs.get(ARGUMENT)?.value as { seed: unknown }).seed,
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
        (instance.store.docs.get(ARGUMENT)?.value as {
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
        (instance.store.docs.get(ARGUMENT)?.value as { stops: unknown[] })
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

  it("hands a body the value where it reads one at a place that another body takes as a handle", async () => {
    // The place has a slot of class `identity`, which `touch` is handed as
    // a handle, and one of class `value`, which `named` reads members of
    // (ES §2.4, "What the argument holds at a path").
    const instance = new Instance(await artifactOf("value-beside-handle"), {
      author: { kind: "person", name: "Ann" },
    });

    expect(instance.result()).toEqual({
      present: 1,
      shown: { kind: "person", name: "Ann" },
    });
  });

  it("gives two references to one cell one `equalsKey`, and a reference to another cell another", async () => {
    // Provisional decision P41: `equalsKey` returns what `equals`
    // compares.
    const link = (index: number) => ({
      $link: { doc: ARGUMENT, path: ["pool", `${index}`] },
    });
    const instance = new Instance(await artifactOf("equals-key"), {
      pool: { 0: { name: "a" }, 1: { name: "b" } },
      items: [link(0), link(1), link(0)],
    });

    expect((instance.result() as { count: unknown }).count).toBe(2);
  });

  it("hands a body the members it reads of each element of an array that holds references", async () => {
    // ES §2.4: the body reads members of each element (`value` entries of
    // `Body.reads` at `*`), beside an `enumeration` entry at the array.
    // The handler wrote the board through a handle, so the array holds a
    // reference to each row.
    const instance = new Instance(await artifactOf("members-below-set"), {
      board: { title: "t", rows: [] },
    });
    const outcome = instance.send(
      instance.plan.bindings.findIndex(({ name }) => name === "publish"),
      {
        board: {
          title: "u",
          rows: [{ id: "a", tags: ["x"] }, { id: "b", tags: [] }],
        },
      },
    );

    expect(outcome.committed).toBe(true);
    expect(instance.failed).toEqual([]);
    expect((instance.result() as { summary: unknown }).summary).toEqual([
      "a:1",
      "b:0",
    ]);
  });

  it("hands a body a handle where it declares one at an array that another body computed whole", async () => {
    // FA §6.2, "A handle bound to a value the instance computed": the
    // handle names the document of the output (ruling Z53).
    const instance = new Instance(await artifactOf("handle-of-computed"), {
      names: ["a", "b"],
    });

    expect((instance.result() as { summary: unknown }).summary).toBe("2:a");
  });

  it("gives two bodies that make a cell under one cause a cell each", async () => {
    // PL §1.3: the cell is named by the cause and by the run that makes it.
    const instance = new Instance(await artifactOf("cause-per-body"), {
      name: "n",
    });
    // Both cells are read again after both bodies ran.
    instance.writeArgument(["name"], "m");

    expect(instance.result()).toEqual({ a: "first m", b: "second m" });
  });

  it("hands a body a handle at each member of a record where it declares one at `*`", async () => {
    // ES §2.4: "An entry whose `at` holds `*` is placed at each child the
    // path reaches". Two members link to one cell.
    const link = (index: number) => ({
      $link: { doc: ARGUMENT, path: ["pool", `${index}`] },
    });
    const instance = new Instance(await artifactOf("record-of-handles"), {
      pool: { 0: { name: "x" }, 1: { name: "y" } },
      byName: { a: link(0), b: link(1), c: link(0) },
    });

    expect((instance.result() as { listed: unknown }).listed).toEqual([
      "a:x:true",
      "b:y:false",
      "c:x:true",
    ]);
  });
});

// PL §3.5 on `fixtures/selected-operand.tsx`: the result of `??`, `||`
// and `&&` is the selected operand itself.
describe("the operand that a logical operator selects", () => {
  const stored = (instance: Instance) =>
    instance.store.docs.get("result")?.value as Record<string, unknown>;
  const linkTo = (name: string) => ({ $link: { doc: ARGUMENT, path: [name] } });

  it("is stored as the link to the left operand where that is a record", async () => {
    const instance = new Instance(await artifactOf("selected-operand"), {
      primary: { name: "p" },
      backup: { name: "b" },
      enabled: true,
    });

    expect(stored(instance).coalesced).toMatchObject(linkTo("primary"));
    expect(stored(instance).either).toMatchObject(linkTo("primary"));
    // The default that the schema of the link declares reaches a reader.
    expect(instance.result()).toMatchObject({
      coalesced: { name: "p", nick: "anon" },
      either: { name: "p", nick: "anon" },
    });
  });

  it("is stored as the link to the right operand where the left one is not selected", async () => {
    const instance = new Instance(await artifactOf("selected-operand"), {
      backup: { name: "b" },
      enabled: true,
    });

    expect(stored(instance).coalesced).toMatchObject(linkTo("backup"));
    expect(stored(instance).either).toMatchObject(linkTo("backup"));
    expect(stored(instance).both).toMatchObject(linkTo("backup"));
    // The plan lists an operand of a scalar type as a `value` slot, so
    // the right operand of `text` is stored as its value.
    expect(stored(instance).text).toBe("none");
  });

  it("is stored as the value of the left operand where that is a scalar", async () => {
    const instance = new Instance(await artifactOf("selected-operand"), {
      backup: { name: "b" },
      label: "l",
      enabled: false,
    });

    expect(stored(instance).text).toBe("l");
    expect(stored(instance).both).toBe(false);
  });

  it("selects the right operand once the left one holds nothing", async () => {
    const instance = new Instance(await artifactOf("selected-operand"), {
      primary: { name: "p" },
      backup: { name: "b" },
      enabled: true,
    });
    instance.result();

    instance.writeArgument(["primary"], undefined);

    expect(stored(instance).coalesced).toMatchObject(linkTo("backup"));
    expect(instance.result()).toMatchObject({ either: { name: "b" } });
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

describe("the identifier of a document", () => {
  // `execution-and-storage.md` §5.1 and §5.2: an identifier is the hash of
  // the cause of the thing, and a key in the cause enters the hash as the
  // record it is.
  it("is the hash of the cause for a state cell of an element body, and holds no text of a key", async () => {
    const instance = new Instance(await artifactOf("equal-values"), {
      tags: ["a", "a"],
    });

    const [first, second] = instance.stateCells();

    expect(first.id).toBe(identifierOf({
      parent: "result",
      type: "state",
      within: [{
        element: "map",
        key: fabricFromJsonValue(whole(instance, "a")),
      }],
      cause: "opened",
    }));
    expect(first.id).toBe(
      instance.stateCellDocument(0, [whole(instance, "a")]),
    );
    expect(second.id).not.toBe(first.id);
    // The identifier is one tagged hash, however long the key is.
    for (const { id } of [first, second]) {
      expect(id).toMatch(/^fid1:[\w-]{43}$/);
    }
  });

  it("is the hash of the cause of an internal cell for a state cell declared directly in the pattern body", async () => {
    const instance = new Instance(await artifactOf("handler"), {
      secret: "s3cret",
      note: "n",
    });

    expect(instance.stateCells().map(({ id }) => id)).toEqual(
      ["last", "log"].map((cause) =>
        identifierOf({ parent: "result", type: "internal", cause })
      ),
    );
  });

  it("is the hash of the result document and the type for the argument document", async () => {
    const instance = new Instance(await artifactOf("handler"), {}, {
      id: "another instance",
    });

    expect(instance.id).toBe("another instance");
    expect(instance.argument).toBe(
      identifierOf({ type: "argument", parent: "another instance" }),
    );
    expect(instance.store.docs.get(instance.argument)?.kind).toBe("argument");
    expect(instance.store.docs.get(instance.id)?.kind).toBe("result");
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
      [whole(instance, "a")],
      [whole(instance, "a", 1)],
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
        $link: {
          doc: ARGUMENT,
          path: ["tags", keySegment(whole(instance, "a"))],
        },
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
    const instance = new Instance(artifact, {
      amount: 420,
      rows: [],
      words: [],
    });

    // Expression code has the default as a constant still. The
    // sandboxed body is handed nothing at the path: `x.symbol.split`
    // throws, and the output that its cone computes holds the error
    // state (PL §5.2).
    expect(instance.result()).toMatchObject({
      bound: "$420",
      boundSpelled: {
        $error: {
          message: "Cannot read properties of undefined (reading 'split')",
        },
      },
    });
    expect(instance.counts.failures).toBe(1);
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
      $link: { doc: ARGUMENT, path: ["sign"], schema: { default: "$" } },
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
    // The binding whose stream the result holds at `marked.append`.
    const append =
      instance.streams().find(({ path }) => path.join("/") === "marked/append")!
        .binding;
    expect(instance.plan.bindings[append].state[0].default).toBe("$");

    // `symbol.set(symbol.get() + "!")`: the read gives the default.
    instance.send(append, {});

    expect(
      (instance.store.docs.get(ARGUMENT)?.value as { sign: string }).sign,
    ).toBe("$!");
  });

  it("does the same for a callee in an element body, over references", async () => {
    const instance = new Instance(await artifactOf("callee-default"), {
      amount: 420,
      pool: { a: { amount: 1 }, b: { amount: 20, sign: "kr" } },
      rows: [
        { $link: { doc: ARGUMENT, path: ["pool", "a"] } },
        { $link: { doc: ARGUMENT, path: ["pool", "b"] } },
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
    $link: { doc: ARGUMENT, path: ["pool", name] },
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
    $link: { doc: ARGUMENT, path: ["pool", name] },
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
  // The identifier of the record: the hash of the address of the list as
  // its cause, and the key.
  const keyed = (list: Ref, key: string) =>
    identifierOf({ list: { document: list.doc, path: [] } }, { key });
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
    expect([...instance.store.docs.keys()]).toContain(keyed(list, "z"));
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
      { $link: { doc: keyed(list, "z"), path: [] } },
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
    $link: { doc: ARGUMENT, path: ["pool", name] },
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
  const cell = (name: string) => cellKey(ARGUMENT, ["pool", name]);
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
      [memberKey(g, whole(instance, "a"))],
      [memberKey(g, whole(instance, "b"))],
      [memberKey(h, whole(instance, "c"))],
    ]);
  });

  it("keys a member that is a reference by its source element and the identity of its cell", async () => {
    const { artifact, instance } = await start();

    expect((instance.result() as Flat).loudPeople).toEqual(["p!", "q!", "r!"]);
    expect(instance.coneInstances(coneOf(artifact, "loudPeople"))).toEqual([
      [memberKey(g, cell("p"))],
      [memberKey(g, cell("q"))],
      [memberKey(h, cell("r"))],
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
      [memberKey(whole(instance, "x"), whole(instance, "x1"))],
      [memberKey(whole(instance, "x"), whole(instance, "x2"))],
      [memberKey(whole(instance, "y"), whole(instance, "y1"))],
      [memberKey(whole(instance, "y"), whole(instance, "y2"))],
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
      [memberKey(g, whole(instance, "a"))],
      [memberKey(g, whole(instance, "a", 1))],
      [memberKey(h, whole(instance, "a"))],
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
      [memberKey(whole(instance, "x"), whole(instance, "x1"))],
      [memberKey(whole(instance, "x"), whole(instance, "x2"))],
      [memberKey(whole(instance, "z"), whole(instance, "z1"))],
      [memberKey(whole(instance, "z"), whole(instance, "z2"))],
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
      [memberKey(g, whole(instance, "b"))],
      [memberKey(h, whole(instance, "c"))],
      [memberKey(g, whole(instance, "z"))],
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
    $link: { doc: ARGUMENT, path: ["pool", name] },
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
      [cellKey(ARGUMENT, ["pool", "a"])],
      [cellKey(ARGUMENT, ["pool", "b"])],
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
      [whole(instance, "x")],
      [whole(instance, "skip")],
      [whole(instance, "y")],
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
      [whole(instance, "x")],
      [whole(instance, "y")],
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
      [cellKey(ARGUMENT, ["pool", "b"])],
    ]);
    expect(instance.coneInstances(marks)).toEqual([
      [whole(instance, "skip")],
      [whole(instance, "y")],
      [whole(instance, "z")],
    ]);
    expect(instance.coneInstances(loud)).toEqual([
      [whole(instance, "y")],
      [whole(instance, "z")],
    ]);
    // For the key `z`: two cones of `marks`, the predicate, and two cones
    // of `loud`. Nothing is evaluated for a key that stayed or left.
    expect(instance.counts.elementEvaluations - before).toBe(5);

    // A key that comes back has new instances, which are evaluated.
    instance.writeArgument(["tags"], ["skip", "y", "z", "x"]);

    expect(instance.counts.elementEvaluations - before).toBe(10);
  });
});

// Rulings Z11 and Z43 on `fixtures/stream-marker.tsx`: `host.stream`
// gives value code a marker, and the executor replaces it by the link to
// the stream when it stores the value, wherever the marker is.
describe("the stream of a binding in a computed value", () => {
  const link = (name: string) => ({
    $link: { doc: ARGUMENT, path: ["pool", name] },
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
  });

  it("is stored as the stream of the instance's key over references", async () => {
    const instance = new Instance(
      await artifactOf("stream-marker"),
      argument(),
    );

    expect(streamsOf(rowsOf(tree(instance).children[1])))
      .toEqual([
        { $stream: { binding: 1, keys: [cellKey(ARGUMENT, ["pool", "a"])] } },
        { $stream: { binding: 1, keys: [cellKey(ARGUMENT, ["pool", "b"])] } },
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
      { $stream: { binding: 2, keys: [whole(instance, "x")] } },
      { $stream: { binding: 2, keys: [whole(instance, "skip")] } },
      { $stream: { binding: 2, keys: [whole(instance, "y")] } },
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
      { $stream: { binding: 3, keys: [whole(instance, "x")] } },
      { $stream: { binding: 3, keys: [whole(instance, "y")] } },
    ]);

    instance.send(3, {}, [1]);

    expect((instance.result() as { chosen: string }).chosen).toBe("y");
  });

  it("stores the link below a conditional when the branch that places the marker is selected", async () => {
    const one = { $stream: { binding: 0, keys: [] } };
    // The other branch is selected, and the position holds its value.
    const instance = new Instance(
      await artifactOf("stream-marker"),
      argument(false),
    );
    expect(tree(instance).children[0]).toBe(null);
    expect(rowsOf(tree(instance).children[2]).length).toBe(3);

    // The branch that places the marker is selected, and a tag is
    // removed in the same write, which changes another subtree.
    instance.store.write(new Ref(ARGUMENT, ["tags"]), ["x"]);
    instance.writeArgument(["shown"], true);

    // The tree is stored whole: the link at the position of the
    // conditional, and the list with one row.
    expect(tree(instance).children[0].props.onClick).toEqual(one);
    expect(rowsOf(tree(instance).children[2]).length).toBe(1);

    instance.writeArgument(["shown"], false);

    expect(tree(instance).children[0]).toBe(null);
  });

  it("passes a stream that is an input of the pattern on as an input", async () => {
    const artifact = await artifactOf("stream-marker");
    const instance = new Instance(artifact, argument());
    const stored = instance.store.docs.get("result")?.value as {
      outside: { $link: { doc: string; path: string[] } };
    };

    // The stored position holds a link to the place of the input, and no
    // stream of a binding.
    expect(stored.outside.$link.doc).toBe(ARGUMENT);
    expect(stored.outside.$link.path).toEqual(["outside"]);
    const passed = tree(instance).children[4].props.onClick as {
      $link: { doc: string; path: string[] };
    };
    expect(passed.$link.path).toEqual(["outside"]);
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
    expect(instance.stateCells()).toMatchObject([
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
    $link: { doc: ARGUMENT, path: ["pool", name] },
  });
  const references = () => ({
    pool: { a: stop("a", 1), b: stop("b", 2), c: stop("c", 3) },
    stops: [link("a"), link("b"), link("c")],
    tags: ["x", "y", "x"],
  });
  const keyOf = (instance: Instance, title: string, at: number, count = 0) =>
    whole(
      instance,
      { done: false, position: { lat: at, lng: at }, title },
      count,
    );
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
      instance.stateCellDocument(
        instance.plan.stateCells.findIndex((cell) => cell.name === name),
      ),
    )?.value;
  const start = async (argument: unknown = inPlace()) =>
    new Instance(await artifactOf("value-identity"), argument);

  it("is passed on as the collection, the key and the path, over plain values in place", async () => {
    const instance = await start();

    const row = stored(instance).rows[1] as Record<string, unknown>;
    const element = ["stops", keySegment(keyOf(instance, "b", 2))];
    expect(row.stop).toMatchObject({
      $link: { doc: ARGUMENT, path: element },
    });
    expect(row.position).toMatchObject({
      $link: { doc: ARGUMENT, path: [...element, "position"] },
    });
    // The member bound both ways holds the reference with the member's
    // path.
    expect((row.check as ViewNode).props.$checked).toMatchObject({
      $link: { doc: ARGUMENT, path: [...element, "done"] },
    });
    // A string: the second `x` is occurrence 1.
    expect(
      (stored(instance).words[2].item as ViewNode).children[0],
    ).toMatchObject({
      $link: {
        doc: ARGUMENT,
        path: ["tags", keySegment(whole(instance, "x", 1))],
      },
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
      $link: { doc: ARGUMENT, path: ["pool", "b"] },
    });
    expect(row.position).toMatchObject({
      $link: { doc: ARGUMENT, path: ["pool", "b", "position"] },
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
        doc: ARGUMENT,
        path: ["stops", keySegment(keyOf(instance, "b", 2))],
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
      $link: { doc: ARGUMENT, path: ["pool", "b"] },
    });
    instance.send(bindingOf(instance, "reverse"), {});
    expect(result(instance).rows.map((row) => [row.title, row.isSelected]))
      .toEqual([["c", false], ["b", true], ["a", false]]);
  });

  it("is told from an equal value by its occurrence, over plain values in place", async () => {
    const instance = await start();
    const chosen = new Ref(
      instance.stateCellDocument(
        instance.plan.stateCells.findIndex((cell) => cell.name === "chosen"),
      ),
      [],
    );
    const occurrence = (count: number) =>
      new Ref(ARGUMENT, ["tags", keySegment(whole(instance, "x", count))]);
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

  // Rulings Z26 and Z33: `items.key(i)` is a handle by position, and it
  // is equal to a reference by key to the element that is at the
  // position at the time of the comparison.
  it("is equal to a handle that names the position it is at, and to no other", async () => {
    const instance = await start();
    const element = new Ref(ARGUMENT, [
      "stops",
      keySegment(keyOf(instance, "a", 1)),
    ]);
    const stops = new Handle(
      instance,
      new Ref(ARGUMENT, ["stops"]),
      undefined,
      undefined,
      [],
    );

    expect(instance.same(element, stops.key(0))).toBe(true);
    expect(stops.key(0).equals(element)).toBe(true);
    expect(instance.same(element, stops.key(1))).toBe(false);
    expect(instance.same(element, new Ref(element.doc, element.path))).toBe(
      true,
    );

    // The element moves: the handle by position names what is at the
    // position now, and the reference by key its element.
    instance.send(bindingOf(instance, "reverse"), {});

    expect(instance.same(element, stops.key(0))).toBe(false);
    expect(instance.same(element, stops.key(2))).toBe(true);
    expect(stops.key(0).get()).toEqual(stop("c", 3));
  });

  it("is equal to a handle that names its position, over references", async () => {
    const instance = await start(references());
    const element = new Ref(ARGUMENT, ["pool", "a"]);
    const stops = new Handle(
      instance,
      new Ref(ARGUMENT, ["stops"]),
      undefined,
      undefined,
      [],
    );

    expect(instance.same(element, stops.key(0))).toBe(true);
    expect(instance.same(element, stops.key(1))).toBe(false);
  });

  // Ruling Z40: the state of `pick` declares `stop: Stop`, a plain type.
  // What the handler is given there carries the reference by key, and
  // `stop.position` the reference with the member's path.
  it("is given to a handler through a state path of plain type as a reference by key, over plain values in place", async () => {
    const instance = await start();

    instance.send(bindingOf(instance, "pick"), {}, [1]);

    // `selected.set(stop)` and `center.set(stop.position)`.
    const element = ["stops", keySegment(keyOf(instance, "b", 2))];
    expect(cellOf(instance, "selected")).toMatchObject({
      $link: { doc: ARGUMENT, path: element },
    });
    expect(cellOf(instance, "center")).toMatchObject({
      $link: { doc: ARGUMENT, path: [...element, "position"] },
    });
  });

  it("is given to a handler through a state path of plain type as the link to its cell, over references", async () => {
    const instance = await start(references());

    instance.send(bindingOf(instance, "pick"), {}, [1]);

    expect(cellOf(instance, "selected")).toMatchObject({
      $link: { doc: ARGUMENT, path: ["pool", "b"] },
    });
    expect(cellOf(instance, "center")).toMatchObject({
      $link: { doc: ARGUMENT, path: ["pool", "b", "position"] },
    });
  });

  // Ruling Z40, second half: a handle whose type declares its members
  // as handles, as `Writable<Writable<Stop>[]>`.
  it("is a handle by key where it is read through a handle of handles, over plain values in place", async () => {
    const instance = await start();
    const stops = new Handle(
      instance,
      new Ref(ARGUMENT, ["stops"]),
      undefined,
      undefined,
      [],
      { type: "array", items: { type: "object", asCell: ["cell"] } },
    );

    const members = stops.get() as Handle[];

    expect(members.map((member) => (targetOf(member) as Ref).path)).toEqual([
      ["stops", keySegment(keyOf(instance, "a", 1))],
      ["stops", keySegment(keyOf(instance, "b", 2))],
      ["stops", keySegment(keyOf(instance, "c", 3))],
    ]);
    // The handle stays with its element when the element moves.
    instance.send(bindingOf(instance, "reverse"), {});
    expect(members[0].get()).toEqual(stop("a", 1));
  });

  it("is a handle to the position that holds the link where it is read through a handle of handles, over references", async () => {
    const instance = await start(references());
    const stops = new Handle(
      instance,
      new Ref(ARGUMENT, ["stops"]),
      undefined,
      undefined,
      [],
      { type: "array", items: { type: "object", asCell: ["cell"] } },
    );

    const members = stops.get() as Handle[];

    expect(members.map((member) => (targetOf(member) as Ref).path)).toEqual([
      ["stops", "0"],
      ["stops", "1"],
      ["stops", "2"],
    ]);
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
      (instance.store.docs.get(ARGUMENT)?.value as { stops: unknown[] })
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
      (instance.store.docs.get(ARGUMENT)?.value as { stops: unknown[] })
        .stops[1],
    ).toEqual(changed);
    // The position holds another key: the cone instances of that key are
    // evaluated, and its row holds the reference with the new key.
    expect(instance.counts.elementEvaluations - before).toBeGreaterThan(0);
    const key = whole(instance, {
      done: true,
      position: { lat: 2, lng: 2 },
      title: "b",
    });
    expect((stored(instance).rows[1] as Record<string, unknown>).stop)
      .toMatchObject({
        $link: { doc: ARGUMENT, path: ["stops", keySegment(key)] },
      });
    // What the old key held moved to the new key in the same
    // transaction (ruling Z24): the state cell of the row is that of
    // the new key and holds what the row had set.
    expect(result(instance).rows[1].open).toBe(true);
    const open = instance.stateCells().filter(({ name }) => name === "open")
      .map(({ keys, value }) => [keys[0], value]);
    expect(open).toContainEqual([key, true]);
    expect(open.map(([held]) => held)).not.toContain(keyOf(instance, "b", 2));
    // The reference `selected` holds was stored under the old key before
    // the write, keeps that key, and reads as nothing.
    expect(result(instance).selected).toBe(undefined);
    expect(result(instance).rows.map((row) => row.isSelected)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("takes a second write through the same reference after a write that changed the value, over plain values in place", async () => {
    const instance = await start();
    instance.send(bindingOf(instance, "toggle"), {}, [1]);

    // `stop.key("done").set(true)` and then `stop.key("title").set(...)`.
    const outcome = instance.send(
      bindingOf(instance, "finishAndRename"),
      {},
      [1],
    );

    // The reference the handler holds follows the element to its new
    // key, and the row keeps its state (ruling Z24).
    expect(outcome.committed).toBe(true);
    expect(result(instance).rows[1]).toMatchObject({
      title: "renamed",
      open: true,
      stop: { title: "renamed", done: true },
    });
    expect(result(instance).rows.map((row) => row.title)).toEqual([
      "a",
      "renamed",
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

// Rulings Z25, Z26 and Z33 on `fixtures/value-copy.tsx`: a function body
// that reads a plain value in place through a handle holds a copy.
describe("a plain value that a function body reads through a handle", () => {
  const card = (suit: string, rank: number) => ({ suit, rank });
  const inPlace = () => ({
    left: [card("a", 1), card("a", 2)],
    right: [card("b", 3), card("b", 4)],
  });
  const link = (name: string) => ({
    $link: { doc: ARGUMENT, path: ["pool", name] },
  });
  const references = () => ({
    pool: {
      p: card("a", 1),
      q: card("a", 2),
      r: card("b", 3),
      s: card("b", 4),
    },
    left: [link("p"), link("q")],
    right: [link("r"), link("s")],
  });
  type Result = { left: unknown[]; right: unknown[]; kept: unknown };
  const [DISCARD, SWAP, KEEP] = [0, 1, 2];
  const argumentOf = (instance: Instance) =>
    instance.store.docs.get(ARGUMENT)?.value as {
      left: unknown[];
      right: unknown[];
    };
  const keptOf = (instance: Instance) =>
    instance.store.docs.get(
      instance.stateCellDocument(
        instance.plan.stateCells.findIndex((cell) => cell.name === "kept"),
      ),
    )?.value;

  it("is stored as the value where the body writes it to a cell, over plain values in place", async () => {
    const instance = new Instance(await artifactOf("value-copy"), inPlace());

    instance.send(KEEP, {});

    // The cell holds the value, and no reference by key and no link to
    // the position.
    expect(keptOf(instance)).toEqual(card("a", 1));
    instance.writeArgument(["left"], [card("z", 9)]);
    expect((instance.result() as Result).kept).toEqual(card("a", 1));
  });

  it("is stored as the link to its cell, over references", async () => {
    const instance = new Instance(await artifactOf("value-copy"), references());

    instance.send(KEEP, {});

    expect(keptOf(instance)).toMatchObject(link("p"));
    instance.writeArgument(["pool", "p", "rank"], 7);
    expect((instance.result() as Result).kept).toEqual(card("a", 7));
  });

  it("is stored in place where the body writes it into another array, over plain values in place", async () => {
    const instance = new Instance(await artifactOf("value-copy"), inPlace());

    const outcome = instance.send(SWAP, {});

    // Each array holds the values, in place: no reference by key into
    // the other array, no link, and no document for a record.
    expect(outcome.committed).toBe(true);
    expect(argumentOf(instance)).toEqual({
      left: [card("a", 1), card("b", 4)],
      right: [card("b", 3), card("a", 2)],
    });
    expect(instance.documents()["element record"]).toBe(undefined);
    expect(instance.result()).toMatchObject({
      left: [card("a", 1), card("b", 4)],
      right: [card("b", 3), card("a", 2)],
    });
  });

  it("keeps the links where the body moves references between two arrays, over references", async () => {
    const instance = new Instance(await artifactOf("value-copy"), references());

    instance.send(SWAP, {});

    expect(argumentOf(instance).left).toMatchObject([link("p"), link("s")]);
    expect(argumentOf(instance).right).toMatchObject([link("r"), link("q")]);
  });

  it("finds the element of a row with a handle by position, over plain values in place", async () => {
    const instance = new Instance(await artifactOf("value-copy"), inPlace());

    // The row of the second card.
    const outcome = instance.send(DISCARD, {}, [1]);

    expect(outcome.committed).toBe(true);
    expect((instance.result() as Result).left).toEqual([card("a", 1)]);
  });

  it("finds the element of a row with a handle by position, over references", async () => {
    const instance = new Instance(await artifactOf("value-copy"), references());

    instance.send(DISCARD, {}, [0]);

    expect((instance.result() as Result).left).toEqual([card("a", 2)]);
  });
});

// Ruling Z24 on `fixtures/rekey.tsx`: a write through a reference by key
// that changes a plain value in place re-keys the element in the same
// transaction, and what the old key holds moves to the new key.
describe("a write through a reference by key that changes the value", () => {
  const task = (title: string, done = false) => ({ title, done });
  const inPlace = () => ({ tasks: [task("a"), task("b"), task("hidden")] });
  const link = (name: string) => ({
    $link: { doc: ARGUMENT, path: ["pool", name] },
  });
  const references = () => ({
    pool: { a: task("a"), b: task("b"), c: task("hidden") },
    tasks: [link("a"), link("b"), link("c")],
  });
  const keyOf = (
    instance: Instance,
    title: string,
    done = false,
    count = 0,
  ) => whole(instance, { done, title }, count);
  type Result = {
    picked: unknown;
    rows: { title: string; done: boolean; noted: string }[];
    open: { title: string; seen: string }[];
  };
  const result = (instance: Instance) => instance.result() as Result;
  const [NOTE, FINISH_AND_RENAME, FINISH_AND_PICK, PICK, SEE] = [0, 1, 2, 3, 4];
  // The cells of the rows that hold something.
  const cells = (instance: Instance, name: string) =>
    instance.stateCells().filter((cell) =>
      cell.name === name && cell.value !== ""
    ).map(({ keys, value }) => [keys[0], value]);
  const keysOf = (instance: Instance, name: string) =>
    instance.stateCells().filter((cell) => cell.name === name).map((
      { keys },
    ) => keys[0]);
  const start = async (argument: unknown = inPlace()) =>
    new Instance(await artifactOf("rekey"), argument);

  it("moves the state cell of the row to the new key, over plain values in place", async () => {
    const instance = await start();
    instance.send(NOTE, { text: "mine" }, [1]);
    const documents = instance.documents()["state cell"];

    const outcome = instance.send(FINISH_AND_RENAME, {}, [1]);

    // Both writes commit, and the row keeps its note.
    expect(outcome.committed).toBe(true);
    expect(result(instance).rows).toMatchObject([
      { title: "a", done: false, noted: "" },
      { title: "renamed", done: true, noted: "mine" },
      { title: "hidden", done: false, noted: "" },
    ]);
    // The cell is that of the new key, and no cell of the old key or of
    // the key between the two writes is left. No document was made.
    expect(cells(instance, "noted")).toEqual([[
      keyOf(instance, "renamed", true),
      "mine",
    ]]);
    expect(keysOf(instance, "noted")).not.toContain(keyOf(instance, "b"));
    expect(keysOf(instance, "noted")).not.toContain(keyOf(instance, "b", true));
    expect(instance.documents()["state cell"]).toBe(documents);
  });

  // Ruling Z41, for the state cell of a row over plain values in place.
  it("replaces the state cell that is stored under the new key with the one that is moved", async () => {
    const instance = await start({ tasks: [task("a", true)] });
    // The key of `a` with `done` holds a note, and leaves.
    instance.send(NOTE, { text: "left" }, [0]);
    instance.writeArgument(["tasks"], [task("a")]);
    instance.send(NOTE, { text: "mine" }, [0]);

    // The element is re-keyed to the key that left.
    instance.send(FINISH_AND_PICK, {}, [0]);

    expect(result(instance).rows).toMatchObject([
      { title: "a", done: true, noted: "mine" },
    ]);
    expect(cells(instance, "noted")).toEqual([[
      keyOf(instance, "a", true),
      "mine",
    ]]);
  });

  it("moves nothing for another element whose occurrence count the write changed", async () => {
    // Two elements with one value: occurrences 0 and 1.
    const instance = await start({ tasks: [task("a"), task("a")] });
    instance.send(NOTE, { text: "second" }, [1]);

    // The first is re-keyed. The second is occurrence 0 of its value
    // now, and the cell of its old key stays where it is.
    instance.send(FINISH_AND_PICK, {}, [0]);

    expect(result(instance).rows).toMatchObject([
      { title: "a", done: true, noted: "" },
      { title: "a", done: false, noted: "" },
    ]);
    expect(cells(instance, "noted")).toEqual([[
      keyOf(instance, "a", false, 1),
      "second",
    ]]);
  });

  it("re-keys nothing on a write that is not through a reference by key", async () => {
    const instance = await start();
    instance.send(NOTE, { text: "mine" }, [1]);

    // A `set` of the whole array: the element with another value is
    // another element, and the cell of the old key stays where it is.
    instance.writeArgument(["tasks"], [
      task("a"),
      task("b", true),
      task("hidden"),
    ]);

    expect(instance.store.rekeys).toEqual([]);
    expect(result(instance).rows[1]).toMatchObject({ done: true, noted: "" });
    expect(cells(instance, "noted")).toEqual([[keyOf(instance, "b"), "mine"]]);
  });

  it("moves the state cell of a row over the result of a `filter` with the upstream key", async () => {
    const instance = await start();
    instance.send(SEE, { text: "seen" }, [1]);
    expect(result(instance).open[1]).toMatchObject({
      title: "b",
      seen: "seen",
    });

    instance.send(FINISH_AND_RENAME, {}, [1]);

    expect(result(instance).open).toMatchObject([
      { title: "a", seen: "" },
      { title: "renamed", seen: "seen" },
    ]);
    expect(cells(instance, "seen")).toEqual([[
      keyOf(instance, "renamed", true),
      "seen",
    ]]);
  });

  it("stores the reference the writer holds with the new key", async () => {
    const instance = await start();

    instance.send(FINISH_AND_PICK, {}, [0]);

    // The handle was stored after the write: it names the element.
    expect(result(instance).picked).toEqual(task("a", true));
    const stored = instance.store.docs.get(instance.stateCellDocument(0))
      ?.value;
    expect(stored).toMatchObject({
      $link: {
        doc: ARGUMENT,
        path: ["tasks", keySegment(keyOf(instance, "a", true))],
      },
    });
  });

  it("leaves a reference stored elsewhere under the old key reading as nothing", async () => {
    const instance = await start();
    instance.send(PICK, {}, [1]);
    expect(result(instance).picked).toEqual(task("b"));

    instance.send(FINISH_AND_RENAME, {}, [1]);

    expect(result(instance).picked).toBe(undefined);
  });

  it("moves the state cell on a write through a member bound both ways", async () => {
    const instance = await start();
    instance.send(NOTE, { text: "mine" }, [0]);

    // As the rendered checkbox of the row writes its attribute.
    instance.writeThrough(["rows", "0", "check", "props", "$checked"], true);

    expect(result(instance).rows[0]).toMatchObject({
      title: "a",
      done: true,
      noted: "mine",
    });
    expect(cells(instance, "noted")).toEqual([[
      keyOf(instance, "a", true),
      "mine",
    ]]);
  });

  it("moves nothing where a handler that wrote throws", async () => {
    const artifact = structuredClone(await artifactOf("rekey"));
    const instance = new Instance(artifact, inPlace());
    instance.send(NOTE, { text: "mine" }, [1]);
    // The body of the handler is wrapped so that it throws after its two
    // writes.
    const run = instance.bodies.get(
      artifact.plan.bindings[FINISH_AND_RENAME].handler.body!,
    )!;
    instance.bodies.set(
      artifact.plan.bindings[FINISH_AND_RENAME].handler.body!,
      (...given: unknown[]) => {
        run(...given);
        throw new Error("after the writes");
      },
    );

    const outcome = instance.send(FINISH_AND_RENAME, {}, [1]);

    expect(outcome.committed).toBe(false);
    expect(result(instance).rows[1]).toMatchObject({
      title: "b",
      done: false,
      noted: "mine",
    });
    expect(cells(instance, "noted")).toEqual([[keyOf(instance, "b"), "mine"]]);
  });

  it("changes no key over references, where the element is a cell", async () => {
    const instance = await start(references());
    instance.send(NOTE, { text: "mine" }, [1]);
    instance.send(PICK, {}, [1]);
    const before = cells(instance, "noted");

    const outcome = instance.send(FINISH_AND_RENAME, {}, [1]);

    expect(outcome.committed).toBe(true);
    expect(result(instance).rows[1]).toMatchObject({
      title: "renamed",
      done: true,
      noted: "mine",
    });
    expect(cells(instance, "noted")).toEqual(before);
    expect(result(instance).picked).toEqual(task("renamed", true));
  });
});

// Ruling Z41 on `fixtures/rekey-made.tsx`: what a re-key moves of what
// the function bodies of an element body made.
describe("what a function body of an element body made, on a re-key", () => {
  const task = (title: string, done = false) => ({ title, done });
  const start = async (argument: unknown) => {
    const [{ patterns }] = JSON.parse(
      await Deno.readTextFile(
        new URL(
          "../../compare/fixtures/rekey-made.emit.json",
          import.meta.url,
        ),
      ),
    ) as { patterns: Artifact[] }[];
    const artifacts = (id: string) =>
      patterns.find((pattern) => pattern.plan.patterns?.[0] === id);
    const main = patterns.find((pattern) => pattern.name === "default")!;
    return new Instance(main, argument, { artifacts });
  };
  const inPlace = () => ({ tasks: [task("a"), task("b")] });
  type Stream = { $stream: { binding: number; keys: string[] } };
  type Rows = {
    pressed: number;
    rows: { done: boolean; row: { title: string; count: number } }[];
  };
  const result = (instance: Instance) => instance.result() as Rows;
  const FINISH = (instance: Instance) =>
    instance.plan.bindings.findIndex((binding) => binding.name === "finish");
  /** The link the result stores at a path, with each link on the way followed. */
  const storedAt = (instance: Instance, path: string[]) =>
    instance.store.locate(new Ref("result", path), true).value;
  /** A handle to the stream the result stores at a path. */
  const streamAt = (instance: Instance, path: string[]) =>
    new Handle(instance, new Ref("result", path), undefined, undefined, []);
  /** The document the result of the instance of a row is stored in. */
  const rowDocument = (instance: Instance, row: number) =>
    instance.store.locate(new Ref("result", ["rows", `${row}`, "row"]), true)
      .ref.doc;

  it("moves the instance that a `lift` of the body made to the new key, over plain values in place", async () => {
    const instance = await start(inPlace());
    streamAt(instance, ["rows", "0", "row", "bump"]).send({ by: 3 });
    instance.dispatch();
    expect(result(instance).rows[0].row.count).toBe(3);
    const before = rowDocument(instance, 0);

    // The write changes the value of the element, and so its key.
    instance.send(FINISH(instance), {}, [0]);

    expect(result(instance).rows[0]).toMatchObject({
      done: true,
      row: { title: "a", count: 3 },
    });
    expect(rowDocument(instance, 0)).toBe(before);
    // The stream of the instance is handled as before.
    streamAt(instance, ["rows", "0", "row", "bump"]).send({ by: 1 });
    instance.dispatch();
    expect(result(instance).rows[0].row.count).toBe(4);
    expect(result(instance).rows[1].row.count).toBe(0);
  });

  it("gives a value that is written anew, with no write through a reference by key, another instance", async () => {
    const instance = await start(inPlace());
    streamAt(instance, ["rows", "0", "row", "bump"]).send({ by: 3 });
    instance.dispatch();

    // A `set` of the whole array: the element with `done` is another
    // element, and nothing is re-keyed.
    instance.writeArgument(["tasks"], [task("a", true), task("b")]);

    expect(instance.store.rekeys).toEqual([]);
    expect(result(instance).rows[0].row.count).toBe(0);
  });

  it("replaces the instance that is stored under the new key with the one that is moved", async () => {
    const instance = await start(inPlace());
    // The key of `a` with `done` is made, its instance is counted up,
    // and the key leaves.
    instance.writeArgument(["tasks"], [task("a", true), task("b")]);
    streamAt(instance, ["rows", "0", "row", "bump"]).send({ by: 9 });
    instance.dispatch();
    instance.writeArgument(["tasks"], [task("a"), task("b")]);
    streamAt(instance, ["rows", "0", "row", "bump"]).send({ by: 3 });
    instance.dispatch();

    // The element that is not done is re-keyed to the key that left.
    instance.send(FINISH(instance), {}, [0]);

    expect(result(instance).rows[0].row.count).toBe(3);
  });

  it("removes the instance that the moved one replaced, with its documents", async () => {
    const instance = await start(inPlace());
    const settled = instance.documents();
    // The key of `a` with `done` is made, with an instance of its own,
    // and the key leaves.
    instance.writeArgument(["tasks"], [task("a", true), task("b")]);
    streamAt(instance, ["rows", "0", "row", "bump"]).send({ by: 9 });
    instance.dispatch();
    const replaced = rowDocument(instance, 0);
    const prefix = replaced.slice(0, -"result".length);
    instance.writeArgument(["tasks"], [task("a"), task("b")]);
    const moved = rowDocument(instance, 0);
    expect(moved).not.toBe(replaced);
    // The instance of the key that left is kept (ruling Z18).
    expect(instance.store.docs.has(replaced)).toBe(true);

    // The element that is not done is re-keyed to the key that left.
    instance.send(FINISH(instance), {}, [0]);

    expect(rowDocument(instance, 0)).toBe(moved);
    expect(
      [...instance.store.docs.keys(), ...instance.store.declared.keys()]
        .filter((id) => id.startsWith(prefix)),
    ).toEqual([]);
    expect(instance.store.streams.has(replaced)).toBe(false);
    // The store holds the documents of two rows, as after it settled.
    expect(besideStreams(instance)).toEqual(settled);
    // The instance that moved handles an event for its stream.
    streamAt(instance, ["rows", "0", "row", "bump"]).send({ by: 1 });
    instance.dispatch();
    expect(result(instance).rows[0].row.count).toBe(1);
  });

  it("moves nothing for the binding that a function body made", async () => {
    const instance = await start(inPlace());
    const press = () =>
      (storedAt(instance, ["rows", "0", "button", "press"]) as Stream).$stream;
    const before = press();
    expect(before.binding).toBe(-1);

    instance.send(FINISH(instance), {}, [0]);

    // The body is evaluated for the new key and binds a handler of its
    // own: the stream is named by the run of the new key.
    expect(press().keys).not.toEqual(before.keys);
    streamAt(instance, ["rows", "0", "button", "press"]).send({ by: 2 });
    instance.dispatch();
    expect(result(instance).pressed).toBe(2);
  });

  it("moves nothing for another element whose occurrence count the write changed", async () => {
    // Two elements with one value: occurrences 0 and 1.
    const instance = await start({ tasks: [task("a"), task("a")] });
    streamAt(instance, ["rows", "1", "row", "bump"]).send({ by: 5 });
    instance.dispatch();
    expect(result(instance).rows.map(({ row }) => row.count)).toEqual([0, 5]);

    // The first is re-keyed, and the second is occurrence 0 of its
    // value now: a key that was the first element's. Nothing of the
    // second element's old key moves to it.
    instance.send(FINISH(instance), {}, [0]);

    expect(result(instance).rows.map(({ row }) => row.count)).toEqual([0, 0]);
  });

  it("keeps the instance over references, where the write changes no key", async () => {
    const instance = await start({
      pool: { a: task("a"), b: task("b") },
      tasks: [
        { $link: { doc: ARGUMENT, path: ["pool", "a"] } },
        { $link: { doc: ARGUMENT, path: ["pool", "b"] } },
      ],
    });
    streamAt(instance, ["rows", "0", "row", "bump"]).send({ by: 3 });
    instance.dispatch();

    instance.send(FINISH(instance), {}, [0]);

    expect(result(instance).rows[0]).toMatchObject({
      done: true,
      row: { title: "a", count: 3 },
    });
  });
});

// Ruling Z27 on `fixtures/push-default.tsx`: a `push` below a path of the
// argument that holds nothing and whose schema declares a default starts
// from the default.
describe("a `push` below an empty argument path with a declared default", () => {
  type Result = { tags: string[]; entries: { text: string }[] };
  const [ADD_TAG, ADD_ENTRY] = [0, 1];

  it("starts from the default, for plain values in place", async () => {
    const instance = new Instance(await artifactOf("push-default"), {});
    expect((instance.result() as Result).tags).toEqual(["first"]);

    const outcome = instance.send(ADD_TAG, { text: "x" });

    expect(outcome.committed).toBe(true);
    expect((instance.result() as Result).tags).toEqual(["first", "x"]);
    expect(
      (instance.store.docs.get(ARGUMENT)?.value as Result).tags,
    ).toEqual(["first", "x"]);
  });

  it("starts from the default, for a record that the push stores as a reference", async () => {
    const instance = new Instance(await artifactOf("push-default"), {});

    instance.send(ADD_ENTRY, { text: "x" });

    // The record of the default stays in place, and the pushed record
    // is a document of its own.
    expect((instance.result() as Result).entries).toEqual([
      { text: "given" },
      { text: "x" },
    ]);
    const stored = (instance.store.docs.get(ARGUMENT)?.value as {
      entries: unknown[];
    }).entries;
    expect(stored[0]).toEqual({ text: "given" });
    expect(stored[1]).toMatchObject({ $link: {} });
  });

  it("appends to what is stored where the path holds an array", async () => {
    const instance = new Instance(await artifactOf("push-default"), {
      tags: ["a"],
      entries: [],
    });

    instance.send(ADD_TAG, { text: "x" });
    instance.send(ADD_ENTRY, { text: "y" });

    expect(instance.result()).toMatchObject({
      tags: ["a", "x"],
      entries: [{ text: "y" }],
    });
  });
});

// Ruling Z13: an output that passes a derived collection on unchanged is
// the same collection for keying, and the plan marks it
// (`Output.passesCollection`). `fixtures/passes-collection.tsx` has a
// `map` over a `computed` that returns the result of a `filter`, twice.
describe("an output that passes a derived collection on", () => {
  const link = (name: string) => ({
    $link: { doc: ARGUMENT, path: ["pool", name] },
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
    expect(keysOf(instance, 0)).toEqual(sorted([
      cellKey(ARGUMENT, ["pool", "a"]),
      cellKey(ARGUMENT, ["pool", "c"]),
    ]));
  });

  it("gives a construct applied to it the keys of the source elements, over plain values in place", async () => {
    const instance = new Instance(
      await artifactOf("passes-collection"),
      argument(),
    );

    // The `filter` dropped the first `x`. The one it kept is occurrence
    // 1 of the source, and that is its key downstream.
    expect(keysOf(instance, 1)).toEqual(
      sorted([whole(instance, "x", 1), whole(instance, "y")]),
    );
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
    expect(keysOf(instance, 0)).toEqual(sorted([
      cellKey(ARGUMENT, ["pool", "a"]),
      cellKey(ARGUMENT, ["pool", "c"]),
    ]));
    // Over plain values in place the kept `x` is keyed as the first one
    // of the array the output holds.
    expect(keysOf(instance, 1)).not.toEqual(
      sorted([whole(instance, "x", 1), whole(instance, "y")]),
    );
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
    $link: { doc: ARGUMENT, path: ["pool", name] },
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

  // Ruling Z28: the state entry of a binding that captures the name has
  // a place of its own kind, which names the result of the instance.
  it("is handed to a handler that captures it, as a reference to the result", async () => {
    const instance = new Instance(await artifactOf("self"), {
      title: "t",
      items: [],
      tags: [],
    });
    const keep = instance.plan.bindings.findIndex((binding) =>
      binding.name === "keep" && binding.within.length === 0
    );
    const entry = instance.plan.bindings[keep].state.find(({ path }) =>
      path[0] === "self"
    );

    expect(entry?.place).toEqual({ result: true });
    // `kept.set(self)` stores what the handler was handed.
    const outcome = instance.send(keep, {});
    expect(outcome.committed).toBe(true);
    const kept = instance.plan.stateCells.findIndex((cell) =>
      cell.name === "kept"
    );
    expect(instance.store.docs.get(instance.stateCellDocument(kept))?.value)
      .toEqual(
        toResult,
      );
    expect(
      instance.store.read(new Ref(instance.stateCellDocument(kept), ["title"])),
    ).toBe(
      "t",
    );
  });

  it("is handed to a handler of an element body, over references and over plain values in place", async () => {
    const instance = new Instance(await artifactOf("self"), {
      title: "t",
      pool: { a: { title: "a" } },
      items: [link("a")],
      tags: ["x"],
    });
    const kept = instance.plan.stateCells.findIndex((cell) =>
      cell.name === "kept"
    );
    const inRows = instance.plan.bindings.flatMap((binding, index) =>
      binding.name === "keep" && binding.within.length > 0 ? [index] : []
    );
    expect(inRows.length).toBe(2);

    for (const binding of inRows) {
      expect(
        instance.plan.bindings[binding].state.find(({ path }) =>
          path[0] === "self"
        )?.place,
      ).toEqual({ result: true });
      instance.writeState("kept", [], null);
      instance.send(binding, {}, [0]);
      expect(instance.store.docs.get(instance.stateCellDocument(kept))?.value)
        .toEqual(
          toResult,
        );
    }
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
    return instance.store.docs.get(instance.stateCellDocument(index))
      ?.value as unknown[];
  };
  const bindingOf = (instance: Instance, name: string) =>
    instance.plan.bindings.findIndex((binding) => binding.name === name);

  it("gets a document of its own where it is pushed, and the list stores a link", async () => {
    const instance = await start();
    instance.send(bindingOf(instance, "add"), { title: "a" });

    const [slot] = held(instance, "stops") as { $link: { doc: string } }[];
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
    expect(instance.store.docs.get(slots[1].$link.doc)?.kind).toBe(
      "element record",
    );
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
    const list = new Ref(instance.stateCellDocument(index), []);

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

    expect(instance.store.docs.get(ARGUMENT)?.value).toMatchObject({
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
      keySegment(whole(store, { title: "b" })),
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
    (instance.store.docs.get(instance.stateCellDocument(0))?.value ??
      []) as unknown[];

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
    const keyOfY = [whole(instance, "y")];
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
    expect(memos(instance)).toContainEqual([whole(instance, "x", 1), "second"]);

    instance.writeArgument(["words"], ["x", "x"]);

    expect(result(instance).labels.map(({ memo }) => memo)).toEqual([
      "first",
      "second",
    ]);
  });

  it("keeps the state cell of an upstream key that leaves the result of a `filter` and returns, over references", async () => {
    const { instance, rowsCone } = await start();
    instance.send(NOTE_ROW, { text: "kept" }, [1]);
    const documents = besideStreams(instance);
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
    expect(besideStreams(instance)).toEqual({
      ...documents,
      "state cell": documents["state cell"] + 1,
    });
  });

  it("keeps the state cell of an upstream key that leaves the result of a `filter` and returns, over plain values", async () => {
    const { instance, labelsCone } = await start();
    instance.send(NOTE_LABEL, { text: "kept" }, [1]);
    const keyOfY = [whole(instance, "y")];

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

// Ruling Z20 on `fixtures/stream-returned.tsx`: a function body may
// return a stream into the result. The body is handed the stream of a
// binding as a handle, and what it returns holds a reference, which is
// stored as a link as any reference a body returns is.
describe("a stream a function body returns into the result", () => {
  const link = (name: string) => ({
    $link: { doc: ARGUMENT, path: ["pool", name] },
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

  it("stores the link to the stream of a binding outside every element body", async () => {
    const { instance } = await start();

    expect(stored(instance).wrapped.again).toEqual({
      $stream: { binding: 0, keys: [] },
    });
    // An event sent through the stored link is handled by the binding.
    instance.send(0, { by: 3 });
    expect((instance.result() as { count: number }).count).toBe(3);
  });

  it("stores the link to the stream of the element's key over references", async () => {
    const { instance } = await start();

    expect(stored(instance).rows.map((row) => row.again)).toEqual([
      { $stream: { binding: 1, keys: [cellKey(ARGUMENT, ["pool", "a"])] } },
      { $stream: { binding: 1, keys: [cellKey(ARGUMENT, ["pool", "b"])] } },
    ]);
  });

  it("stores the link to the stream of the element's key over plain values in place", async () => {
    const { instance } = await start();

    expect(stored(instance).labels.map((row) => row.again)).toEqual([
      { $stream: { binding: 2, keys: [whole(instance, "x")] } },
      { $stream: { binding: 2, keys: [whole(instance, "y")] } },
    ]);
  });

  it("records the position of each link, with the element it is for", async () => {
    const { instance } = await start();

    expect(
      instance.streams().map(({ binding, path, elements }) => [
        binding,
        path.join("/"),
        elements,
      ]),
      // In the order the result document holds its members in, which is
      // that of the storage.
    ).toEqual([
      [0, "inc", []],
      [2, "labels/0/again", [0]],
      [2, "labels/1/again", [1]],
      [1, "rows/0/again", [0]],
      [1, "rows/1/again", [1]],
      [0, "wrapped/again", []],
    ]);
  });
});

// Ruling Z43 on `fixtures/star-kinds.tsx` and `fixtures/member-kind.tsx`:
// the link to a stream is stored at each position where value code
// placed its marker, among the elements of a collection, beside them,
// and inside the value of an element.
describe("where the stream of a binding is stored in an array", () => {
  const link = (name: string) => ({
    $link: { doc: ARGUMENT, path: ["pool", name] },
  });
  // The elements of `items` are references to cells, and those of `tags`
  // plain values stored in place.
  const argument = () => ({
    pool: { a: { title: "a" }, b: { title: "b" } },
    items: [link("a"), link("b")],
    tags: ["x", "y", "z"],
  });
  const INC = 0;
  const MORE = 1;
  const STORY = 2;
  const ROW_PICK = 4;
  /** Where the result holds the stream of a binding, and for which keys. */
  const held = (instance: Instance, binding: number) =>
    instance.streams().filter((stream) => stream.binding === binding).map((
      { path, keys },
    ) => [path.join("/"), keys]);

  it("stores the one stream of a binding made outside the callback at every element", async () => {
    const instance = new Instance(await artifactOf("star-kinds"), argument());

    // Over references, and over plain values in place.
    expect(held(instance, INC)).toEqual([
      ["$UI/children/0/children/0/0/props/onClick", []],
      ["$UI/children/0/children/0/1/props/onClick", []],
      ["$UI/children/1/children/0/0/props/onClick", []],
      ["$UI/children/1/children/0/1/props/onClick", []],
      ["$UI/children/1/children/0/2/props/onClick", []],
    ]);
  });

  it("stores the stream at a child written after a collection", async () => {
    const instance = new Instance(await artifactOf("star-kinds"), argument());

    expect(held(instance, MORE)).toEqual([
      ["$UI/children/2/children/2/props/onClick", []],
    ]);
  });

  it("stores the stream that one element of an array written in place holds inside its value", async () => {
    const instance = new Instance(await artifactOf("star-kinds"), argument());

    expect(held(instance, STORY)).toEqual([
      ["$UI/children/4/children/0/0/children/0/$UI/props/onClick", []],
    ]);
  });

  it("stores the stream of each upstream key over the result of another per-element construct", async () => {
    const instance = new Instance(await artifactOf("star-kinds"), argument());

    expect(held(instance, ROW_PICK)).toEqual([
      ["$UI/children/5/children/0/0/props/onClick", [whole(instance, "x")]],
      ["$UI/children/5/children/0/1/props/onClick", [whole(instance, "y")]],
      ["$UI/children/5/children/0/2/props/onClick", [whole(instance, "z")]],
    ]);
  });

  it("stores the stream at a member written after a spread, over references and over plain values in place", async () => {
    const instance = new Instance(await artifactOf("member-kind"), argument());
    const [AFTER, TAIL] = [0, 1];

    // `rows` holds the first member, the two elements, and the member.
    expect(held(instance, AFTER)).toEqual([["rows/3/pick", []]]);
    // `words` holds three elements first.
    expect(held(instance, TAIL)).toEqual([["words/3/pick", []]]);
  });

  it("stores two collections among the children of one node as two children", async () => {
    const instance = new Instance(await artifactOf("star-kinds"), argument());
    type Row = { props: { onClick: unknown } };
    const menu = (instance.store.docs.get("result")?.value as {
      $UI: { children: { children: Row[][] }[] };
    }).$UI.children[3].children;

    // Each row holds the stream of its own key: over references in the
    // first collection and over plain values in place in the second.
    expect(menu.length).toBe(2);
    expect(menu[0].map((row) => row.props.onClick)).toEqual([
      { $stream: { binding: 5, keys: [cellKey(ARGUMENT, ["pool", "a"])] } },
      { $stream: { binding: 5, keys: [cellKey(ARGUMENT, ["pool", "b"])] } },
    ]);
    expect(menu[1].map((row) => row.props.onClick)).toEqual([
      { $stream: { binding: 6, keys: [whole(instance, "x")] } },
      { $stream: { binding: 6, keys: [whole(instance, "y")] } },
      { $stream: { binding: 6, keys: [whole(instance, "z")] } },
    ]);
  });
});

// `fixtures/flat-streams.tsx`: every member of the segment that the
// callback of a `flatMap` writes for a source element holds the stream
// of that source key (rulings Z22 and Z43).
describe("the stream of a binding of a `flatMap` body", () => {
  const link = (name: string) => ({
    $link: { doc: ARGUMENT, path: ["pool", name] },
  });
  // The elements of `items` are references to cells, and those of `tags`
  // plain values stored in place.
  const argument = () => ({
    pool: { a: { title: "a" }, b: { title: "b" } },
    items: [link("a"), link("b")],
    tags: ["x", "y"],
  });
  type Row = { props: { onClick: { $stream: { keys: string[] } } } };
  const lists = (instance: Instance) =>
    (instance.store.docs.get("result")?.value as {
      $UI: { children: { children: Row[][] }[] };
    }).$UI.children.map((list) => list.children[0]);

  it("is stored at every member of the segment of its source key", async () => {
    const artifact = await artifactOf("flat-streams");
    const instance = new Instance(artifact, argument());

    // Over references: the two members of a segment hold the stream of
    // the one source key.
    const [a, b] = ["a", "b"].map((name) => cellKey(ARGUMENT, ["pool", name]));
    expect(lists(instance)[0].map((row) => row.props.onClick.$stream.keys))
      .toEqual([[a], [a], [b], [b]]);
    // Over plain values in place.
    expect(lists(instance)[1].map((row) => row.props.onClick.$stream.keys))
      .toEqual([[whole(instance, "x")], [whole(instance, "y")]]);

    // An event for the stream of the second source key.
    instance.send(0, {}, [1]);
    expect((instance.result() as { chosen: string }).chosen).toBe("b");
    instance.send(1, {}, [0]);
    expect((instance.result() as { chosen: string }).chosen).toBe("x");
  });
});

// Ruling Z39 on `fixtures/spread-child.tsx`: a JSX spread child, and an
// array literal with a spread or a hole among the children of a view
// node, is each one child at its written position.
describe("a spread among the children of a view node", () => {
  const link = (name: string) => ({
    $link: { doc: ARGUMENT, path: ["pool", name] },
  });
  // The elements of `items` are references to cells, and those of
  // `words` plain values stored in place.
  const start = async () =>
    new Instance(await artifactOf("spread-child"), {
      pool: { a: { title: "a" }, b: { title: "b" } },
      items: [link("a"), link("b")],
      words: ["x", "y"],
    });
  const children = (instance: Instance) =>
    (instance.result() as { $UI: ViewNode }).$UI.children;
  const texts = (rows: unknown) =>
    (rows as ViewNode[]).map((row) => row.children);

  it("stores each spread child as one child, a nested array", async () => {
    const instance = await start();

    const held = children(instance);

    expect(held.length).toBe(7);
    expect((held[0] as ViewNode).children).toEqual(["first"]);
    // Over plain values in place.
    expect(held[1]).toEqual(["x", "y"]);
    // Over the result of a `map`, whose source holds references.
    expect(texts(held[2])).toEqual([["a"], ["b"]]);
    // Over an array of references.
    expect(held[3]).toEqual([{ title: "a" }, { title: "b" }]);
    expect((held[6] as ViewNode).children).toEqual(["last"]);
  });

  it("stores the links of an array of references that is spread, and the values of plain values in place", async () => {
    const instance = await start();

    const stored = (instance.store.docs.get(instance.id)?.value as {
      $UI: ViewNode;
    }).$UI.children;

    // Over an array of references: each position holds the link to the
    // cell of its element.
    expect(stored[3]).toEqual([link("a"), link("b")]);
    // Over plain values in place.
    expect(stored[1]).toEqual(["x", "y"]);
    expect(stored[4]).toEqual(["before", "x", "y", "after"]);
  });

  it("stores an array literal with a spread, and one with a hole, as one child", async () => {
    const instance = await start();

    const held = children(instance);

    // The members and what the spread holds are the positions of the
    // one nested array.
    expect(held[4]).toEqual(["before", "x", "y", "after"]);
    // The hole is a position that holds nothing.
    expect((held[5] as unknown[]).length).toBe(3);
    expect((held[5] as unknown[])[0]).toBe("left");
    expect((held[5] as unknown[])[1] ?? null).toBe(null);
    expect((held[5] as unknown[])[2]).toBe("right");
  });

  it("keeps the position of each child when a spread array changes its length", async () => {
    const instance = await start();

    instance.writeArgument(["words"], ["x", "y", "z"]);

    const held = children(instance);
    expect(held.length).toBe(7);
    expect(held[1]).toEqual(["x", "y", "z"]);
    expect(held[4]).toEqual(["before", "x", "y", "z", "after"]);
    expect((held[6] as ViewNode).children).toEqual(["last"]);
  });
});

// Ruling Z43 on `fixtures/flat-inner.tsx`: the callback of a `flatMap`
// returns an inner `map` whose body binds a handler. The result of the
// `flatMap` has one level of positions, and each holds the link that
// value code placed there, for the keys of both collections.
describe("the stream of a binding of an inner `map` that a `flatMap` callback returns", () => {
  const [OVER_REFERENCES, OVER_PLAIN_VALUES, ADD] = [0, 1, 2];
  // The elements of `shelves` and of their `tags` are plain values
  // stored in place.
  const argument = () => ({
    shelves: [{ name: "s", tags: ["x", "y"] }, { name: "t", tags: ["z"] }],
  });
  // The groups are records a handler pushed: references to cells, whose
  // parts are references to cells too.
  const withGroups = async () => {
    const instance = new Instance(await artifactOf("flat-inner"), argument());
    instance.send(ADD, { name: "g", titles: ["a", "b"] });
    instance.send(ADD, { name: "h", titles: ["c"] });
    return instance;
  };
  type Stream = { binding: number; keys: string[] };
  type Row = { props: { onClick: { $stream: Stream } } };
  const rows = (instance: Instance, list: number) =>
    (instance.store.docs.get("result")?.value as {
      $UI: { children: { children: Row[][] }[] };
    }).$UI.children[list].children[0];
  const chosen = (instance: Instance) =>
    (instance.result() as { chosen: string }).chosen;

  it("is stored at each position of the result for both keys, over references", async () => {
    const instance = await withGroups();

    const streams = rows(instance, 0).map((row) => row.props.onClick.$stream);
    expect(streams.map(({ binding }) => binding)).toEqual([
      OVER_REFERENCES,
      OVER_REFERENCES,
      OVER_REFERENCES,
    ]);
    // The key of the group and then the key of the part, each the
    // identity of a cell.
    const [a, b, c] = streams.map(({ keys }) => keys);
    expect([a.length, b.length, c.length]).toEqual([2, 2, 2]);
    expect(a[0]).toBe(b[0]);
    expect(c[0]).not.toBe(a[0]);
    expect(new Set([a[1], b[1], c[1]]).size).toBe(3);
    for (const key of [...a, ...b, ...c]) expect(key).toContain('"document"');

    // An event for the stream of each position reads its group and its
    // part.
    instance.send(OVER_REFERENCES, {}, [0, 1]);
    expect(chosen(instance)).toBe("g/b");
    instance.send(OVER_REFERENCES, {}, [1, 0]);
    expect(chosen(instance)).toBe("h/c");
  });

  it("is stored at each position of the result for both keys, over plain values in place", async () => {
    const instance = new Instance(await artifactOf("flat-inner"), argument());

    const [s, t] = argument().shelves.map((shelf) => whole(instance, shelf));
    expect(rows(instance, 1).map((row) => row.props.onClick.$stream)).toEqual([
      { binding: OVER_PLAIN_VALUES, keys: [s, whole(instance, "x")] },
      { binding: OVER_PLAIN_VALUES, keys: [s, whole(instance, "y")] },
      { binding: OVER_PLAIN_VALUES, keys: [t, whole(instance, "z")] },
    ]);

    instance.send(OVER_PLAIN_VALUES, {}, [0, 1]);
    expect(chosen(instance)).toBe("s/y");
    instance.send(OVER_PLAIN_VALUES, {}, [1, 0]);
    expect(chosen(instance)).toBe("t/z");
  });

  it("records the position of each link to a stream that it stores", async () => {
    const instance = await withGroups();
    const below = (list: number, row: number) => [
      "$UI",
      "children",
      `${list}`,
      "children",
      "0",
      `${row}`,
      "props",
      "onClick",
    ];

    const held = instance.streams();

    // One for each row of the two lists, each with the position of the
    // element of its two collections, and the one stream of `add`.
    expect(held.map(({ binding, path, elements }) => [binding, path, elements]))
      .toEqual([
        [OVER_REFERENCES, below(0, 0), [0, 0]],
        [OVER_REFERENCES, below(0, 1), [0, 1]],
        [OVER_REFERENCES, below(0, 2), [1, 0]],
        [OVER_PLAIN_VALUES, below(1, 0), [0, 0]],
        [OVER_PLAIN_VALUES, below(1, 1), [0, 1]],
        [OVER_PLAIN_VALUES, below(1, 2), [1, 0]],
        [ADD, ["add"], []],
      ]);
    // Each is in the record of the document that holds the link.
    for (const { binding, keys, path } of held) {
      expect(instance.store.streams.get("result")).toContainEqual({
        path,
        stream: { binding, keys },
      });
    }
    expect(instance.store.streams.get("result")?.length).toBe(held.length);
  });

  it("drops the record of a position that holds the link no longer", async () => {
    const instance = await withGroups();

    instance.writeArgument(["shelves"], [{ name: "s", tags: ["x"] }]);

    expect(
      instance.streams().filter(({ binding }) => binding === OVER_PLAIN_VALUES)
        .map(({ path }) => path[5]),
    ).toEqual(["0"]);
    expect(instance.store.streams.get("result")?.length).toBe(5);
  });
});

// Rulings Z44, Z47, Z48, Z49, Z51 and Z52: the key of a plain value in
// an array that declares key fields names the fields in the order of
// their names and holds one salted hash of their values, a key formed
// from a whole value holds the salted hash of the value and names no
// field, and a reference by key is resolved from the key alone. The
// written form of a key is the serialization of the record of its parts
// by the JSON codec of fabric values. The arrays hold plain values in
// place, and the store is given no schema for them. An array of
// references is keyed by its cells, and declared key fields change
// nothing for it.
describe("the key of a plain value", () => {
  /** The address that `member`, a container in what a read gave, carries. */
  const addressIn = (store: Store, read: object, member: object): Ref => {
    const below = new Map<object, Ref>();
    const handed = store.handed.get(read);
    if (handed !== undefined) store.addressesBelow(read, handed, below);
    return (store.addresses.get(member) ?? below.get(member))!;
  };
  const addressOfFirst = (store: Store, read: object[]): Ref =>
    addressIn(store, read, read[0]);

  const SECRET = "the secret of the space";
  const repo = (id: number, name: string) => ({
    id,
    name,
    position: { lat: id, lng: 0 },
  });
  const arrayByKey = (...fields: string[]) => ({
    type: "array",
    ...(fields.length === 0 ? {} : { keyFields: fields }),
    items: { type: "object" },
  });
  const start = () => {
    const store = new Store({ secret: SECRET });
    store.create("d", "argument", {
      saved: [repo(7, "s"), repo(8, "t")],
      numbers: [7, 8],
    });
    return store;
  };
  // What the documents state, formed with the helpers of the data model
  // and not with the store: the hash of the record of the secret and the
  // value (ruling Z57), and the record of the element part and the
  // occurrence count of a key as the JSON codec writes it.
  const salted = (value: FabricValue) => hashOf({ salt: SECRET, value });
  const keyOfFields = (
    fields: string[],
    values: FabricValue[],
    occurrence = 0,
  ) =>
    jsonFromFabricValue({
      element: { fields, hash: salted(values) },
      occurrence,
    });
  const keyOfWhole = (value: FabricValue, occurrence = 0) =>
    jsonFromFabricValue({ element: salted(value), occurrence });
  const SEVEN = keySegment(keyOfFields(["id"], [7]));
  const pair = (owner: string | number, name: string, stars = 0) => ({
    owner,
    name,
    stars,
  });

  it("holds the names of the fields in the order of their names and one salted hash of the array of their values", () => {
    const store = new Store({ secret: SECRET });
    const held = [pair("cf", "labs"), pair("cf", "specs"), pair("x", "labs")];
    store.create("d", "argument", { pairs: held });
    const at = new Ref("d", ["pairs"]);

    const keys = store.keysOf(held, at, undefined, ["owner", "name"]);

    expect(keys).toEqual([
      keyOfFields(["name", "owner"], ["labs", "cf"]),
      keyOfFields(["name", "owner"], ["specs", "cf"]),
      keyOfFields(["name", "owner"], ["labs", "x"]),
    ]);
    // The written form is that of the JSON codec of fabric values, and
    // the key holds the names and no value of a field.
    expect(keys[0].startsWith("fvj1:")).toBe(true);
    expect(fabricFromJsonValue(keys[0])).toEqual({
      element: { fields: ["name", "owner"], hash: salted(["labs", "cf"]) },
      occurrence: 0,
    });
    expect(keys[0]).not.toContain("labs");
    expect(keys[0]).not.toContain("cf");
    // The order in which the fields are given changes no key.
    expect(store.keysOf(held, at, undefined, ["name", "owner"])).toEqual(keys);
    // The names are ordered by code point: a name that starts above the
    // surrogates stands before one outside the basic plane.
    expect(
      store.keysOf([{ "\u{1F600}": 1, "Ａ": 2 }], at, [
        { "\u{1F600}": 1, "Ａ": 2 },
      ], ["\u{1F600}", "Ａ"]),
    ).toEqual([keyOfFields(["Ａ", "\u{1F600}"], [2, 1])]);
  });

  it("is salted with the secret of the space", () => {
    const held = [repo(7, "s"), 7];
    const keysIn = (store: Store) =>
      store.keysOf(held, new Ref("d", ["saved"]), held, ["id"]);

    const keys = keysIn(new Store({ secret: SECRET }));

    expect(keysIn(new Store({ secret: SECRET }))).toEqual(keys);
    const other = keysIn(new Store({ secret: "another secret" }));
    expect(other[0]).not.toBe(keys[0]);
    expect(other[1]).not.toBe(keys[1]);
    // A store that is given no secret mints one of its own.
    expect(keysIn(new Store())).not.toEqual(keysIn(new Store()));
  });

  it("gives the number 7 and the string `7` different keys", () => {
    const store = new Store({ secret: SECRET });
    const held = [pair(7, "x"), pair("7", "x"), 7, "7"];
    store.create("d", "argument", { pairs: held });
    const at = new Ref("d", ["pairs"]);

    const keys = store.keysOf(held, at, undefined, ["owner", "name"]);

    expect(keys).toEqual([
      keyOfFields(["name", "owner"], ["x", 7]),
      keyOfFields(["name", "owner"], ["x", "7"]),
      keyOfWhole(7),
      keyOfWhole("7"),
    ]);
    expect(new Set(keys).size).toBe(4);
    // Each key names its own element.
    expect(keys.map((key) => store.read(at.key(keySegment(key))))).toEqual(
      held,
    );
  });

  it("gives two elements that share the value of one field keys with the names in common and nothing else", () => {
    const store = new Store({ secret: SECRET });
    const held = [pair("cf", "labs"), pair("cf", "specs")];

    const [first, second] = store.keysOf(
      held,
      new Ref("d", ["pairs"]),
      held,
      ["owner", "name"],
    ).map((key) =>
      fabricFromJsonValue(key) as {
        element: Record<string, FabricValue>;
        occurrence: number;
      }
    );

    expect(first.element.fields).toEqual(second.element.fields);
    expect(first.occurrence).toBe(second.occurrence);
    expect(jsonFromFabricValue(first.element.hash)).not.toBe(
      jsonFromFabricValue(second.element.hash),
    );
    expect(Object.keys(first).sort()).toEqual(["element", "occurrence"]);
    expect(Object.keys(first.element).sort()).toEqual(["fields", "hash"]);
  });

  it("names a field whose name holds `:`, `,`, `\\`, `#` or a quote as it is, and resolves by it", () => {
    const store = new Store({ secret: SECRET });
    const names = ["a:b,c", "back\\slash", 'quo"te', "x#1", "count", "cell"];
    const element = Object.fromEntries(
      names.map((name, index) => [name, index]),
    );
    const held = [element, { ...element, "a:b,c": "other" }];
    store.create("d", "argument", { odd: held });
    const at = new Ref("d", ["odd"]);

    const keys = store.keysOf(held, at, undefined, names);

    const ordered = ["a:b,c", "back\\slash", "cell", "count", 'quo"te', "x#1"];
    expect(keys[0]).toBe(
      keyOfFields(ordered, ordered.map((name) => element[name])),
    );
    expect(fieldsOfKey(keys[0])).toEqual(ordered);
    expect(new Set(keys).size).toBe(2);
    expect(keys.map((key) => store.read(at.key(keySegment(key), "a:b,c"))))
      .toEqual([0, "other"]);
    // One such name alone.
    const [single] = store.keysOf(held, at, undefined, ["a:b,c"]);
    expect(single).toBe(keyOfFields(["a:b,c"], [0]));
    expect(store.read(at.key(keySegment(single), "cell"))).toBe(5);
  });

  it("forms the keys of a stored array once for the reads by key that follow no write", () => {
    const store = start();
    const before = store.keyings;

    expect(store.read(new Ref("d", ["saved", SEVEN, "name"]))).toBe("s");
    expect(store.read(new Ref("d", ["saved", SEVEN, "id"]))).toBe(7);
    expect(store.read(new Ref("d", ["saved", SEVEN, "name"]))).toBe("s");

    expect(store.keyings - before).toBe(1);

    // The keys that are kept are those of what is stored: after a write
    // that moves the elements, a key names the element where it stands.
    store.write(new Ref("d", ["saved"]), [repo(8, "t"), repo(7, "moved")]);
    expect(store.read(new Ref("d", ["saved", SEVEN, "name"]))).toBe("moved");
  });

  it("names the field, so the key of a field that holds 7 is not the key of a whole value 7", () => {
    const store = start();

    expect(
      store.keysOf(
        [repo(7, "s"), repo(8, "t")],
        new Ref("d", ["saved"]),
        undefined,
        ["id"],
      ),
    ).toEqual([keyOfFields(["id"], [7]), keyOfFields(["id"], [8])]);
    expect(store.keysOf([7, 8], new Ref("d", ["numbers"]), [7, 8])).toEqual([
      keyOfWhole(7),
      keyOfWhole(8),
    ]);
    // The key of the whole value 7 names an element of `numbers` and
    // none of `saved`, and the key of the field the reverse. So does the
    // key of the whole value `[7]`, whose hash is the one the key of the
    // field holds.
    expect(
      store.read(new Ref("d", ["numbers", keySegment(keyOfWhole(7))])),
    ).toBe(7);
    for (const whole of [keyOfWhole(7), keyOfWhole([7])]) {
      expect(
        store.locate(new Ref("d", ["saved", keySegment(whole)]), true).missing,
      ).toBe(true);
    }
    expect(store.locate(new Ref("d", ["numbers", SEVEN]), true).missing)
      .toBe(true);
  });

  it("is resolved from the key alone, for the element and for a member below it", () => {
    const store = start();

    expect(store.read(new Ref("d", ["saved", SEVEN, "name"]))).toBe("s");
    // A reference to a member below the element, as the one
    // `center.set(repo.position)` stores.
    expect(store.read(new Ref("d", ["saved", SEVEN, "position", "lat"])))
      .toBe(7);
    // A write to another member re-keys nothing, and the reference
    // names the element after it.
    store.write(new Ref("d", ["saved", SEVEN, "name"]), "edited");
    expect(store.rekeys).toEqual([]);
    expect(store.read(new Ref("d", ["saved", SEVEN, "name"]))).toBe("edited");
    // The element is found where it stands after a move.
    store.write(new Ref("d", ["saved"]), [repo(8, "t"), repo(7, "moved")]);
    expect(store.read(new Ref("d", ["saved", SEVEN, "name"]))).toBe("moved");
  });

  it("resolves a stored reference to the same element for a reader that declares no key and for one that declares another key", () => {
    const store = start();
    store.create("holder", "created cell", {
      picked: { $link: { doc: "d", path: ["saved", SEVEN] } },
      center: { $link: { doc: "d", path: ["saved", SEVEN, "position"] } },
    });
    const reader = (fields: string[]) =>
      new Ref("holder", [], {
        properties: {
          picked: { type: "object" },
          center: { type: "object" },
          list: arrayByKey(...fields),
        },
      });

    for (const fields of [[], ["id"], ["name"], ["id", "name"]]) {
      expect(store.read(reader(fields).key("picked", "name"))).toBe("s");
      expect(store.read(reader(fields).key("center", "lat"))).toBe(7);
    }
    // The same through the array, read under each declaration.
    for (const fields of [[], ["id"], ["name"], ["id", "name"]]) {
      const saved = new Ref("d", ["saved"], arrayByKey(...fields));
      expect(
        store.read(new Ref(saved.doc, [...saved.path, SEVEN], saved.schema)),
      ).toMatchObject({ id: 7, name: "s" });
    }
  });

  it("forms the keys of an array that is read whole with the key fields that the schema of the array declares beside `items`", () => {
    const store = start();
    const first = (schema: Schema) =>
      addressOfFirst(
        store,
        store.read(new Ref("d", ["saved"], schema)) as object[],
      );

    expect(first(arrayByKey("id")).path).toEqual(["saved", SEVEN]);
    expect(first(arrayByKey("name")).path).toEqual([
      "saved",
      keySegment(keyOfFields(["name"], ["s"])),
    ]);
    expect(first(arrayByKey()).path).toEqual([
      "saved",
      keySegment(keyOfWhole(repo(7, "s"))),
    ]);
    expect(first(arrayByKey("name", "id")).path).toEqual([
      "saved",
      keySegment(keyOfFields(["id", "name"], [7, "s"])),
    ]);
    // The keyword in the schema of the items declares no key.
    expect(
      first({ type: "array", items: { type: "object", keyFields: ["id"] } })
        .path,
    ).toEqual(["saved", keySegment(keyOfWhole(repo(7, "s")))]);
    // Each of these names the one element, whatever the array was read
    // under before.
    for (const fields of [["id"], ["name"], [], ["id", "name"]]) {
      expect(store.read(first(arrayByKey(...fields)).key("name"))).toBe("s");
    }
  });

  // Ruling Z52: where the reader gets the key fields of an array of
  // plain values in place from, when its own type declares none.
  it("forms the keys of a reader whose schema declares no key with the key fields of the array schema that a link on the way holds", () => {
    const store = start();
    const link = (schema?: Schema) => ({
      $link: {
        doc: "d",
        path: ["saved"],
        ...(schema === undefined ? {} : { schema }),
      },
    });
    store.create("holder", "argument", {
      keyed: link(arrayByKey("id")),
      plain: link(arrayByKey()),
      bare: link(),
      // A link to a link: the one nearer the array declares no key.
      outer: {
        $link: {
          doc: "holder",
          path: ["plain"],
          schema: arrayByKey("id"),
        },
      },
    });
    const first = (name: string, schema: Schema) =>
      addressOfFirst(
        store,
        store.read(new Ref("holder", [name], schema)) as object[],
      ).path;

    expect(first("keyed", arrayByKey())).toEqual(["saved", SEVEN]);
    expect(first("outer", arrayByKey())).toEqual(["saved", SEVEN]);
    // The reader's own declaration comes first.
    expect(first("keyed", arrayByKey("name"))).toEqual([
      "saved",
      keySegment(keyOfFields(["name"], ["s"])),
    ]);
    // No schema with the keyword on the way: the key is of the whole
    // value.
    for (const name of ["plain", "bare"]) {
      expect(first(name, arrayByKey())).toEqual([
        "saved",
        keySegment(keyOfWhole(repo(7, "s"))),
      ]);
    }
    // The array below a record that is read through the link.
    store.create("above", "argument", {
      $link: {
        doc: "d",
        path: [],
        schema: { properties: { saved: arrayByKey("id") } },
      },
    });
    const read = store.read(
      new Ref("above", [], { properties: { saved: arrayByKey() } }),
    ) as { saved: object[] };
    expect(addressIn(store, read, read.saved[0]).path).toEqual([
      "saved",
      SEVEN,
    ]);
  });

  it("re-keys the element on a write to a key field and on no other write, and counts equal values of the fields", () => {
    const store = new Store({ secret: SECRET });
    const held = [pair("cf", "labs"), pair("cf", "specs"), pair("x", "labs")];
    store.create("d", "argument", { pairs: held });
    const at = new Ref("d", ["pairs"]);
    const keys = store.keysOf(held, at, undefined, ["owner", "name"]);

    // Each key is resolved from the key alone.
    expect(
      keys.map((key) => store.read(at.key(keySegment(key), "owner"))),
    ).toEqual(["cf", "cf", "x"]);
    store.write(at.key(keySegment(keys[1]), "stars"), 5);
    expect(store.rekeys).toEqual([]);
    store.write(at.key(keySegment(keys[1]), "owner"), "y");
    expect(store.rekeys).toEqual([{
      doc: "d",
      array: ["pairs"],
      from: keys[1],
      to: keyOfFields(["name", "owner"], ["specs", "y"]),
    }]);
    // Two elements with the same values of every field have two keys,
    // and an element that lacks one of the fields is keyed whole.
    const more = [pair("cf", "labs"), pair("cf", "labs", 1), { owner: "cf" }];
    expect(store.keysOf(more, at, more, ["owner", "name"])).toEqual([
      keyOfFields(["name", "owner"], ["labs", "cf"]),
      keyOfFields(["name", "owner"], ["labs", "cf"], 1),
      keyOfWhole({ owner: "cf" }),
    ]);
  });

  it("re-keys the element on a write to the field that the key names", () => {
    const store = start();

    store.write(new Ref("d", ["saved", SEVEN, "id"]), 9);

    expect(store.rekeys).toEqual([{
      doc: "d",
      array: ["saved"],
      from: keyOfFields(["id"], [7]),
      to: keyOfFields(["id"], [9]),
    }]);
  });

  it("is the salted hash of the value as the fabric value it is, and not of its JSON text", () => {
    const store = new Store({ secret: SECRET });
    const sparse: unknown[] = [];
    sparse[1] = 2;
    const held = [{ a: 1, b: undefined }, { a: 1 }, sparse, [null, 2]];

    const keys = store.keysOf(held, new Ref("d", ["held"]), held);

    // A member that is `undefined` and a member that is absent are two
    // values, and so are a hole of an array and a `null`.
    expect(keys[0]).toBe(keyOfWhole({ a: 1, b: undefined }));
    expect(keys[1]).toBe(keyOfWhole({ a: 1 }));
    expect(keys[2]).toBe(keyOfWhole(sparse as FabricValue));
    expect(keys[3]).toBe(keyOfWhole([null, 2]));
    expect(new Set(keys).size).toBe(4);
  });

  it("is the record of the source key and the member key for a member of a `flatMap` segment", () => {
    const [source, member] = [keyOfFields(["id"], [7]), keyOfWhole("a", 1)];

    expect(fabricFromJsonValue(memberKey(source, member))).toEqual({
      source: fabricFromJsonValue(source),
      member: fabricFromJsonValue(member),
    });
  });

  it("is one text for one record, whatever the order its members were written in", () => {
    // The store compares two keys as their texts, so the codec has to
    // write the members of a record in one order.
    const hash = salted([7]);
    expect(
      jsonFromFabricValue({ occurrence: 0, element: { hash, fields: [] } }),
    )
      .toBe(
        jsonFromFabricValue({ element: { fields: [], hash }, occurrence: 0 }),
      );
    expect(
      jsonFromFabricValue({
        member: { occurrence: 1, element: hash },
        source: { occurrence: 0, element: { path: [], document: "d" } },
      }),
    ).toBe(
      jsonFromFabricValue({
        source: { element: { document: "d", path: [] }, occurrence: 0 },
        member: { element: hash, occurrence: 1 },
      }),
    );
    // A key that the store forms is the text of the record that is
    // read back from it.
    const store = new Store({ secret: SECRET });
    for (
      const key of store.keysOf([{ id: 7 }, 7], new Ref("d", []), [
        { id: 7 },
        7,
      ], ["id"])
    ) {
      expect(jsonFromFabricValue(fabricFromJsonValue(key))).toBe(key);
    }
  });

  it("stands in a stored path as the text of its record, which a reader tells from a property name by decoding it", () => {
    const store = start();
    const key = keyOfFields(["id"], [7]);

    // The segment is the text that the codec writes for the key, with
    // nothing before it.
    expect(keySegment(key)).toBe(key);
    expect(fabricFromJsonValue(keySegment(key))).toEqual({
      element: { fields: ["id"], hash: salted([7]) },
      occurrence: 0,
    });
    expect(store.read(new Ref("d", ["saved", key, "name"]))).toBe("s");
    // A property whose name is no text of a key is a property, also
    // where it begins as the earlier form of a key segment did, or is
    // the text of another fabric value.
    const other = jsonFromFabricValue({ element: 1 });
    store.create("names", "argument", {
      "$key:x": 1,
      [other]: 2,
      "fvj1:": 3,
    });
    expect(store.read(new Ref("names", ["$key:x"]))).toBe(1);
    expect(store.read(new Ref("names", [other]))).toBe(2);
    expect(store.read(new Ref("names", ["fvj1:"]))).toBe(3);
  });

  it("holds the space in the element part of a position that holds a link", () => {
    const store = new Store({ secret: SECRET, space: "did:key:space" });
    store.create("d", "argument", { saved: [repo(7, "s")] });
    const links = [
      { $link: { doc: "d", path: ["saved", "0"] } },
      { $link: { doc: "d", path: ["saved", SEVEN, "position"] } },
    ];
    store.create("refs", "created cell", links);

    const keys = store.keysOf(links, new Ref("refs", []));

    expect(keys[0]).toBe(cellKey("d", ["saved", "0"], 0, "did:key:space"));
    // A link to an element by key is keyed by the record of that
    // reference: the collection, the key, and the path below the element.
    expect(fabricFromJsonValue(keys[1])).toEqual({
      element: {
        collection: { space: "did:key:space", document: "d", path: ["saved"] },
        key: fabricFromJsonValue(keyOfFields(["id"], [7])),
        path: ["position"],
      },
      occurrence: 0,
    });
  });

  it("keys a position that holds a link by its cell, with or without a declared field", () => {
    const store = start();
    const links = [{ $link: { doc: "d", path: ["saved", "0"] } }];
    store.create("refs", "created cell", links);

    expect(store.keysOf(links, new Ref("refs", []), undefined, ["id"])).toEqual(
      store.keysOf(links, new Ref("refs", [])),
    );
    expect(store.keysOf(links, new Ref("refs", []))).toEqual([
      cellKey("d", ["saved", "0"]),
    ]);
  });
});

// Ruling Z43: the store records the position of each link to a stream,
// in whichever document it is stored.
describe("the store's record of the links to streams", () => {
  const stream = (binding: number, ...keys: string[]) => ({
    $stream: { binding, keys },
  });
  const recorded = (store: Store, doc: string) =>
    (store.streams.get(doc) ?? []).map(({ path, stream }) => [
      path.join("/"),
      stream.binding,
    ]).sort();

  it("has the position of each link of a value that is stored, in any document", () => {
    const store = new Store();

    store.create("cell", "state cell", { kept: stream(0), rows: [] });
    store.write(new Ref("cell", ["rows"]), [
      { pick: stream(1, "a") },
      { pick: stream(1, "b") },
    ]);

    expect(recorded(store, "cell")).toEqual([
      ["kept", 0],
      ["rows/0/pick", 1],
      ["rows/1/pick", 1],
    ]);
    expect(store.streams.get("cell")).toContainEqual({
      path: ["rows", "1", "pick"],
      stream: { binding: 1, keys: ["b"] },
    });
  });

  it("drops a position that another value is stored at, or that an array holds no longer", () => {
    const store = new Store();
    store.create("cell", "state cell", {
      kept: stream(0),
      rows: [{ pick: stream(1, "a") }, { pick: stream(1, "b") }],
    });

    store.write(new Ref("cell", ["kept"]), "text");
    store.write(new Ref("cell", ["rows", "length"]), 1);

    expect(recorded(store, "cell")).toEqual([["rows/0/pick", 1]]);

    store.write(new Ref("cell", []), {});

    expect(store.streams.has("cell")).toBe(false);
  });

  it("follows a document that is given another identifier", () => {
    const store = new Store();
    store.create("old", "state cell", { kept: stream(0) });

    store.move("old", "new");

    expect(store.streams.has("old")).toBe(false);
    expect(recorded(store, "new")).toEqual([["kept", 0]]);
  });
});

// Rulings Z35 and Z36 on `fixtures/as-instance.tsx`: a pattern called
// through the factory modifier `asInstance()` in an element body is an
// instance of its own. Today's runtime has no `asInstance()`, so these
// tests are of the executor alone.
describe("a pattern called through `asInstance()` in an element body", () => {
  const link = (name: string) => ({
    $link: { doc: ARGUMENT, path: ["pool", name] },
  });
  const references = () => ({
    pool: { a: { title: "a" }, b: { title: "b" } },
    items: [link("a"), link("b")],
    tags: ["x", "y"],
  });
  const inPlace = () => ({
    items: [{ title: "a" }, { title: "b" }],
    tags: ["x", "y"],
  });
  const start = async (argument: unknown) => {
    const [{ patterns }] = JSON.parse(
      await Deno.readTextFile(
        new URL(
          "../../compare/fixtures/as-instance.emit.json",
          import.meta.url,
        ),
      ),
    ) as { patterns: Artifact[] }[];
    const artifacts = (id: string) =>
      patterns.find((pattern) => pattern.plan.patterns?.[0] === id);
    const main = patterns.find((pattern) => pattern.name === "default")!;
    return new Instance(main, argument, { artifacts });
  };
  type Row = { title: string; noted: string };
  type Result = {
    rows: Row[];
    words: { tag: string; noted: string }[];
    kept: Row[];
    plain: Row[];
  };
  const result = (instance: Instance) => instance.result() as Result;
  type Link = { $link: { doc: string; path: string[] } };
  const stored = (instance: Instance) =>
    instance.store.docs.get("result")?.value as Record<
      "rows" | "words" | "kept",
      Link[]
    >;
  const valueOf = (instance: Instance, id: string) =>
    instance.store.docs.get(id)?.value;
  /** Sends an event through the stream a document holds at `note`. */
  const note = (instance: Instance, row: Link, text: string) => {
    new Handle(
      instance,
      new Ref(row.$link.doc, ["note"]),
      undefined,
      undefined,
      [],
    ).send({ text });
    return instance.dispatch();
  };
  const [ROWS, WORDS, KEPT, LEAD] = [0, 1, 2, 3];

  it("is a child of the plan with the mark, and no code of the callee is compiled in for it", async () => {
    const instance = await start(references());

    // Each callee is named by the identity of its own source, one for
    // `Row` at its three sites and another for `Word`.
    const [row, word] = [
      instance.plan.children?.[0].callee.compiled,
      instance.plan.children?.[1].callee.compiled,
    ];
    expect(row).toMatch(/^sha256:/);
    expect(word).toMatch(/^sha256:/);
    expect(row).not.toBe(word);
    expect(
      instance.plan.children?.map((child) => [
        child.asInstance,
        child.callee.compiled,
        child.within,
      ]),
    ).toEqual([
      [true, row, [{ element: 0 }]],
      [true, word, [{ element: 1 }]],
      [true, row, [{ element: 3 }]],
      [true, row, []],
    ]);
    // The one binding of the plan is that of `plain`, which is compiled
    // in under a `site` step.
    expect(instance.plan.bindings.map((binding) => binding.within)).toEqual([
      [{ element: 4 }, { site: "map" }],
    ]);
  });

  it("has an argument and a result document of its own, named by the site and the element key, over references", async () => {
    const instance = await start(references());

    expect(result(instance).rows).toMatchObject([
      { title: "a", noted: "" },
      { title: "b", noted: "" },
    ]);
    // One instance per key of each of the three sites.
    expect(instance.childInstances().map(({ child, keys }) => [child, keys]))
      .toEqual([
        [ROWS, [cellKey(ARGUMENT, ["pool", "a"])]],
        [ROWS, [cellKey(ARGUMENT, ["pool", "b"])]],
        [WORDS, [whole(instance, "x")]],
        [WORDS, [whole(instance, "y")]],
        [KEPT, [cellKey(ARGUMENT, ["pool", "a"])]],
        [KEPT, [cellKey(ARGUMENT, ["pool", "b"])]],
        [LEAD, []],
      ]);
    expect(instance.documents()).toMatchObject({ argument: 8, result: 8 });
    // The row of the enclosing result is a link to the result document
    // of the child, and the argument of the child holds the reference to
    // the element's cell.
    const [first] = stored(instance).rows;
    expect(first.$link.path).toEqual([]);
    expect(valueOf(instance, argumentDocument(first.$link.doc))).toMatchObject({
      item: link("a"),
    });

    // A change of the element's value changes no key and writes no
    // argument: the instance reads through the reference.
    const log: { doc: string }[] = instance.store.log = [];
    instance.writeArgument(["pool", "a", "title"], "renamed");
    expect(result(instance).rows[0].title).toBe("renamed");
    expect(
      log.some((write) => write.doc === argumentDocument(first.$link.doc)),
    ).toBe(false);
    expect(instance.childInstances().length).toBe(7);
  });

  it("holds the value of the element in its argument, over plain values in place", async () => {
    const instance = await start(inPlace());

    const [first] = stored(instance).rows;
    const [word] = stored(instance).words;
    // The value, and no reference by key.
    expect(valueOf(instance, argumentDocument(first.$link.doc))).toEqual({
      item: { title: "a" },
    });
    expect(valueOf(instance, argumentDocument(word.$link.doc))).toEqual({
      tag: "x",
    });
    expect(result(instance).words).toMatchObject([
      { tag: "x", noted: "" },
      { tag: "y", noted: "" },
    ]);
  });

  it("holds the value in its argument over the result of a `filter` of plain values, and the reference over one of references", async () => {
    const plain = await start(inPlace());
    expect(valueOf(plain, argumentDocument(stored(plain).kept[1].$link.doc)))
      .toEqual({
        item: { title: "b" },
      });
    expect(
      plain.childInstances().filter(({ child }) => child === KEPT).map((
        { keys },
      ) => keys),
    ).toEqual([[whole(plain, { title: "a" })], [whole(plain, { title: "b" })]]);

    const linked = await start(references());
    expect(valueOf(linked, argumentDocument(stored(linked).kept[1].$link.doc)))
      .toMatchObject({ item: link("b") });
  });

  it("is not torn down when its key leaves, and is the same instance when the key returns, over references", async () => {
    const instance = await start(references());
    const second = stored(instance).rows[1];
    expect(note(instance, second, "mine").map(({ committed }) => committed))
      .toEqual([true]);
    expect(result(instance).rows[1].noted).toBe("mine");
    const documents = instance.documents();

    // The element leaves: nothing of the instance is written or removed.
    const log: { doc: string }[] = instance.store.log = [];
    instance.writeArgument(["items"], [link("a")]);

    expect(result(instance).rows.length).toBe(1);
    expect(instance.documents()).toEqual(documents);
    expect(
      log.some((write) =>
        instance.childInstances().find(({ instance: made }) =>
          made.id === second.$link.doc
        )?.instance.documentIds().includes(write.doc)
      ),
    ).toBe(false);
    expect(instance.childInstances().length).toBe(7);
    expect(valueOf(instance, argumentDocument(second.$link.doc))).toMatchObject(
      {
        item: link("b"),
      },
    );

    // The key returns, at another position: the row has the instance it
    // had, with its state.
    instance.writeArgument(["items"], [link("b"), link("a")]);

    expect(stored(instance).rows[0]).toEqual(second);
    expect(result(instance).rows).toMatchObject([
      { title: "b", noted: "mine" },
      { title: "a", noted: "" },
    ]);
    expect(instance.documents()).toEqual(documents);
  });

  it("is not torn down when its value leaves, and is the same instance when the value returns, over plain values in place", async () => {
    const instance = await start(inPlace());
    const second = stored(instance).words[1];
    note(instance, second, "mine");
    const children = instance.childInstances().length;

    instance.writeArgument(["tags"], ["x"]);

    expect(instance.childInstances().length).toBe(children);
    // The instance reads the value it was last given.
    expect(instance.store.read(new Ref(second.$link.doc, []))).toMatchObject({
      tag: "y",
      noted: "mine",
    });

    instance.writeArgument(["tags"], ["y", "x"]);

    expect(result(instance).words).toMatchObject([
      { tag: "y", noted: "mine" },
      { tag: "x", noted: "" },
    ]);
    expect(instance.childInstances().length).toBe(children);
  });

  it("is kept while its upstream key is out of the result of a `filter`, and is the same instance when it enters again", async () => {
    const instance = await start(references());
    const second = stored(instance).kept[1];
    note(instance, second, "kept");
    const children = instance.childInstances().length;

    // The `filter` drops the element.
    instance.writeArgument(["pool", "b", "title"], "skip");
    expect(result(instance).kept.map((row) => row.title)).toEqual(["a"]);
    expect(instance.childInstances().length).toBe(children);

    instance.writeArgument(["pool", "b", "title"], "back");

    expect(stored(instance).kept[1]).toEqual(second);
    expect(result(instance).kept[1]).toMatchObject({
      title: "back",
      noted: "kept",
    });
  });

  it("handles an event for one of its streams while its key is away, over references and over plain values in place", async () => {
    const linked = await start(references());
    const row = stored(linked).rows[1];
    linked.writeArgument(["items"], [link("a")]);

    expect(note(linked, row, "late")).toEqual([{
      binding: 0,
      committed: true,
    }]);
    expect(linked.store.read(new Ref(row.$link.doc, ["noted"]))).toBe("late");

    const plain = await start(inPlace());
    const word = stored(plain).words[1];
    plain.writeArgument(["tags"], ["x"]);

    expect(note(plain, word, "late")).toEqual([{
      binding: 0,
      committed: true,
    }]);
    expect(plain.store.read(new Ref(word.$link.doc, ["noted"]))).toBe("late");
    // The key returns, and the row shows what the event wrote.
    plain.writeArgument(["tags"], ["x", "y"]);
    expect(result(plain).words[1]).toMatchObject({ tag: "y", noted: "late" });
  });

  it("refuses an event for a stream of an element body without the modifier after the key left", async () => {
    const instance = await start(references());
    const plain = (instance.store.docs.get("result")?.value as {
      plain: { note: { $stream: { binding: number; keys: string[] } } }[];
    }).plain;
    const { binding, keys } = plain[1].note.$stream;
    const send = (text: string) => {
      new Handle(
        instance,
        new StreamRef(binding, keys),
        undefined,
        undefined,
        [],
      ).send({ text });
      return instance.dispatch();
    };
    // While the key is in the collection the event is handled.
    expect(send("here")).toEqual([{ binding, committed: true }]);
    expect(result(instance).plain[1].noted).toBe("here");
    const cells = instance.stateCells().length;

    instance.writeArgument(["items"], [link("a")]);

    expect(send("late")).toEqual([{
      binding,
      committed: false,
      error: "no element holds the stream",
    }]);
    expect(instance.stateCells().length).toBe(cells);
    // The key returns with the state it had, and not what the refused
    // event carried (ruling Z18).
    instance.writeArgument(["items"], [link("a"), link("b")]);
    expect(result(instance).plain[1].noted).toBe("here");
  });

  it("keeps the instance with the element when a write through a reference by key re-keys it, over plain values in place", async () => {
    const instance = await start(inPlace());
    const first = stored(instance).rows[0];
    note(instance, first, "mine");
    const children = instance.childInstances().length;

    // A write through the reference by key of the element, as a handler
    // of the row or a member bound both ways makes.
    instance.store.write(
      new Ref(ARGUMENT, [
        "items",
        keySegment(whole(instance, { "title": "a" })),
        "title",
      ]),
      "edited",
    );
    instance.settle();

    // The row keeps its instance, whose argument is written again with
    // the new value (PL §3.15, assumed there under question 123).
    expect(stored(instance).rows[0]).toEqual(first);
    expect(result(instance).rows[0]).toMatchObject({
      title: "edited",
      noted: "mine",
    });
    expect(valueOf(instance, argumentDocument(first.$link.doc))).toEqual({
      item: { title: "edited" },
    });
    expect(instance.childInstances().length).toBe(children);
  });

  // Ruling Z50, over plain values in place with no declared key.
  it("drops an instance that a re-keyed instance replaces from the element table and keeps its documents, over plain values in place", async () => {
    const instance = await start(inPlace());
    const [first, second] = stored(instance).words;
    note(instance, second, "old");
    // The key of `y` leaves, and its instance stays (ruling Z35).
    instance.writeArgument(["tags"], ["x"]);
    note(instance, first, "moved");
    const words = () =>
      instance.childInstances().filter(({ child }) => child === WORDS);
    expect(words().map(({ keys }) => keys)).toEqual([
      [whole(instance, "x")],
      [whole(instance, "y")],
    ]);
    const documents = instance.store.docs.size;

    // A write through the reference by key re-keys `x` to the key that
    // the instance of `y` is named by.
    instance.store.write(
      new Ref(ARGUMENT, ["tags", keySegment(whole(instance, "x"))]),
      "y",
    );
    instance.settle();

    // The row has the instance that moved, and the element table names
    // that one alone under the key.
    expect(stored(instance).words).toEqual([first]);
    expect(result(instance).words).toMatchObject([
      { tag: "y", noted: "moved" },
    ]);
    expect(words().map(({ keys }) => keys)).toEqual([[whole(instance, "y")]]);
    expect(words()[0].instance.id).toBe(first.$link.doc);
    // The documents of the instance that was replaced stay, and a link
    // to it that is stored elsewhere reads it.
    expect(instance.store.docs.size).toBe(documents);
    expect(valueOf(instance, argumentDocument(second.$link.doc))).toEqual({
      tag: "y",
    });
    expect(instance.store.read(new Ref(second.$link.doc, []))).toMatchObject({
      tag: "y",
      noted: "old",
    });
  });

  it("is an instance with no element key outside an element body, whose argument holds the reference", async () => {
    const instance = await start({ ...references(), lead: { title: "l" } });
    const lead = (instance.store.docs.get("result")?.value as { lead: Link })
      .lead;

    expect(lead.$link.doc).toBe(
      instance.childInstances().find(({ child }) => child === LEAD)?.instance
        .id,
    );
    expect(valueOf(instance, argumentDocument(lead.$link.doc))).toMatchObject({
      item: { $link: { doc: ARGUMENT, path: ["lead"] } },
    });
    expect(note(instance, lead, "led")).toEqual([{
      binding: 0,
      committed: true,
    }]);
    instance.writeArgument(["lead", "title"], "m");
    expect((instance.result() as unknown as { lead: Row }).lead).toMatchObject({
      title: "m",
      noted: "led",
    });
  });

  it("makes another instance for a plain value that is written anew with another value", async () => {
    const instance = await start(inPlace());
    const first = stored(instance).rows[0];
    note(instance, first, "mine");
    const children = instance.childInstances().length;

    // No write through a reference by key: the array is written whole.
    instance.writeArgument(["items"], [{ title: "other" }, { title: "b" }]);

    expect(stored(instance).rows[0]).not.toEqual(first);
    expect(result(instance).rows[0]).toMatchObject({
      title: "other",
      noted: "",
    });
    // The instance of the old key stays as that of a key that left.
    expect(instance.store.read(new Ref(first.$link.doc, []))).toMatchObject({
      title: "a",
      noted: "mine",
    });
    // One more for `rows` and one more for `kept`.
    expect(instance.childInstances().length).toBe(children + 2);
  });
});

// Rulings Z37 and Z49 on `fixtures/array-by-key.tsx`: the array type
// `ArrayByKey<T, "field">` declares the key of the plain values of an
// array. Today's runtime has no such type, so these tests are of the
// executor alone.
describe("a key field declared with `ArrayByKey`", () => {
  const repo = (id: number, name: string, stars: number) => ({
    id,
    name,
    stars,
    owner: { login: `${name}-owner` },
  });
  const argument = (saved: unknown[] = [repo(7, "s", 1), repo(8, "t", 2)]) => ({
    names: ["ab", "cde"],
    bonus: 0,
    minStars: 3,
    saved,
  });
  const start = async (given: unknown = argument()) => {
    const [{ patterns }] = JSON.parse(
      await Deno.readTextFile(
        new URL(
          "../../compare/fixtures/array-by-key.emit.json",
          import.meta.url,
        ),
      ),
    ) as { patterns: Artifact[] }[];
    const artifacts = (id: string) =>
      patterns.find((pattern) => pattern.plan.patterns?.[0] === id);
    const main = patterns.find((pattern) => pattern.name === "default")!;
    return new Instance(main, given, { artifacts });
  };
  type Row = { name: string; stars: number; noted: string };
  type Result = { rows: Row[]; starred: Row[]; kept: Row[] };
  const result = (instance: Instance) => instance.result() as Result;
  const [NOTE_ROW, NOTE_KEPT, PICK_KEPT, PICK_FOUND] = [0, 1, 2, 3];
  const [PICKED, OWNER, ROWS_CELL, KEPT_CELL, TALLIES_CELL] = [0, 1, 2, 3, 4];
  /** What a state cell of the pattern's body stores. */
  const cell = (instance: Instance, index: number) =>
    instance.store.docs.get(instance.stateCellDocument(index))?.value;
  /** The key of each state cell declared by one record of the plan. */
  const keysOf = (instance: Instance, cell: number) =>
    instance.stateCells().filter((held) => held.cell === cell).map((
      { keys },
    ) => keys[0]).sort();
  type Link = { $link: { doc: string; path: string[] } };
  const starred = (instance: Instance) =>
    (instance.store.docs.get("result")?.value as { starred: Link[] }).starred;
  const note = (instance: Instance, row: Link, text: string) => {
    new Handle(
      instance,
      new Ref(row.$link.doc, ["note"]),
      undefined,
      undefined,
      [],
    ).send({ text });
    return instance.dispatch();
  };

  it("is in the plan as `Collection.keyFields`, for a source that is an output or a slot", async () => {
    const instance = await start();

    expect(
      instance.plan.collections.map(({ construct, keyFields }) => [
        construct,
        keyFields,
      ]),
    ).toEqual([
      ["map", ["id"]],
      ["filter", ["id"]],
      ["map", undefined],
      ["map", ["id"]],
      ["filter", undefined],
      ["map", undefined],
      ["filter", ["id"]],
      ["map", undefined],
    ]);
  });

  it("keys a plain value by the value of the field, in an array generated from scratch and in one in place", async () => {
    const instance = await start();

    expect(keysOf(instance, ROWS_CELL)).toEqual(sorted([
      byFields(instance, { id: 1 }),
      byFields(instance, { id: 2 }),
    ]));
    expect(keysOf(instance, KEPT_CELL)).toEqual(sorted([
      byFields(instance, { id: 7 }),
      byFields(instance, { id: 8 }),
    ]));
  });

  it("keeps the state of a row when another field of its element changes between evaluations", async () => {
    const instance = await start();
    instance.send(NOTE_ROW, { text: "mine" }, [0]);
    expect(result(instance).rows).toMatchObject([
      { name: "ab", stars: 2, noted: "mine" },
      { name: "cde", stars: 3, noted: "" },
    ]);
    const cells = instance.stateCells().length;
    const documents = instance.documents()["state cell"];

    // The computation returns a new array: each element has the `id` it
    // had and another `stars`.
    instance.writeArgument(["bonus"], 5);

    expect(result(instance).rows).toMatchObject([
      { name: "ab", stars: 7, noted: "mine" },
      { name: "cde", stars: 8, noted: "" },
    ]);
    expect(keysOf(instance, ROWS_CELL)).toEqual(sorted([
      byFields(instance, { id: 1 }),
      byFields(instance, { id: 2 }),
    ]));
    expect(instance.stateCells().length).toBe(cells);
    expect(instance.documents()["state cell"]).toBe(documents);
  });

  it("keeps the instance of a row over the result of a `filter`, which has the upstream key", async () => {
    const instance = await start();
    // One element passes the `filter`.
    expect(instance.childInstances().map(({ keys }) => keys)).toEqual([
      [byFields(instance, { id: 2 })],
    ]);
    const [row] = starred(instance);
    note(instance, row, "kept");

    // A new array: both elements pass, and `cde` has another `stars`.
    instance.writeArgument(["bonus"], 1);

    expect(starred(instance)[1]).toEqual(row);
    expect(result(instance).starred).toMatchObject([
      { name: "ab", stars: 3, noted: "" },
      { name: "cde", stars: 4, noted: "kept" },
    ]);
    // The argument of the instance is written again with the new value.
    expect(
      instance.store.docs.get(argumentDocument(row.$link.doc))?.value,
    ).toEqual({ repo: repo(2, "cde", 4) });
    expect(instance.childInstances().map(({ keys }) => keys)).toEqual([
      [byFields(instance, { id: 2 })],
      [byFields(instance, { id: 1 })],
    ]);

    // Both leave the result of the `filter` and enter it again: the same
    // two instances.
    instance.writeArgument(["bonus"], -5);
    expect(result(instance).starred).toEqual([]);
    instance.writeArgument(["bonus"], 2);

    expect(starred(instance)[1]).toEqual(row);
    expect(result(instance).starred[1]).toMatchObject({
      name: "cde",
      stars: 5,
      noted: "kept",
    });
    expect(instance.childInstances().length).toBe(2);
  });

  it("evaluates nothing again where nothing changed, for a body and a fold over elements that have no place", async () => {
    // The elements of an array that a computation returned have no
    // place, and a reader depends on what the element of its key holds.
    const keyed = await start();
    const before = { ...keyed.counts };
    keyed.settle();
    expect(keyed.counts).toEqual(before);

    // The step of a `reduce` over the result of a `map` reads such an
    // element under the fold, which is checked outside the collection.
    const folded = new Instance(await artifactOf("reduce"), {
      items: [{ title: "a", amount: 3 }, { title: "b", amount: 4 }],
      amounts: [5, 6, 7],
      bonus: 1,
    });
    const settled = { ...folded.counts };
    folded.settle();
    folded.settle();
    expect(folded.counts).toEqual(settled);
  });

  it("makes an element with another value of the field another element", async () => {
    const instance = await start();
    instance.send(NOTE_ROW, { text: "mine" }, [1]);

    // The array has one element, with the `id` 1.
    instance.writeArgument(["names"], ["cde"]);

    expect(result(instance).rows).toMatchObject([
      { name: "cde", stars: 3, noted: "" },
    ]);
  });

  it("keeps the key of a plain value in place that is edited in another field, and re-keys nothing", async () => {
    const instance = await start();
    instance.send(NOTE_KEPT, { text: "mine" }, [0]);

    // A write through the reference by key of the element.
    instance.store.write(
      new Ref(ARGUMENT, [
        "saved",
        keySegment(byFields(instance, { id: 7 })),
        "name",
      ]),
      "edited",
    );
    expect(instance.store.rekeys).toEqual([]);
    instance.settle();

    expect(result(instance).kept).toMatchObject([
      { name: "edited", noted: "mine" },
      { name: "t", noted: "" },
    ]);
    // The reference still names the element.
    expect(
      instance.store.read(
        new Ref(ARGUMENT, [
          "saved",
          keySegment(byFields(instance, { id: 7 })),
          "name",
        ]),
      ),
    ).toBe("edited");

    // The array is written whole, in another order and with another
    // name: each element has the key of its `id`.
    instance.writeArgument(["saved"], [repo(8, "t", 2), repo(7, "again", 9)]);

    expect(result(instance).kept).toMatchObject([
      { name: "t", noted: "" },
      { name: "again", noted: "mine" },
    ]);
    expect(keysOf(instance, KEPT_CELL)).toEqual(sorted([
      byFields(instance, { id: 7 }),
      byFields(instance, { id: 8 }),
    ]));
  });

  it("gives two elements with one value of the field two keys, and keys an element that lacks the field by its value", async () => {
    const instance = await start(
      argument([repo(7, "s", 1), repo(7, "t", 2), { name: "n" }]),
    );

    expect(keysOf(instance, KEPT_CELL)).toEqual(sorted([
      byFields(instance, { id: 7 }),
      byFields(instance, { id: 7 }, 1),
      whole(instance, { "name": "n" }),
    ]));
  });

  // Ruling Z44, over a plain array generated from scratch with a
  // `filter` and a `map` after it.
  it("names the field in the key of a row over the result of a `filter`, where a whole value that is the same number names none", async () => {
    const instance = await start();

    // `tallies` is over the numbers 1 and 2, and `rows` over the
    // elements whose `id` are 1 and 2.
    expect(keysOf(instance, TALLIES_CELL)).toEqual(
      sorted([whole(instance, 1), whole(instance, 2)]),
    );
    expect(keysOf(instance, ROWS_CELL)).toEqual(sorted([
      byFields(instance, { id: 1 }),
      byFields(instance, { id: 2 }),
    ]));
    // The stream of `pick` in `found`, over the result of the `filter`,
    // has the upstream key.
    expect(
      instance.streams().filter(({ binding }) => binding === PICK_FOUND)
        .map(({ keys }) => keys),
    ).toEqual([[byFields(instance, { id: 2 })]]);
  });

  // Ruling Z44, over plain values in place.
  it("stores a reference by key to the element and to a member below it, which resolve from the key alone", async () => {
    const instance = await start();

    expect(instance.send(PICK_KEPT, {}, [1]).committed).toBe(true);

    const key = keySegment(byFields(instance, { id: 8 }));
    expect(cell(instance, PICKED)).toEqual({
      $link: { doc: ARGUMENT, path: ["saved", key] },
    });
    expect(cell(instance, OWNER)).toEqual({
      $link: { doc: ARGUMENT, path: ["saved", key, "owner"] },
    });
    // `pickedName` and `ownerLogin` read the cells under types that
    // declare no key.
    expect(instance.result()).toMatchObject({
      pickedName: "t",
      ownerLogin: "t-owner",
    });

    // The array is written whole, in another order and with other
    // values of the members that are no key field.
    instance.writeArgument(["saved"], [
      { ...repo(8, "t", 2), name: "again", owner: { login: "new-owner" } },
      repo(7, "s", 1),
    ]);

    expect(instance.result()).toMatchObject({
      pickedName: "again",
      ownerLogin: "new-owner",
    });
    // A reader whose type declares another key resolves the stored
    // references to the same element.
    const byName = { type: "array", keyFields: ["name"] };
    expect(
      instance.store.read(
        new Ref(instance.stateCellDocument(0), [], byName).key("name"),
      ),
    ).toBe("again");
    expect(
      instance.store.read(
        new Ref(instance.stateCellDocument(1), [], byName).key("login"),
      ),
    ).toBe("new-owner");
  });

  // Ruling Z53, over the result of a `filter` of a plain array generated
  // from scratch: the element has a reference by key whose collection is
  // the address of the output.
  it("stores a reference by key to an element of a plain array generated from scratch, with the output as its collection", async () => {
    const instance = await start();

    expect(instance.send(PICK_FOUND, {}, [0]).committed).toBe(true);

    const key = keySegment(byFields(instance, { id: 2 }));
    expect(cell(instance, PICKED)).toEqual({
      $link: { doc: instance.outputDocument(0), path: [key] },
    });
    expect(cell(instance, OWNER)).toEqual({
      $link: { doc: instance.outputDocument(0), path: [key, "owner"] },
    });
    expect(instance.result()).toMatchObject({
      pickedName: "cde",
      ownerLogin: "cde-owner",
    });
    // The computation returns a new array, whose element with the same
    // `id` has another name: the references name that element.
    instance.writeArgument(["names"], ["ab", "wxyz"]);
    expect(instance.result()).toMatchObject({
      pickedName: "wxyz",
      ownerLogin: "wxyz-owner",
    });
    // A computed output refuses a write through the reference.
    expect(() =>
      instance.store.write(
        new Ref(instance.outputDocument(0), [key, "name"]),
        "edited",
      )
    ).toThrow(ComputedOutput);
  });

  it("changes nothing over an array of references, where the key is the cell", async () => {
    const link = (name: string) => ({
      $link: { doc: ARGUMENT, path: ["pool", name] },
    });
    const instance = await start({
      ...argument([link("a"), link("b")]),
      pool: { a: repo(7, "s", 1), b: repo(7, "t", 2) },
    });

    expect(keysOf(instance, KEPT_CELL)).toEqual(sorted([
      cellKey(ARGUMENT, ["pool", "a"]),
      cellKey(ARGUMENT, ["pool", "b"]),
    ]));
  });
});

// Rulings Z45 and Z49 on `fixtures/array-by-key-fields.tsx`: the array
// type `ArrayByKey<Repo, "owner" | "name">` declares two key fields, and
// an element has one key across them. Today's runtime has no such type,
// so these tests are of the executor alone.
describe("several key fields declared with `ArrayByKey`", () => {
  const repo = (owner: string, name: string, stars: number) => ({
    owner,
    name,
    stars,
  });
  const start = async (
    saved: unknown[] = [repo("cf", "labs", 1), repo("x", "labs", 2)],
  ) => {
    const [{ patterns }] = JSON.parse(
      await Deno.readTextFile(
        new URL(
          "../../compare/fixtures/array-by-key-fields.emit.json",
          import.meta.url,
        ),
      ),
    ) as { patterns: Artifact[] }[];
    const artifacts = (id: string) =>
      patterns.find((pattern) => pattern.plan.patterns?.[0] === id);
    const main = patterns.find((pattern) => pattern.name === "default")!;
    return new Instance(main, {
      names: ["ab", "cde", "fghi"],
      bonus: 0,
      reversed: false,
      minStars: 3,
      saved,
    }, { artifacts });
  };
  type Row = { owner: string; name: string; stars: number; noted: string };
  type Result = { starred: Row[]; kept: Row[] };
  const result = (instance: Instance) => instance.result() as Result;
  const [STARRED, KEPT] = [0, 1];
  type Link = { $link: { doc: string; path: string[] } };
  const rows = (instance: Instance, list: "starred" | "kept") =>
    (instance.store.docs.get("result")?.value as Record<string, Link[]>)[list];
  const note = (instance: Instance, row: Link, text: string) => {
    new Handle(
      instance,
      new Ref(row.$link.doc, ["note"]),
      undefined,
      undefined,
      [],
    ).send({ text });
    return instance.dispatch();
  };
  /** The keys of the instances of one `asInstance()` call. */
  const keysOf = (instance: Instance, child: number) =>
    instance.childInstances().filter((made) => made.child === child)
      .map(({ keys }) => keys[0]);

  it("is in the plan as `Collection.keyFields`, in the order of the names", async () => {
    const instance = await start();

    expect(
      instance.plan.collections.map(({ construct, keyFields }) => [
        construct,
        keyFields,
      ]),
    ).toEqual([
      ["filter", ["name", "owner"]],
      ["map", undefined],
      ["map", ["name", "owner"]],
    ]);
  });

  it("gives an element one key across the fields, over the result of a `filter` of a plain array generated from scratch and over plain values in place", async () => {
    const instance = await start();

    expect(keysOf(instance, STARRED)).toEqual([
      byFields(instance, { name: "cde", owner: "x" }),
      byFields(instance, { name: "fghi", owner: "cf" }),
    ]);
    // Two elements with one `name` and two `owner` are two keys.
    expect(keysOf(instance, KEPT)).toEqual([
      byFields(instance, { name: "labs", owner: "cf" }),
      byFields(instance, { name: "labs", owner: "x" }),
    ]);
  });

  it("keeps the state of an `asInstance()` row over a plain array generated from scratch when a field that is no key and the order change", async () => {
    const instance = await start();
    const [cde, fghi] = rows(instance, "starred");
    note(instance, cde, "first");
    note(instance, fghi, "second");

    // A new array: every element has another `stars`, `ab` passes the
    // `filter` now, and the elements are in the reverse order.
    instance.writeArgument(["bonus"], 1);
    instance.writeArgument(["reversed"], true);

    expect(result(instance).starred).toEqual([
      { ...repo("cf", "fghi", 5), noted: "second", note: { $stream: true } },
      { ...repo("x", "cde", 4), noted: "first", note: { $stream: true } },
      { ...repo("cf", "ab", 3), noted: "", note: { $stream: true } },
    ]);
    expect(rows(instance, "starred").slice(0, 2)).toEqual([fghi, cde]);
    expect(keysOf(instance, STARRED).length).toBe(3);
  });

  it("keeps the state of an `asInstance()` row over plain values in place when a field that is no key and the order change", async () => {
    const instance = await start();
    const [cf, x] = rows(instance, "kept");
    note(instance, cf, "first");
    note(instance, x, "second");

    // A write through the reference by key of the element, to a member
    // that is no key field.
    instance.store.write(
      new Ref(ARGUMENT, [
        "saved",
        keySegment(byFields(instance, { name: "labs", owner: "cf" })),
        "stars",
      ]),
      9,
    );
    expect(instance.store.rekeys).toEqual([]);
    instance.settle();
    expect(result(instance).kept).toMatchObject([
      { owner: "cf", stars: 9, noted: "first" },
      { owner: "x", stars: 2, noted: "second" },
    ]);

    // The array is written whole, in another order and with other
    // `stars`.
    instance.writeArgument(["saved"], [
      repo("x", "labs", 7),
      repo("cf", "labs", 8),
    ]);

    expect(result(instance).kept).toMatchObject([
      { owner: "x", stars: 7, noted: "second" },
      { owner: "cf", stars: 8, noted: "first" },
    ]);
    expect(rows(instance, "kept")).toEqual([x, cf]);
    expect(keysOf(instance, KEPT).length).toBe(2);
  });

  it("makes an element with another value of one key field another element", async () => {
    const instance = await start();
    const [cf] = rows(instance, "kept");
    note(instance, cf, "first");

    instance.writeArgument(["saved"], [repo("cf", "specs", 1)]);

    expect(result(instance).kept).toMatchObject([
      { owner: "cf", name: "specs", noted: "" },
    ]);
    expect(keysOf(instance, KEPT)).toEqual([
      byFields(instance, { name: "labs", owner: "cf" }),
      byFields(instance, { name: "labs", owner: "x" }),
      byFields(instance, { name: "specs", owner: "cf" }),
    ]);
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

  it("writes none of the documents the executor was started with when it is made", async () => {
    // `options.documents` are the root instance's: the instance a body
    // makes shares the store and makes none of them again.
    const [{ patterns }] = JSON.parse(
      await Deno.readTextFile(
        new URL(
          "../../compare/fixtures/instantiate.emit.json",
          import.meta.url,
        ),
      ),
    ) as { patterns: Artifact[] }[];
    const instance = new Instance(
      patterns.find((pattern) => pattern.name === "default")!,
      { note: "n" },
      {
        artifacts: (id) =>
          patterns.find((pattern) => pattern.plan.patterns?.[0] === id),
        documents: [{ id: "given", kind: "input", value: { kept: true } }],
      },
    );
    const before = instance.transactions.length;

    expect(instance.send(ADD, { title: "a" }).committed).toBe(true);
    expect(
      instance.transactions.slice(before).flatMap(({ written }) => written),
    ).not.toContain("given");
  });

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
    const stored = instance.store.docs.get(instance.stateCellDocument(0))
      ?.value as {
        $link: { doc: string; path: string[] };
      }[];
    expect(stored.map(({ $link }) => $link.path)).toEqual([[], []]);
    expect(new Set(stored.map(({ $link }) => $link.doc)).size).toBe(2);
    // An argument and a result document for each instance, and the
    // state cell of the list.
    expect(besideStreams(instance)).toEqual({
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
    expect(besideStreams(instance)).toEqual(before);
  });

  it("binds a handler in a function body, and an event for its stream runs the handler with the state the body bound", async () => {
    const instance = await start();

    expect(result(instance).buttons).toEqual([
      { by: 1, press: { $stream: true } },
      { by: 2, press: { $stream: true } },
    ]);
    // The stored positions hold a link to a stream each (ruling Z20).
    const stored = instance.store.docs.get("result")?.value as {
      buttons: { press: { $stream: { binding: number; keys: string[] } } }[];
    };
    const [first, second] = stored.buttons.map(({ press }) => press.$stream);
    expect(first.binding).toBe(-1);
    expect(first.keys).not.toEqual(second.keys);

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

// Ruling Z52 and PL §8, question 143, on
// `fixtures/array-by-key-reader.tsx`: a reader whose type declares no key
// forms keys with the key fields of the array it is given. Today's
// runtime has no `ArrayByKey`, so these tests are of the executor alone.
describe("a reader typed as a plain array that is given an array with a declared key", () => {
  const repo = (id: number, name: string, stars: number) => ({
    id,
    name,
    stars,
  });
  const start = async () => {
    const [{ patterns }] = JSON.parse(
      await Deno.readTextFile(
        new URL(
          "../../compare/fixtures/array-by-key-reader.emit.json",
          import.meta.url,
        ),
      ),
    ) as { patterns: Artifact[] }[];
    const artifacts = (id: string) =>
      patterns.find((pattern) => pattern.plan.patterns?.[0] === id);
    const main = patterns.find((pattern) => pattern.name === "default")!;
    return new Instance(main, {
      names: ["ab", "cde"],
      bonus: 0,
      saved: [repo(7, "s", 1), repo(8, "t", 2)],
      loose: [repo(7, "s", 1)],
    }, { artifacts });
  };
  /** The keys of the state cells that one record of a plan declares. */
  const keysOf = (instance: Instance, cell: number) =>
    sorted(
      instance.stateCells().filter((held) => held.cell === cell).map((
        { keys },
      ) => keys[0]),
    );
  /** The instance that a call through `asInstance()` made, by its child. */
  const made = (instance: Instance, child: number) => {
    const found = instance.childInstances().find((held) =>
      held.child === child
    );
    if (found === undefined) throw new Error("no instance of the child");
    return found.instance;
  };
  type Row = { name: string; stars: number; noted: string };
  type Result = Record<
    | "inPlace"
    | "scratch"
    | "derived"
    | "none"
    | "made"
    | "madeScratch"
    | "madeDerived"
    | "madeKept",
    { rows: Row[] }
  >;
  const result = (instance: Instance) => instance.result() as Result;
  /** Sends an event through the stream that a row of a document holds. */
  const note = (
    instance: Instance,
    doc: string,
    rows: string[],
    row: number,
    text: string,
  ) => {
    new Handle(
      instance,
      new Ref(doc, [...rows, `${row}`, "note"]),
      undefined,
      undefined,
      [],
    ).send({ text });
    return instance.dispatch();
  };
  const [IN_PLACE, SCRATCH, DERIVED, NONE] = [0, 1, 2, 3];
  const [MADE, MADE_SCRATCH, MADE_DERIVED, MADE_KEPT] = [0, 1, 2, 3];

  it("gives the collection of a reader that is compiled in the key fields of the array given, in the plan", async () => {
    const instance = await start();

    expect(
      instance.plan.collections.map(({ construct, source, keyFields }) => [
        construct,
        Object.keys(source)[0],
        keyFields,
      ]),
    ).toEqual([
      // Over plain values in place.
      ["map", "slot", ["id"]],
      // Over a plain array generated from scratch.
      ["map", "output", ["id"]],
      ["filter", "output", ["id"]],
      // Over the result of the `filter`: the upstream keys.
      ["map", "collection", undefined],
      // Over an array that declares no key.
      ["map", "slot", undefined],
      // The two results that are given whole to an instance of its own.
      ["filter", "output", ["id"]],
      ["filter", "slot", ["id"]],
    ]);
  });

  it("keys the rows of a reader that is compiled in by the declared field, in each of the three cases", async () => {
    const instance = await start();
    instance.result();

    // Over plain values in place.
    expect(keysOf(instance, IN_PLACE)).toEqual(
      sorted([7, 8].map((id) => byFields(instance, { id }))),
    );
    // Over a plain array generated from scratch, and over the result of
    // a `filter` of it, whose elements have the upstream keys.
    for (const cell of [SCRATCH, DERIVED]) {
      expect(keysOf(instance, cell)).toEqual(
        sorted([1, 2].map((id) => byFields(instance, { id }))),
      );
    }
    // Over an array whose type declares no key: the whole value.
    expect(keysOf(instance, NONE)).toEqual([
      whole(instance, repo(7, "s", 1)),
    ]);
  });

  it("keeps the state of a row of a reader that is compiled in when a member that is no key field changes", async () => {
    const instance = await start();
    instance.result();
    expect(
      note(instance, "result", ["inPlace", "rows"], 1, "kept").map((
        { committed },
      ) => committed),
    ).toEqual([true]);
    expect(
      note(instance, "result", ["scratch", "rows"], 1, "fresh").map((
        { committed },
      ) => committed),
    ).toEqual([true]);

    instance.writeArgument(["saved", "1", "stars"], 9);
    instance.writeArgument(["bonus"], 5);

    expect(result(instance).inPlace.rows[1]).toMatchObject({
      name: "t",
      stars: 9,
      noted: "kept",
    });
    expect(result(instance).scratch.rows[1]).toMatchObject({
      stars: 8,
      noted: "fresh",
    });
    expect(keysOf(instance, SCRATCH)).toEqual(
      sorted([1, 2].map((id) => byFields(instance, { id }))),
    );
  });

  it("keys the rows of an instance called through `asInstance()` by the key fields of the array schema that the link in its argument holds, over plain values in place", async () => {
    const instance = await start();
    instance.result();

    // The argument of the instance holds a link to the array, with the
    // schema of the array that the caller reads it under.
    expect(instance.store.docs.get(made(instance, MADE).argument)?.value)
      .toMatchObject({
        repos: {
          $link: {
            doc: ARGUMENT,
            path: ["saved"],
            schema: { type: "array", keyFields: ["id"] },
          },
        },
      });
    expect(keysOf(made(instance, MADE), 0)).toEqual(
      sorted([7, 8].map((id) => byFields(instance, { id }))),
    );
    // The row keeps its state when a member that is no key field
    // changes.
    expect(
      note(instance, made(instance, MADE).id, ["rows"], 1, "mine").map((
        { committed },
      ) => committed),
    ).toEqual([true]);
    instance.writeArgument(["saved", "1", "stars"], 9);
    expect(result(instance).made.rows).toMatchObject([
      { name: "s", stars: 1, noted: "" },
      { name: "t", stars: 9, noted: "mine" },
    ]);
    expect(keysOf(made(instance, MADE), 0)).toEqual(
      sorted([7, 8].map((id) => byFields(instance, { id }))),
    );
  });

  it("names each instance called through `asInstance()` by the hash of a cause that holds the name of its child as the record of the name and its ordinal", async () => {
    const instance = await start();
    instance.result();

    // The four calls of `Rows` through `asInstance()` are four
    // declarations of one name, so each has the name and its ordinal.
    expect(instance.plan.children?.map(({ name }) => name)).toEqual(
      [1, 2, 3, 4].map((ordinal) => ({ name: "Rows", ordinal })),
    );
    expect(made(instance, MADE).id).toBe(identifierOf({
      parent: "result",
      type: "child",
      within: [],
      cause: { name: "Rows", ordinal: 1 },
    }));
    expect(made(instance, MADE_SCRATCH).id).toBe(identifierOf({
      parent: "result",
      type: "child",
      within: [],
      cause: { name: "Rows", ordinal: 2 },
    }));
  });

  it("gives an instance called through `asInstance()` a plain array generated from scratch as a link to the stored output with the array schema, and keys its rows by the declared field", async () => {
    const instance = await start();
    instance.result();

    // Ruling Z54: the argument holds no value of the array. The link
    // names the document of the output, and its schema has the keyword.
    expect(
      instance.store.docs.get(made(instance, MADE_SCRATCH).argument)?.value,
    ).toEqual({
      repos: {
        $link: {
          doc: instance.outputDocument(0),
          path: [],
          schema: { type: "array", keyFields: ["id"] },
        },
      },
    });
    expect(instance.store.docs.get(instance.outputDocument(0))).toEqual({
      kind: "output",
      value: [repo(1, "ab", 2), repo(2, "cde", 3)],
    });
    expect(keysOf(made(instance, MADE_SCRATCH), 0)).toEqual(
      sorted([1, 2].map((id) => byFields(instance, { id }))),
    );
    expect(result(instance).madeScratch.rows).toMatchObject([
      { name: "ab", stars: 2, noted: "" },
      { name: "cde", stars: 3, noted: "" },
    ]);
    // The row keeps its state when the computation returns the element
    // with another value of a member that is no key field.
    expect(
      note(instance, made(instance, MADE_SCRATCH).id, ["rows"], 1, "mine")
        .map(({ committed }) => committed),
    ).toEqual([true]);
    instance.writeArgument(["bonus"], 5);
    expect(result(instance).madeScratch.rows).toMatchObject([
      { name: "ab", stars: 7, noted: "" },
      { name: "cde", stars: 8, noted: "mine" },
    ]);
    expect(keysOf(made(instance, MADE_SCRATCH), 0)).toEqual(
      sorted([1, 2].map((id) => byFields(instance, { id }))),
    );
  });

  it("gives an instance called through `asInstance()` the result of another per-element construct as the assembled values and the links it holds", async () => {
    const instance = await start();
    instance.result();

    // Over a plain array generated from scratch and over plain values
    // in place alike, the argument holds the values of the elements that
    // the `filter` passes on.
    const scratch = instance.store.docs.get(
      made(instance, MADE_DERIVED).argument,
    )?.value as { repos: unknown[] };
    const kept = instance.store.docs.get(made(instance, MADE_KEPT).argument)
      ?.value as { repos: unknown[] };
    expect(scratch.repos).toEqual([repo(1, "ab", 2), repo(2, "cde", 3)]);
    expect(kept.repos).toEqual([repo(7, "s", 1), repo(8, "t", 2)]);
    // The argument holds the values and no link to an array, so no
    // schema is on the way and the rows are keyed by the whole value.
    expect(keysOf(made(instance, MADE_DERIVED), 0)).toEqual(
      sorted(
        [repo(1, "ab", 2), repo(2, "cde", 3)].map((value) =>
          whole(instance, value)
        ),
      ),
    );
    expect(keysOf(made(instance, MADE_KEPT), 0)).toEqual(
      sorted(
        [repo(7, "s", 1), repo(8, "t", 2)].map((value) =>
          whole(instance, value)
        ),
      ),
    );
  });
});

// Rulings Z47, Z48 and Z51 on `fixtures/array-by-key-form.tsx`: what a
// key with declared fields holds, over a plain array generated from
// scratch followed by a `filter` and a `map` (`found`) and over plain
// values in place followed by the same (`kept`). The secret of the space
// is fixed, and each expected key is formed here with the helpers of the
// data model. Today's runtime has no `ArrayByKey`, so these tests are of
// the executor alone.
describe("the form of a key with declared fields, over a `filter` and a `map`", () => {
  const SECRET = "the secret of the space";
  const entry = (code: string | number, tag: string, stars: number) => ({
    "a:b": code,
    tag,
    stars,
    position: { lat: stars * 10 },
  });
  // The number 7 and the string `7` with one `tag`, and a third element
  // that shares the `tag` and one that shares the number.
  const entries = () => [
    entry(7, "x", 1),
    entry("7", "x", 2),
    entry(8, "x", 3),
    entry(7, "y", 4),
  ];
  const start = async () => {
    const instance = new Instance(await artifactOf("array-by-key-form"), {
      seeds: entries(),
      bonus: 0,
      minStars: 0,
      saved: entries(),
    }, { secret: SECRET });
    instance.result();
    return instance;
  };
  const keyOf = (code: string | number, tag: string) =>
    jsonFromFabricValue({
      element: {
        fields: ["a:b", "tag"],
        hash: hashOf({ salt: SECRET, value: [code, tag] }),
      },
      occurrence: 0,
    });
  const expected = () =>
    sorted([keyOf(7, "x"), keyOf("7", "x"), keyOf(8, "x"), keyOf(7, "y")]);
  const [PICK_FOUND, PICK_KEPT] = [1, 3];
  const [PICKED, CENTER, FOUND_CELL, KEPT_CELL] = [0, 1, 2, 3];
  const cell = (instance: Instance, index: number) =>
    instance.store.docs.get(instance.stateCellDocument(index))?.value;
  const keysOf = (instance: Instance, cell: number) =>
    sorted(
      instance.stateCells().filter((held) => held.cell === cell).map((
        { keys },
      ) => keys[0]),
    );
  type Result = {
    pickedTag: string;
    centerLat: number;
    found: { tag: string; stars: number }[];
    kept: { tag: string; stars: number }[];
  };

  for (
    const [name, stateCell] of [
      ["a plain array generated from scratch", FOUND_CELL],
      ["plain values in place", KEPT_CELL],
    ] as const
  ) {
    it(`names the fields in name order and holds one salted hash of their values, over ${name}`, async () => {
      const instance = await start();

      const keys = keysOf(instance, stateCell);

      // The number 7 and the string `7` have two keys, and so has each
      // element that shares one of the two values with another.
      expect(keys).toEqual(expected());
      expect(new Set(keys).size).toBe(4);
      // A name that holds a `:` is read back from the key as it is.
      for (const key of keys) expect(fieldsOfKey(key)).toEqual(["a:b", "tag"]);
      // Two keys that share the value of one field have the names and
      // the count in common, and no part of the hash.
      const parts = (key: string) => {
        const { element, occurrence } = fabricFromJsonValue(key) as {
          element: Record<string, FabricValue>;
          occurrence: number;
        };
        return {
          fields: element.fields,
          count: occurrence,
          hash: jsonFromFabricValue(element.hash),
        };
      };
      const [first, second] = [parts(keyOf(7, "x")), parts(keyOf(8, "x"))];
      expect(first.fields).toEqual(second.fields);
      expect(first.count).toBe(second.count);
      expect(first.hash).not.toBe(second.hash);
      // No key holds a value of a key field.
      for (const key of keys) expect(key).not.toContain('"x"');
    });

    it(`keeps every key when a member that is no key field changes, over ${name}`, async () => {
      const instance = await start();

      if (stateCell === FOUND_CELL) instance.writeArgument(["bonus"], 5);
      else instance.writeArgument(["saved", "2", "stars"], 9);
      instance.result();

      expect(keysOf(instance, stateCell)).toEqual(expected());
    });
  }

  it("resolves a stored reference to the element and to a member below it from the key alone, over plain values in place", async () => {
    const instance = await start();

    // The row of the string `7`.
    expect(instance.send(PICK_KEPT, {}, [1]).committed).toBe(true);

    const key = keySegment(keyOf("7", "x"));
    expect(cell(instance, PICKED)).toEqual({
      $link: { doc: ARGUMENT, path: ["saved", key] },
    });
    expect(cell(instance, CENTER)).toEqual({
      $link: { doc: ARGUMENT, path: ["saved", key, "position"] },
    });
    expect(instance.result() as Result).toMatchObject({
      pickedTag: "x",
      centerLat: 20,
    });
    // The array is written whole in another order, with another value of
    // the member below the element: the references name the element of
    // the string `7` and not that of the number 7.
    instance.writeArgument(["saved"], [
      { ...entry("7", "x", 2), position: { lat: 77 } },
      ...entries().filter((held) => held["a:b"] !== "7"),
    ]);
    expect(instance.result() as Result).toMatchObject({ centerLat: 77 });
  });

  // Ruling Z53: the same over a plain array generated from scratch,
  // whose collection is the address of the output.
  it("resolves a stored reference to the element and to a member below it from the key alone, over a plain array generated from scratch", async () => {
    const instance = await start();

    // The row of the string `7`.
    expect(instance.send(PICK_FOUND, {}, [1]).committed).toBe(true);

    const key = keySegment(keyOf("7", "x"));
    expect(cell(instance, PICKED)).toEqual({
      $link: { doc: instance.outputDocument(0), path: [key] },
    });
    expect(cell(instance, CENTER)).toEqual({
      $link: { doc: instance.outputDocument(0), path: [key, "position"] },
    });
    expect(instance.result() as Result).toMatchObject({
      pickedTag: "x",
      centerLat: 20,
    });
    // The computation returns a new array in another order, with
    // another value of the member below the element: the references
    // name the element of the string `7` and not that of the number 7.
    instance.writeArgument(["seeds"], [
      { ...entry("7", "x", 2), position: { lat: 77 } },
      ...entries().filter((held) => held["a:b"] !== "7"),
    ]);
    expect(instance.result() as Result).toMatchObject({ centerLat: 77 });
  });
});

// Ruling Z53 on `fixtures/generated-reference.tsx`: an element of a plain
// array generated from scratch, with no declared key, has a reference by
// key whose collection is the address of the output. Today's runtime
// stores no such reference, so these tests are of the executor alone.
describe("an element of a plain array generated from scratch that declares no key", () => {
  const start = async () => {
    const [{ patterns }] = JSON.parse(
      await Deno.readTextFile(
        new URL(
          "../../compare/fixtures/generated-reference.emit.json",
          import.meta.url,
        ),
      ),
    ) as { patterns: Artifact[] }[];
    const artifacts = (id: string) =>
      patterns.find((pattern) => pattern.plan.patterns?.[0] === id);
    const main = patterns.find((pattern) => pattern.name === "default")!;
    const instance = new Instance(main, { titles: ["ab", "cde"], bonus: 0 }, {
      artifacts,
    });
    instance.result();
    return instance;
  };
  const item = (title: string, bonus = 0) => ({
    title,
    stars: title.length + bonus,
  });
  const PICK = 0;
  type Result = { picked?: unknown; pickedTitle?: string };

  it("is stored in a document of the output, which the rows read by key", async () => {
    const instance = await start();

    expect(instance.store.docs.get(instance.outputDocument(0))).toEqual({
      kind: "output",
      value: [item("ab"), item("cde")],
    });
    const rows = (instance.store.docs.get("result")?.value as {
      rows: { title: unknown }[];
    }).rows;
    expect(rows.map(({ title }) => title)).toMatchObject(
      ["ab", "cde"].map((title) => ({
        $link: {
          doc: instance.outputDocument(0),
          path: [keySegment(whole(instance, item(title))), "title"],
        },
      })),
    );
  });

  it("is stored by a handler as a reference by key of its whole value, which reads nothing once the element changes", async () => {
    const instance = await start();

    expect(instance.send(PICK, {}, [1]).committed).toBe(true);

    const key = keySegment(whole(instance, item("cde")));
    expect(instance.store.docs.get(instance.stateCellDocument(0))?.value)
      .toEqual({
        $link: { doc: instance.outputDocument(0), path: [key] },
      });
    expect(instance.result() as Result).toMatchObject({
      picked: item("cde"),
      pickedTitle: "cde",
    });
    // Another element is added, and the reference names the same one.
    instance.writeArgument(["titles"], ["z", "ab", "cde"]);
    expect((instance.result() as Result).pickedTitle).toBe("cde");
    // Every element has another value, so no element has the key.
    instance.writeArgument(["bonus"], 2);
    const after = instance.result() as Result;
    expect(after.picked).toBe(undefined);
    expect(after.pickedTitle).toBe(undefined);
    // No write repairs it: the output refuses writes.
    expect(() =>
      instance.store.write(
        new Ref(instance.outputDocument(0), [
          keySegment(whole(instance, item("cde", 2))),
          "title",
        ]),
        "edited",
      )
    ).toThrow(ComputedOutput);
  });

  it("is given to an instance called through `asInstance()` as a copy in its argument", async () => {
    const instance = await start();

    expect(
      instance.childInstances().map(({ instance: made }) =>
        instance.store.docs.get(made.argument)?.value
      ),
    ).toEqual([{ item: item("ab") }, { item: item("cde") }]);
  });
});

// Ruling Z56: an output inside an element body gives its elements a
// reference by key as one outside does. `items` of
// `fixtures/generated-inner.tsx` is a plain array generated from scratch
// with a declared key, computed once per group, and the groups are plain
// values in place.
describe("an element of a plain array generated from scratch inside an element body", () => {
  const groups = () => [
    { name: "g", titles: ["ab", "cde"] },
    { name: "h", titles: ["f"] },
  ];
  const start = async () => {
    const instance = new Instance(await artifactOf("generated-inner"), {
      groups: groups(),
      bonus: 0,
    });
    instance.result();
    return instance;
  };
  const bindingOf = (instance: Instance, name: string) =>
    instance.plan.bindings.findIndex((binding) => binding.name === name);
  const picked = (instance: Instance) =>
    instance.store.docs.get(instance.stateCellDocument(0))?.value;
  /** The document of `items` for the group at a position. */
  const itemsOf = (instance: Instance, group: number) =>
    instance.outputDocument(0, [whole(instance, groups()[group])]);
  type Result = { pickedStars?: number };

  it("is stored by a handler as a reference by key with the document of the output of its group as the collection", async () => {
    const instance = await start();

    expect(instance.send(bindingOf(instance, "pick"), {}, [0, 1]).committed)
      .toBe(true);

    expect(instance.store.docs.get(itemsOf(instance, 0))).toEqual({
      kind: "output",
      value: [{ title: "ab", stars: 2 }, { title: "cde", stars: 3 }],
    });
    expect(picked(instance)).toEqual({
      $link: {
        doc: itemsOf(instance, 0),
        path: [keySegment(byFields(instance, { title: "cde" }))],
      },
    });
    expect((instance.result() as Result).pickedStars).toBe(3);
  });

  it("is the element of its own group for an event sent through the stored link to the stream, where a later group holds an element of the same key", async () => {
    const instance = new Instance(await artifactOf("generated-inner"), {
      groups: [{ name: "g", titles: ["ab"] }, { name: "h", titles: ["ab"] }],
      bonus: 0,
    });
    instance.result();
    const stream = new Handle(
      instance,
      new Ref("result", ["groups", "0", "rows", "0", "pick"]),
      undefined,
      undefined,
      [],
    );

    stream.send({});
    const [outcome] = instance.dispatch();

    expect(outcome.committed).toBe(true);
    expect(picked(instance)).toEqual({
      $link: {
        doc: instance.outputDocument(0, [
          whole(instance, { name: "g", titles: ["ab"] }),
        ]),
        path: [keySegment(byFields(instance, { title: "ab" }))],
      },
    });
  });

  it("reads the current value through a link to it that is stored elsewhere, before anything else demands the output", async () => {
    const instance = await start();
    instance.send(bindingOf(instance, "pick"), {}, [0, 1]);
    const stars = new Ref(instance.stateCellDocument(0), ["stars"]);
    expect(instance.store.read(stars)).toBe(3);

    // A write that no evaluation followed: the computation of the group
    // returns another array, and nothing has demanded it.
    instance.store.write(new Ref(ARGUMENT, ["bonus"]), 4);

    expect(instance.store.read(stars)).toBe(7);
    expect(instance.store.docs.get(itemsOf(instance, 0))?.value).toEqual([
      { title: "ab", stars: 6 },
      { title: "cde", stars: 7 },
    ]);
    instance.settle();
    expect((instance.result() as Result).pickedStars).toBe(7);
  });

  it("keeps what the link read last once the key of its group left", async () => {
    const instance = await start();
    instance.send(bindingOf(instance, "pick"), {}, [0, 1]);
    const stars = new Ref(instance.stateCellDocument(0), ["stars"]);

    instance.writeArgument(["groups"], [groups()[1]]);
    instance.store.write(new Ref(ARGUMENT, ["bonus"]), 4);

    // Nothing is cleaned up when a key leaves, and nothing computes the
    // output of a group that is in the collection no longer.
    expect(instance.store.read(stars)).toBe(3);
  });

  it("refuses a write that a handler makes through the stored reference, and commits nothing of the handler", async () => {
    const instance = await start();
    instance.send(bindingOf(instance, "pick"), {}, [0, 1]);
    const before = structuredClone(
      instance.store.docs.get(itemsOf(instance, 0)),
    );

    const outcome = instance.send(bindingOf(instance, "edit"), {});

    expect(outcome).toEqual({
      binding: bindingOf(instance, "edit"),
      committed: false,
      error: new ComputedOutput().message,
    });
    expect(instance.store.docs.get(itemsOf(instance, 0))).toEqual(before);
    expect((instance.result() as Result).pickedStars).toBe(3);
  });
});

// What a `set` does on a cell that holds a link
// (`fixtures/set-over-link.tsx`). The comparison of values runs the same
// events on today's runtime, which gives the same value at every point
// (`compare/values-fixtures.ts`).
describe("a `set` on a cell that holds a link", () => {
  type Result = Record<
    "firstTitle" | "firstStars" | "pickedTitle" | "pickedStars",
    unknown
  >;
  const [PICK, STAR, REPLACE] = [0, 1, 2];
  const start = async () => {
    const instance = new Instance(await artifactOf("set-over-link"), {
      first: { title: "a", stars: 1 },
    });
    instance.send(PICK, {});
    return instance;
  };
  const link = { $link: { doc: ARGUMENT, path: ["first"] } };
  const cell = (instance: Instance) =>
    instance.store.docs.get(instance.stateCellDocument(0))?.value;

  it("writes a member below the cell into the record that the link names", async () => {
    const instance = await start();
    expect(cell(instance)).toEqual(link);

    instance.send(STAR, {});

    expect(cell(instance)).toEqual(link);
    expect(instance.result()).toMatchObject({ firstStars: 9, pickedStars: 9 });
  });

  it("writes a plain value over the record that the link names, and the cell keeps the link", async () => {
    const instance = await start();

    instance.send(REPLACE, {});

    expect(cell(instance)).toEqual(link);
    expect(instance.store.docs.get(ARGUMENT)?.value).toEqual({
      first: { title: "plain", stars: 0 },
    });
    expect(instance.result() as Result).toMatchObject({
      firstTitle: "plain",
      firstStars: 0,
      pickedTitle: "plain",
      pickedStars: 0,
    });
  });
});

// `dataFile(path)` gives the text of a file of the program, which the
// artifact holds as a constant (BI, "Pure API functions";
// `fixtures/data-file.tsx`).
describe("a data file", () => {
  it("is the text that the artifact holds, at module scope and in a function body", async () => {
    const instance = new Instance(await artifactOf("data-file"), { index: 2 });

    expect(instance.result()).toEqual({
      first: "alfa",
      count: 3,
      picked: "charlie",
    });
  });

  it("fails the start of the instance where the artifact holds no text for it", async () => {
    const artifact = structuredClone(await artifactOf("data-file"));
    artifact.code.dataFiles = [{ file: "compare/fixtures/data/words.json" }];

    expect(() => new Instance(artifact, { index: 0 })).toThrow(
      "a data file whose text the artifact does not hold",
    );
  });
});

// A per-element construct inside the block body of a promoted `computed`
// that names a `const` of the block (`fixtures/block-const.tsx`). The
// arrays are arrays of plain values in place.
describe("a `const` of the block body of a promoted `computed`", () => {
  const argument = (second: boolean, skip: string) => ({
    items: [
      { text: "a", done: true },
      { text: "b", done: false },
      { text: "c", done: true },
    ],
    fleet: { ships: [{ text: "x", done: false }, { text: "y", done: true }] },
    spare: { ships: [{ text: "z", done: false }, { text: "w", done: false }] },
    second,
    skip,
  });

  it("is the receiver of a construct, is read in its callback, and is named in its receiver", async () => {
    const instance = new Instance(
      await artifactOf("block-const"),
      argument(false, " b "),
    );

    expect(instance.result()).toEqual({
      summary: "2/3",
      others: [{ text: "a", done: true }, { text: "c", done: true }],
      afloat: 1,
    });
  });

  it("selects the receiver of the construct by the `const`", async () => {
    const instance = new Instance(
      await artifactOf("block-const"),
      argument(true, ""),
    );

    expect(instance.result()).toEqual({
      summary: "2/3",
      others: [],
      afloat: 2,
    });
  });
});

// A memo entry that many entries depend on (`fixtures/shared-values.tsx`:
// twenty-five values in a chain, each of which reads the two before it).
describe("a memo entry that other entries share", () => {
  it("is checked once in a pass that follows no write", async () => {
    const instance = new Instance(await artifactOf("shared-values"), {
      seed: 1,
    });
    expect(instance.result()).toEqual({ v24: 196418 });
    const evaluations = instance.counts.evaluations;
    const before = instance.checks;

    instance.settle();

    // The result and the twenty-five values.
    expect(instance.checks - before).toBeLessThanOrEqual(26);
    expect(instance.counts.evaluations).toBe(evaluations);
  });

  it("is evaluated again after a write to what it read", async () => {
    const instance = new Instance(await artifactOf("shared-values"), {
      seed: 1,
    });

    instance.writeArgument(["seed"], 2);

    expect(instance.result()).toEqual({ v24: 271443 });
  });
});

// The debug renderers of the API are conversions to a string (FA §3.3;
// `fixtures/debug-strings.tsx`).
describe("a debug renderer", () => {
  it("gives the text that the renderer of the data model gives, in the reactive tier and in a function body", async () => {
    const entry = { title: "a", tags: ["x", "y"] };
    const instance = new Instance(await artifactOf("debug-strings"), {
      entry,
    });

    // The value code reads the members of the record in the order of the
    // storage, which is that of their names (`membersInOrder`).
    const read = { tags: entry.tags, title: entry.title };
    expect(instance.result()).toEqual({
      compact: toCompactDebugString(read),
      indented: `entry: ${toIndentedDebugString(read)}`,
    });
  });
});

// A constant at a position of handle type (ES §2.4): the call of a
// pattern compiled in writes `step` as a literal and leaves `max` out,
// and the callee declares both as handles (`fixtures/action-constant.tsx`).
describe("a name of handle type that an `action` captures and the call binds to a constant", () => {
  const [INCREMENT, WIDEN] = [0, 1];

  it("is a handle that reads the constant", async () => {
    const instance = new Instance(await artifactOf("action-constant"), {
      score: 3,
    });
    expect(instance.result()).toMatchObject({ score: 3, stepNow: 5 });

    expect(instance.send(INCREMENT, {}).committed).toBe(true);

    expect(instance.result()).toMatchObject({ score: 8, stepNow: 5 });
  });

  it("refuses a write through the handle, which fails the handler", async () => {
    const instance = new Instance(await artifactOf("action-constant"), {
      score: 3,
    });

    const outcome = instance.send(WIDEN, {});

    expect(outcome.committed).toBe(false);
    expect(outcome.error).toContain(
      "a write through a handle to a value the instance holds no address for",
    );
    expect(instance.result()).toMatchObject({ score: 3, stepNow: 5 });
  });
});

// A constant at a position of handle type that a sandboxed body captures
// (ES §2.4): the call of a pattern compiled in leaves `show` and `hide`
// out or writes `hide` as a literal (`fixtures/body-constant.tsx`).
describe("a name of handle type that a body captures and the call binds to a constant", () => {
  it("is a handle that reads the constant", async () => {
    const instance = new Instance(await artifactOf("body-constant"), {
      words: ["a", "b"],
    });

    expect(instance.result()).toEqual({ open: "a,b", closed: "-" });
  });
});

// A declaration of policy at module scope names built-ins that the
// executor does not have (`fixtures/module-policy.tsx`).
describe("a built-in that the executor does not have", () => {
  it("gives, at module scope, a value whose members can be read and called", async () => {
    const instance = new Instance(await artifactOf("module-policy"), {
      message: "kept",
    });

    expect(instance.result()).toEqual({ message: "kept" });
  });
});

// A pattern compiled in that passes its whole argument on
// (`fixtures/whole-argument.tsx`).
describe("a pattern compiled in that names its whole argument", () => {
  it("reads every path that the call binds: a computed value, an input, an input under a computed key that is a string literal, and a literal", async () => {
    const instance = new Instance(await artifactOf("whole-argument"), {
      note: "n",
      count: 2,
    });

    expect(instance.result()).toEqual({
      context: { input: "n!", count: 2, label: "l", jam: 2 },
    });
  });
});

// `navigateTo` in a handler is a request of an effect, which the handler
// makes and commits with (BI, `navigateTo`; `fixtures/handle-passed.tsx`).
describe("a handler that requests a navigation", () => {
  it("commits, and the instance holds the request with the target it was given", async () => {
    const [{ patterns }] = JSON.parse(
      await Deno.readTextFile(
        new URL(
          "../../compare/fixtures/handle-passed.emit.json",
          import.meta.url,
        ),
      ),
    ) as { patterns: Artifact[] }[];
    const instance = new Instance(
      await artifactOf("handle-passed"),
      { mine: "a", other: "b" },
      {
        artifacts: (id) =>
          patterns.find((pattern) => pattern.plan.patterns?.[0] === id),
      },
    );

    const outcome = instance.send(0, {});

    expect(outcome.committed).toBe(true);
    expect(instance.store.read(new Ref(ARGUMENT, ["mine"]))).toBe("joined");
    expect(instance.requests.map(({ kind }) => kind)).toEqual(["navigateTo"]);
    // The target is the result of the child that the handler made.
    expect(instance.store.read(instance.requests[0].target as Ref))
      .toMatchObject({ mine: "joined", other: "b" });
  });

  it("holds no request of a handler that throws", async () => {
    const instance = new Instance(await artifactOf("handler-throws"), {});
    const before = instance.requests.length;

    for (let binding = 0; binding < instance.plan.bindings.length; binding++) {
      instance.send(binding, {});
    }

    expect(instance.requests.length).toBe(before);
  });
});

// A state path that the handler declares as a handle or `undefined`
// (`fixtures/handle-or-undefined.tsx`).
describe("a state path declared as a handle or `undefined`", () => {
  it("is handed to the body as a handle where it is bound", async () => {
    const instance = new Instance(await artifactOf("handle-or-undefined"), {
      item: { title: "a" },
    });

    expect(instance.send(0, {})).toMatchObject({ committed: true });

    expect(instance.result()).toMatchObject({ out: "a" });
  });
});

describe("the schemas of an artifact", () => {
  it("are frozen with all they hold once an instance was made of the artifact", async () => {
    const artifact = await artifactOf("scale");
    const instance = new Instance(artifact, { groups: [], rows: [] });

    const schemas = artifact.schemas.filter(({ schema }) =>
      schema !== undefined
    );
    expect(schemas.length).toBeGreaterThan(0);
    for (const { id } of schemas) {
      expect(isDeepFrozen(instance.schemaOf(id))).toBe(true);
    }
  });
});
