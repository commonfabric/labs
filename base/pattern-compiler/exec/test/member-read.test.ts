import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance } from "../executor.ts";

/** The pattern `name` of `compare/fixtures/member-read.tsx`. */
const artifact = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL("../../compare/fixtures/member-read.emit.json", import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find((pattern) => pattern.name === name)!;
};

/** `count` items, the item at index `i` with the key `k<i>`. */
const itemsOf = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    key: `k${index}`,
    title: `title ${index}`,
  }));

/**
 * The evaluations, and those of them that are of an element body, that
 * `change` causes once the instance has settled.
 */
const work = (instance: Instance, change: () => void) => {
  const before = { ...instance.counts };
  change();
  instance.settle();
  return {
    evaluations: instance.counts.evaluations - before.evaluations,
    elementEvaluations: instance.counts.elementEvaluations -
      before.elementEvaluations,
  };
};

type Rows = { rows: { title: string; replies: number }[] };

describe("executor", () => {
  describe("a row of a `map` over an array of plain values in place that reads one member of a stored record by its element's key", () => {
    const started = async (count: number) => {
      const items = itemsOf(count);
      const instance = new Instance(await artifact("Stored"), {
        items,
        places: Object.fromEntries(
          items.map(({ key }, index) => [key, { replies: index }]),
        ),
      });
      instance.result();
      return instance;
    };

    it("evaluates no row when a member that no row reads is added to the record, at 10 and at 100 members", async () => {
      const added = async (count: number) => {
        const instance = await started(count);
        return work(
          instance,
          () => instance.writeArgument(["places", "spare"], { replies: 7 }),
        );
      };

      expect([await added(10), await added(100)]).toEqual([
        { evaluations: 0, elementEvaluations: 0 },
        { evaluations: 0, elementEvaluations: 0 },
      ]);
    });

    it("evaluates the one row whose member is written, at 10 and at 100 members", async () => {
      const written = async (count: number) => {
        const instance = await started(count);
        const done = work(
          instance,
          () => instance.writeArgument(["places", "k3", "replies"], 70),
        );
        return {
          elementEvaluations: done.elementEvaluations,
          replies: (instance.result() as Rows).rows[3].replies,
        };
      };

      expect([await written(10), await written(100)]).toEqual([
        { elementEvaluations: 1, replies: 70 },
        { elementEvaluations: 1, replies: 70 },
      ]);
    });
  });

  describe("a row of a `map` over an array of plain values in place that reads one member of a computed record by its element's key", () => {
    it("evaluates the row of an element that is appended and no other row, at 10 and at 100 elements", async () => {
      const appended = async (count: number) => {
        const instance = new Instance(await artifact("Computed"), {
          items: itemsOf(count),
        });
        instance.result();
        const done = work(
          instance,
          () =>
            instance.spliceArgument(["items"], count, 0, [{
              key: "spare",
              title: "spare",
            }]),
        );
        const { count: held, rows } = instance.result() as Rows & {
          count: number;
        };
        return {
          elementEvaluations: done.elementEvaluations,
          count: held,
          last: rows[count],
        };
      };

      expect([await appended(10), await appended(100)]).toEqual([
        {
          elementEvaluations: 1,
          count: 11,
          last: { title: "spare", replies: 5 },
        },
        {
          elementEvaluations: 1,
          count: 101,
          last: { title: "spare", replies: 5 },
        },
      ]);
    });
  });
});
