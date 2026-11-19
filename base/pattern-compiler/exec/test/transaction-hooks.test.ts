import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type Artifact,
  Instance,
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

  /** Each read, with the number of brackets before it. */
  readonly reads: { at: number; doc: string; path: string[] }[] = [];

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

  read(doc: string, path: readonly string[]): void {
    this.reads.push({ at: this.brackets.length, doc, path: [...path] });
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
            1: {
              chain: [{ doc: ARGUMENT, path: ["tags", "*"] }],
              observes: "value",
            },
          },
        },
      });
      // `open` over `items` in place is the same form.
      expect(writes.get(2)?.elements).toEqual({
        1: {
          uniform: {
            4: {
              chain: [{ doc: ARGUMENT, path: ["items", "*", "done"] }],
              observes: "value",
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
          bindings: {
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
          bindings: { 7: { output: 5, keys: [[2, expect.any(String)]] } },
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
