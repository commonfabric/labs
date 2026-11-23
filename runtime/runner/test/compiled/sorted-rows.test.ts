import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { parseLink } from "../../src/link-utils.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { storedList } from "./storage.ts";

/** The pattern of `compare/fixtures/sorted-rows.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../../base/pattern-compiler/compare/fixtures/sorted-rows.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

type Sorted = { count: number; cards: { title: string }[] };

const COUNT = 40;

// A `map` over a `sortBy` of an array of item references whose rows are
// records, so each row is a document of its own and the result holds an
// array of links in the order of the ranks. A change of one rank takes the
// row out of its place and puts it in at another: the positions between
// the two hold other links, and no document of a row is written.
describe("the rows of a `map` over a sort by a key as a compiled piece, stored as documents of their own", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let space: MemorySpace;
  let piece: CompiledPiece;

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
  });

  afterEach(async () => {
    piece.stop();
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

  /** A piece over `COUNT` items, the item `index` with the rank `index`. */
  const sorted = async () => {
    const items = Array.from(
      { length: COUNT },
      (_, index) =>
        runtime.getCell<Record<string, unknown>>(
          space,
          `sorted rows item ${index}`,
        ),
    );
    const list = runtime.getCell<unknown[]>(space, "sorted rows items");
    const result = runtime.getCell<Sorted>(space, "sorted rows result");
    await commit((tx) => {
      items.forEach((cell, index) =>
        cell.withTx(tx).set({ title: `t${index}`, rank: index })
      );
      list.withTx(tx).set(items);
    });
    const compiled = await artifact();
    await commit((tx) => {
      piece = startCompiledPiece(
        runtime,
        tx,
        compiled,
        { items: list },
        result.withTx(tx),
      );
    });
    expect(piece.refusals).toEqual([]);
    return { result, items };
  };

  /** The titles of the cards, in the order the result holds them. */
  const titles = (result: Cell<Sorted>): string[] => {
    const tx = runtime.edit();
    try {
      return result.withTx(tx).get().cards.map(({ title }) => title);
    } finally {
      tx.abort();
    }
  };

  /** The document each position of the stored array of cards links to. */
  const documents = (result: Cell<Sorted>): string[] => {
    const cards = storedList(runtime, result, ["cards"]) as unknown[];
    return cards.map((card) => parseLink(card as never).id!);
  };

  const expected = (order: number[]) => order.map((index) => `t${index}`);
  const inOrder = Array.from({ length: COUNT }, (_, index) => index);

  it("stores a link to the document of each card, in the order of the ranks", async () => {
    const { result } = await sorted();

    expect(titles(result)).toEqual(expected(inOrder));
    expect(new Set(documents(result)).size).toBe(COUNT);
  });

  it("moves the card of an item whose rank puts it before every other, with two writes of the list document, none of the result, and the document of each card where it was", async () => {
    const { result, items } = await sorted();
    const before = documents(result);
    const written = { ...piece.transactions.counts };

    await commit((tx) => items[COUNT - 1].withTx(tx).key("rank").set(-1));

    expect(titles(result)).toEqual(
      expected([COUNT - 1, ...inOrder.slice(0, -1)]),
    );
    expect(documents(result)).toEqual([
      before[COUNT - 1],
      ...before.slice(0, -1),
    ]);
    const { rowArraysWritten, listDocumentsWritten } =
      piece.transactions.counts;
    expect(rowArraysWritten - written.rowArraysWritten).toBe(0);
    // The removal and the insertion are each written to the one document.
    expect(listDocumentsWritten - written.listDocumentsWritten).toBe(2);
  });

  it("moves the cards of two items whose ranks another writer changes in one transaction", async () => {
    const { result, items } = await sorted();

    await commit((tx) => {
      items[30].withTx(tx).key("rank").set(-1);
      items[2].withTx(tx).key("rank").set(100);
    });

    expect(titles(result)).toEqual(
      expected([30, 0, 1, ...inOrder.slice(3, 30), ...inOrder.slice(31), 2]),
    );
  });

  it("moves a card to the place beside its own", async () => {
    const { result, items } = await sorted();

    await commit((tx) => items[20].withTx(tx).key("rank").set(21.5));

    expect(titles(result)).toEqual(
      expected([...inOrder.slice(0, 20), 21, 20, ...inOrder.slice(22)]),
    );
  });

  it("puts the card of an item that enters the array at the place of its rank, and takes out the card of one that leaves", async () => {
    const { result, items } = await sorted();
    const entering = runtime.getCell<Record<string, unknown>>(
      space,
      "sorted rows item entering",
    );
    const list = runtime.getCell<unknown[]>(space, "sorted rows items");

    await commit((tx) => {
      entering.withTx(tx).set({ title: "entered", rank: 4.5 });
      list.withTx(tx).push(entering);
    });

    expect(titles(result).slice(3, 7)).toEqual(["t3", "t4", "entered", "t5"]);

    await commit((tx) =>
      list.withTx(tx).set(items.filter((_, index) => index !== 4))
    );

    expect(titles(result).slice(3, 6)).toEqual(["t3", "t5", "t6"]);
    expect(titles(result)).toHaveLength(COUNT - 1);
  });
});
