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
import { StorageManager } from "../../src/storage/cache.deno.ts";

/** The pattern `Joined` of `compare/fixtures/keyed-join.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../../base/pattern-compiler/compare/fixtures/keyed-join.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "Joined")!;
};

type Rows = { name: string; titles: string[] }[];

// A keyed join on the runner path: a `map` over an array of tag references
// whose body looks up, in a `groupBy` over an array of item references,
// the bucket of the tag's name. Each item and each tag is a cell under a
// clause of its own, so that what a read of a row consumes says which
// inputs the row's stored label names. A bucket's membership depends on
// the key of every item, of those that are not in it as well (PL §3.17).
describe("a keyed join as a compiled piece, each member under a clause of its own", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let space: MemorySpace;
  let pieces: CompiledPiece[];

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("pattern-compiler-compare");
    space = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
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

  /** A schema with the one clause `name`, as the comparison generates it. */
  const labeled = async (name: string): Promise<JSONSchema> => ({
    type: "object",
    properties: {
      title: { type: "string" },
      tag: { type: "string" },
      name: { type: "string" },
    },
    ifc: { confidentiality: [inputClause(name, await scenarioAudience())] },
  } as JSONSchema);

  const ITEMS = ["ia", "ib", "ic", "id"];
  const TAGS = ["even", "odd", "none"];

  /**
   * Starts the join over the items `names`, by default four, whose tags are
   * `even` and `odd` in turn and whose clauses are `clause-` and the name
   * of the item, and over the
   * tags `even`, `odd` and `none` under the clauses `clause-teven`,
   * `clause-todd` and `clause-tnone`.
   */
  const started = async (names: string[] = ITEMS) => {
    const items = await Promise.all(
      names.map(async (name) =>
        runtime.getCell<Record<string, unknown>>(
          space,
          `join item ${name}`,
          await labeled(`clause-${name}`),
        )
      ),
    );
    const tags = await Promise.all(
      TAGS.map(async (name) =>
        runtime.getCell<Record<string, unknown>>(
          space,
          `join tag ${name}`,
          await labeled(`clause-t${name}`),
        )
      ),
    );
    const itemList = runtime.getCell<unknown[]>(space, "join items");
    const tagList = runtime.getCell<unknown[]>(space, "join tags");
    const result = runtime.getCell<{ rows: Rows }>(space, "join result");
    await commit((tx) => {
      items.forEach((cell, index) =>
        cell.withTx(tx).set({
          title: names[index],
          tag: index % 2 === 0 ? "even" : "odd",
        })
      );
      tags.forEach((cell, index) => cell.withTx(tx).set({ name: TAGS[index] }));
      itemList.withTx(tx).set(items);
      tagList.withTx(tx).set(tags);
    });
    const compiled = await artifact();
    let piece: CompiledPiece | undefined;
    await commit((tx) => {
      piece = startCompiledPiece(
        runtime,
        tx,
        compiled,
        { items: itemList, tags: tagList },
        result.withTx(tx),
      );
      pieces.push(piece);
    });
    expect(piece!.refusals).toEqual([]);
    return { piece: piece!, result, items, tags, itemList };
  };

  /** The titles of each row, by the name of its tag. */
  const titles = (
    result: Cell<{ rows: Rows }>,
  ): Record<string, string[]> => {
    const tx = runtime.edit();
    try {
      const { rows } = JSON.parse(
        JSON.stringify(result.withTx(tx).get()),
      ) as { rows: Rows };
      return Object.fromEntries(rows.map((row) => [row.name, row.titles]));
    } finally {
      tx.abort();
    }
  };

  /**
   * The clauses of the inputs that a read of the value at `path` of the
   * result consumes, in the runtime's own resolution.
   */
  const consumed = (
    result: Cell<{ rows: Rows }>,
    path: string[],
  ): string[] => {
    const tx = runtime.edit();
    try {
      // deno-lint-ignore no-explicit-any
      let cell: any = result.withTx(tx);
      for (const segment of path) cell = cell.key(segment);
      JSON.stringify(cell.get());
      const text = JSON.stringify(deriveFlowJoin(tx).confidentiality);
      return [...new Set(text.match(/input:clause-[a-z]+/g) ?? [])].sort();
    } finally {
      tx.abort();
    }
  };

  const EVERY_ITEM = ITEMS.map((name) => `input:clause-${name}`);

  it("gives each row the titles of the bucket of its tag", async () => {
    const { result } = await started();

    expect(titles(result)).toEqual({
      even: ["ia", "ic"],
      odd: ["ib", "id"],
      none: [],
    });
  });

  it("stores, for the titles of a row, the clause of every item and not of those in the bucket alone", async () => {
    const { result } = await started();

    expect(consumed(result, ["rows", "0", "titles"])).toEqual(
      expect.arrayContaining([...EVERY_ITEM, "input:clause-teven"]),
    );
  });

  it("stores the clause of every item for the titles of a row whose key no item has", async () => {
    const { result } = await started();

    expect(consumed(result, ["rows", "2", "titles"])).toEqual(
      expect.arrayContaining([...EVERY_ITEM, "input:clause-tnone"]),
    );
  });

  it("stores no clause of an item for the name of a row, which no bucket decides", async () => {
    const { result } = await started();

    const clauses = consumed(result, ["rows", "0", "name"]);

    expect(clauses).toContain("input:clause-teven");
    expect(clauses.filter((clause) => EVERY_ITEM.includes(clause))).toEqual(
      [],
    );
  });

  it("moves an item whose tag another writer changes to the row of that tag, and keeps the clause of every item on both rows", async () => {
    const { result, items } = await started();

    await commit((tx) => items[1].withTx(tx).key("tag").set("none"));

    expect(titles(result)).toEqual({
      even: ["ia", "ic"],
      odd: ["id"],
      none: ["ib"],
    });
    for (const row of ["1", "2"]) {
      expect(consumed(result, ["rows", row, "titles"])).toEqual(
        expect.arrayContaining(EVERY_ITEM),
      );
    }
  });

  // The reads through the transaction and the write records do follow the
  // number of items: the record of the titles of a row names the key of
  // every item (PL §3.17), so the adapter asks the label of each.
  it("evaluates as much for a change of one item's tag among 120 items as among 12", async () => {
    const evaluations: number[] = [];
    for (const count of [12, 120]) {
      const letters = "abcdefghijklmnopqrstuvwxyz";
      const names = Array.from(
        { length: count },
        (_, index) =>
          `i${letters[Math.floor(index / 26)]}${letters[index % 26]}${
            count === 12 ? "s" : "l"
          }`,
      );
      const { piece, items } = await started(names);
      const before = piece.instance.counts.evaluations;

      await commit((tx) => items[1].withTx(tx).key("tag").set("none"));

      evaluations.push(piece.instance.counts.evaluations - before);
      piece.stop();
    }

    expect(evaluations[1]).toBe(evaluations[0]);
  });

  it("gives a row the item that is added with its tag, and takes out the item that is removed", async () => {
    const { result, items, itemList } = await started();

    await commit((tx) => itemList.withTx(tx).set(items.slice(1)));

    expect(titles(result)).toEqual({
      even: ["ic"],
      odd: ["ib", "id"],
      none: [],
    });

    await commit((tx) =>
      itemList.withTx(tx).set([...items.slice(1), items[0]])
    );

    expect(titles(result)).toEqual({
      even: ["ic", "ia"],
      odd: ["ib", "id"],
      none: [],
    });
  });
});
