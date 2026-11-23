import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance } from "../executor.ts";
import { Ref } from "../store.ts";

/** The pattern `Derived` of `compare/fixtures/handle-reads.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../compare/fixtures/handle-reads.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "Derived")!;
};

/** An instance over three items, each a document of its own. */
const started = async () => {
  const documents = [0, 1, 2].map((index) => ({
    id: `item-${index}`,
    kind: "item",
    value: { title: `t${index}`, note: `n${index}` },
  }));
  const instance = new Instance(
    await artifact(),
    { items: documents.map(({ id }) => ({ $link: { doc: id, path: [] } })) },
    { documents },
  );
  /** The result with each row read in place of the reference to it. */
  const result = () => {
    const { rows, ...rest } = instance.result() as { rows: unknown[] };
    return {
      ...rest,
      rows: rows.map((row) =>
        instance.store.read(instance.store.addresses.get(row as object)!)
      ),
    };
  };
  return { instance, result };
};

describe("derivations over an array of references that read a member through a handle or not at all", () => {
  it("gives the number of members, a row for each member and the titles of the rows", async () => {
    const { instance } = await started();

    expect(instance.result()).toMatchObject({ count: 3, titles: "T0,T1,T2" });
  });

  it("evaluates nothing when a field of a member changes that no declared type names", async () => {
    const { instance } = await started();
    const before = instance.counts.evaluations;

    instance.store.write(new Ref("item-1", ["note"]), "edited");
    instance.settle();

    expect(instance.counts.evaluations).toBe(before);
    expect(instance.result()).toMatchObject({ count: 3, titles: "T0,T1,T2" });
  });

  it("evaluates the `lift` over the members and the one over its rows, and not the count, when a title changes", async () => {
    const { instance } = await started();
    const transactions = instance.transactions.length;

    instance.store.write(new Ref("item-1", ["title"]), "edited");
    instance.settle();

    expect(instance.result()).toMatchObject({
      count: 3,
      titles: "T0,EDITED,T2",
    });
    const evaluated = instance.transactions.slice(transactions).flatMap((
      { evaluated },
    ) => evaluated);
    expect(evaluated).toContain("rows");
    expect(evaluated).toContain("titles");
    expect(evaluated).not.toContain("count");
  });

  it("evaluates the count when a member is added", async () => {
    const { instance } = await started();

    instance.store.create("item-3", "item", { title: "t3", note: "n3" });
    instance.store.splice(new Ref(instance.argument, ["items"]), 3, 0, [
      { $link: { doc: "item-3", path: [] } },
    ]);
    instance.settle();

    expect(instance.result()).toMatchObject({
      count: 4,
      titles: "T0,T1,T2,T3",
    });
  });
});
