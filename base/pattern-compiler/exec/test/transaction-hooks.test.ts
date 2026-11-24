import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type Artifact,
  Instance,
  type LabelChange,
  type Transaction,
  type TransactionHooks,
} from "../executor.ts";
import {
  type InputsTable,
  type NestedPlanWrite as PlanWrite,
  nestedWrite,
  type PlanWrite as IndexedWrite,
} from "../plan-write.ts";
import { argumentOf, Ref, type Store, type Undo } from "../store.ts";

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
  constructor(
    readonly label?: (
      doc: string,
      path: string[],
      observes: string,
    ) => string,
  ) {}

  labelOf(
    doc: string,
    path: readonly string[],
    observes = "value",
  ): string | undefined {
    return this.label?.(doc, [...path], observes);
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
    writes?: readonly IndexedWrite[],
    _splice?: unknown,
    inputs?: InputsTable,
  ): void {
    this.changed.push({
      at: this.brackets.length,
      cause: this.#cause,
      doc,
      path: [...path],
      value: structuredClone(store.peek(doc, path)),
      ...(writes === undefined || inputs === undefined
        ? {}
        : { writes: this.#nested(writes, inputs) }),
    });
  }

  /** Each write record given with a table, with the table. */
  readonly indexed: { write: IndexedWrite; inputs: InputsTable }[] = [];

  /** `writes` with the inputs each names in `inputs` held by value. */
  #nested(
    writes: readonly IndexedWrite[],
    inputs: InputsTable,
  ): PlanWrite[] {
    for (const write of writes) this.indexed.push({ write, inputs });
    return writes.map((write) => nestedWrite(write, inputs));
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
    writes: readonly IndexedWrite[],
    inputs: InputsTable,
  ): void {
    this.left.push({
      cause: this.#cause,
      doc,
      path: [...path],
      writes: this.#nested(writes, inputs),
    });
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

  /**
   * The same instance and change of the label of item 3, reported as a
   * change of the label alone. Returns the targets of the records given
   * again, each with whether its label alone is formed again.
   */
  const relabeled = async (size: number) => {
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
    labels.set("item-3", "secret");
    recorder.labelsChanged?.([{ doc: "item-3", paths: [[]] }], true);
    instance.dispatch();
    return recorder.left.flatMap(({ writes }) =>
      writes.map(({ target, relabel }) =>
        `${relabel ? "label of " : ""}/${target.path.join("/")}`
      )
    ).sort();
  };

  it("gives again the records of the outputs that read the changed label, the same ones among 10 elements and among 1,000", async () => {
    const small = await relabeled(10);
    const large = await relabeled(1_000);

    expect(small.length).toBeGreaterThan(0);
    expect(small.every((target) => target.startsWith("label of "))).toBe(true);
    expect(large).toEqual(small);
  });

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

describe("the table of inputs of a transaction", () => {
  it("holds the inputs of an output once for the records that name them", async () => {
    // `bump` writes through two write edges whose templates both reach
    // the interim output 0.
    const recorder = new Recorder();
    const instance = new Instance(
      await artifactOf("binding-output"),
      { n: 2, log: [] },
      { transactions: recorder },
    );
    const begun = recorder.indexed.length;

    instance.send(bindingOf(instance, "bump"), {});

    const given = recorder.indexed.slice(begun).filter(({ write }) =>
      "body" in write.record
    );
    expect(given.length).toBeGreaterThan(1);
    const tables = new Set(given.map(({ inputs }) => inputs));
    expect(tables.size).toBe(1);
    const [table] = tables;
    const named = new Set(
      given.map(({ write }) => table.inputs[write.inputs].outputs?.[0]),
    );
    expect(named.size).toBe(1);
    const [index] = named;
    expect(table.bindings[table.inputs[index!].slots[0]]).toEqual({
      chain: [{ doc: instance.argument, path: ["n"] }],
      observes: "value",
    });
  });

  it("holds no two entries with equal content", async () => {
    const recorder = new Recorder();
    const instance = new Instance(
      await artifactOf("chain"),
      {
        items: [{ title: "a", done: false }, { title: "b", done: false }],
        tags: ["x", "y"],
      },
      { transactions: recorder },
    );
    instance.writeArgument(["items", "1", "title"], "c");

    const tables = new Set(recorder.indexed.map(({ inputs }) => inputs));
    expect(tables.size).toBeGreaterThan(1);
    for (const table of tables) {
      const inputs = table.inputs.map((entry) => JSON.stringify(entry));
      const bindings = table.bindings.map((entry) => JSON.stringify(entry));
      expect(new Set(inputs).size).toBe(inputs.length);
      expect(new Set(bindings).size).toBe(bindings.length);
    }
  });
});

describe("an element at no stored position", () => {
  /** The slots of each element that a write of the `filter` names. */
  const elementSlots = (recorder: Recorder) =>
    recorder.changed.flatMap(({ writes }) => writes ?? [])
      .flatMap((write) => {
        const elements = write.outputs?.[0]?.elements?.[0];
        return elements !== undefined && "groups" in elements
          ? elements.groups
          : [];
      });

  it("binds the slot of an element of an array a computation returned to the one position that computation read", async () => {
    // `items?.get() || [...]` where `items` holds nothing: the `filter`
    // runs over the array written at the right, whose elements are values
    // in memory. The computation read `items` for the test of `||`.
    const recorder = new Recorder();
    const instance = new Instance(
      await artifactOf("filter-of-fallback"),
      {},
      { transactions: recorder },
    );
    const groups = elementSlots(recorder);
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.slots[2]).toEqual({
        chain: [{ doc: instance.argument, path: ["items"] }],
        observes: "value",
      });
    }
  });

  it("binds the slot of an element to its stored position where `||` selects a left operand that is an array of plain values in place", async () => {
    // `items.get() || []` where `items` holds an array: the result of
    // `||` is the reference to `items` (PL §3.5), so the `filter` runs
    // over the stored array and each element is at its position.
    const recorder = new Recorder();
    const instance = new Instance(
      await artifactOf("filter-of-computed"),
      { items: [{ done: true, text: "a" }, { done: false, text: "b" }] },
      { transactions: recorder },
    );
    const bound = elementSlots(recorder).map((group) => group.slots[2]);
    expect(bound.length).toBeGreaterThan(0);
    for (const position of ["0", "1"]) {
      expect(bound).toContainEqual({
        chain: [{ doc: instance.argument, path: ["items", position, "done"] }],
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
    label: (doc: string, path: string[], observes: string) => string,
  ): Promise<number> => {
    const recorder = new Recorder(label);
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

// `fixtures/lists.tsx`: `rows` of `Plain` is a `map` over `items`, given
// here as an array of references to a document each or as an array of plain
// values in place, and `rows` of `Chained` a `map` over the result of a
// `filter` over them, the result of another per-element construct.
describe("the records of the elements of the result of a `map`", () => {
  const patternOf = async (name: string): Promise<Artifact> => {
    const [{ patterns }] = JSON.parse(
      await Deno.readTextFile(
        new URL("../../compare/fixtures/lists.emit.json", import.meta.url),
      ),
    ) as { patterns: Artifact[] }[];
    return patterns.find((pattern) => pattern.name === name)!;
  };

  /**
   * An instance of a pattern of the fixture over `count` items, with the
   * label each item is given by its position, `plain` where it has none.
   */
  const over = async (
    pattern: string,
    kind: "references" | "in place",
    count: number,
    labels = new Map<number, string>(),
  ) => {
    const positionOf = (doc: string, path: string[]) =>
      doc.startsWith("item-")
        ? Number(doc.slice("item-".length))
        : path[0] === "items" && path.length > 1
        ? Number(path[1])
        : undefined;
    const recorder = new Recorder((doc, path) => {
      const position = positionOf(doc, path);
      return position === undefined ? "other" : labels.get(position) ?? "plain";
    });
    const values = Array.from({ length: count }, (_, index) => ({
      id: `id-${index}`,
      title: `t${index}`,
      done: false,
    }));
    const documents = kind === "in place" ? [] : values.map((value, index) => ({
      id: `item-${index}`,
      kind: "input",
      value,
    }));
    const instance = new Instance(
      await patternOf(pattern),
      {
        items: kind === "in place"
          ? values
          : documents.map(({ id }) => ({ $link: { doc: id, path: [] } })),
      },
      { transactions: recorder, documents },
    );
    /** The inputs each record of an element's `label` names, by position. */
    const inputsOf = () => {
      const found = new Map<string, number>();
      for (const { write } of recorder.indexed) {
        const { path } = write.target;
        if (path[0] === "rows" && path[2] === "label") {
          found.set(path[1], write.inputs);
        }
      }
      return found;
    };
    return { instance, recorder, labels, inputsOf };
  };

  const CASES = [
    ["an array of references", "Plain", "references"],
    ["an array of plain values in place", "Plain", "in place"],
    ["the result of another per-element construct", "Chained", "references"],
  ] as const;

  for (const [name, pattern, kind] of CASES) {
    it(`name one set of inputs where the labels of the elements are equal, among 10 elements and among 1,000, over ${name}`, async () => {
      for (const count of [10, 1_000]) {
        const { inputsOf } = await over(pattern, kind, count);
        const inputs = inputsOf();

        expect(inputs.size).toBe(count);
        expect(new Set(inputs.values()).size).toBe(1);
      }
    });

    it(`name inputs of its own for each label the elements hold, over ${name}`, async () => {
      const { inputsOf } = await over(
        pattern,
        kind,
        12,
        new Map([[2, "secret"], [5, "secret"], [7, "other secret"]]),
      );
      const inputs = inputsOf();

      expect(new Set(inputs.values()).size).toBe(3);
      expect(inputs.get("2")).toBe(inputs.get("5"));
      expect(inputs.get("2")).not.toBe(inputs.get("0"));
      expect(inputs.get("7")).not.toBe(inputs.get("2"));
    });
  }

  it("gives the record of an element again when the label of what it alone read changed, with inputs that name its own positions", async () => {
    const { instance, recorder, labels } = await over("Plain", "references", 8);
    labels.set(3, "secret");
    recorder.labelsChanged?.([{ doc: "item-3", paths: [[]] }], true);
    instance.dispatch();

    const again = recorder.left.flatMap(({ writes }) => writes).filter((
      { target },
    ) => target.path.join("/") === "rows/3/label");
    expect(again.length).toBe(1);
    expect(JSON.stringify(again[0].slots)).toContain("item-3");
    expect(
      recorder.left.flatMap(({ writes }) => writes).filter(({ target }) =>
        target.path[0] === "rows" && target.path[1] !== "3"
      ),
    ).toEqual([]);
  });

  it("gives the record of the first element alone again when the label of what that element read changed, among 10 elements and among 1,000", async () => {
    for (const count of [10, 1_000]) {
      const { instance, recorder, labels } = await over(
        "Plain",
        "references",
        count,
      );
      labels.set(0, "secret");
      recorder.labelsChanged?.([{ doc: "item-0", paths: [[]] }], true);
      instance.dispatch();

      expect(
        recorder.left.flatMap(({ writes }) => writes).filter(({ target }) =>
          target.path[0] === "rows"
        ).map(({ target }) => target.path.join("/")),
      ).toEqual(["rows/0/label"]);
    }
  });
});

// `fixtures/whole-after-push.tsx`: `all` is a text of everything the list
// `items` holds, given here as references to a document each: an array of
// references. The read of the list goes through each link to its record.
describe("a read that covers the members of an array of references", () => {
  /**
   * An instance over `count` records, each a document of its own, with the
   * label each document is given by its name, `plain` where it has none.
   */
  const over = async (count: number, labels = new Map<string, string>()) => {
    const asked: string[] = [];
    const recorder = new Recorder((doc, path, observes) => {
      asked.push(doc);
      // A link of the list as a reference is labeled as its position is.
      return doc.startsWith("item-")
        ? labels.get(doc) ?? "plain"
        : observes === "identity"
        ? "link"
        : `${path.length === 2 ? "member" : path.join("/")}`;
    });
    const documents = Array.from({ length: count }, (_, index) => ({
      id: `item-${index}`,
      kind: "input",
      value: { note: `n${index}`, amount: index },
    }));
    const instance = new Instance(
      await artifactOf("whole-after-push"),
      { items: documents.map(({ id }) => ({ $link: { doc: id, path: [] } })) },
      { transactions: recorder, documents },
    );
    /** The binding of the slot of the last record given for `all`. */
    const binding = () => {
      const given = [
        ...recorder.changed.flatMap(({ writes }) => writes ?? []),
        ...recorder.left.flatMap(({ writes }) => writes),
      ].filter(({ target }) => target.path.join("/") === "all");
      const [found] = Object.values(given[given.length - 1]?.slots ?? {});
      if (found === undefined || !("chain" in found)) {
        throw new Error("The record of `all` binds no slot to a chain.");
      }
      return found;
    };
    return { instance, recorder, asked, labels, binding };
  };

  it("binds the slot to one chain for each distinct label of the members, and names the container with its numbers of members and of groups", async () => {
    const { instance, binding } = await over(
      6,
      new Map([["item-2", "secret"], ["item-4", "secret"]]),
    );

    const found = binding();

    expect(found.below?.length).toBe(2);
    expect(found.members).toEqual([{
      container: { doc: instance.argument, path: ["items"] },
      count: 6,
      groups: 2,
    }]);
  });

  it("asks, where one member changed, for as many labels among 1,000 members as among 10", async () => {
    const asks = async (count: number) => {
      const { instance, asked, binding } = await over(count);
      asked.length = 0;
      instance.store.write(new Ref("item-1", ["amount"]), 99);
      instance.settle();
      expect(binding().members?.[0].count).toBe(count);
      return asked.length;
    };

    const small = await asks(10);

    expect(small).toBeGreaterThan(0);
    expect(await asks(1_000)).toBe(small);
  });

  it("asks for no label where the entry of the list's membership alone changed, among 10 members and among 1,000", async () => {
    const asks = async (count: number) => {
      const { instance, recorder, asked } = await over(count);
      asked.length = 0;
      recorder.labelsChanged?.([{
        doc: instance.argument,
        paths: [["items"]],
        alone: [["items"]],
      }]);
      instance.dispatch();
      return asked.length;
    };

    expect(await asks(10)).toBe(0);
    expect(await asks(1_000)).toBe(0);
  });

  it("moves a member whose label changed to the group of its label, and forms the label of the output that read the list again", async () => {
    const { instance, recorder, labels, binding } = await over(8);
    expect(binding().members?.[0].groups).toBe(1);

    labels.set("item-5", "secret");
    recorder.labelsChanged?.([{ doc: "item-5", paths: [[]] }], true);
    instance.dispatch();

    expect(
      recorder.left.flatMap(({ writes }) =>
        writes.map(({ target, relabel }) =>
          `${relabel ? "label of " : ""}/${target.path.join("/")}`
        )
      ),
    ).toEqual(["label of /all"]);
    const found = binding();
    expect(found.below?.length).toBe(2);
    expect(found.members?.[0]).toMatchObject({ count: 8, groups: 2 });
  });

  it("gives no record again where the label of a member changed to one another member has", async () => {
    const { instance, recorder, labels } = await over(
      8,
      new Map([["item-1", "secret"], ["item-2", "secret"]]),
    );

    labels.set("item-5", "secret");
    recorder.labelsChanged?.([{ doc: "item-5", paths: [[]] }], true);
    instance.dispatch();

    expect(recorder.left).toEqual([]);
  });

  it("counts a member the list gains in the group of its label", async () => {
    const { instance, binding } = await over(4);

    instance.send(bindingOf(instance, "append"), {});

    expect(binding().members?.[0].count).toBe(5);
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
describe("the records of a change of a list's members through a handle", () => {
  /** The records of the changes of the last event sent, by target path. */
  const recordsOf = (recorder: Recorder, from: number) =>
    recorder.changed.slice(from).filter(({ cause }) => cause === "event")
      .flatMap(({ writes }) => writes ?? []);

  /** What a record observes beside its template, as `class /path`. */
  const observedBy = (
    positions: PlanWrite["observed"],
  ) =>
    (positions ?? []).map(({ address, observes }) =>
      `${observes} /${address.path.join("/")}`
    );

  // `fixtures/remove-shift.tsx`: a list of plain values in place.
  describe("over plain values in place", () => {
    const pushed = async () => {
      const recorder = new Recorder();
      const instance = new Instance(
        await artifactOf("remove-shift"),
        { note: "n" },
        { transactions: recorder },
      );
      const send = (name: string, event: unknown) => {
        const from = recorder.changed.length;
        instance.send(bindingOf(instance, name), event);
        return recordsOf(recorder, from);
      };
      send("addWord", { word: "x" });
      send("addNote", {});
      return { send };
    };

    it("records a push at the position added, at the number of members and for the membership, the last two with what the list stored of its membership", async () => {
      const { send } = await pushed();
      const records = send("addWord", { word: "y" });

      expect(
        records.map(({ target, enumeration }) =>
          `${enumeration ? "enumeration " : ""}/${target.path.join("/")}`
        ),
      ).toEqual(["/2", "/length", "enumeration /"]);
      expect(records[0].observed).toBeUndefined();
      for (const { observed } of records.slice(1)) {
        expect(observedBy(observed)).toEqual([
          "value /length",
          "enumeration /",
        ]);
      }
    });

    it("records a removal at the number of members and for the membership, which names the members that moved, and at no position", async () => {
      const { send } = await pushed();
      send("addWord", { word: "y" });
      const records = send("drop", { word: "x" });

      expect(
        records.map(({ target, enumeration }) =>
          `${enumeration ? "enumeration " : ""}/${target.path.join("/")}`
        ),
      ).toEqual(["/length", "enumeration /"]);
      expect(records[1]).toMatchObject({
        removes: true,
        start: 0,
        moves: [{ from: 1, to: 0, count: 2 }],
      });
    });

    it("gives every record of a removal what the comparison read: the membership and the value at each position", async () => {
      const { send } = await pushed();
      const records = send("drop", { word: "x" });

      for (const { decided } of records) {
        expect(observedBy(decided)).toEqual([
          "enumeration /",
          "value /0",
          "value /1",
        ]);
      }
      expect(new Set(records.map(({ decided }) => decided)).size).toBe(1);
    });

    it("records the membership alone, as left as it was, for a removal that finds no member", async () => {
      const recorder = new Recorder();
      const instance = new Instance(
        await artifactOf("remove-shift"),
        { note: "n" },
        { transactions: recorder },
      );
      instance.send(bindingOf(instance, "addWord"), { word: "x" });
      const from = recorder.changed.length;
      instance.send(bindingOf(instance, "drop"), { word: "q" });
      const unchanged = recorder.left.flatMap(({ writes }) => writes);

      expect(recordsOf(recorder, from)).toEqual([]);
      expect(
        unchanged.map(({ target, enumeration }) =>
          `${enumeration ? "enumeration " : ""}/${target.path.join("/")}`
        ),
      ).toEqual(["/length", "enumeration /"]);
      expect(observedBy(unchanged[0].decided)).toEqual([
        "enumeration /",
        "value /0",
      ]);
    });
  });

  // `fixtures/remove-reference.tsx`: an array of references.
  describe("over an array of references", () => {
    it("gives the records of a removal the reference at each compared position, and reads no document a reference names", async () => {
      const recorder = new Recorder();
      const instance = new Instance(
        await artifactOf("remove-reference"),
        { note: "n" },
        { transactions: recorder },
      );
      instance.send(bindingOf(instance, "add"), { title: "a" });
      instance.send(bindingOf(instance, "add"), { title: "b" });
      const from = recorder.changed.length;
      instance.send(bindingOf(instance, "dropFirst"), {});
      const records = recordsOf(recorder, from);

      expect(observedBy(records[0].decided)).toEqual([
        "enumeration /",
        "identity /0",
      ]);
      expect(records.map(({ target }) => `/${target.path.join("/")}`))
        .toEqual(["/length", "/"]);
      expect(records[1].moves).toEqual([{ from: 1, to: 0, count: 1 }]);
    });
  });
});

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

  it("gives the record of each output that read it again, in a derivation transaction, after a label changed alone", async () => {
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

  it("gives the record of each output that read it again after a label changed with the values of positions the output did not read", async () => {
    const recorder = new Recorder();
    const instance = new Instance(
      await artifactOf("unchanged-write"),
      { floor: 3, level: 3 },
      { transactions: recorder },
    );

    // The store does not say that no value changed, and no value the
    // outputs read did: nothing evaluates them again.
    recorder.labelsChanged?.([{ doc: instance.argument, paths: [["level"]] }]);
    instance.dispatch();

    expect(recorder.left.map(({ cause, writes }) => ({
      cause,
      targets: writes.map(({ target, relabel }) =>
        `${relabel ? "label of " : ""}${target.path.join("/")}`
      ).sort(),
    }))).toEqual([{
      cause: "derivation",
      targets: ["label of level", "label of text"],
    }]);
  });

  it("gives no record of the label alone for an output that is given again with its value", async () => {
    const recorder = new Recorder();
    const instance = new Instance(
      await artifactOf("unchanged-write"),
      { floor: 3, level: 3 },
      { transactions: recorder },
    );

    recorder.labelsChanged?.([{ doc: instance.argument, paths: [["level"]] }]);
    instance.writeArgument(["level"], 5);
    instance.dispatch();

    const again = recorder.left.flatMap(({ writes }) =>
      writes.map(({ target, relabel }) =>
        `${relabel ? "label of " : ""}${target.path.join("/")}`
      )
    );
    expect(again).not.toContain("label of text");
  });

  it("reports a change, and no such write, where the value differs", async () => {
    const { left, changed } = await raised(4);

    expect(left).toEqual([]);
    expect(changed.map(({ path, value }) => ({ path, value }))).toEqual([
      { path: ["level"], value: 4 },
    ]);
  });
});

// `fixtures/list-records.tsx`: each record `add` pushes is a document of its
// own, which the list holds a link to. A read of the list's value goes
// through each link to its record, and each such pair of positions is a
// further chain of the slot's binding.
describe("the chains of a read of a value that holds links", () => {
  /**
   * The most further chains a slot binding has, after `count` records were
   * appended to a list whose first member is a plain value in place. Each
   * appended record is a document of its own that the list holds a link
   * to, and `all` of `whole-after-push.tsx` reads the list as a value.
   */
  const chainsThroughLinks = async (
    count: number,
    label: (doc: string, path: string[], observes: string) => string,
  ): Promise<number> => {
    const recorder = new Recorder(label);
    const instance = new Instance(
      await artifactOf("whole-after-push"),
      { items: [{ note: "a", amount: 1 }] },
      { transactions: recorder },
    );
    for (let index = 0; index < count; index++) {
      instance.send(bindingOf(instance, "append"), {});
    }
    let most = 0;
    for (const { writes } of recorder.changed) {
      for (const write of writes ?? []) {
        for (const binding of Object.values(write.slots)) {
          if ("chain" in binding) {
            most = Math.max(most, binding.below?.length ?? 0);
          }
        }
      }
    }
    return most;
  };

  it("reports one chain for the links whose labels are equal, as values and as references, for 4 records and for 8", async () => {
    const few = await chainsThroughLinks(4, () => "one label");

    expect(await chainsThroughLinks(8, () => "one label")).toBe(few);
  });

  // The runtime observes a link a read crossed as a reference, and the
  // label of that observation is not part of the label of a read of the
  // value at the link's position.
  it("reports a chain for each link whose label as a reference is another, where the labels of the values are equal", async () => {
    const byReference = (doc: string, path: string[], observes: string) =>
      observes === "identity" ? `${doc}/${path.join("/")}` : "one label";
    const few = await chainsThroughLinks(4, byReference);

    expect(few).toBeGreaterThanOrEqual(3);
    expect(await chainsThroughLinks(8, byReference)).toBe(few + 4);
  });
});

describe("a read that stops at the links of a record of handles", () => {
  /**
   * The record of `rows` of `record-of-unread-handles.tsx` over three
   * members, each a link to a document of its own. The label of a link as
   * a reference is another for each member, and so is that of each
   * document.
   */
  const record = async (
    count = 3,
    label = (doc: string, path: string[], observes: string) =>
      `${doc}/${path.join("/")}/${observes}`,
    output = "rows",
  ) => {
    const recorder = new Recorder(label);
    const documents = Array.from({ length: count }, (_, index) => ({
      id: `item-${index}`,
      kind: "input",
      value: { note: `n${index}` },
    }));
    const instance = new Instance(
      await artifactOf("record-of-unread-handles"),
      {
        byName: Object.fromEntries(
          documents.map((
            { id },
            index,
          ) => [`k${index}`, { $link: { doc: id, path: [] } }]),
        ),
        held: { member: { $link: { doc: "item-0", path: [] } }, name: "h" },
      },
      { transactions: recorder, documents },
    );
    const [write] = recorder.changed.flatMap(({ writes }) => writes ?? [])
      .filter(({ target }) => target.path.join("/") === output);
    // Each position the record names, with whether the runtime observes it
    // as a reference: every position of an `identity` slot, and every
    // position of a chain but its last.
    const positions: { doc: string; path: string; reference: boolean }[] = [];
    for (const binding of Object.values(write.slots)) {
      if (!("chain" in binding)) continue;
      for (const chain of [binding.chain, ...(binding.below ?? [])]) {
        chain.forEach(({ doc, path }, at) =>
          positions.push({
            doc,
            path: path.join("/"),
            reference: binding.observes === "identity" ||
              at < chain.length - 1,
          })
        );
      }
    }
    return { instance, positions };
  };

  it("names no position of a document a member links to", async () => {
    const { positions } = await record();

    expect(positions.filter(({ doc }) => doc.startsWith("item-"))).toEqual([]);
  });

  it("observes the link of each member as a reference", async () => {
    const { instance, positions } = await record();

    const references = new Set(
      positions.filter(({ doc, reference }) =>
        reference && doc === instance.argument
      ).map(({ path }) => path),
    );
    // The `identity` slot at `byName/*` observes each, at `*` below the
    // record.
    expect([...references]).toEqual(["byName/*"]);
  });

  it("names as many positions for 30 members as for 3 where the links hold one label as references", async () => {
    const one = (_doc: string, path: string[], observes: string) =>
      `${path.length}/${observes}`;
    const few = await record(3, one);

    expect((await record(30, one)).positions.length).toBe(
      few.positions.length,
    );
  });

  it("binds a slot of the class `shape` whose read stopped at a link of a member to that link as a reference and to its own position, and to nothing of what the link leads to", async () => {
    const { instance, positions } = await record(3, undefined, "text");

    expect(positions).toEqual([
      { doc: instance.argument, path: "held/member", reference: true },
      { doc: instance.argument, path: "held", reference: false },
    ]);
  });

  it("names no position below the link of a member", async () => {
    const { instance, positions } = await record();

    expect(
      positions.filter(({ doc, path }) =>
        doc === instance.argument && path.split("/").length > 2
      ),
    ).toEqual([]);
  });
});

describe("the slot of a count of an array of references", () => {
  // `items.length` of `length-of-labeled.tsx` observes which members the
  // list has. The value code reads the list as a value, through each
  // reference, which is a wider read than the slot's: a slot of the class
  // `enumeration` consumes nothing below its bound address and has no
  // further binding (PL §2.5).
  it("is bound to the list alone, and to no position of a member's document", async () => {
    const recorder = new Recorder((doc, path, observes) =>
      `${doc}/${path.join("/")}/${observes}`
    );
    const documents = [0, 1, 2].map((index) => ({
      id: `item-${index}`,
      kind: "input",
      value: { note: `n${index}`, amount: index },
    }));
    const instance = new Instance(
      await artifactOf("length-of-labeled"),
      { items: documents.map(({ id }) => ({ $link: { doc: id, path: [] } })) },
      { transactions: recorder, documents },
    );

    const [write] = recorder.changed.flatMap(({ writes }) => writes ?? [])
      .filter(({ target }) => target.path.join("/") === "count");
    expect(Object.values(write.slots)).toEqual([{
      chain: [{ doc: instance.argument, path: ["items"] }],
      observes: "enumeration",
    }]);
  });
});

describe("the records of the row documents a `lift` writes", () => {
  /**
   * `created-rows.tsx` over `size` items, each a document of its own, all
   * labeled "plain" but those `labels` names. `rows(from)` gives the
   * records given for row documents since the mark `from`, each as the
   * title its row holds, with `label of ` before it where the record forms
   * the label alone again.
   */
  const started = async (size: number) => {
    const labels = new Map<string, string>();
    const recorder = new Recorder((doc) => labels.get(doc) ?? "plain");
    const documents = Array.from({ length: size }, (_, index) => ({
      id: `item-${index}`,
      kind: "input",
      value: { title: `t${index}` },
    }));
    const instance = new Instance(
      await artifactOf("created-rows"),
      {
        items: documents.map(({ id }) => ({ $link: { doc: id, path: [] } })),
        other: "o",
      },
      { transactions: recorder, documents },
    );
    const rows = (from: number) =>
      recorder.left.slice(from).flatMap(({ writes }) => writes).filter((
        { record },
      ) => "body" in record).map(({ target, relabel }) =>
        `${relabel ? "label of " : ""}${
          (instance.store.peek(target.doc, target.path) as { title: string })
            .title
        }`
      ).sort();
    const enter = (index: number) => {
      instance.store.create(`item-${index}`, "input", { title: `t${index}` });
      instance.store.splice(new Ref(instance.argument, ["items"]), index, 0, [
        { $link: { doc: `item-${index}`, path: [] } },
      ]);
      instance.settle();
    };
    return { instance, recorder, labels, rows, enter };
  };

  it("gives a record for each row when the `lift` first runs", async () => {
    const { rows } = await started(3);

    expect(rows(0)).toEqual(["T0", "T1", "T2"]);
  });

  it("gives a record for the one row whose value changed when the `lift` runs again", async () => {
    const { instance, recorder, rows } = await started(3);
    const mark = recorder.left.length;

    instance.store.write(new Ref("item-1", ["title"]), "edited");
    instance.settle();

    expect(rows(mark)).toEqual(["EDITED"]);
  });

  it("gives a record for the row of a member that enters under a label the `lift` had read, and for no other row", async () => {
    const { recorder, rows, enter } = await started(3);
    const mark = recorder.left.length;

    enter(3);

    expect(rows(mark)).toEqual(["T3"]);
  });

  it("gives a record for every row when a member enters under a label the `lift` had not read", async () => {
    const { recorder, labels, rows, enter } = await started(3);
    const mark = recorder.left.length;
    labels.set("item-3", "secret");

    enter(3);

    expect(rows(mark)).toEqual(["T0", "T1", "T2", "T3"]);
  });

  it("gives no record when a member leaves whose label the members that stayed share", async () => {
    const { instance, recorder, rows } = await started(3);
    const mark = recorder.left.length;

    instance.store.splice(new Ref(instance.argument, ["items"]), 2, 1, []);
    instance.settle();

    // The one clause is still read through the members that stayed, and
    // the rows hold what they held.
    expect(rows(mark)).toEqual([]);
  });

  it("forms the label of every row again when a label the `lift` read changes while no value does", async () => {
    const { instance, recorder, labels, rows } = await started(3);
    const mark = recorder.left.length;

    labels.set("item-1", "secret");
    recorder.labelsChanged?.([{ doc: "item-1", paths: [[]] }], true);
    instance.dispatch();

    expect(rows(mark)).toEqual(["label of T0", "label of T1", "label of T2"]);
  });

  it("forms no label again when a label changes that the `lift` did not read", async () => {
    const { instance, recorder, rows } = await started(3);
    const mark = recorder.left.length;

    recorder.labelsChanged?.([{ doc: "unread", paths: [[]] }], true);
    instance.dispatch();

    expect(rows(mark)).toEqual([]);
  });
});

// `fixtures/named-position.tsx`: the row of a `map` over an array of
// references holds the cell of its item, which its body names as
// `items.key(index)` and does not read. The plan has a slot for the
// reference at `items/*`, and no read binds it.
describe("a slot of the reference at a position that a body named through a handle and did not read", () => {
  /** An instance over `count` items, each a document of its own. */
  const over = async (count: number) => {
    const recorder = new Recorder((doc, path, observes) =>
      `${doc}/${path.join("/")} ${observes}`
    );
    const documents = Array.from({ length: count }, (_, index) => ({
      id: `item-${index}`,
      kind: "input",
      value: { title: `t${index}`, n: index },
    }));
    const instance = new Instance(
      await artifactOf("named-position"),
      { items: documents.map(({ id }) => ({ $link: { doc: id, path: [] } })) },
      { transactions: recorder, documents },
    );
    /** The paths each record of `rows/<row>/item` binds a chain to. */
    const named = (row: number) =>
      [
        ...recorder.changed.flatMap(({ writes }) => writes ?? []),
        ...recorder.left.flatMap(({ writes }) => writes),
      ].filter(({ target }) => target.path.join("/") === `rows/${row}/item`)
        .flatMap(({ slots }) => Object.values(slots)).flatMap((bound) =>
          "chain" in bound
            ? [bound.chain[bound.chain.length - 1].path.join("/")]
            : []
        );
    return { instance, recorder, named };
  };

  it("binds the slot to the position the body named, and to no position that names every member", async () => {
    const { named } = await over(3);

    for (const row of [0, 1, 2]) {
      expect(named(row)).toContain(`items/${row}`);
      expect(named(row)).not.toContain("items/*");
    }
  });

  it("gives the record of one row again when the label at the position of its member changed, and of no other row, among 10 members and among 1,000", async () => {
    for (const count of [10, 1_000]) {
      const { instance, recorder } = await over(count);
      const given = recorder.left.length;

      // The store says that a read of the second position consumes
      // another label, and that a read of no other position does.
      recorder.labelsChanged?.(
        [{
          doc: instance.argument,
          paths: [["items", "1"]],
          unchanged: (path) => path.join("/") !== "items/1",
        }],
        true,
      );
      instance.dispatch();

      expect(
        recorder.left.slice(given).flatMap(({ writes }) => writes).filter((
          { target },
        ) => target.path[0] === "rows").map(({ target }) =>
          target.path.join("/")
        ),
      ).toEqual(["rows/1/item"]);
    }
  });
});

// `fixtures/unchanged-place.tsx`: a change of `count` gives `parity`
// another value, and the result is compared with its form whole, `chosen`
// with it. The record of a place that holds what it held forms the label
// of the place again, so it is given where the inputs of the place are
// other ones than those the record last given for it had, and not
// otherwise.
describe("the record of a place of the result that a comparison left as it was", () => {
  const started = async () => {
    const recorder = new Recorder();
    const instance = new Instance(
      await artifactOf("unchanged-place"),
      { count: 1, useLeft: true, left: 5, right: 7 },
      { transactions: recorder },
    );
    /** The targets of the records given for places left as they were. */
    const leftBy = (event: { count?: number; useLeft?: boolean }) => {
      const given = recorder.left.length;
      instance.send(bindingOf(instance, "set"), event);
      return recorder.left.slice(given).filter(({ cause }) =>
        cause === "derivation"
      ).flatMap(({ writes }) => writes).map(({ target }) =>
        target.path.join("/")
      );
    };
    return { instance, recorder, leftBy };
  };

  it("is not given again where the place has the inputs it had", async () => {
    const { instance, leftBy } = await started();

    const left = leftBy({ count: 2 });

    expect(instance.result()).toMatchObject({ parity: 0, chosen: true });
    expect(left).toEqual([]);
  });

  it("is not given again at any of three changes in a row", async () => {
    const { leftBy } = await started();

    const left = [2, 3, 4].flatMap((count) => leftBy({ count }));

    expect(left).toEqual([]);
  });

  it("is given again where an evaluation bound a slot to another position", async () => {
    const { instance, leftBy } = await started();

    const left = leftBy({ count: 2, useLeft: false });

    expect(instance.result()).toMatchObject({ parity: 0, chosen: true });
    expect(left).toEqual(["chosen"]);
  });

  it("is given again where a label the record read changed", async () => {
    const { instance, recorder, leftBy } = await started();

    recorder.labelsChanged?.([{ doc: instance.argument, paths: [["left"]] }]);
    const left = leftBy({ count: 2 });

    expect(left).toEqual(["chosen"]);
  });
});
