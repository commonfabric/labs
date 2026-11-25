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
