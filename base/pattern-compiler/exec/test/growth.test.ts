import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance } from "../executor.ts";
import { argumentOf } from "../store.ts";

// How the work of the executor grows with the data, on
// `fixtures/scale.tsx`: `nested` is a `map` inside a `map`, `labels` a
// `map` over the result of a `filter`, and `marks` a `map` over a long
// list. Each test runs at two sizes and bounds the ratio. The arrays are
// given as arrays of plain values in place and as arrays of references.

const artifactOf = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(`../../compare/fixtures/${name}.emit.json`, import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns[patterns.length - 1];
};

const ARGUMENT = argumentOf("result");
const item = (index: number) => ({
  title: `t${index}`,
  done: index % 3 === 0,
});

/** `size` rows, and `size` groups of five items each, in place. */
const inPlace = (size: number) => ({
  groups: Array.from({ length: size }, (_, group) => ({
    name: `g${group}`,
    items: Array.from({ length: 5 }, (_, index) => item(group * 5 + index)),
  })),
  rows: Array.from({ length: size }, (_, index) => item(index)),
});

/** The same, with each row, each group and each item a cell of its own. */
const references = (size: number) => {
  const link = (...path: string[]) => ({ $link: { doc: ARGUMENT, path } });
  const { groups, rows } = inPlace(size);
  return {
    pool: {
      rows,
      items: groups.map(({ items }) => items),
      groups: groups.map(({ name }, group) => ({
        name,
        items: [0, 1, 2, 3, 4].map((index) =>
          link("pool", "items", `${group}`, `${index}`)
        ),
      })),
    },
    groups: groups.map((_, group) => link("pool", "groups", `${group}`)),
    rows: rows.map((_, index) => link("pool", "rows", `${index}`)),
  };
};

type Work = {
  evaluations: number;
  elementEvaluations: number;
  checks: number;
  keyings: number;
};

const workOf = (instance: Instance): Work => ({
  evaluations: instance.counts.evaluations,
  elementEvaluations: instance.counts.elementEvaluations,
  checks: instance.checks,
  keyings: instance.store.keyings,
});

const between = (before: Work, after: Work): Work => ({
  evaluations: after.evaluations - before.evaluations,
  elementEvaluations: after.elementEvaluations - before.elementEvaluations,
  checks: after.checks - before.checks,
  keyings: after.keyings - before.keyings,
});

const cases: [string, (size: number) => unknown, string[]][] = [
  ["arrays of plain values in place", inPlace, ["rows", "4", "title"]],
  ["arrays of references", references, ["pool", "rows", "4", "title"]],
];

for (const [name, argument, changed] of cases) {
  describe(`the work of the executor over ${name}`, () => {
    const run = async (size: number) => {
      const instance = new Instance(await artifactOf("scale"), argument(size));
      const settled = workOf(instance);
      instance.writeArgument(changed, "changed");
      return {
        instance,
        settled,
        change: between(settled, workOf(instance)),
      };
    };

    it("grows with the data and no faster when the instance settles", async () => {
      const [small, large] = [await run(40), await run(80)];

      for (const count of ["evaluations", "checks", "keyings"] as const) {
        expect(large.settled[count] / small.settled[count]).toBeLessThan(2.5);
      }
      // One evaluation for each element of each of the five constructs.
      expect(large.settled.elementEvaluations).toBeGreaterThan(80 * 7);
    });

    it("evaluates for a change of one element what read it, whatever the length of the list", async () => {
      const [small, large] = [await run(40), await run(80)];

      expect(small.change.elementEvaluations).toBeGreaterThan(0);
      expect(large.change.elementEvaluations).toBe(
        small.change.elementEvaluations,
      );
      expect(large.change.evaluations).toBe(small.change.evaluations);
      expect(
        (large.instance.result() as { marks: string[] }).marks[4],
      ).toBe("changed:false");
    });

    it("checks every entry for a change of one element, which follows the length of the list", async () => {
      const [small, large] = [await run(40), await run(80)];

      // The executor finds what is stale by checking each memo entry
      // that is demanded, so its bookkeeping follows the list, and not
      // the change. It grows no faster than the list.
      expect(large.change.checks / small.change.checks).toBeLessThan(2.5);
      expect(large.change.keyings / small.change.keyings).toBeLessThan(2.5);
    });
  });
}
