import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import { inputClause } from "../../../../base/pattern-compiler/compare/generate.ts";
import { scenarioAudience } from "../../../../base/pattern-compiler/compare/harness.ts";
import type { JSONSchema } from "../../src/builder/types.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import { deriveFlowJoin } from "../../src/cfc/prepare.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { Runtime } from "../../src/runtime.ts";
import { openStorage, type TestStorage } from "./storage.ts";

/** The default pattern of `compare/fixtures/<name>.tsx`. */
const artifact = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        `../../../../base/pattern-compiler/compare/fixtures/${name}.emit.json`,
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

// The stored labels of two forms of a collection index beside the
// grouping of `collection-index.test.ts`: an index in `key` mode, and a
// grouping written in an element body. Every item, tag and group is a
// cell under a clause of its own, named `clause-` and the name of the
// cell.
describe("the stored labels of a collection index in `key` mode and of one written in an element body", () => {
  let runtime: Runtime;
  let storageManager: TestStorage;
  let space: MemorySpace;
  let pieces: CompiledPiece[];

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("pattern-compiler-compare");
    space = signer.did();
    storageManager = openStorage(signer);
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcFlowLabels: "persist",
      experimental: { compiledPatterns: true },
      servingPosture: true,
    });
    pieces = [];
  });

  afterEach(async () => {
    for (const piece of pieces) piece.stop();
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.dispose();
    await storageManager.close();
  });

  const commit = async (write: (tx: ReturnType<Runtime["edit"]>) => void) => {
    const tx = runtime.edit();
    write(tx);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.scheduler.idleWithPendingCommits();
  };

  /** A cell named `name` under the one clause `clause-<name>`. */
  const labeled = async (name: string) =>
    runtime.getCell<Record<string, unknown>>(
      space,
      `modes ${name}`,
      {
        type: "object",
        ifc: {
          confidentiality: [
            inputClause(`clause-${name}`, await scenarioAudience()),
          ],
        },
      } as JSONSchema,
    );

  const clauses = (...names: string[]) =>
    names.map((name) => `input:clause-${name}`).sort();

  /** Starts the pattern of the fixture `name` on `argument`. */
  const started = async (name: string, argument: Record<string, unknown>) => {
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      `modes result ${name}`,
    );
    const compiled = await artifact(name);
    let piece: CompiledPiece | undefined;
    await commit((tx) => {
      piece = startCompiledPiece(
        runtime,
        tx,
        compiled,
        argument,
        result.withTx(tx),
      );
      pieces.push(piece);
    });
    expect(piece!.refusals).toEqual([]);
    return result;
  };

  /** The value a cell holds, with every link followed. */
  const valueOf = <T>(cell: Cell<T>): T => {
    const tx = runtime.edit();
    try {
      return JSON.parse(JSON.stringify(cell.withTx(tx).get())) as T;
    } finally {
      tx.abort();
    }
  };

  /**
   * The clauses of the inputs that a read of the value at `path` of
   * `result` consumes, in the runtime's own resolution.
   */
  const consumed = (
    result: Cell<Record<string, unknown>>,
    path: string[],
  ): string[] => {
    const tx = runtime.edit();
    try {
      // deno-lint-ignore no-explicit-any
      let cell: any = result.withTx(tx);
      for (const segment of path) cell = cell.key(segment);
      JSON.stringify(cell.get());
      const text = JSON.stringify(deriveFlowJoin(tx).confidentiality);
      return [...new Set(text.match(/input:clause-[a-z0-9]+/g) ?? [])].sort();
    } finally {
      tx.abort();
    }
  };

  describe("`keyBy` over an array of references, with a `map` over a second array of references that looks up the item of each tag", () => {
    const ITEMS = ["ia", "ib", "ic", "id"];

    /**
     * Four items tagged `even` and `odd` in turn, and the tags `even`,
     * `odd` and `none`, in the cells `te`, `to` and `tn`.
     */
    const keyed = async () => {
      const items = await Promise.all(ITEMS.map(labeled));
      const tags = await Promise.all(["te", "to", "tn"].map(labeled));
      const itemList = runtime.getCell<unknown[]>(space, "modes items");
      const tagList = runtime.getCell<unknown[]>(space, "modes tags");
      await commit((tx) => {
        items.forEach((cell, index) =>
          cell.withTx(tx).set({
            title: ITEMS[index],
            tag: index % 2 === 0 ? "even" : "odd",
          })
        );
        ["even", "odd", "none"].forEach((name, index) =>
          tags[index].withTx(tx).set({ name })
        );
        itemList.withTx(tx).set(items);
        tagList.withTx(tx).set(tags);
      });
      const result = await started("key-index", {
        items: itemList,
        tags: tagList,
      });
      return { result, items };
    };

    it("gives each row the first item of its tag in the order of the array, and nothing for a tag no item has", async () => {
      const { result } = await keyed();

      expect(valueOf(result)).toEqual({
        count: 3,
        rows: [
          { name: "even", first: "ia" },
          { name: "odd", first: "ib" },
          { name: "none", first: "" },
        ],
      });
    });

    it("stores the clause of every item and of the row's tag for what a row read of the item it looked up, for a tag that has an item and for one that has none", async () => {
      const { result } = await keyed();

      expect(consumed(result, ["rows", "0", "first"])).toEqual(
        clauses(...ITEMS, "te"),
      );
      expect(consumed(result, ["rows", "2", "first"])).toEqual(
        clauses(...ITEMS, "tn"),
      );
    });

    it("stores the clause of the row's tag and of no item for the name of a row, and no clause for the number of tags", async () => {
      const { result } = await keyed();

      expect(consumed(result, ["rows", "0", "name"])).toEqual(clauses("te"));
      expect(consumed(result, ["count"])).toEqual([]);
    });

    it("gives a row the item that comes to be the first of its tag when another writer changes a tag, under the clause of every item", async () => {
      const { result, items } = await keyed();

      await commit((tx) => items[0].withTx(tx).key("tag").set("none"));

      expect(valueOf(result).rows).toEqual([
        { name: "even", first: "ic" },
        { name: "odd", first: "ib" },
        { name: "none", first: "ia" },
      ]);
      expect(consumed(result, ["rows", "2", "first"])).toEqual(
        clauses(...ITEMS, "tn"),
      );
      expect(consumed(result, ["rows", "2", "name"])).toEqual(clauses("tn"));
    });
  });

  describe("`groupBy` in the body of a `map` over an array of references, over the items each group holds", () => {
    /**
     * Two groups, `ga` over the items `ia` and `ib` and `gb` over the
     * items `ic` and `id`; the first item of each is tagged `even`.
     */
    const grouped = async () => {
      const items = await Promise.all(["ia", "ib", "ic", "id"].map(labeled));
      const groups = await Promise.all(["ga", "gb"].map(labeled));
      const groupList = runtime.getCell<unknown[]>(space, "modes groups");
      await commit((tx) => {
        items.forEach((cell, index) =>
          cell.withTx(tx).set({
            title: `i${"abcd"[index]}`,
            tag: index % 2 === 0 ? "even" : "odd",
          })
        );
        groups.forEach((cell, index) =>
          cell.withTx(tx).set({
            name: `g${"ab"[index]}`,
            items: items.slice(index * 2, index * 2 + 2),
          })
        );
        groupList.withTx(tx).set(groups);
      });
      const result = await started("index-in-body", { groups: groupList });
      return { result, items };
    };

    it("gives each row the members of the bucket of its own group's index", async () => {
      const { result } = await grouped();

      expect(valueOf(result)).toEqual({
        count: 2,
        rows: [{ name: "ga", even: ["ia"] }, { name: "gb", even: ["ic"] }],
      });
    });

    it("stores, for the bucket a row read, the clause of the row's group and of every item of that group, and of no item of another group", async () => {
      const { result } = await grouped();

      expect(consumed(result, ["rows", "0", "even"])).toEqual(
        clauses("ga", "ia", "ib"),
      );
      expect(consumed(result, ["rows", "1", "even"])).toEqual(
        clauses("gb", "ic", "id"),
      );
    });

    it("stores the clause of the row's group alone for the name of a row, and no clause for the number of groups", async () => {
      const { result } = await grouped();

      expect(consumed(result, ["rows", "0", "name"])).toEqual(clauses("ga"));
      expect(consumed(result, ["count"])).toEqual([]);
    });

    it("moves an item into the bucket of its group's row when another writer changes its tag, and leaves the row of the other group as it was", async () => {
      const { result, items } = await grouped();

      await commit((tx) => items[1].withTx(tx).key("tag").set("even"));

      expect(valueOf(result).rows).toEqual([
        { name: "ga", even: ["ia", "ib"] },
        { name: "gb", even: ["ic"] },
      ]);
      expect(consumed(result, ["rows", "0", "even"])).toEqual(
        clauses("ga", "ia", "ib"),
      );
      expect(consumed(result, ["rows", "1", "even"])).toEqual(
        clauses("gb", "ic", "id"),
      );
    });
  });
});
