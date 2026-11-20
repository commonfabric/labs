import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type Artifact,
  Instance,
  type LabelChange,
  type Transaction,
  type TransactionHooks,
} from "../executor.ts";
import type { PlanWrite } from "../plan-write.ts";
import { argumentOf, type Store, type Undo } from "../store.ts";

const artifactOf = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(`../../compare/fixtures/${name}.emit.json`, import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find((pattern) => pattern.name === "default") ??
    patterns[patterns.length - 1];
};

/** What the hooks of an instance were told, in order. */
class Recorder implements TransactionHooks {
  /** `begin` and `end`, written as `begin <cause>` and `end <committed>`. */
  readonly brackets: string[] = [];

  /**
   * Each read, with the number of brackets before it, and the body and
   * handle it was made through, where it was made through one.
   */
  readonly reads: {
    at: number;
    doc: string;
    path: string[];
    by?: { body: number; handle: number };
  }[] = [];

  /**
   * Each change, with the number of brackets before it, the cause of the
   * transaction it was made in, and its value.
   */
  readonly changed: {
    at: number;
    cause: string;
    doc: string;
    path: string[];
    value: unknown;
    writes?: readonly PlanWrite[];
  }[] = [];

  #cause = "";

  /**
   * Constructs an instance. `label` gives the identifier of the label at a
   * position, where the test names one.
   */
  constructor(readonly label?: (doc: string, path: string[]) => string) {}

  labelOf(doc: string, path: readonly string[]): string | undefined {
    return this.label?.(doc, [...path]);
  }

  /** What the executor registered to hear of changed labels. */
  labelsChanged?: (changes: readonly LabelChange[], alone?: boolean) => void;

  watchLabels(
    changed: (changes: readonly LabelChange[], alone?: boolean) => void,
  ): void {
    this.labelsChanged = changed;
  }

  /** Each end, with its changes and the documents of the store after it. */
  readonly ends: {
    committed: boolean;
    changes: Undo[];
    documents: string[];
  }[] = [];

  begin(cause: Transaction["cause"] | "send" | "watermark"): void {
    this.#cause = cause;
    this.brackets.push(`begin ${cause}`);
  }

  read(
    doc: string,
    path: readonly string[],
    by?: { body: number; handle: number },
  ): void {
    this.reads.push({
      at: this.brackets.length,
      doc,
      path: [...path],
      ...(by === undefined ? {} : { by }),
    });
  }

  change(
    doc: string,
    path: readonly string[],
    store: Store,
    _schema?: unknown,
    writes?: readonly PlanWrite[],
  ): void {
    this.changed.push({
      at: this.brackets.length,
      cause: this.#cause,
      doc,
      path: [...path],
      value: structuredClone(store.peek(doc, path)),
      ...(writes === undefined ? {} : { writes }),
    });
  }

  /** Each write that left the value at its path as it was. */
  readonly left: {
    cause: string;
    doc: string;
    path: string[];
    writes: readonly PlanWrite[];
  }[] = [];

  unchanged(
    doc: string,
    path: readonly string[],
    _store: Store,
    _schema: unknown,
    writes: readonly PlanWrite[],
  ): void {
    this.left.push({ cause: this.#cause, doc, path: [...path], writes });
  }

  end(
    { committed, changes, store }: {
      committed: boolean;
      changes: readonly Undo[];
      store: Store;
    },
  ): void {
    this.brackets.push(`end ${committed}`);
    this.ends.push({
      committed,
      changes: [...changes],
      documents: [...store.docs.keys()],
    });
  }
}

const bindingOf = (instance: Instance, name: string): number =>
  instance.plan.bindings.findIndex((binding) => binding.name === name);

describe("TransactionHooks", () => {
  it("brackets every transaction of the executor with `begin` and `end`", async () => {
    const recorder = new Recorder();
    const instance = new Instance(
      await artifactOf("handler"),
      { secret: "s", note: "n" },
      { transactions: recorder },
    );
    instance.send(bindingOf(instance, "record"), { text: "t", extra: "e" });

    // The append of the sent event to its stream is the sender's write,
    // and the watermark passes the event after its transaction: each is a
    // transaction of the store of its own and none of the executor's.
    const transactions = instance.transactions.flatMap((
      { cause, committed },
    ) => [`begin ${cause}`, `end ${committed}`]);
    const sent = transactions.indexOf("begin event");
    expect(recorder.brackets).toEqual([
      ...transactions.slice(0, sent),
      "begin send",
      "end true",
      ...transactions.slice(sent, sent + 2),
      "begin watermark",
      "end true",
      ...transactions.slice(sent + 2),
    ]);
  });

  it("gives `end` the changes of a committed transaction and the documents after it", async () => {
    const recorder = new Recorder();
    const instance = new Instance(
      await artifactOf("handler"),
      { secret: "s", note: "n" },
      { transactions: recorder },
    );

    // The creation writes the argument document and the result document.
    const [created] = recorder.ends;
    expect(created.committed).toBe(true);
    expect(created.changes.map(({ doc }) => doc)).toEqual(
      expect.arrayContaining([instance.argument, instance.id]),
    );
    expect(created.documents).toEqual(
      expect.arrayContaining([instance.argument, instance.id]),
    );
  });

  it("reports the reads a transaction makes and none outside one", async () => {
    const recorder = new Recorder();
    const instance = new Instance(
      await artifactOf("handler"),
      { secret: "s", note: "n" },
      { transactions: recorder },
    );
    const before = recorder.reads.length;
    instance.result();
    expect(recorder.reads.length).toBe(before);

    const begun = recorder.brackets.length;
    instance.send(bindingOf(instance, "record"), { text: "t", extra: "e" });
    // The handler reads `secret` of the argument.
    expect(
      recorder.reads.filter(({ at }) => at > begun).map(({ doc, path }) => [
        doc,
        path,
      ]),
    ).toContainEqual([instance.argument, ["secret"]]);
  });

  it("tells `change` of each change with the store as it is after it", async () => {
    const recorder = new Recorder();
    const instance = new Instance(
      await artifactOf("handler"),
      { secret: "s", note: "n" },
      { transactions: recorder },
    );
    const begun = recorder.brackets.length;
    instance.send(bindingOf(instance, "record"), { text: "t", extra: "e" });

    // The journal holds a first write of a declared document twice, as
    // the creation of the document and the write, and `change` once. The
    // append of the event and the watermark are no transactions of the
    // executor, and have no journal.
    const during = recorder.changed.filter(({ at, cause }) =>
      at > begun && cause !== "send" && cause !== "watermark"
    );
    const unique = (docs: string[]) => [...new Set(docs)].sort();
    expect(unique(during.map(({ doc }) => doc))).toEqual(
      unique(
        recorder.ends.slice(-4).flatMap(({ changes }) =>
          changes.map(({ doc }) => doc)
        ),
      ),
    );
    // The handler sets `last`, a state cell, to the text and the secret.
    expect(during.map(({ value }) => value)).toContain("ts");
  });

  it("makes the documents it is given before the creation, outside any transaction", async () => {
    const recorder = new Recorder();
    const instance = new Instance(
      await artifactOf("handler"),
      {
        secret: { $link: { doc: "input:secret", path: [] } },
        note: "n",
      },
      {
        transactions: recorder,
        documents: [{ id: "input:secret", kind: "input", value: "s" }],
      },
    );
    instance.send(bindingOf(instance, "record"), { text: "t", extra: "e" });

    expect(instance.result()).toMatchObject({ last: "ts" });
    expect(
      recorder.ends.flatMap(({ changes }) => changes.map(({ doc }) => doc)),
    ).not.toContain("input:secret");
  });

  it("gives each write of a handler the record of its write edge and the bindings of its slots", async () => {
    const recorder = new Recorder();
    const instance = new Instance(
      await artifactOf("handler"),
      { secret: "s", note: "n" },
      { transactions: recorder },
    );
    const begun = recorder.brackets.length;
    instance.send(bindingOf(instance, "record"), { text: "t", extra: "e" });
    const cells = Object.fromEntries(
      instance.stateCells().map(({ name, id }) => [String(name), id]),
    );
    const during = recorder.changed.filter(({ at, cause }) =>
      at > begun && cause === "event"
    );

    // The template of both write edges derives from the event's `text`,
    // the two cells the binding captures, and `secret` of the argument.
    const slots = {
      0: {
        chain: [{
          doc: expect.any(String),
          path: ["entries", "0", "event", "text"],
        }],
        observes: "value",
      },
      1: { chain: [{ doc: cells.last, path: [] }], observes: "identity" },
      2: { chain: [{ doc: cells.log, path: [] }], observes: "identity" },
      3: {
        chain: [{ doc: instance.argument, path: ["secret"] }],
        observes: "value",
      },
    };
    expect(during.find(({ doc }) => doc === cells.last)?.writes).toEqual([{
      target: { doc: cells.last, path: [] },
      record: { body: 0, write: 0 },
      instance: instance.id,
      keys: [],
      slots,
    }]);
    // The push writes the list and the document of the pushed record,
    // both under the edge at `*` below `log`.
    const pushed = during.filter(({ doc }) => doc !== cells.last);
    expect(pushed.length).toBe(2);
    for (const { doc, path, writes } of pushed) {
      expect(writes).toEqual([{
        target: { doc, path },
        record: { body: 0, write: 1 },
        instance: instance.id,
        keys: [],
        slots,
      }]);
    }
  });

  it("gives each output a write of the result covers its record and the bindings of its cone instance", async () => {
    const recorder = new Recorder();
    const instance = new Instance(
      await artifactOf("handler"),
      { secret: "s", note: "n" },
      { transactions: recorder },
    );
    const cells = Object.fromEntries(
      instance.stateCells().map(({ name, id }) => [String(name), id]),
    );
    const writes = recorder.changed.filter(({ cause, doc }) =>
      cause === "derivation" && doc === instance.id
    ).flatMap(({ writes }) => writes ?? []);
    expect(writes).toContainEqual({
      target: { doc: instance.id, path: ["last"] },
      record: { output: 0 },
      instance: instance.id,
      keys: [],
      slots: {
        4: { chain: [{ doc: cells.last, path: [] }], observes: "identity" },
      },
    });
    expect(writes).toContainEqual({
      target: { doc: instance.id, path: ["note"] },
      record: { output: 2 },
      instance: instance.id,
      keys: [],
      slots: {
        7: {
          chain: [{ doc: instance.argument, path: ["note"] }],
          observes: "identity",
        },
      },
    });
  });

  it("gives each output of `briefing.tsx` its record, on creation and on a change of the argument", async () => {
    const recorder = new Recorder();
    const instance = new Instance(
      await artifactOf("briefing"),
      { secret: "s", city: "Paris" },
      { transactions: recorder },
    );
    const city = {
      chain: [{ doc: instance.argument, path: ["city"] }],
      observes: "value",
    };
    const secret = {
      chain: [{ doc: instance.argument, path: ["secret"] }],
      observes: "value",
    };
    const derived = (from: number) =>
      recorder.changed.slice(from).filter(({ cause, doc }) =>
        cause === "derivation" && doc === instance.id
      ).flatMap(({ writes }) => writes ?? []);
    const briefing = {
      target: { doc: instance.id, path: ["briefing"] },
      record: { output: 2 },
      instance: instance.id,
      keys: [],
      slots: { 1: city, 2: secret },
    };
    const created = derived(0);
    expect(created).toContainEqual(briefing);
    expect(created).toContainEqual({
      target: { doc: instance.id, path: ["climate"] },
      record: { output: 3 },
      instance: instance.id,
      keys: [],
      slots: { 1: city },
    });
    expect(created).toContainEqual({
      target: { doc: instance.id, path: ["$UI", "children", "1"] },
      record: { output: 1 },
      instance: instance.id,
      keys: [],
      slots: {
        0: {
          chain: [{ doc: instance.argument, path: ["city"] }],
          observes: "identity",
        },
      },
    });
    // `$NAME` is a constant that no output names: no record covers it.
    expect(
      created.filter(({ target }) => target.path[0] === "$NAME"),
    ).toEqual([]);

    const begun = recorder.changed.length;
    instance.writeArgument(["city"], "Rome");
    expect(derived(begun)).toContainEqual(briefing);
  });
});

describe("the selections of a write record", () => {
  it("carries the branch each selector took, which the value code reports", async () => {
    const recorder = new Recorder();
    const instance = new Instance(
      await artifactOf("selected"),
      { flag: true, secret: "ss", plain: "p" },
      { transactions: recorder },
    );
    const selections = (from: number) =>
      new Map(
        recorder.changed.slice(from).filter(({ doc }) => doc === instance.id)
          .flatMap(({ writes }) => writes ?? []).flatMap((write) =>
            "output" in write.record
              ? [[write.record.output, write.selections]]
              : []
          ),
      );
    // `shown` takes `secret`, `either` takes `plain`, `given` takes
    // `plain` where `extra` is absent, and the `if` of `chosen` takes its
    // first path.
    expect(selections(0)).toEqual(
      new Map([[0, { 0: 0 }], [1, { 1: 0 }], [2, { 2: 1 }], [3, { 3: 0 }]]),
    );

    const begun = recorder.changed.length;
    instance.writeArgument(["flag"], false);
    expect(selections(begun)).toEqual(new Map([[0, { 0: 1 }], [3, { 3: 1 }]]));
  });
});

describe("the reads through a handle", () => {
  it("are attributed to the body and the handle, and a write record carries them at its `dynamic` node", async () => {
    const recorder = new Recorder();
    const instance = new Instance(
      await artifactOf("handle-or-undefined"),
      { item: { title: "t" } },
      { transactions: recorder },
    );
    const begun = recorder.brackets.length;
    const from = recorder.reads.length;
    instance.send(bindingOf(instance, "copy"), {});

    // The handler reads `item` through the handle of its body, entry 0
    // of `Body.handles`, which entry 0 of `Plan.dynamicReads` names.
    const item = { doc: instance.argument, path: ["item"] };
    expect(
      recorder.reads.slice(from).filter(({ by }) => by !== undefined).map((
        { doc, path, by },
      ) => ({ doc, path, by })),
    ).toEqual([{ ...item, by: { body: 0, handle: 0 } }]);
    const writes = recorder.changed.filter(({ at, cause }) =>
      at > begun && cause === "event"
    ).flatMap(({ writes }) => writes ?? []);
    expect(writes).toMatchObject([{
      record: { body: 0, write: 0 },
      dynamic: { 0: [item] },
    }]);
  });
});

/** One write record for each output, by the output's index. */
const byOutput = (writes: readonly PlanWrite[]) =>
  new Map(
    writes.flatMap((write) =>
      "output" in write.record ? [[write.record.output, write]] : []
    ),
  );

describe("the elements of a `fold` in a write record", () => {
  const ARGUMENT = argumentOf("result");

  /**
   * `fold-groups.tsx` at `size`, with `items` an array of references
   * where `references` holds, changed in one element of `tags` and one of
   * `items`. Every position of a document has the same label.
   */
  const run = async (size: number, references: boolean) => {
    const tags = Array.from({ length: size }, (_, index) => `t${index}`);
    const items = Array.from({ length: size }, (_, index) => ({
      title: `i${index}`,
      done: index % 3 === 0,
    }));
    const argument = references
      ? {
        tags,
        pool: items,
        items: items.map((_, index) => ({
          $link: { doc: ARGUMENT, path: ["pool", `${index}`] },
        })),
      }
      : { tags, items };
    const recorder = new Recorder((doc) => `the label of ${doc}`);
    const instance = new Instance(await artifactOf("fold-groups"), argument, {
      transactions: recorder,
    });
    const updates = instance.counts.groupUpdates;
    const begun = recorder.changed.length;
    instance.writeArgument(["tags", "4"], "skip");
    instance.writeArgument(
      references ? ["pool", "4", "done"] : ["items", "4", "done"],
      true,
    );
    return {
      updates: instance.counts.groupUpdates - updates,
      writes: byOutput(
        recorder.changed.slice(begun).flatMap(({ writes }) => writes ?? []),
      ),
    };
  };

  it("reports one set of bindings at `*` for a `filter` over an array of plain values in place", async () => {
    for (const size of [10, 1_000]) {
      const { writes } = await run(size, false);
      // `kept` is output 0, of the `filter` of collection 0 over `tags`.
      expect(writes.get(0)?.elements).toEqual({
        0: {
          uniform: {
            slots: {
              1: {
                chain: [{ doc: ARGUMENT, path: ["tags", "*"] }],
                observes: "value",
              },
            },
          },
        },
      });
      // `open` over `items` in place is the same form.
      expect(writes.get(2)?.elements).toEqual({
        1: {
          uniform: {
            slots: {
              4: {
                chain: [{ doc: ARGUMENT, path: ["items", "*", "done"] }],
                observes: "value",
              },
            },
          },
        },
      });
    }
  });

  it("reports one group per distinct input for a `filter` over an array of references and over the result of a `map`", async () => {
    const [small, large] = [await run(10, true), await run(1_000, true)];
    for (const { writes } of [small, large]) {
      // `open` is output 2, of collection 1 over the references. An
      // element is read through its cell, the link having been followed
      // when the element table was formed.
      const open = writes.get(2)?.elements?.[1];
      expect(open).toMatchObject({
        groups: [{
          slots: {
            4: {
              chain: [{
                doc: ARGUMENT,
                path: ["pool", expect.any(String), "done"],
              }],
              observes: "value",
            },
          },
        }],
      });
      // `loud` is output 6, of collection 3 over the result of the `map`
      // of collection 2: its element is output 5 of the upstream element.
      const loud = writes.get(6)?.elements?.[3];
      expect(loud).toMatchObject({
        groups: [{
          slots: { 7: { output: 5 } },
          outputs: {
            5: {
              slots: {
                6: {
                  chain: [{
                    doc: ARGUMENT,
                    path: ["tags", expect.any(String)],
                  }],
                  observes: "value",
                },
              },
            },
          },
        }],
      });
    }
    const counts = (elements: unknown) =>
      (elements as { groups: { count: number }[] }).groups.map(({ count }) =>
        count
      );
    // The fold of a `filter` is over every element of its source, and
    // every element has the same inputs.
    expect(counts(small.writes.get(2)?.elements?.[1])).toEqual([10]);
    expect(counts(large.writes.get(2)?.elements?.[1])).toEqual([1_000]);
    expect(counts(large.writes.get(6)?.elements?.[3])).toEqual([1_000]);
    // A change of one element updates the groups of that element alone.
    expect(large.updates).toBe(small.updates);
    expect(small.updates).toBeGreaterThan(0);
  });
});

describe("the elements of a `fold` whose body holds another `fold`", () => {
  /**
   * `nested-fold.tsx` over two lists in place whose items are references,
   * the first to a document labeled "plain" and the second to one labeled
   * "secret": the two lists bind the same labels and differ in their inner
   * fold alone. Returns the elements of the outer fold that the record of
   * `busy` reports after `then` ran.
   */
  const run = async (then: (instance: Instance) => void = () => {}) => {
    const recorder = new Recorder((doc) =>
      doc === "secret" ? "secret" : "plain"
    );
    const instance = new Instance(
      await artifactOf("nested-fold"),
      {
        lists: [
          { name: "a", items: [{ $link: { doc: "plain", path: [] } }] },
          { name: "b", items: [{ $link: { doc: "secret", path: [] } }] },
        ],
      },
      {
        transactions: recorder,
        documents: [
          { id: "plain", kind: "input", value: "p" },
          { id: "secret", kind: "input", value: "s" },
        ],
      },
    );
    const begun = recorder.changed.length;
    then(instance);
    const writes = byOutput(
      recorder.changed.flatMap(({ writes }) => writes ?? []),
    );
    return {
      elements: writes.get(2)?.elements?.[0],
      changed: recorder.changed.length > begun,
    };
  };

  it("puts two elements whose inner folds differ into two groups", async () => {
    const { elements } = await run();
    expect(
      (elements as { groups: { count: number }[] }).groups.map(({ count }) =>
        count
      ),
    ).toEqual([1, 1]);
    // Each group reports the inner fold of its own element, through the
    // interim output of the inner `filter` that the outer body names.
    const inner = (elements as { groups: unknown[] }).groups.map((group) =>
      JSON.stringify(group).includes('"doc":"secret"')
    );
    expect(inner.sort()).toEqual([false, true]);
  });
});

describe("a label that changes while the value stays", () => {
  /**
   * `fold-groups.tsx` at `size`, with `items` an array of references, each
   * to a document of its own, all labeled "plain". The label of the
   * document of item 3 becomes "secret", the store reports it, and item 0
   * is pointed at the document of item 1, which runs the `filter` of
   * `open` again. Returns the counts of the groups that the record of
   * `open` reports, and the group updates the change of the label made.
   */
  const run = async (size: number) => {
    const labels = new Map<string, string>();
    const recorder = new Recorder((doc) => labels.get(doc) ?? "plain");
    const documents = Array.from({ length: size }, (_, index) => ({
      id: `item-${index}`,
      kind: "input",
      value: { title: `i${index}`, done: false },
    }));
    const instance = new Instance(
      await artifactOf("fold-groups"),
      {
        tags: [],
        items: documents.map(({ id }) => ({ $link: { doc: id, path: [] } })),
      },
      { transactions: recorder, documents },
    );
    const before = instance.counts.groupUpdates;
    labels.set("item-3", "secret");
    recorder.labelsChanged?.([{ doc: "item-3", paths: [[]] }]);
    const updates = instance.counts.groupUpdates - before;
    const begun = recorder.changed.length;
    instance.writeArgument(["items", "0"], {
      $link: { doc: "item-1", path: [] },
    });
    const open = byOutput(
      recorder.changed.slice(begun).flatMap(({ writes }) => writes ?? []),
    ).get(2)?.elements?.[1] as { groups: { count: number }[] } | undefined;
    return {
      counts: open?.groups.map(({ count }) => count).sort((a, b) => a - b),
      updates,
    };
  };

  it("regroups the elements that read the document, and no other", async () => {
    const small = await run(10);
    expect(small.counts).toEqual([1, 9]);
    const large = await run(1_000);
    expect(large.counts).toEqual([1, 999]);
    expect(small.updates).toBe(1);
    expect(large.updates).toBe(1);
  });
});

describe("a slot no evaluation bound", () => {
  it("binds a slot of the argument that no value code read to its position in the argument", async () => {
    // `state.result?.picks ?? []` reads the shape of `state.result` only
    // through the read of `picks`: no cone binds that slot, and the label
    // of its position is what the runtime observes at commit.
    for (
      const argument of [{ state: {} }, { state: { result: { picks: ["a"] } } }]
    ) {
      const recorder = new Recorder();
      const instance = new Instance(
        await artifactOf("optional-chain"),
        argument,
        { transactions: recorder },
      );
      const writes = recorder.changed.filter(({ doc }) => doc === instance.id)
        .flatMap(({ writes }) => writes ?? [])
        .filter(({ record }) => "output" in record);
      expect(writes.length).toBeGreaterThan(0);
      for (const write of writes) {
        expect(write.slots[0]).toEqual({
          chain: [{ doc: instance.argument, path: ["state", "result"] }],
          observes: "shape",
        });
      }
    }
  });
});

describe("a binding's state that the pattern computes", () => {
  it("binds the slot of a binding whose state is an output of the pattern to that output, with the output's inputs", async () => {
    // The state's `doubled` is the interim output 0: a value computed in
    // memory, at no stored position. The slot takes the label of the
    // output (PL §4.1, `SlotBinding`).
    const recorder = new Recorder();
    const instance = new Instance(
      await artifactOf("binding-output"),
      { n: 2, log: [] },
      { transactions: recorder },
    );
    const begun = recorder.changed.length;
    instance.send(bindingOf(instance, "bump"), {});
    const writes = recorder.changed.slice(begun)
      .flatMap(({ writes }) => writes ?? [])
      .filter(({ record }) => "body" in record);
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write.slots[1]).toEqual({ output: 0 });
      expect(write.outputs?.[0]?.slots[0]).toEqual({
        chain: [{ doc: instance.argument, path: ["n"] }],
        observes: "value",
      });
    }
  });
});

describe("an element at no stored position", () => {
  it("binds the slot of an element of an array a computation returned to the one position that computation read", async () => {
    // `items.get() || []` over an array of plain values in place: the
    // elements the `filter` sees are values in memory. The computation read
    // the stored array whole, whose label covers every element of it.
    const recorder = new Recorder();
    const instance = new Instance(
      await artifactOf("filter-of-computed"),
      { items: [{ done: true, text: "a" }, { done: false, text: "b" }] },
      { transactions: recorder },
    );
    const groups = recorder.changed.flatMap(({ writes }) => writes ?? [])
      .flatMap((write) => {
        const elements = write.outputs?.[0]?.elements?.[0];
        return elements !== undefined && "groups" in elements
          ? elements.groups
          : [];
      });
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.slots[2]).toEqual({
        chain: [{ doc: instance.argument, path: ["items"] }],
        observes: "value",
      });
    }
  });
});

// `fixtures/reduce.tsx` folds `items`, given here as references to a
// document each: the slot of what the `reduce` computed is bound to the
// position each step read, which a link of the array leads to.
describe("the positions a slot's read reached through links", () => {
  /** The chains below the slot of `total`, for `count` items. */
  const chainsBelow = async (
    count: number,
    label: (doc: string) => string,
  ): Promise<number> => {
    const recorder = new Recorder((doc) => label(doc));
    const documents = Array.from({ length: count }, (_, index) => ({
      id: `item-${index}`,
      kind: "input",
      value: { title: `t${index}`, amount: index },
    }));
    new Instance(
      await artifactOf("reduce"),
      {
        items: documents.map(({ id }) => ({ $link: { doc: id, path: [] } })),
        amounts: [1],
        bonus: 1,
      },
      { transactions: recorder, documents },
    );
    const total = recorder.changed.flatMap(({ writes }) => writes ?? []).find((
      write,
    ) => write.target.path.join("/") === "total");
    const [binding] = Object.values(total?.slots ?? {});
    if (binding === undefined || !("chain" in binding)) {
      throw new Error("The write of `total` binds no slot to a chain.");
    }
    return binding.below?.length ?? 0;
  };

  it("reports one chain for the positions whose labels are equal, for 3 items and for 30", async () => {
    const few = await chainsBelow(3, () => "one label");

    expect(few).toBeGreaterThan(0);
    expect(await chainsBelow(30, () => "one label")).toBe(few);
  });

  it("reports a chain for each position whose label is another", async () => {
    const few = await chainsBelow(3, (doc) => doc);

    expect(few).toBeGreaterThanOrEqual(3);
    expect(await chainsBelow(30, (doc) => doc)).toBe(few * 10);
  });
});

// `fixtures/remove-reference.tsx`: `add` pushes a record, which has a
// document of its own, and `dropFirst` removes the first record of the
// list.
describe("TransactionHooks for a removal from an array of references", () => {
  /** The run after two records were added, with what the removal changed. */
  const removed = async () => {
    const recorder = new Recorder();
    const instance = new Instance(
      await artifactOf("remove-reference"),
      { note: "n" },
      { transactions: recorder },
    );
    instance.send(bindingOf(instance, "add"), { title: "a" });
    instance.send(bindingOf(instance, "add"), { title: "b" });
    const records = [...instance.store.docs].flatMap(([doc, { value }]) =>
      typeof value === "object" && value !== null && "title" in value
        ? [{ doc, title: (value as { title: string }).title }]
        : []
    );
    const before = recorder.changed.length;
    instance.send(bindingOf(instance, "dropFirst"), {});
    return {
      instance,
      records,
      changed: recorder.changed.slice(before).filter(({ cause }) =>
        cause === "event"
      ),
      // The transaction of the event is the one that changed the list.
      undone: recorder.ends.flatMap(({ changes }) => changes).filter((
        undo,
      ) => "splice" in undo && undo.splice.inserted === 0),
    };
  };

  it("removes the member in place, as one splice of the list", async () => {
    const { records, undone } = await removed();
    const first = records.find(({ title }) => title === "a")!;

    expect(undone.map((undo) => "splice" in undo && undo.splice)).toEqual([{
      start: 0,
      inserted: 0,
      removed: [{ $link: { doc: first.doc, path: [] } }],
    }]);
  });

  it("changes the list alone, and no document of a record the list keeps", async () => {
    const { records, changed } = await removed();
    const kept = records.find(({ title }) => title === "b")!;
    const first = records.find(({ title }) => title === "a")!;

    const documents = new Set(changed.map(({ doc }) => doc));
    expect(documents.has(kept.doc)).toBe(false);
    expect(documents.has(first.doc)).toBe(false);
  });

  it("leaves in the list the reference to the record it keeps", async () => {
    const { instance, records, changed } = await removed();
    const kept = records.find(({ title }) => title === "b")!;

    const list = changed.find(({ value }) => Array.isArray(value));
    expect(list?.value).toEqual([{ $link: { doc: kept.doc, path: [] } }]);
    expect(instance.store.docs.get(kept.doc)?.value).toEqual({
      title: "b",
      note: "n",
    });
  });
});

// `fixtures/unchanged-write.tsx`: `raise` writes the greater of the inputs
// `level` and `floor`.
describe("TransactionHooks for a write that leaves the value as it was", () => {
  const raised = async (floor: number) => {
    const recorder = new Recorder();
    const instance = new Instance(
      await artifactOf("unchanged-write"),
      { floor, level: 3 },
      { transactions: recorder },
    );
    const before = recorder.changed.length;
    instance.send(bindingOf(instance, "raise"), {});
    return {
      instance,
      left: recorder.left,
      changed: recorder.changed.slice(before).filter(({ cause }) =>
        cause === "event"
      ),
    };
  };

  it("reports the write with the record of its write edge, and no change", async () => {
    const { instance, left, changed } = await raised(3);

    expect(changed).toEqual([]);
    expect(left.map(({ cause, doc, path, writes }) => ({
      cause,
      doc,
      path,
      records: writes.map(({ record, target }) => ({ record, target })),
    }))).toEqual([{
      cause: "event",
      doc: instance.argument,
      path: ["level"],
      records: [{
        record: { body: 0, write: 0 },
        target: { doc: instance.argument, path: ["level"] },
      }],
    }]);
  });

  it("gives the record of every kept output again, in a derivation transaction, after a label changed alone", async () => {
    const recorder = new Recorder();
    const instance = new Instance(
      await artifactOf("unchanged-write"),
      { floor: 3, level: 3 },
      { transactions: recorder },
    );
    const changed = recorder.changed.length;

    recorder.labelsChanged?.(
      [{ doc: instance.argument, paths: [["level"]] }],
      true,
    );
    instance.dispatch();

    expect(recorder.changed.length).toBe(changed);
    expect(recorder.left.map(({ cause, doc, writes }) => ({
      cause,
      doc,
      targets: writes.map(({ target }) => target.path.join("/")).sort(),
    }))).toEqual([{
      cause: "derivation",
      doc: instance.id,
      targets: ["level", "text"],
    }]);
  });

  it("gives no record again after labels changed with their values", async () => {
    const recorder = new Recorder();
    const instance = new Instance(
      await artifactOf("unchanged-write"),
      { floor: 3, level: 3 },
      { transactions: recorder },
    );

    recorder.labelsChanged?.([{ doc: instance.argument, paths: [["level"]] }]);
    instance.dispatch();

    expect(recorder.left).toEqual([]);
  });

  it("reports a change, and no such write, where the value differs", async () => {
    const { left, changed } = await raised(4);

    expect(left).toEqual([]);
    expect(changed.map(({ path, value }) => ({ path, value }))).toEqual([
      { path: ["level"], value: 4 },
    ]);
  });
});
