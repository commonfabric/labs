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

/** The pattern of `compare/fixtures/sort-by.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../../base/pattern-compiler/compare/fixtures/sort-by.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

type Sorted = { count: number; titles: string[]; initials: string[] };

// A `sortBy` over an array of item references, with a `map` over the
// result that gives the titles in the order of the ranks. Each item is a
// cell under a clause of its own. Which element stands at a position of
// the sorted result depends on the key of every item (note 614 of
// `SPEC-NOTES.md`), so a read of a title at a position consumes the clause
// of every item; the number of items consumes none.
describe("a sort by a key as a compiled piece, over an array of references each under a clause of its own", () => {
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
    properties: { title: { type: "string" }, rank: { type: "number" } },
    ifc: { confidentiality: [inputClause(name, await scenarioAudience())] },
  } as JSONSchema);

  const ITEMS = ["ia", "ib", "ic", "id"];
  const EVERY_ITEM = ITEMS.map((name) => `input:clause-${name}`);

  /**
   * Starts the piece over four items whose ranks fall from 4 to 1 in the
   * order of the array, and whose clauses are `clause-ia` to `clause-id`.
   */
  const sorted = async () => {
    const items = await Promise.all(
      ITEMS.map(async (name) =>
        runtime.getCell<Record<string, unknown>>(
          space,
          `sorted item ${name}`,
          await labeled(`clause-${name}`),
        )
      ),
    );
    const itemList = runtime.getCell<unknown[]>(space, "sorted items");
    const result = runtime.getCell<Sorted>(space, "sorted result");
    await commit((tx) => {
      items.forEach((cell, index) =>
        cell.withTx(tx).set({ title: ITEMS[index], rank: 4 - index })
      );
      itemList.withTx(tx).set(items);
    });
    const compiled = await artifact();
    let piece: CompiledPiece | undefined;
    await commit((tx) => {
      piece = startCompiledPiece(
        runtime,
        tx,
        compiled,
        { items: itemList },
        result.withTx(tx),
      );
      pieces.push(piece);
    });
    expect(piece!.refusals).toEqual([]);
    return { result, items };
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
   * The clauses of the inputs that a read of the value at `path` of the
   * result consumes, in the runtime's own resolution.
   */
  const consumed = (result: Cell<Sorted>, path: string[]): string[] => {
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

  it("stores the titles in the order of the ranks", async () => {
    const { result } = await sorted();

    expect(valueOf(result)).toMatchObject({
      count: 4,
      titles: ["id", "ic", "ib", "ia"],
      initials: ["ia", "ib", "ic", "id"],
    });
  });

  it("stores the clause of every item for the title at a position of the sorted result, and none for the number of items", async () => {
    const { result } = await sorted();

    expect(consumed(result, ["titles", "0"])).toEqual(EVERY_ITEM);
    expect(consumed(result, ["titles", "length"])).toEqual(EVERY_ITEM);
    expect(consumed(result, ["count"])).toEqual([]);
  });

  it("moves one title when another writer changes the rank of its item, under the clause of every item", async () => {
    const { result, items } = await sorted();

    await commit((tx) => items[3].withTx(tx).key("rank").set(3.5));

    expect(valueOf(result).titles).toEqual(["ic", "ib", "id", "ia"]);
    expect(consumed(result, ["titles", "2"])).toEqual(EVERY_ITEM);
    expect(pieces[0].refusals).toEqual([]);
  });
});
