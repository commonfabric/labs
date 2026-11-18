import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance, type Transaction } from "../executor.ts";

// The serving loop of `scheduler-and-serving-loop.md` (SS) §5 and §8 and
// the transactions of `execution-and-storage.md` (ES) §1, on the
// artifacts of the fixtures of the comparison.

const artifactOf = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(`../../compare/fixtures/${name}.emit.json`, import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find((pattern) => pattern.name === "default") ??
    patterns[patterns.length - 1];
};

/** The index of the binding of a name in the plan of an instance. */
const bindingOf = (instance: Instance, name: string): number => {
  const found = instance.plan.bindings.findIndex((binding) =>
    binding.name === name
  );
  if (found < 0) throw new Error(`no binding named ${name}`);
  return found;
};

/** The transactions an instance ran while `run` was called. */
const during = (instance: Instance, run: () => void): Transaction[] => {
  const before = instance.transactions.length;
  run();
  return instance.transactions.slice(before);
};

const causes = (transactions: readonly Transaction[]): string[] =>
  transactions.map(({ cause }) => cause);

// `fixtures/batch.tsx`: `items` is an array of plain values in place that
// handlers push strings onto, and no per-element construct is over it.
describe("a batch of events", () => {
  type Result = {
    items: string[];
    count: number;
    total: string;
    seen: number[];
    copied: string;
  };

  it("creates an instance in one transaction and settles it in one more", async () => {
    const instance = new Instance(await artifactOf("batch"), {});

    expect(causes(instance.transactions)).toEqual(["creation", "derivation"]);
    const [creation, derivation] = instance.transactions;
    expect(creation.evaluated).toEqual([]);
    expect(creation.written).toEqual([instance.argument, instance.id]);
    expect(derivation.evaluated).toContain("count");
    expect(derivation.written).toContain(instance.id);
  });

  it("gives each event a transaction and settles once behind the batch", async () => {
    const instance = new Instance(await artifactOf("batch"), {});
    const add = bindingOf(instance, "adding");

    const transactions = during(instance, () => {
      instance.enqueue(add, { text: "a" });
      instance.enqueue(add, { text: "b" });
      // Nothing is handled until the batch is.
      expect((instance.result() as Result).items).toEqual([]);
      instance.batch();
    });

    expect(causes(transactions)).toEqual(["event", "event", "derivation"]);
    // An event's transaction holds no derivation behind the body.
    expect(transactions[0].evaluated).toEqual([]);
    expect(transactions[1].evaluated).toEqual([]);
    // `count` reads the whole array: it is evaluated once for the batch.
    expect(transactions[2].evaluated.filter((cone) => cone === "count"))
      .toEqual(["count"]);
    expect(transactions[2].evaluated.filter((cone) => cone === "total"))
      .toEqual(["total"]);
    expect(instance.result()).toMatchObject({
      items: ["a", "b"],
      count: 2,
      total: "2 in all",
    });
  });

  it("settles after each event where each event is a batch of its own", async () => {
    const instance = new Instance(await artifactOf("batch"), {});
    const add = bindingOf(instance, "adding");

    const transactions = during(instance, () => {
      instance.send(add, { text: "a" });
      instance.send(add, { text: "b" });
    });

    expect(causes(transactions)).toEqual([
      "event",
      "derivation",
      "event",
      "derivation",
    ]);
    expect(
      transactions.flatMap(({ evaluated }) => evaluated).filter((cone) =>
        cone === "count"
      ),
    ).toEqual(["count", "count"]);
    expect((instance.result() as Result).count).toBe(2);
  });

  it("evaluates before a body the stale cone that computes what it reads", async () => {
    const instance = new Instance(await artifactOf("batch"), {});
    const add = bindingOf(instance, "adding");
    const note = bindingOf(instance, "note");

    const transactions = during(instance, () => {
      instance.enqueue(add, { text: "a" });
      instance.enqueue(add, { text: "b" });
      instance.enqueue(note, {});
      instance.batch();
    });

    expect(causes(transactions)).toEqual([
      "event",
      "event",
      "event",
      "derivation",
    ]);
    // The handler reads `count` as of its event: the two earlier events
    // of the batch made it stale, and it is evaluated in the handler's
    // transaction, before the body.
    expect(transactions[2].evaluated).toEqual(["count"]);
    expect((instance.result() as Result).seen).toEqual([2]);
    // Behind the batch `count` is current, and `total`, which no handler
    // read, is evaluated.
    expect(transactions[3].evaluated).not.toContain("count");
    expect(transactions[3].evaluated).toContain("total");
  });

  it("evaluates before a body the stale cone that writes a cell it reads", async () => {
    const instance = new Instance(await artifactOf("batch"), {});
    const add = bindingOf(instance, "adding");
    const copy = bindingOf(instance, "copy");

    const transactions = during(instance, () => {
      instance.enqueue(add, { text: "a" });
      instance.enqueue(add, { text: "b" });
      instance.enqueue(copy, {});
      instance.batch();
    });

    // `_join` writes `joined`, which the handler reads through a handle.
    expect(transactions[2].evaluated).toEqual(["_join"]);
    expect((instance.result() as Result).copied).toBe("a,b");
  });

  it("handles in the same batch an event that a handler sends", async () => {
    const instance = new Instance(await artifactOf("batch"), {});
    const add = bindingOf(instance, "adding");
    const relay = bindingOf(instance, "relay");

    let outcomes: { binding: number; committed: boolean }[] = [];
    const transactions = during(instance, () => {
      instance.enqueue(relay, { text: "x" });
      instance.enqueue(add, { text: "y" });
      outcomes = instance.batch();
    });

    // The event that `relay` sent joined the queue behind the events
    // that were queued when its transaction ended.
    expect(outcomes.map(({ binding }) => binding)).toEqual([relay, add, add]);
    expect(causes(transactions)).toEqual([
      "event",
      "event",
      "event",
      "derivation",
    ]);
    expect((instance.result() as Result).items).toEqual(["y", "x!"]);
  });

  it("aborts the transaction of a body that throws and no other", async () => {
    const instance = new Instance(await artifactOf("batch"), {});
    const add = bindingOf(instance, "adding");
    const fail = bindingOf(instance, "fail");

    let outcomes: { committed: boolean; error?: string }[] = [];
    const transactions = during(instance, () => {
      instance.enqueue(add, { text: "a" });
      instance.enqueue(fail, {});
      instance.enqueue(add, { text: "b" });
      outcomes = instance.batch();
    });

    expect(outcomes.map(({ committed }) => committed)).toEqual([
      true,
      false,
      true,
    ]);
    expect(outcomes[1].error).toBe("the handler fails");
    expect(transactions[1]).toMatchObject({ committed: false, written: [] });
    expect((instance.result() as Result).items).toEqual(["a", "b"]);
  });

  it("writes no document for a cause that changes nothing", async () => {
    const instance = new Instance(await artifactOf("batch"), {});
    const copy = bindingOf(instance, "copy");
    // The first write of a state cell makes its document.
    instance.send(copy, {});

    const transactions = during(instance, () => {
      // `copied` holds what `joined` holds already.
      instance.enqueue(copy, {});
      instance.batch();
    });

    expect(causes(transactions)).toEqual(["event", "derivation"]);
    expect(transactions[0].written).toEqual([]);
    expect(transactions[1].written).toEqual([]);
    expect(transactions[1].evaluated).toEqual([]);
  });
});
