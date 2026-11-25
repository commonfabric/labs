import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type Artifact,
  Instance,
  type LabelChange,
  type TransactionHooks,
} from "../executor.ts";
import type { PlanWrite } from "../plan-write.ts";

const artifactOf = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(`../../compare/fixtures/${name}.emit.json`, import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find((pattern) => pattern.name === "default") ??
    patterns[patterns.length - 1];
};

/** The records the hooks were given, as `change` or `unchanged`. */
class Given implements TransactionHooks {
  /** Each record given, as its kind and the path of its target. */
  readonly records: string[] = [];

  /** What the executor registered to hear of changed labels. */
  labelsChanged?: (changes: readonly LabelChange[], alone?: boolean) => void;

  begin(): void {}

  read(): void {}

  labelOf(): string | undefined {
    return undefined;
  }

  watchLabels(
    changed: (changes: readonly LabelChange[], alone?: boolean) => void,
  ): void {
    this.labelsChanged = changed;
  }

  change(
    _doc: string,
    _path: readonly string[],
    _store: unknown,
    _schema?: unknown,
    writes?: readonly PlanWrite[],
  ): void {
    for (const { target } of writes ?? []) {
      this.records.push(`change ${target.path.join("/")}`);
    }
  }

  unchanged(
    _doc: string,
    _path: readonly string[],
    _store: unknown,
    _schema: unknown,
    writes: readonly PlanWrite[],
  ): void {
    for (const { target } of writes) {
      this.records.push(`unchanged ${target.path.join("/")}`);
    }
  }

  end(): void {}
}

// `fixtures/shared-window.tsx`: a window of the three newest items, each
// read whole with the owner it links to, and every item links to one owner.
// An append moves every entry by one position, so each holds another title
// and the owner record placed before at its position, which the store step
// does not form again; the window is still written whole, as an array that
// holds another value at every position is.
describe("the store step of a window whose entries hold a record placed before", () => {
  it("writes the window whole at an append", async () => {
    const written: string[] = [];
    const item = (index: number) => ({
      id: `item-${index}`,
      kind: "external",
      value: {
        title: `t${index}`,
        owner: { $link: { doc: "owner", path: [] } },
      },
    });
    const instance = new Instance(
      await artifactOf("shared-window"),
      {
        items: [0, 1, 2].map((index) => ({
          $link: { doc: `item-${index}`, path: [] },
        })),
      },
      {
        transactions: Object.assign(new Given(), {
          change: (doc: string, path: readonly string[]) => {
            if (doc === "result") written.push(path.join("/"));
          },
        }),
        documents: [
          { id: "owner", kind: "external", value: { name: "o" } },
          ...[0, 1, 2].map(item),
        ],
      },
    );
    written.length = 0;

    const { id, kind, value } = item(3);
    instance.store.create(id, kind, value);
    instance.spliceArgument(["items"], 3, 0, [
      { $link: { doc: "item-3", path: [] } },
    ]);

    expect(
      (instance.result() as { latest: { title: string }[] }).latest.map((
        { title },
      ) => title),
    ).toEqual(["t1", "t2", "t3"]);
    expect(written).toEqual(["latest"]);
  });
});

// `fixtures/result-tree.tsx`: a result that holds a tree over the rows of a
// `map` over `items`, an array of references with each item a document of
// its own, beside the count and the titles that a body forms from every
// item through the handle of the array. An append gives the result another
// count, other titles and another row, and leaves the rest of the tree as
// it was; a rename gives it other titles.
describe("the store step of a result that holds a tree", () => {
  const started = async (size: number) => {
    const given = new Given();
    const instance = new Instance(
      await artifactOf("result-tree"),
      {
        items: Array.from({ length: size }, (_, index) => ({
          $link: { doc: `item-${index}`, path: [] },
        })),
      },
      {
        transactions: given,
        documents: Array.from({ length: size }, (_, index) => ({
          id: `item-${index}`,
          kind: "external",
          value: { title: `t${index}` },
        })),
      },
    );
    /** What a change counted, and the records it gave. */
    const costOf = (change: () => void) => {
      const before = { ...instance.counts };
      const records = given.records.length;
      change();
      return {
        positionsPlaced: instance.counts.positionsPlaced -
          before.positionsPlaced,
        recordsNoted: instance.counts.recordsNoted - before.recordsNoted,
        recordRegistrations: instance.counts.recordRegistrations -
          before.recordRegistrations,
        records: given.records.slice(records),
      };
    };
    const append = () =>
      costOf(() => {
        instance.store.create(`item-${size}`, "external", { title: "new" });
        instance.spliceArgument(["items"], size, 0, [
          { $link: { doc: `item-${size}`, path: [] } },
        ]);
      });
    const rename = () =>
      costOf(() =>
        instance.send(
          instance.plan.bindings.findIndex(({ name }) => name === "rename"),
          { at: 1, title: "renamed" },
        )
      );
    /**
     * The records whose labels are formed again, once `paths` of the
     * document `doc` changed their labels alone.
     */
    const relabeled = (doc: string, paths: string[][]) => {
      const records = given.records.length;
      given.labelsChanged?.([{ doc, paths }], true);
      instance.batch();
      return given.records.slice(records);
    };
    return { instance, given, append, rename, relabeled };
  };

  it("places the members of the result that an append changed, and none of the tree, at 10 items as at 100", async () => {
    const [small, large] = [
      (await started(10)).append(),
      (await started(100)).append(),
    ];

    expect(large.positionsPlaced).toBe(small.positionsPlaced);
    // The members of the result's record and the link of the stream; the
    // positions of the tree, which holds what it held, are not compared.
    expect(small.positionsPlaced).toBeLessThanOrEqual(8);
    expect(large.recordsNoted).toBe(small.recordsNoted);
  });

  it("gives for an append the records of what it changed, and of nothing else", async () => {
    const { instance, append } = await started(10);

    const { records } = append();

    expect((instance.result() as { count: number }).count).toBe(11);
    expect(records).toEqual([
      "change count",
      "change titles",
      "change $UI/children/1/children/0",
      "change $UI/children/1/children/0/10",
      "change $UI/children/1/children/0/10/children/0/children/0",
    ]);
  });

  it("registers the readers of labels for an append at as many positions at 10 items as at 100", async () => {
    const [small, large] = [
      (await started(10)).append(),
      (await started(100)).append(),
    ];

    expect(large.recordRegistrations).toBe(small.recordRegistrations);
    expect(large.recordsNoted).toBe(small.recordsNoted);
  });

  it("forms again after an append the labels of the records that read a label that changed alone", async () => {
    const { append, relabeled } = await started(10);
    append();

    // A position the body read before the append, one it read for the
    // appended item, and a document no record reads.
    const before = relabeled("item-3", [["title"]]).sort();
    const appended = relabeled("item-10", [["title"]]).sort();
    const unread = relabeled("elsewhere", [["title"]]);

    expect(before).toEqual([
      "unchanged $UI/children/1/children/0/3/children/0/children/0",
      "unchanged count",
      "unchanged titles",
    ]);
    expect(appended).toEqual([
      "unchanged $UI/children/1/children/0/10/children/0/children/0",
      "unchanged count",
      "unchanged titles",
    ]);
    expect(unread).toEqual([]);
  });

  it("gives for a rename the record of the titles alone", async () => {
    const { instance, rename } = await started(10);

    const { records, positionsPlaced } = rename();

    expect((instance.result() as { titles: string }).titles).toBe(
      "t0renamedt2t3t4t5t6t7t8t9",
    );
    expect(records).toEqual(["change titles"]);
    expect(positionsPlaced).toBeLessThanOrEqual(8);
  });
});

// `fixtures/followed-rows.tsx`: the rows of a `map` over `items`, an array of
// references in the argument, each following its item's link to the owner,
// and each looking up what the facts say of its title. The facts read every
// item and, through `*`, every note, which the argument holds beside the
// items, so the record of each row names positions of the argument at
// `notes/*/title`. The handler `add` appends an item and reads whether the
// result of the instance is there.
describe("rows that follow a link and name the facts", () => {
  const started = async (size: number) => {
    const given = new Given();
    const link = (doc: string) => ({ $link: { doc, path: [] } });
    const instance = new Instance(
      await artifactOf("followed-rows"),
      {
        items: Array.from(
          { length: size },
          (_, index) => link(`item-${index}`),
        ),
        notes: [{ title: "t0" }],
        owner: link("owner"),
      },
      {
        transactions: given,
        documents: [
          { id: "owner", kind: "external", value: { name: "Ada" } },
          ...Array.from({ length: size }, (_, index) => ({
            id: `item-${index}`,
            kind: "external",
            value: { title: `t${index}`, owner: link("owner") },
          })),
        ],
      },
    );
    /**
     * The records whose labels are formed again, and the sets of positions
     * looked at, once `paths` of the argument changed their labels alone,
     * with `consumes` saying whether a read of a path consumes another label.
     */
    const relabeled = (
      paths: string[][],
      consumes: (path: readonly string[]) => boolean,
    ) => {
      const records = given.records.length;
      const readers = instance.counts.labelReaders;
      given.labelsChanged?.([{
        doc: instance.argument,
        paths,
        unchanged: (path) => !consumes(path),
      }], true);
      instance.batch();
      return {
        records: given.records.slice(records).sort(),
        readers: instance.counts.labelReaders - readers,
      };
    };
    /** What the containers the reads copied number, for one add. */
    const copiedByAdd = () => {
      const copied = instance.store.copiedByReads;
      instance.send(
        instance.plan.bindings.findIndex(({ name }) => name === "add"),
        { title: "added" },
      );
      return instance.store.copiedByReads - copied;
    };
    return { relabeled, copiedByAdd };
  };

  it("forms no label again where a label changed at an appended item and no read consumes another", async () => {
    const [small, large] = [
      (await started(10)).relabeled([["items", "10"]], () => false),
      (await started(100)).relabeled([["items", "100"]], () => false),
    ];

    expect(small.records).toEqual([]);
    expect(large.records).toEqual([]);
    expect(large.readers).toBe(small.readers);
  });

  it("forms again the labels of the records that read every note where a note's label changed", async () => {
    const { relabeled } = await started(3);

    const { records } = relabeled(
      [["notes", "0", "title"]],
      (path) => path.join("/") === "notes/*/title",
    );

    // The count, and the look-up of each row.
    expect(records).toEqual([
      "unchanged $UI/children/0/0/children/2/children/0",
      "unchanged $UI/children/0/1/children/2/children/0",
      "unchanged $UI/children/0/2/children/2/children/0",
      "unchanged count",
    ]);
  });

  it("copies as much for an add that reads whether the result is there at 10 rows as at 100", async () => {
    // A read of which children the result holds reads none of them.
    const [small, large] = [
      (await started(10)).copiedByAdd(),
      (await started(100)).copiedByAdd(),
    ];

    expect(large).toBe(small);
  });
});
