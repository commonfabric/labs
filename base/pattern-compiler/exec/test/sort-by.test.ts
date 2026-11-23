import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance } from "../executor.ts";
import { Ref } from "../store.ts";

/** The pattern of `compare/fixtures/sort-by.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL("../../compare/fixtures/sort-by.emit.json", import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

const link = (doc: string) => ({ $link: { doc, path: [] } });

type Sorted = { count: number; titles: string[]; initials: string[] };

/**
 * An instance over `count` items, each a document of its own. The item at
 * position `index` has the title `t<index>` and the rank `count - index`,
 * so the order of the ranks is the reverse of the order of the array. The
 * document `spare` is an item of rank 2.5 that the array does not hold.
 */
const started = async (count: number) => {
  const items = Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    kind: "item",
    value: { title: `t${index}`, rank: count - index },
  }));
  const instance = new Instance(
    await artifact(),
    { items: items.map(({ id }) => link(id)) },
    {
      documents: [...items, {
        id: "spare",
        kind: "item",
        value: { title: "spare", rank: 2.5 },
      }],
    },
  );
  const result = () => instance.result() as Sorted;
  /** The evaluations that `change` causes. */
  const work = (change: () => void): number => {
    const before = instance.counts.evaluations;
    change();
    instance.settle();
    return instance.counts.evaluations - before;
  };
  return { instance, result, work };
};

describe("a sort by a key: `sortBy` over an array of references, and over the result of a `map` over the array", () => {
  it("gives the elements of an array of references in the order of their keys", async () => {
    const { result } = await started(4);

    expect(result().titles).toEqual(["t3", "t2", "t1", "t0"]);
  });

  it("gives the rows of a `map` over the array in the order of their keys, which the negated weight makes descending", async () => {
    const { result } = await started(4);

    expect(result().initials).toEqual(["t0", "t1", "t2", "t3"]);
  });

  it("moves one element when its key changes, in both sorts", async () => {
    const { instance, result } = await started(4);

    instance.store.write(new Ref("item-3", ["rank"]), 3.5);
    instance.settle();

    expect(result().titles).toEqual(["t2", "t1", "t3", "t0"]);
    expect(result().initials).toEqual(["t0", "t3", "t1", "t2"]);
  });

  it("keeps the order of the array among elements with equal keys, and puts an element whose key becomes equal behind those before it in the array", async () => {
    const { instance, result } = await started(4);

    instance.store.write(new Ref("item-0", ["rank"]), 2);
    instance.settle();

    expect(result().titles).toEqual(["t3", "t0", "t2", "t1"]);

    instance.store.write(new Ref("item-3", ["rank"]), 2);
    instance.settle();

    expect(result().titles).toEqual(["t0", "t2", "t3", "t1"]);
  });

  it("puts an element that is appended to the array at the place of its key, and takes out one that is removed", async () => {
    const { instance, result } = await started(4);

    instance.spliceArgument(["items"], 4, 0, [link("spare")]);
    instance.settle();

    expect(result().titles).toEqual(["t3", "t2", "spare", "t1", "t0"]);
    expect(result().count).toBe(5);

    instance.spliceArgument(["items"], 1, 1, []);
    instance.settle();

    expect(result().titles).toEqual(["t3", "t2", "spare", "t0"]);
  });

  it("leaves the order as it is for a change of a title, which no key reads, and gives the title", async () => {
    const { instance, result } = await started(4);

    instance.store.write(new Ref("item-2", ["title"]), "edited");
    instance.settle();

    expect(result().titles).toEqual(["t3", "edited", "t1", "t0"]);
  });

  it("evaluates as much for a change of one key among 1,000 elements as among 10, and forms no key of another element again", async () => {
    const counts: number[] = [];
    for (const count of [10, 1_000]) {
      const { instance, result, work } = await started(count);
      counts.push(
        work(() => instance.store.write(new Ref("item-5", ["rank"]), 0.5)),
      );
      expect(result().titles[0]).toBe("t5");
      expect(result().titles[1]).toBe(`t${count - 1}`);
    }

    expect(counts[1]).toBe(counts[0]);
    expect(counts[0]).toBeLessThan(20);
  });
});
