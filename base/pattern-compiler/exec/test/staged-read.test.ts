import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance, type Transaction } from "../executor.ts";

// `compare/fixtures/staged-read.tsx`: the handler `stage` pushes onto the
// input `items`, an array of plain values in place with no per-element
// construct over it, reads `joined`, which a cone writes from `items`, and
// throws where the event says so. A transaction that does not reach the
// storage leaves no derived value behind that follows from what it wrote
// (ES §1.6).

const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../compare/fixtures/staged-read.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find((pattern) => pattern.name === "default")!;
};

type Result = {
  items: string[];
  count: number;
  total: string;
  joined: string;
  loud: string;
  seen: string[];
};

/** The index of the binding of a name in the plan of an instance. */
const bindingOf = (instance: Instance, name: string): number => {
  const found = instance.plan.bindings.findIndex((binding) =>
    binding.name === name
  );
  if (found < 0) throw new Error(`no binding named ${name}`);
  return found;
};

/** The values of the result that follow from `items`, with `items`. */
const derived = (instance: Instance) => {
  const { items, count, total, joined, loud } = instance.result() as Result;
  return { items, count, total, joined, loud };
};

/**
 * The same values as the documents of the store hold them, read with no
 * evaluation: the document of the result, with each link in it followed
 * to the position it names.
 */
const stored = (instance: Instance) => {
  const { docs } = instance.store;
  const follow = (value: unknown): unknown => {
    const link = (value as { $link?: { doc: string; path: string[] } } | null)
      ?.$link;
    if (link === undefined) return value;
    let at = docs.get(link.doc)?.value;
    for (const segment of link.path) {
      at = (at as Record<string, unknown> | undefined)?.[segment];
    }
    return follow(at);
  };
  const result = docs.get("result")?.value as Record<string, unknown>;
  return Object.fromEntries(
    ["items", "count", "total", "joined", "loud"].map((
      name,
    ) => [name, follow(result[name])]),
  );
};

/** The transactions an instance ran while `run` was called. */
const during = (instance: Instance, run: () => void): Transaction[] => {
  const before = instance.transactions.length;
  run();
  return instance.transactions.slice(before);
};

const AFTER_A = {
  items: ["a"],
  count: 1,
  total: "1 in all",
  joined: "a",
  loud: "A",
};

describe("a handler that reads a derived value behind its own write", () => {
  it("reads the value as it was when its body started", async () => {
    const instance = new Instance(await artifact(), { items: [] });
    const stage = bindingOf(instance, "stage");

    instance.enqueue(stage, { text: "a" });
    instance.enqueue(stage, { text: "b" });
    instance.batch();

    // The second body reads what follows from the first event's write,
    // and neither reads what follows from its own.
    expect((instance.result() as Result).seen).toEqual(["", "a"]);
    expect(derived(instance)).toEqual({
      items: ["a", "b"],
      count: 2,
      total: "2 in all",
      joined: "a,b",
      loud: "A,B",
    });
  });

  it("leaves the derived values of the stored input where it throws behind the read", async () => {
    const instance = new Instance(await artifact(), { items: [] });
    const stage = bindingOf(instance, "stage");

    let outcomes: { committed: boolean; error?: string }[] = [];
    const transactions = during(instance, () => {
      instance.enqueue(stage, { text: "a" });
      instance.enqueue(stage, { text: "b", fail: true });
      outcomes = instance.batch();
    });

    expect(outcomes).toMatchObject([
      { committed: true },
      { committed: false, error: "the handler fails" },
    ]);
    // The transaction of the second event evaluated `_join` before the
    // body, over the first event's write, and stored nothing.
    expect(transactions[1]).toMatchObject({
      evaluated: ["_join"],
      committed: false,
      written: [],
    });
    // What is stored behind the batch is what a read of the result gives.
    expect(stored(instance)).toEqual(AFTER_A);
    expect(derived(instance)).toEqual(AFTER_A);
    expect((instance.result() as Result).seen).toEqual([""]);
  });

  it("leaves the derived values of the stored input where its commit is refused", async () => {
    let refusing = false;
    const instance = new Instance(await artifact(), { items: [] }, {
      refuses: () => refusing ? "refused" : undefined,
    });
    const stage = bindingOf(instance, "stage");
    instance.enqueue(stage, { text: "a" });
    instance.batch();
    refusing = true;

    instance.enqueue(stage, { text: "b" });
    const outcomes = instance.batch();

    expect(outcomes).toMatchObject([{ committed: false, error: "refused" }]);
    expect(stored(instance)).toEqual(AFTER_A);
    expect(derived(instance)).toEqual(AFTER_A);
    expect((instance.result() as Result).seen).toEqual([""]);
  });

  it("stores again what a cone wrote in the transaction of a handler that read it and threw, where the handler wrote nothing the cone read", async () => {
    const instance = new Instance(await artifact(), { items: [] });
    const stage = bindingOf(instance, "stage");
    const look = bindingOf(instance, "look");

    const transactions = during(instance, () => {
      instance.enqueue(stage, { text: "a" });
      instance.enqueue(look, { fail: true });
      instance.batch();
    });

    // The transaction of `look` evaluated the cones that the first event
    // made stale, and with it went what `_join` wrote into `joined` and
    // what `loud` computed from that. Nothing that they read changed.
    expect(transactions[1]).toMatchObject({
      evaluated: ["count", "_join", "loud"],
      committed: false,
      written: [],
    });
    expect(stored(instance)).toEqual(AFTER_A);
    expect(derived(instance)).toEqual(AFTER_A);
    expect((instance.result() as Result).seen).toEqual([""]);
  });

  it("hands the derived values of the stored input to the next event of the batch where the event before it was withdrawn", async () => {
    const instance = new Instance(await artifact(), { items: [] });
    const stage = bindingOf(instance, "stage");
    const look = bindingOf(instance, "look");

    instance.enqueue(stage, { text: "a" });
    instance.enqueue(stage, { text: "b", fail: true });
    instance.enqueue(look, {});
    const outcomes = instance.batch();

    expect(outcomes.map(({ committed }) => committed)).toEqual([
      true,
      false,
      true,
    ]);
    // `look` reads `count`, `joined` and `loud` behind the withdrawn
    // event: each follows from the one item that is stored.
    expect((instance.result() as Result).seen).toEqual(["", "1 a A"]);
    expect(stored(instance)).toEqual(AFTER_A);
    expect(derived(instance)).toEqual(AFTER_A);
  });
});

// A store outside the executor refuses a commit after the executor has
// gone on, and `Instance.restore` then takes what the storage holds for
// each document that the refused transaction wrote.
describe("a document that a cone wrote, restored to what the storage holds", () => {
  it("is written again by the cone, where nothing that the cone read changed", async () => {
    const instance = new Instance(await artifact(), { items: [] });
    instance.enqueue(bindingOf(instance, "stage"), { text: "a" });
    instance.batch();
    const result = instance.store.docs.get("result")?.value as {
      joined: { $link: { doc: string } };
    };

    // The storage holds the push onto `items`, and not what `_join` wrote
    // into `joined` behind it.
    instance.restore(result.joined.$link.doc, "");
    instance.settle();

    expect(stored(instance)).toEqual(AFTER_A);
    expect(derived(instance)).toEqual(AFTER_A);
  });
});
