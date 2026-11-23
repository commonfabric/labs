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

/** The pattern `which` of `compare/fixtures/kept-index.tsx`. */
const artifact = async (which: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../../base/pattern-compiler/compare/fixtures/kept-index.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === which)!;
};

type Kept = { count: number; byTag: Record<string, unknown> };
type Read = { name: string; titles: string[] };

// A `groupBy` over an array of item references that a piece keeps in its
// result, and a second piece that is handed a reference to the stored
// index and looks up one key. Each item is a cell under a clause of its
// own. The membership of a bucket depends on the key of every item (PL
// §3.17), so a read of any bucket of the stored index, of a key that has
// no bucket, and of the occupied keys consumes the clause of every item.
describe("a collection index that a compiled piece keeps, and a second piece that looks up a key in it", () => {
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

  /** A schema with the one clause `name`, as the comparison generates it. */
  const labeled = async (name: string): Promise<JSONSchema> => ({
    type: "object",
    properties: { title: { type: "string" }, tag: { type: "string" } },
    ifc: { confidentiality: [inputClause(name, await scenarioAudience())] },
  } as JSONSchema);

  const ITEMS = ["ia", "ib", "ic", "id"];
  const EVERY_ITEM = ITEMS.map((name) => `input:clause-${name}`);

  /**
   * Starts the piece that keeps the index over four items, whose tags are
   * `even` and `odd` in turn and whose clauses are `clause-ia` to
   * `clause-id`.
   */
  const kept = async () => {
    const items = await Promise.all(
      ITEMS.map(async (name) =>
        runtime.getCell<Record<string, unknown>>(
          space,
          `kept item ${name}`,
          await labeled(`clause-${name}`),
        )
      ),
    );
    const itemList = runtime.getCell<unknown[]>(space, "kept items");
    const result = runtime.getCell<Kept>(space, "kept result");
    await commit((tx) => {
      items.forEach((cell, index) =>
        cell.withTx(tx).set({
          title: ITEMS[index],
          tag: index % 2 === 0 ? "even" : "odd",
        })
      );
      itemList.withTx(tx).set(items);
    });
    const compiled = await artifact("default");
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

  /** Starts the piece that looks up `name` in the index `result` keeps. */
  const reading = async (result: Cell<Kept>, name: string) => {
    const read = runtime.getCell<Read>(space, `kept reader ${name}`);
    const compiled = await artifact("Reader");
    let piece: CompiledPiece | undefined;
    await commit((tx) => {
      piece = startCompiledPiece(
        runtime,
        tx,
        compiled,
        { index: result.key("byTag"), name },
        read.withTx(tx),
      );
      pieces.push(piece);
    });
    expect(piece!.refusals).toEqual([]);
    return { piece: piece!, read };
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
   * kept result consumes, in the runtime's own resolution.
   */
  const consumed = (result: Cell<Kept>, path: string[]): string[] => {
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

  it("stores the index in the shape of today's index data, each bucket under its encoded key", async () => {
    const { result } = await kept();

    expect(valueOf(result).byTag).toMatchObject({
      kind: "collection-index",
      mode: "group",
      keys: ["even", "odd"],
      buckets: {
        "s:even": [{ title: "ia" }, { title: "ic" }],
        "s:odd": [{ title: "ib" }, { title: "id" }],
      },
    });
  });

  it("stores the clause of every item for a bucket, for a key that has no bucket, and for the occupied keys", async () => {
    const { result } = await kept();

    for (
      const path of [
        ["byTag", "buckets", "s:even"],
        ["byTag", "buckets", "s:even", "length"],
        ["byTag", "buckets", "s:none"],
        ["byTag", "keys"],
      ]
    ) {
      expect(consumed(result, path)).toEqual(EVERY_ITEM);
    }
  });

  it("stores no clause of an item for the number of items, which no key decides", async () => {
    const { result } = await kept();

    expect(consumed(result, ["count"])).toEqual([]);
  });

  it("gives a second piece the members of the bucket it looks up", async () => {
    const { result } = await kept();

    const { read } = await reading(result, "odd");

    expect(valueOf(read)).toEqual({ name: "odd", titles: ["ib", "id"] });
  });

  it("evaluates nothing in the second piece when a bucket it did not look up changes, and follows the bucket it looked up", async () => {
    const { result, items } = await kept();
    const { piece, read } = await reading(result, "odd");
    const before = piece.instance.counts.evaluations;

    await commit((tx) => items[0].withTx(tx).key("tag").set("none"));

    expect(piece.instance.counts.evaluations).toBe(before);

    await commit((tx) => items[2].withTx(tx).key("tag").set("odd"));

    expect(valueOf(read)).toEqual({ name: "odd", titles: ["ib", "ic", "id"] });
  });

  it("gives one record of the occupied keys, and none of a position among them, when a key leaves the middle of them and another enters", async () => {
    const { result, items } = await kept();
    await commit((tx) =>
      items.forEach((item, index) =>
        item.withTx(tx).key("tag").set(`t${index}`)
      )
    );
    const recorded: string[] = [];
    pieces[0].transactions.onRecorded((writes) => {
      for (const { target } of writes) recorded.push(target.path.join("/"));
    });

    await commit((tx) => items[0].withTx(tx).key("tag").set("t9"));

    expect((valueOf(result).byTag as { keys: string[] }).keys).toEqual([
      "t1",
      "t2",
      "t3",
      "t9",
    ]);
    expect(recorded.filter((path) => path.startsWith("byTag/keys/")))
      .toEqual([]);
    expect(recorded.filter((path) => path === "byTag/keys")).toEqual([
      "byTag/keys",
    ]);
    expect(consumed(result, ["byTag", "keys"])).toEqual(EVERY_ITEM);
    // The buckets that stayed, the one that came to exist, and a key that
    // has no bucket any more.
    for (const key of ["s:t1", "s:t9", "s:t0"]) {
      expect(consumed(result, ["byTag", "buckets", key])).toEqual(EVERY_ITEM);
      expect(consumed(result, ["byTag", "buckets", key, "length"])).toEqual(
        EVERY_ITEM,
      );
    }
  });
});
