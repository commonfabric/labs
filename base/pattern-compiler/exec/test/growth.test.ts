import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance } from "../executor.ts";
import { argumentOf, Ref } from "../store.ts";

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

      for (const count of ["evaluations", "keyings"] as const) {
        expect(large.settled[count] / small.settled[count]).toBeLessThan(2.5);
      }
      // Nothing is marked while an instance settles for the first time.
      expect(large.settled.checks).toBe(0);
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

    it("checks for a change of one element the entries that the write marked, whatever the length of the list", async () => {
      const [small, large] = [await run(40), await run(80)];

      // A write marks the entries that read the position, and a mark
      // passes on to the entries that used a marked one (SS §3). An
      // entry that is not marked is compared with nothing.
      expect(small.change.checks).toBeGreaterThan(0);
      expect(large.change.checks).toBe(small.change.checks);
      expect(large.change.keyings).toBe(small.change.keyings);
    });
  });
}

// What one change of a list costs, on `fixtures/lists.tsx`
// (`compare/growth.ts`): a `map` over an array of references, over an
// array of plain values in place with no declared key, over the same
// with a key field declared with `ArrayByKey`, and over the result of a
// `filter`. Each count of a change is the same at 100 and at 1,000
// elements.
describe("one change of a list", () => {
  const listsOf = async (name: string): Promise<Artifact> => {
    const [{ patterns }] = JSON.parse(
      await Deno.readTextFile(
        new URL("../../compare/fixtures/lists.emit.json", import.meta.url),
      ),
    ) as { patterns: Artifact[] }[];
    return patterns.find((pattern) => pattern.name === name)!;
  };
  const row = (index: number) => ({
    id: `i${index}`,
    title: `t${index}`,
    done: false,
  });
  const start = async (
    pattern: string,
    references: boolean,
    length: number,
    options: ConstructorParameters<typeof Instance>[2] = {},
  ) => {
    const items = Array.from({ length }, (_, index) => row(index));
    return new Instance(
      await listsOf(pattern),
      references
        ? {
          pool: Object.fromEntries(items.map((held, index) => [index, held])),
          items: items.map((_, index) => ({
            $link: { doc: ARGUMENT, path: ["pool", `${index}`] },
          })),
        }
        : { items },
      options,
    );
  };
  const costOf = (instance: Instance, change: () => void) => {
    const before = {
      evaluations: instance.counts.evaluations,
      hashes: instance.store.hashes,
      checks: instance.checks,
      transactions: instance.transactions.length,
    };
    change();
    const transactions = instance.transactions.slice(before.transactions);
    const sum = (of: (transaction: typeof transactions[0]) => number) =>
      transactions.reduce((total, transaction) => total + of(transaction), 0);
    return {
      evaluations: instance.counts.evaluations - before.evaluations,
      hashes: instance.store.hashes - before.hashes,
      checks: instance.checks - before.checks,
      changes: sum(({ changes }) => changes),
      patchBytes: sum(({ patchBytes }) => patchBytes),
      documents: sum(({ stored }) => stored.documents),
    };
  };
  const kinds: [string, string, boolean][] = [
    ["an array of references", "Plain", true],
    ["an array of plain values in place with no declared key", "Plain", false],
    ["an array of plain values in place with `ArrayByKey`", "Keyed", false],
    ["the result of a `filter` of plain values in place", "Chained", false],
  ];
  const changes: [string, (instance: Instance, length: number) => void][] = [
    ["an append", (instance, length) => {
      if (instance.store.peek(ARGUMENT, ["pool"]) !== undefined) {
        instance.store.write(
          new Ref(ARGUMENT, ["pool", `${length}`]),
          row(0),
        );
        instance.spliceArgument(["items"], length, 0, [
          { $link: { doc: ARGUMENT, path: ["pool", `${length}`] } },
        ]);
      } else {
        instance.spliceArgument(["items"], length, 0, [
          { ...row(0), id: "new" },
        ]);
      }
    }],
    ["an edit of one field", (instance) => {
      instance.writeArgument(
        instance.store.peek(ARGUMENT, ["pool"]) !== undefined
          ? ["pool", "3", "title"]
          : ["items", "3", "title"],
        "edited",
      );
    }],
    ["a removal of the last element", (instance, length) => {
      instance.spliceArgument(["items"], length - 1, 1, []);
    }],
  ];

  for (const [kind, pattern, references] of kinds) {
    for (const [name, change] of changes) {
      it(`costs the same at 100 and at 1,000 elements: ${name}, for a \`map\` over ${kind}`, async () => {
        const costs = [];
        for (const length of [100, 1_000]) {
          const instance = await start(pattern, references, length);
          costs.push(costOf(instance, () => change(instance, length)));
        }
        const [small, large] = costs;

        expect(large).toEqual(small);
        expect(small.evaluations).toBeLessThanOrEqual(4);
        // One salted hash for a plain value that entered or changed,
        // and none over references.
        expect(small.hashes).toBeLessThanOrEqual(references ? 0 : 1);
        expect(small.checks).toBeLessThanOrEqual(4);
        expect(small.patchBytes).toBeLessThan(200);
        expect(small.documents).toBeLessThanOrEqual(2);
      });
    }
  }

  it("gives the same result with the keys of an array formed again and each assembly formed whole", async () => {
    for (const [, pattern, references] of kinds) {
      const results = [];
      for (
        const options of [{}, {
          keys: "formed" as const,
          assembly: "formed" as const,
        }]
      ) {
        const instance = await start(pattern, references, 30, options);
        for (const [, change] of changes) change(instance, 30);
        results.push(instance.result());
      }
      expect(results[1]).toEqual(results[0]);
    }
  });

  it("forms the key of every position again after each write where the keys are not kept", async () => {
    const kept = await start("Plain", false, 100);
    const formed = await start("Plain", false, 100, { keys: "formed" });

    const costs = [kept, formed].map((instance) =>
      costOf(instance, () => changes[1][1](instance, 100))
    );

    expect(costs[0].hashes).toBe(1);
    expect(costs[1].hashes).toBeGreaterThanOrEqual(100);
  });
});

// The layout of a stored result (ES §4.10), on the same fixture: the
// rows of a `map` over an array of plain values in place with a
// declared key, which is a kept collection.
describe("the documents that a result is stored in", () => {
  const artifact = async (): Promise<Artifact> => {
    const [{ patterns }] = JSON.parse(
      await Deno.readTextFile(
        new URL("../../compare/fixtures/lists.emit.json", import.meta.url),
      ),
    ) as { patterns: Artifact[] }[];
    return patterns.find((pattern) => pattern.name === "Keyed")!;
  };
  const start = async (
    length: number,
    title = (index: number) => `t${index}`,
  ) =>
    new Instance(await artifact(), {
      items: Array.from({ length }, (_, index) => ({
        id: `i${index}`,
        title: title(index),
        done: false,
      })),
    });
  const last = (instance: Instance) =>
    instance.transactions[instance.transactions.length - 1].stored;
  // The result as a reader finds it: each storage link followed.
  const read = (instance: Instance): unknown => {
    const documents = instance.laidOut();
    const follow = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(follow);
      if (typeof value !== "object" || value === null) return value;
      const part = (value as { $part?: string }).$part;
      if (typeof part === "string") {
        return follow((documents.get(part) as { value: unknown }).value);
      }
      return Object.fromEntries(
        Object.entries(value).map(([name, member]) => [name, follow(member)]),
      );
    };
    return follow(documents.get(instance.id));
  };

  it("stores small rows in the document of their array, which is a part once it holds 1,024 bytes", async () => {
    const few = await start(3);
    const more = await start(100);

    expect(few.laidOut().size).toBe(1);
    // The array is the root of a kept output, and is a split point.
    expect(more.laidOut().size).toBe(2);
    expect(read(more)).toEqual(more.store.docs.get(more.id)?.value);
  });

  it("stores a row of 1,024 bytes or more in a part of its own, and one change of it writes that part alone", async () => {
    const instance = await start(20, (index) => `${index}`.repeat(1_200));

    // The array of 20 storage links, and the 20 rows.
    expect(instance.laidOut().size).toBe(22);
    expect(read(instance)).toEqual(instance.store.docs.get(instance.id)?.value);
    instance.writeArgument(["items", "4", "title"], "x".repeat(1_100));
    expect(last(instance)).toMatchObject({
      documents: 1,
      created: 0,
      deleted: 0,
    });
    expect(last(instance).bytes).toBeLessThan(1_300);
    // A row that falls to 512 bytes is stored in place again.
    instance.writeArgument(["items", "4", "title"], "short");
    expect(last(instance)).toMatchObject({ deleted: 1 });
    expect(instance.laidOut().size).toBe(21);
    expect(read(instance)).toEqual(instance.store.docs.get(instance.id)?.value);
  });

  it("makes every row a part in the transaction in which the array passes 65,536 bytes", async () => {
    // A row is 23 to 26 bytes, and a storage link is longer than that.
    const instance = await start(2_600);

    expect(instance.laidOut().size).toBe(2);
    instance.spliceArgument(
      ["items"],
      2_600,
      0,
      Array.from({ length: 200 }, (_, index) => ({
        id: `n${index}`,
        title: "added",
        done: false,
      })),
    );
    const crossing = last(instance);

    expect(crossing.created).toBe(2_800);
    expect(instance.laidOut().size).toBe(2_802);
    expect(read(instance)).toEqual(instance.store.docs.get(instance.id)?.value);
    // The array then holds 2,800 storage links and no split point: it
    // is larger than it was, and larger than a document may be.
    const rows = [...instance.laidOut().values()].find((document) =>
      Array.isArray((document as { value?: unknown }).value)
    ) as { value: unknown[] };
    expect(JSON.stringify(rows.value).length).toBeGreaterThan(65_536 * 2);
    // One more append writes the new part and that array.
    instance.spliceArgument(["items"], 2_800, 0, [
      { id: "last", title: "added", done: false },
    ]);
    expect(last(instance)).toMatchObject({ documents: 2, created: 1 });
    expect(last(instance).patchBytes).toBeLessThan(200);
    expect(last(instance).bytes).toBeGreaterThan(65_536 * 2);
  });
});
