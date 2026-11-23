import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance } from "../executor.ts";
import { bucketDocumentCollections } from "../row-documents.ts";
import { Ref } from "../store.ts";

/** The default pattern of `compare/fixtures/<name>.tsx`. */
const artifact = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(`../../compare/fixtures/${name}.emit.json`, import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

const link = (doc: string) => ({ $link: { doc, path: [] } });

/**
 * An instance of `compare/fixtures/kept-index.tsx` over `count` items,
 * each a document of its own with a tag of its own, with the buckets of
 * the kept index declared as documents of their own.
 */
const grouped = async (count: number) => {
  const items = Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    kind: "item",
    value: { title: `t${index}`, tag: `tag-${index}` },
  }));
  const compiled = await artifact("kept-index");
  const instance = new Instance(
    compiled,
    { items: items.map(({ id }) => link(id)) },
    {
      documents: items,
      bucketDocuments: bucketDocumentCollections(compiled),
    },
  );
  /** The titles of the members of each bucket, by its encoded key. */
  const buckets = (): Record<string, string[]> => {
    const { byTag } = instance.result() as {
      byTag: { buckets: Record<string, { title: string }[]> };
    };
    return Object.fromEntries(
      Object.entries(byTag.buckets).map(([key, members]) => [
        key,
        members.map(({ title }) => title),
      ]),
    );
  };
  return { instance, buckets };
};

describe("a kept index whose buckets are documents of their own", () => {
  it("stores each bucket under its encoded key", async () => {
    const { buckets } = await grouped(3);

    expect(buckets()).toEqual({
      "s:tag-0": ["t0"],
      "s:tag-1": ["t1"],
      "s:tag-2": ["t2"],
    });
  });

  it("moves a member whose key changed to the bucket of its key, and removes the bucket it emptied", async () => {
    const { instance, buckets } = await grouped(3);

    instance.store.write(new Ref("item-1", ["tag"]), "tag-0");
    instance.settle();

    expect(buckets()).toEqual({ "s:tag-0": ["t0", "t1"], "s:tag-2": ["t2"] });

    instance.store.write(new Ref("item-1", ["tag"]), "tag-9");
    instance.settle();

    expect(buckets()).toEqual({
      "s:tag-0": ["t0"],
      "s:tag-2": ["t2"],
      "s:tag-9": ["t1"],
    });
  });

  it("stores the bucket of a member that enters the array, and removes that of one that leaves", async () => {
    const { instance, buckets } = await grouped(3);

    instance.spliceArgument(["items"], 1, 1, []);
    instance.settle();

    expect(buckets()).toEqual({ "s:tag-0": ["t0"], "s:tag-2": ["t2"] });

    instance.spliceArgument(["items"], 2, 0, [link("item-1")]);
    instance.settle();

    expect(buckets()).toEqual({
      "s:tag-0": ["t0"],
      "s:tag-2": ["t2"],
      "s:tag-1": ["t1"],
    });
  });

  it("does not evaluate the result of the instance when a member moves between two buckets", async () => {
    const { instance } = await grouped(3);
    const before = instance.trace.length;

    instance.store.write(new Ref("item-1", ["tag"]), "tag-0");
    instance.settle();

    expect(instance.trace.slice(before)).not.toContain("result");
  });
});
