import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance } from "../executor.ts";
import { Ref } from "../store.ts";

/** The pattern of `compare/fixtures/record-entries.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../compare/fixtures/record-entries.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

const link = (doc: string) => ({ $link: { doc, path: [] } });

/**
 * An instance over a record of `count` references, each to a document of
 * its own, under the names `n0` on. The document `item-spare` is an item
 * that the record does not hold.
 */
const started = async (count: number) => {
  const items = Array.from({ length: count + 1 }, (_, index) => ({
    id: index === count ? "item-spare" : `item-${index}`,
    kind: "item",
    value: { title: index === count ? "spare" : `t${index}`, note: "n" },
  }));
  const instance = new Instance(
    await artifact(),
    {
      byName: Object.fromEntries(
        items.slice(0, count).map(({ id }, index) => [`n${index}`, link(id)]),
      ),
    },
    { documents: items },
  );
  /** The title of each row, by the name of its entry. */
  const titles = (): Record<string, string> => {
    const { rows } = instance.result() as {
      rows: { name: string; title: string }[];
    };
    return Object.fromEntries(rows.map((row) => [row.name, row.title]));
  };
  /** The evaluations of an element body that `change` causes. */
  const bodies = (change: () => void): number => {
    const before = instance.counts.elementEvaluations;
    change();
    instance.settle();
    return instance.counts.elementEvaluations - before;
  };
  return { instance, titles, bodies };
};

describe("a `map` over the entries of a record of references", () => {
  it("gives a row for each entry, with the entry's name and what its body reads of the member", async () => {
    const { titles } = await started(3);

    expect(titles()).toEqual({ n0: "t0!", n1: "t1!", n2: "t2!" });
  });

  it("evaluates the body of one row when the member of one entry changes", async () => {
    const { instance, titles, bodies } = await started(3);

    const evaluated = bodies(() =>
      instance.store.write(new Ref("item-1", ["title"]), "edited")
    );

    expect(evaluated).toBe(1);
    expect(titles()).toEqual({ n0: "t0!", n1: "edited!", n2: "t2!" });
  });

  it("evaluates no body when a field of a member changes that no body reads", async () => {
    const { instance, bodies } = await started(3);

    const evaluated = bodies(() =>
      instance.store.write(new Ref("item-1", ["note"]), "edited")
    );

    expect(evaluated).toBe(0);
  });

  it("evaluates the body of the entry that is added and of no other, among 1,000 entries as among 10", async () => {
    for (const count of [10, 1_000]) {
      const { instance, titles, bodies } = await started(count);

      const evaluated = bodies(() =>
        instance.writeArgument(["byName", "added"], link("item-spare"))
      );

      expect(evaluated).toBe(1);
      expect(titles().added).toBe("spare!");
    }
  });

  it("drops the row of an entry that is removed and evaluates no body", async () => {
    const { instance, titles, bodies } = await started(3);

    const evaluated = bodies(() =>
      instance.writeArgument(["byName"], {
        n0: link("item-0"),
        n2: link("item-2"),
      })
    );

    expect(evaluated).toBe(0);
    expect(titles()).toEqual({ n0: "t0!", n2: "t2!" });
  });
});
