import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type Artifact,
  Instance,
  MAX_EVALUATIONS,
  type Transaction,
} from "../executor.ts";

// The serving loop of `scheduler-and-serving-loop.md` (SS) §5 and §8 and
// the transactions of `execution-and-storage.md` (ES) §1, on the
// artifacts of the fixtures of the comparison.

const patternsOf = async (name: string): Promise<Artifact[]> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(`../../compare/fixtures/${name}.emit.json`, import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns;
};

const artifactOf = async (name: string): Promise<Artifact> => {
  const patterns = await patternsOf(name);
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

/** How many times each cone was evaluated in some transactions. */
const evaluations = (
  transactions: readonly Transaction[],
): Record<string, number> => {
  const times: Record<string, number> = {};
  for (const { evaluated } of transactions) {
    for (const cone of evaluated) times[cone] = (times[cone] ?? 0) + 1;
  }
  return times;
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

// `fixtures/batch.tsx` again: the cone `_join` writes `joined` from
// `items`, and the handler `overwrite` writes `joined` and reads nothing.
// ES §1.3 has the writing cone instance evaluated before a body where "a
// slot of the handler" is bound to the target, and does not say whether a
// slot that observes the reference alone is one.
describe("a handler that writes a cell that a cone writes", () => {
  type Result = { joined: string };

  it("keeps what the handler wrote where each event is a batch", async () => {
    const instance = new Instance(await artifactOf("batch"), {});

    instance.send(bindingOf(instance, "adding"), { text: "a" });
    instance.send(bindingOf(instance, "overwrite"), {});

    // `_join` was evaluated behind the first event, and nothing it read
    // changed since.
    expect((instance.result() as Result).joined).toBe(
      "written by the handler",
    );
  });

  it("loses what the handler wrote in one batch, where the cone is evaluated behind the batch", async () => {
    const instance = new Instance(await artifactOf("batch"), {});

    const transactions = during(instance, () => {
      instance.enqueue(bindingOf(instance, "adding"), { text: "a" });
      instance.enqueue(bindingOf(instance, "overwrite"), {});
      instance.batch();
    });

    // The handler reads nothing of `joined`, so `_join`, which the first
    // event made stale, is not evaluated before its body. It is evaluated
    // behind the batch, and writes over what the handler wrote.
    expect(transactions[1].evaluated).toEqual([]);
    expect(transactions[2].evaluated).toContain("_join");
    expect((instance.result() as Result).joined).toBe("a");
  });

  it("keeps what the handler wrote in one batch, where the cone is evaluated before the body", async () => {
    const instance = new Instance(await artifactOf("batch"), {}, {
      beforeBody: "bound",
    });

    const transactions = during(instance, () => {
      instance.enqueue(bindingOf(instance, "adding"), { text: "a" });
      instance.enqueue(bindingOf(instance, "overwrite"), {});
      instance.batch();
    });

    expect(transactions[1].evaluated).toEqual(["_join"]);
    expect(transactions[2].evaluated).not.toContain("_join");
    expect((instance.result() as Result).joined).toBe(
      "written by the handler",
    );
  });
});

// `fixtures/bound.tsx`: `_ping` and `_pong` each write the cell that the
// other reads, and never settle. `_cap` and `_back` settle by value.
describe("the bound on the evaluations of a cone instance", () => {
  const SET_A = 0;
  const SET_OTHER = 2;
  type Result = {
    a: number;
    b: number;
    sum: number;
    raw: number;
    capped: number;
    double: number;
  };

  it("fails a cone instance whose next evaluation would be the eleventh", async () => {
    const instance = new Instance(await artifactOf("bound"), {});

    const [, derivation] = instance.transactions;
    const times = evaluations([derivation]);
    expect(MAX_EVALUATIONS).toBe(10);
    expect(times._ping).toBe(10);
    expect(times._pong).toBe(10);
    expect(derivation.failed).toEqual(["_ping", "_pong"]);
    expect(instance.counts.failures).toBe(2);
    // The rest of the transaction commits.
    expect(derivation.committed).toBe(true);
    expect((instance.result() as Result).double).toBe(2);
  });

  it("withdraws the side-writes of the failed cone instances", async () => {
    const instance = new Instance(await artifactOf("bound"), {});

    // Each cell holds what it held before the transaction: the constant
    // it was declared with, and no document.
    expect(instance.result()).toMatchObject({ a: 0, b: 0 });
    const cells = instance.stateCells().filter(({ name }) =>
      name === "a" || name === "b"
    );
    expect(cells.map(({ id }) => instance.store.docs.has(id))).toEqual([
      false,
      false,
    ]);
  });

  it("does not fail a reader of a withdrawn value", async () => {
    const instance = new Instance(await artifactOf("bound"), {});

    const [, derivation] = instance.transactions;
    // `sum` read the two cells while the cycle ran, and is evaluated
    // again against what they held before the transaction.
    expect(derivation.failed).not.toContain("sum");
    expect(evaluations([derivation]).sum).toBeLessThan(MAX_EVALUATIONS);
    expect((instance.result() as Result).sum).toBe(0);
  });

  it("ends a cycle that settles by value before the bound", async () => {
    const instance = new Instance(await artifactOf("bound"), {});

    const [, derivation] = instance.transactions;
    const times = evaluations([derivation]);
    expect(times._cap).toBe(2);
    expect(times._back).toBe(1);
    expect(derivation.failed).not.toContain("_cap");
    expect(derivation.failed).not.toContain("_back");
    expect(instance.result()).toMatchObject({ raw: 10, capped: 10 });
  });

  // SS §8.1 has a cone instance that failed at the bound "not evaluated
  // again until one of its inputs changes". ES §1.7 has its memo entry
  // hold "the reads made up to the failure", and SS §8.2 has its
  // side-writes withdrawn, so what those reads saw is not what is stored.
  // The two tests below show a cause that changes no input of the cycle
  // under each of two readings of what the entry is current against.
  it("is not evaluated again by a cause that changes no input, where the entry is current against what is stored", async () => {
    const instance = new Instance(await artifactOf("bound"), {}, {
      afterBound: "stored",
    });

    const transactions = during(instance, () => {
      instance.send(SET_OTHER, { to: 5 });
    });

    const times = evaluations(transactions);
    expect(times._ping).toBeUndefined();
    expect(times._pong).toBeUndefined();
    expect(times.double).toBe(1);
    expect(transactions.flatMap(({ failed }) => failed)).toEqual([]);
    expect(instance.result()).toMatchObject({ a: 0, b: 0, double: 10 });
  });

  it("is evaluated to the bound again by every cause, where the entry is current against what its last evaluation read", async () => {
    const instance = new Instance(await artifactOf("bound"), {}, {
      afterBound: "reads",
    });

    const transactions = during(instance, () => {
      instance.send(SET_OTHER, { to: 5 });
      instance.send(SET_OTHER, { to: 6 });
    });

    // The withdrawal changed what the two cone instances had read, so
    // each cause finds them stale, evaluates each ten times, and fails
    // them again.
    const times = evaluations(transactions);
    expect(times._ping).toBe(20);
    expect(times._pong).toBe(20);
    expect(transactions.flatMap(({ failed }) => failed)).toEqual([
      "_ping",
      "_pong",
      "_ping",
      "_pong",
    ]);
    expect(instance.result()).toMatchObject({ a: 0, b: 0, double: 12 });
  });

  it("is evaluated again when one of its inputs changes", async () => {
    const instance = new Instance(await artifactOf("bound"), {});

    const transactions = during(instance, () => {
      instance.send(SET_A, { to: 7 });
    });

    const [event, derivation] = transactions;
    expect(event.evaluated).toEqual([]);
    expect(evaluations([derivation])._ping).toBe(10);
    expect(derivation.failed).toEqual(["_ping", "_pong"]);
    // The cells keep what they held before the derivation transaction:
    // what the handler wrote, and the constant.
    expect(instance.result()).toMatchObject({ a: 7, b: 0, sum: 7 });
  });
});

// `fixtures/failing.tsx`: the body of `half` throws for a negative
// number. `each` is a `map` over `rows`, an array of plain values in
// place. An array of references and the result of another per-element
// construct are not covered.
describe("a cone instance whose body throws", () => {
  const KEEP = 0;
  const MARK = 1;
  const SET_N = 2;
  const failed = { $error: { message: "negative" } };

  it("takes an error state, and the rest of the transaction commits", async () => {
    const instance = new Instance(await artifactOf("failing"), { rows: [] });

    const transactions = during(instance, () => {
      instance.send(SET_N, { to: -4 });
    });

    const [, derivation] = transactions;
    expect(derivation.committed).toBe(true);
    expect(derivation.failed).toContain("halved");
    // The kept output stores the error state at its path, and the
    // output that reads nothing of it its value.
    expect(instance.result()).toMatchObject({
      n: -4,
      halved: failed,
      steady: "n is -4",
    });
  });

  it("fails in turn a cone instance that reads the failed value", async () => {
    const instance = new Instance(await artifactOf("failing"), { rows: [] });

    const [, derivation] = during(instance, () => {
      instance.send(SET_N, { to: -4 });
    });

    expect(derivation.failed).toContain("next");
    expect(instance.result()).toMatchObject({ next: failed });
  });

  it("does not fail a cone instance that reads the failed value in a branch it does not select", async () => {
    const instance = new Instance(await artifactOf("failing"), { rows: [] });

    const [, derivation] = during(instance, () => {
      instance.send(SET_N, { to: -4 });
    });

    expect(derivation.failed).not.toContain("chosen");
    expect(instance.result()).toMatchObject({ chosen: "negative" });
  });

  it("is passed on by a cone instance that places the failed value and reads nothing of it", async () => {
    const instance = new Instance(await artifactOf("failing"), { rows: [] });

    const [, derivation] = during(instance, () => {
      instance.send(SET_N, { to: -4 });
    });

    // The view node holds the error state at the child position, and
    // its own cone instance does not fail.
    expect(derivation.failed).not.toContain("view");
    expect(instance.result()).toMatchObject({
      view: { type: "vnode", name: "p", children: ["half: ", failed] },
    });
  });

  it("withdraws the side-write its body made before it threw", async () => {
    const instance = new Instance(await artifactOf("failing"), { rows: [] });
    expect(instance.result()).toMatchObject({ log: "tried 4" });

    const [, derivation] = during(instance, () => {
      instance.send(SET_N, { to: -4 });
    });

    expect(derivation.failed).toContain("_try");
    // `log` keeps what it held before the transaction.
    expect(instance.result()).toMatchObject({ log: "tried 4" });
  });

  it("is not evaluated again until something it read changes", async () => {
    const instance = new Instance(await artifactOf("failing"), { rows: [] });
    instance.send(SET_N, { to: -4 });

    const unrelated = during(instance, () => {
      instance.send(MARK, {});
    });
    expect(evaluations(unrelated).halved).toBeUndefined();

    const repaired = during(instance, () => {
      instance.send(SET_N, { to: 6 });
    });
    expect(evaluations(repaired).halved).toBe(1);
    expect(instance.result()).toMatchObject({
      halved: 3,
      next: 4,
      chosen: "half 3",
      log: "tried 6",
    });
  });

  it("is one errored element of a `map` over plain values in place", async () => {
    const instance = new Instance(await artifactOf("failing"), {
      rows: [2, -2, 6],
    });

    const [, derivation] = instance.transactions;
    expect(derivation.failed).toEqual(["each"]);
    expect(instance.result()).toMatchObject({ each: [1, failed, 3] });
  });

  it("fails the handler that reads it, whose transaction stores nothing", async () => {
    const instance = new Instance(await artifactOf("failing"), { rows: [] });
    instance.send(SET_N, { to: -4 });

    let outcome: { committed: boolean; error?: string } | undefined;
    const [event] = during(instance, () => {
      outcome = instance.send(KEEP, {});
    });

    expect(outcome).toMatchObject({
      committed: false,
      error: "the handler reads a failed value: negative",
    });
    expect(event).toMatchObject({ committed: false, written: [] });
    expect(instance.result()).toMatchObject({ kept: [] });
  });

  it("does not fail a handler that reads nothing of it", async () => {
    const instance = new Instance(await artifactOf("failing"), { rows: [] });
    instance.send(SET_N, { to: -4 });

    const outcome = instance.send(MARK, {});

    expect(outcome.committed).toBe(true);
    expect(instance.result()).toMatchObject({ kept: [-1] });
  });

  it("fails before the body in the transaction of a handler that reads it", async () => {
    const instance = new Instance(await artifactOf("failing"), { rows: [] });

    let outcomes: { committed: boolean }[] = [];
    const transactions = during(instance, () => {
      instance.enqueue(SET_N, { to: -4 });
      instance.enqueue(KEEP, {});
      instance.enqueue(MARK, {});
      outcomes = instance.batch();
    });

    expect(outcomes.map(({ committed }) => committed)).toEqual([
      true,
      false,
      true,
    ]);
    // The second event's transaction evaluated `halved`, which failed,
    // and stored nothing: the error state is stored by the derivation
    // transaction behind the batch, from the memo, with no evaluation.
    expect(transactions[1]).toMatchObject({
      evaluated: ["halved"],
      failed: ["halved"],
      committed: false,
      written: [],
    });
    expect(evaluations([transactions[3]]).halved).toBeUndefined();
    expect(instance.result()).toMatchObject({ halved: failed, kept: [-1] });
  });
});

// The executor instantiates no label and checks no constraint of a plan.
// `refuses` stands for the check of the constraints on what a handler
// itself writes (PL §4.4), so that what a refusal does to the event's
// transaction can be tested (SS §5.5, first row of the table).
describe("a refused write of a handler", () => {
  it("rejects the event's whole transaction and no other event", async () => {
    const artifact = await artifactOf("batch");
    let refusing = false;
    const instance = new Instance(artifact, {}, {
      refuses: ({ binding }) =>
        refusing && artifact.plan.bindings[binding].name === "copy"
          ? "refused"
          : undefined,
    });
    const add = bindingOf(instance, "adding");
    const copy = bindingOf(instance, "copy");
    refusing = true;

    let outcomes: { committed: boolean; error?: string }[] = [];
    const transactions = during(instance, () => {
      instance.enqueue(add, { text: "a" });
      instance.enqueue(copy, {});
      instance.enqueue(add, { text: "b" });
      outcomes = instance.batch();
    });

    expect(outcomes).toMatchObject([
      { committed: true },
      { committed: false, error: "refused" },
      { committed: true },
    ]);
    // The refused transaction evaluated `_join` before the body, which
    // wrote `joined`: that derived write is rejected with the handler's
    // own, and the derivation transaction behind the batch performs it.
    expect(transactions[1]).toMatchObject({
      evaluated: ["_join"],
      committed: false,
      written: [],
    });
    expect(transactions[3].evaluated).toContain("_join");
    expect(instance.result()).toMatchObject({
      items: ["a", "b"],
      copied: "",
      joined: "a,b",
    });
  });
});

// `fixtures/instantiate.tsx`: the handler `add` instantiates the pattern
// `Row` and pushes the reference to its result onto `rows`, which is then
// an array of references. No per-element construct is over it.
describe("an instance that a handler creates", () => {
  it("gets its documents in the event's transaction and is evaluated behind the batch", async () => {
    const patterns = await patternsOf("instantiate");
    const instance = new Instance(await artifactOf("instantiate"), {
      note: "n",
    }, {
      artifacts: (id) =>
        patterns.find((pattern) => pattern.plan.patterns?.[0] === id),
    });
    const kindsOf = (documents: string[]) =>
      documents.map((id) => instance.store.docs.get(id)?.kind).sort();

    const transactions = during(instance, () => {
      instance.send(bindingOf(instance, "add"), { title: "first" });
    });

    // Two transactions, from the creation to the settled result
    // (ES §1.1).
    expect(causes(transactions)).toEqual(["event", "derivation"]);
    const [event, derivation] = transactions;
    expect(event.evaluated).toEqual([]);
    expect(kindsOf(event.written)).toEqual([
      "argument",
      "result",
      "state cell",
    ]);
    // The result of the new instance is computed and stored behind the
    // batch. The result of the instance that made it holds the cell
    // `rows` by reference, and is not evaluated.
    expect(derivation.evaluated).toEqual(["result"]);
    expect(kindsOf(derivation.written)).toEqual(["result"]);
    expect(derivation.written).not.toContain(instance.id);
    expect(instance.result()).toMatchObject({
      rows: [{ title: "first", count: 0 }],
    });
  });
});

// ES §4.7, "The stream document", on `fixtures/batch.tsx`.
describe("the document of a stream", () => {
  type Stream = { entries: { event: unknown }[]; eventWatermark: number };
  const streamsOf = (instance: Instance) =>
    [...instance.store.docs.values()].filter(({ kind }) => kind === "stream")
      .map(({ value }) => value as Stream);

  it("does not exist for a binding that received no event, which has a row of the stream index", async () => {
    const instance = new Instance(await artifactOf("batch"), {});

    expect(instance.documents().stream).toBe(undefined);
    // One row for each of the six bindings whose stream the result holds.
    expect(instance.streamRows().length).toBe(6);
  });

  it("is created by the first event appended, and holds the entries and the watermark", async () => {
    const instance = new Instance(await artifactOf("batch"), {});
    const add = bindingOf(instance, "adding");

    instance.enqueue(add, { text: "a" });

    // The append is the sender's commit: the event is stored before it
    // is handled.
    expect(streamsOf(instance)).toEqual([
      { entries: [{ event: { text: "a" } }], eventWatermark: 0 },
    ]);

    instance.batch();
    instance.send(add, { text: "b" });

    expect(streamsOf(instance)).toEqual([
      {
        entries: [{ event: { text: "a" } }, { event: { text: "b" } }],
        eventWatermark: 2,
      },
    ]);
    expect(instance.documents().stream).toBe(1);
  });

  it("gets the entry of an event that a handler sends in the transaction of that handler", async () => {
    const instance = new Instance(await artifactOf("batch"), {});

    const [relayed] = during(instance, () => {
      instance.send(bindingOf(instance, "relay"), { text: "x" });
    });

    // The stream of `relay` got its entry before the transaction, and
    // that of `add` in it.
    const written = relayed.written.map((id) =>
      instance.store.docs.get(id)?.kind
    );
    expect(written).toEqual(["stream"]);
    expect(instance.documents().stream).toBe(2);
  });
});
