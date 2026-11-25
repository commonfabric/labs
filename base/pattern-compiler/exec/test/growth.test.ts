import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CASES, keystrokes, polled } from "../../compare/rekey-cost.ts";
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

// A row that holds the rows of another collection, on
// `fixtures/scale.tsx`: `nested` is a `map` inside a `map`, over arrays
// of plain values in place.
describe("a stored row that holds the rows of another collection", () => {
  it("is stored anew, with the rows in it, where its key leaves and enters in one change", async () => {
    const { groups, rows } = inPlace(4);
    const moved = [groups[2], groups[0], groups[3], groups[1]];
    const options = { secret: "one secret for both" };
    const instance = new Instance(
      await artifactOf("scale"),
      { groups, rows },
      options,
    );

    instance.writeArgument(["groups"], moved);

    const fresh = new Instance(
      await artifactOf("scale"),
      { groups: moved, rows },
      options,
    );
    expect(instance.result()).toEqual(fresh.result());
    expect(instance.store.docs.get(instance.id)?.value).toEqual(
      fresh.store.docs.get(fresh.id)?.value,
    );
  });
});

// What follows from the rule that the key of a plain value is formed
// from the value (`plan-and-label-templates.md` §1.3, "A plain value
// edited in place is a new element"), on `fixtures/rows-state.tsx`:
// each row has a state cell, a handler binding with a stream, a `lift`
// in the body and an instance called through `asInstance()`.
describe("an edit of one member of an element that has state", () => {
  const artifacts = async (): Promise<Artifact[]> => {
    const [{ patterns }] = JSON.parse(
      await Deno.readTextFile(
        new URL("../../compare/fixtures/rows-state.emit.json", import.meta.url),
      ),
    ) as { patterns: Artifact[] }[];
    return patterns;
  };
  const [unkeyed, keyed, references] = CASES;

  it("moves what is stored under the key, and adds a stream document, for each keystroke over plain values in place with no declared key", async () => {
    const patterns = await artifacts();
    const [small, large] = [
      keystrokes(patterns, unkeyed, 20),
      keystrokes(patterns, unkeyed, 60),
    ];

    // The state cell of the row moves to the new key, and the event of
    // the next keystroke is for a stream of the new key, which gets a
    // document of its own.
    expect(small.documentsMoved).toBe(1);
    expect(small.documentsAdded).toBe(1);
    expect(small.hashes).toBe(1);
    for (
      const count of [
        "documentsWritten",
        "documentsMoved",
        "documentsAdded",
        "hashes",
        "evaluations",
      ] as const
    ) {
      expect(large[count]).toBe(small[count]);
    }
  });

  it("moves nothing with a key field declared with `ArrayByKey`, and nothing over an array of references", async () => {
    const patterns = await artifacts();

    for (const one of [keyed, references]) {
      const cost = keystrokes(patterns, one, 20);
      expect(cost.documentsMoved).toBe(0);
      // The one stream document, which the first event creates.
      expect(cost.documentsAdded).toBeLessThan(0.1);
      expect(cost.instancesMade).toBe(0);
    }
    expect(keystrokes(patterns, keyed, 20).patchBytes).toBeLessThan(
      keystrokes(patterns, unkeyed, 20).patchBytes / 4,
    );
  });

  it("keeps the instance and its two documents of every value that a list of plain values with no declared key ever held", async () => {
    const patterns = await artifacts();
    const of = (one: typeof unkeyed) => polled(patterns, one, 10, 5, [0, 5]);

    const [first, last] = of(unkeyed);
    // Each round replaces the ten values by ten new ones: ten keys, ten
    // instances, and an argument and a result document for each.
    expect(last.instances - first.instances).toBe(50);
    expect(last.documents - first.documents).toBe(100);
    for (const one of [keyed, references]) {
      const [before, after] = of(one);
      expect(after.instances).toBe(before.instances);
      expect(after.documents).toBe(before.documents);
    }
  });
});

// How bringing the membership of a `filter` up to date grows with the
// elements, on `fixtures/filter-rows.tsx`: `shown` is a `filter` over
// `items`, given as an array of references or as an array of plain values
// in place, and `titled` a `filter` over the result of `shown`, another
// per-element construct whose elements are those of `items`. A change of
// one element is brought up to date from the changes of the source, and
// looks at the same number of elements at 10 and at 100.
// `fixtures/filter-of-map.tsx` has a `filter` over the result of a `map`,
// whose elements are the records the `map` returns.
describe("the membership of a `filter` brought up to date", () => {
  const row = (index: number) => ({
    title: `t${index}`,
    shown: index % 2 === 0,
  });
  const start = async (
    fixture: string,
    references: boolean,
    length: number,
  ) => {
    const items = Array.from({ length }, (_, index) => row(index));
    return new Instance(
      await artifactOf(fixture),
      references
        ? {
          pool: Object.fromEntries(items.map((held, index) => [index, held])),
          items: items.map((_, index) => ({
            $link: { doc: ARGUMENT, path: ["pool", `${index}`] },
          })),
        }
        : { items },
    );
  };
  /** Appends `added` to `items`, in the pool where `items` links there. */
  const append = (
    instance: Instance,
    length: number,
    added: { title: string; shown: boolean },
  ) => {
    if (instance.store.peek(ARGUMENT, ["pool"]) === undefined) {
      instance.spliceArgument(["items"], length, 0, [added]);
      return;
    }
    instance.store.write(new Ref(ARGUMENT, ["pool", `${length}`]), added);
    instance.spliceArgument(["items"], length, 0, [
      { $link: { doc: ARGUMENT, path: ["pool", `${length}`] } },
    ]);
  };
  /** The path of a member of the element at `index` of `items`. */
  const at = (instance: Instance, index: number, member: string) =>
    instance.store.peek(ARGUMENT, ["pool"]) === undefined
      ? ["items", `${index}`, member]
      : ["pool", `${index}`, member];
  const changes: [string, (instance: Instance, length: number) => void][] = [
    ["an append of an element the predicate keeps", (instance, length) => {
      append(instance, length, { title: "new", shown: true });
    }],
    ["an append of an element the predicate leaves out", (instance, length) => {
      append(instance, length, { title: "new", shown: false });
    }],
    [
      "an edit of a member the predicate reads that keeps the membership",
      (instance) => {
        instance.writeArgument(at(instance, 4, "title"), "edited");
      },
    ],
    ["an edit that takes the last element out", (instance, length) => {
      instance.writeArgument(at(instance, length - 2, "title"), "");
    }],
    [
      "an append of an element the predicate leaves out, then of one it keeps",
      (instance, length) => {
        append(instance, length, { title: "late", shown: false });
        append(instance, length + 1, { title: "new", shown: true });
      },
    ],
    ["a removal of the last element", (instance, length) => {
      instance.spliceArgument(["items"], length - 1, 1, []);
    }],
  ];

  for (
    const [kind, references] of [
      ["an array of references", true],
      ["an array of plain values in place", false],
    ] as const
  ) {
    for (const [name, change] of changes) {
      it(`looks at as many elements at 10 as at 100: ${name}, for a \`filter\` over ${kind} and over the result of a \`filter\` over it`, async () => {
        const costs = [];
        for (const length of [10, 100]) {
          const instance = await start("filter-rows", references, length);
          const before = {
            visited: instance.counts.elementsVisited,
            formed: instance.counts.assembliesFormed,
          };
          change(instance, length);
          costs.push({
            visited: instance.counts.elementsVisited - before.visited,
            formed: instance.counts.assembliesFormed - before.formed,
          });
        }
        const [small, large] = costs;

        expect(large).toEqual(small);
        expect(small.formed).toBe(0);
      });
    }
  }

  it("holds the elements each predicate keeps after each change", async () => {
    for (const references of [true, false]) {
      const changed = async (fixture: string) => {
        const instance = await start(fixture, references, 10);
        const titles = () =>
          Object.fromEntries(
            Object.entries(instance.result() as Record<string, unknown>)
              .map(([name, rows]) => [
                name,
                (rows as { title: string }[]).map(({ title }) => title),
              ]),
          );
        const seen = [];
        append(instance, 10, { title: "new", shown: true });
        seen.push(titles());
        instance.writeArgument(at(instance, 4, "title"), "skip");
        seen.push(titles());
        instance.writeArgument(at(instance, 6, "title"), "");
        seen.push(titles());
        append(instance, 11, { title: "late", shown: false });
        instance.spliceArgument(["items"], 2, 1, []);
        seen.push(titles());
        return seen;
      };

      expect(await changed("filter-rows")).toEqual([
        {
          shown: ["t0", "t2", "t4", "t6", "t8", "new"],
          titled: ["t0", "t2", "t4", "t6", "t8", "new"],
        },
        {
          shown: ["t0", "t2", "skip", "t6", "t8", "new"],
          titled: ["t0", "t2", "t6", "t8", "new"],
        },
        {
          shown: ["t0", "t2", "skip", "t8", "new"],
          titled: ["t0", "t2", "t8", "new"],
        },
        { shown: ["t0", "skip", "t8", "new"], titled: ["t0", "t8", "new"] },
      ]);
      expect(await changed("filter-of-map")).toEqual([
        { marked: ["t0!", "t2!", "t4!", "t6!", "t8!", "new!"] },
        { marked: ["t0!", "t2!", "skip!", "t6!", "t8!", "new!"] },
        { marked: ["t0!", "t2!", "skip!", "t8!", "new!"] },
        { marked: ["t0!", "skip!", "t8!", "new!"] },
      ]);
    }
  });
});
