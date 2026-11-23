import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance } from "../executor.ts";
import { Ref } from "../store.ts";

/** The pattern of `compare/fixtures/keyed-join.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL("../../compare/fixtures/keyed-join.emit.json", import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

const link = (doc: string) => ({ $link: { doc, path: [] } });

/**
 * An instance over `count` items, each a document of its own whose tag is
 * one of `tags` in turn, and over one tag document for each of `tags` and
 * for the tag `none`, which no item has. The document `item-spare` is an
 * item with the first tag that the array does not hold.
 */
const started = async (count: number, tags = ["even", "odd"]) => {
  const items = Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    kind: "item",
    value: { title: `t${index}`, tag: tags[index % tags.length] },
  }));
  const names = [...tags, "none"].map((name) => ({
    id: `tag-${name}`,
    kind: "tag",
    value: { name },
  }));
  const instance = new Instance(
    await artifact(),
    {
      items: items.map(({ id }) => link(id)),
      tags: names.map(({ id }) => link(id)),
    },
    {
      documents: [...items, ...names, {
        id: "item-spare",
        kind: "item",
        value: { title: "spare", tag: tags[0] },
      }],
    },
  );
  /** The titles the row of each tag holds, by the name of the tag. */
  const titles = (): Record<string, string[]> => {
    const { rows } = instance.result() as {
      rows: { name: string; titles: string[] }[];
    };
    return Object.fromEntries(rows.map((row) => [row.name, row.titles]));
  };
  /** The evaluations and the positions read that `change` causes. */
  const work = (change: () => void) => {
    const before = { ...instance.counts };
    change();
    instance.settle();
    return {
      evaluations: instance.counts.evaluations - before.evaluations,
      elementEvaluations: instance.counts.elementEvaluations -
        before.elementEvaluations,
      bucketsChanged: instance.counts.bucketsChanged - before.bucketsChanged,
    };
  };
  return { instance, titles, work };
};

describe("a keyed join: a `map` over an array of references whose body looks up a bucket of a `groupBy` over a second array of references", () => {
  it("gives each row the members of the bucket of its key in source order, and an empty bucket for a key no member has", async () => {
    const { titles } = await started(4);

    expect(titles()).toEqual({
      even: ["t0", "t2"],
      odd: ["t1", "t3"],
      none: [],
    });
  });

  it("moves a member whose key changes from the bucket it was in to the bucket of its key, at its place in the source order", async () => {
    const { instance, titles } = await started(4);

    instance.store.write(new Ref("item-2", ["tag"]), "odd");
    instance.settle();

    expect(titles()).toEqual({
      even: ["t0"],
      odd: ["t1", "t2", "t3"],
      none: [],
    });
  });

  it("gives a row whose key no member had the member that takes that key", async () => {
    const { instance, titles } = await started(4);

    instance.store.write(new Ref("item-1", ["tag"]), "none");
    instance.settle();

    expect(titles()).toEqual({
      even: ["t0", "t2"],
      odd: ["t3"],
      none: ["t1"],
    });
  });

  it("takes a member out of every bucket when its key becomes `undefined`", async () => {
    const { instance, titles } = await started(4);

    instance.store.write(new Ref("item-0", ["tag"]), undefined);
    instance.settle();

    expect(titles()).toEqual({ even: ["t2"], odd: ["t1", "t3"], none: [] });
  });

  it("puts a member that is added into the bucket of its key, and takes a member that is removed out of its bucket", async () => {
    const { instance, titles } = await started(4);

    instance.spliceArgument(["items"], 1, 0, [link("item-spare")]);
    instance.settle();

    expect(titles()).toEqual({
      even: ["t0", "spare", "t2"],
      odd: ["t1", "t3"],
      none: [],
    });

    instance.spliceArgument(["items"], 0, 1, []);
    instance.settle();

    expect(titles()).toEqual({
      even: ["spare", "t2"],
      odd: ["t1", "t3"],
      none: [],
    });
  });

  it("evaluates no key function and changes no bucket for a change of a member that the key function does not read", async () => {
    const { instance, work } = await started(4);

    const done = work(() =>
      instance.store.write(new Ref("item-2", ["note"]), "edited")
    );

    expect(done).toMatchObject({ elementEvaluations: 0, bucketsChanged: 0 });
  });

  // The members are spread over ten tags, so that a bucket holds a tenth
  // of them: the work for one member is then that of the two rows it
  // leaves and enters, and those rows are longer in the larger instance.
  // What must not grow is the number of evaluations and of buckets.
  it("evaluates as much for a change of one member's key among 1,000 members as among 10", async () => {
    const tags = Array.from({ length: 10 }, (_, index) => `tag${index}`);
    const counts: unknown[] = [];
    for (const count of [10, 1_000]) {
      const { instance, work } = await started(count, tags);
      const { evaluations, elementEvaluations, bucketsChanged } = work(() =>
        instance.store.write(new Ref("item-3", ["tag"]), "tag7")
      );
      counts.push({ evaluations, bucketsChanged });
      // The key function of the one member, and not that of another.
      expect(elementEvaluations).toBeLessThan(40);
    }

    expect(counts[1]).toEqual(counts[0]);
    expect(counts[0]).toMatchObject({ bucketsChanged: 2 });
  });
});
