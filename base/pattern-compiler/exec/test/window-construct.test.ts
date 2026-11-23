import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance } from "../executor.ts";

/** The pattern of `compare/fixtures/window-construct.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../compare/fixtures/window-construct.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

type Item = { text: string; shown: boolean };

type Windows = {
  latest: Item[];
  oldest: Item[];
  latestShown: Item[];
  texts: string[];
  lastTexts: string[];
};

/**
 * An instance over `count` items, each a document of its own with the text
 * `t<index>`. Every third item, from the first on, is not shown.
 */
const started = async (count: number) => {
  const items = Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    kind: "item",
    value: { text: `t${index}`, shown: index % 3 !== 0 },
  }));
  const instance = new Instance(
    await artifact(),
    { items: items.map(({ id }) => ({ $link: { doc: id, path: [] } })) },
    { documents: items },
  );
  const [stream] = instance.streams();
  const add = (text: string, shown = true) =>
    instance.send(stream.binding, { text, shown });
  const result = () => {
    const { latest, oldest, latestShown, texts, lastTexts } = instance
      .result() as Windows;
    const of = (items: Item[]) => items.map(({ text }) => text);
    return {
      latest: of(latest),
      oldest: of(oldest),
      latestShown: of(latestShown),
      texts,
      lastTexts,
    };
  };
  /** What `change` adds to the counters of the executor. */
  const work = (change: () => void) => {
    const before = { ...instance.counts };
    change();
    return {
      evaluations: instance.counts.evaluations - before.evaluations,
      elements: instance.counts.elementEvaluations -
        before.elementEvaluations,
      formedWhole: instance.counts.assembliesFormed -
        before.assembliesFormed,
    };
  };
  return { instance, add, result, work };
};

describe("a window of a collection: `last` and `first`", () => {
  it("holds the last and the first elements of an array of references, in the order of the array", async () => {
    const { result } = await started(7);

    expect(result().latest).toEqual(["t4", "t5", "t6"]);
    expect(result().oldest).toEqual(["t0", "t1"]);
  });

  it("holds every element of a source that is shorter than the count", async () => {
    const { result } = await started(2);

    expect(result().latest).toEqual(["t0", "t1"]);
    expect(result().oldest).toEqual(["t0", "t1"]);
    expect(result().texts).toEqual(["t0", "t1"]);
  });

  it("holds the last elements of the result of a `filter`", async () => {
    const { result } = await started(7);

    expect(result().latestShown).toEqual(["t2", "t4", "t5"]);
  });

  it("gives a `map` over it a row for each element of the window", async () => {
    const { result } = await started(7);

    expect(result().texts).toEqual(["t4", "t5", "t6"]);
  });

  it("holds the last rows of the result of a `map`, and moves by one at an append", async () => {
    const { add, result } = await started(7);

    expect(result().lastTexts).toEqual(["t5", "t6"]);

    add("new");

    expect(result().lastTexts).toEqual(["t6", "new"]);
  });

  it("moves by one when an element is appended to its source", async () => {
    const { add, result } = await started(7);

    add("new");

    expect(result().latest).toEqual(["t5", "t6", "new"]);
    expect(result().texts).toEqual(["t5", "t6", "new"]);
    expect(result().oldest).toEqual(["t0", "t1"]);
    expect(result().latestShown).toEqual(["t4", "t5", "new"]);
  });

  it("keeps a window over a `filter` when the element appended is not in the result of the `filter`", async () => {
    const { add, result } = await started(7);

    add("hidden", false);

    expect(result().latest).toEqual(["t5", "t6", "hidden"]);
    expect(result().latestShown).toEqual(["t2", "t4", "t5"]);
  });

  it("evaluates as much for an append to 1,000 elements as to 10", async () => {
    const [small, large] = [await started(10), await started(1_000)];

    const few = small.work(() => small.add("new"));
    const many = large.work(() => large.add("new"));

    // The window over the result of the `map` is formed whole.
    expect(many).toEqual(few);
    expect(many.formedWhole).toBe(1);
    expect(large.result().latest).toEqual(["t998", "t999", "new"]);
  });

  it("writes as many positions of the result for an append to 1,000 elements as to 10", async () => {
    const written = async (count: number) => {
      const { instance, add } = await started(count);
      const paths: string[] = [];
      const { onChange } = instance.store;
      instance.store.onChange = (change) => {
        if (change.doc === instance.id) paths.push(change.path.join("/"));
        onChange?.(change);
      };
      add("new");
      instance.store.onChange = onChange;
      return paths.length;
    };

    expect(await written(1_000)).toBe(await written(10));
  });
});
