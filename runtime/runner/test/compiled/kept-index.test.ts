import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import { inputClause } from "../../../../base/pattern-compiler/compare/generate.ts";
import { scenarioAudience } from "../../../../base/pattern-compiler/compare/harness.ts";
import type { JSONSchema } from "../../src/builder/types.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import { readStoredCfcMetadata } from "../../src/cfc/metadata.ts";
import { deriveFlowJoin } from "../../src/cfc/prepare.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { isPrimitiveCellLink } from "../../src/link-types.ts";
import { parseLink } from "../../src/link-utils.ts";
import { Runtime } from "../../src/runtime.ts";
import { openStorage, storedList, type TestStorage } from "./storage.ts";

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
  const kept = async (
    tags: readonly string[] = ["even", "odd", "even", "odd"],
    rows: "documents" | "in-place" = "documents",
  ) => {
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
          tag: tags[index],
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
        { rows },
      );
      pieces.push(piece);
    });
    expect(piece!.refusals).toEqual([]);
    return { result, items, itemList };
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

  /**
   * What the entity of the result holds at `path`, and where that is the
   * link to the document of the bucket links of an index, what that
   * document holds. No link to a bucket is followed.
   */
  const storedAt = (result: Cell<Kept>, path: string[]): unknown =>
    storedList(runtime, result, path);

  /** The entity a stored link names. */
  const entityOf = (link: unknown): string => parseLink(link as never).id!;

  /** The titles of the items an entity that holds a bucket links to. */
  const titlesIn = (bucket: string): string[] => {
    const tx = runtime.edit();
    try {
      const members = tx.readValueOrThrow({
        space,
        id: bucket as never,
        path: [],
        scope: "space",
      }) as unknown[];
      return members.map((member) =>
        tx.readValueOrThrow({
          space,
          id: entityOf(member) as never,
          path: ["title"],
          scope: "space",
        }) as string
      );
    } finally {
      tx.abort();
    }
  };

  /** How many label entries the entity of the result stores. */
  const labelEntries = (result: Cell<Kept>): number => {
    const tx = runtime.edit();
    try {
      const { space, id, scope } = result.getAsNormalizedFullLink();
      return readStoredCfcMetadata(tx, { space, id, scope })?.labelMap.entries
        .length ?? 0;
    } finally {
      tx.abort();
    }
  };

  it("stores the index in the shape of today's index data without the occupied keys, each bucket under its encoded key", async () => {
    const { result } = await kept();

    const index = valueOf(result).byTag;
    expect(index).toEqual({
      kind: "collection-index",
      mode: "group",
      buckets: {
        "s:even": [
          { title: "ia", tag: "even" },
          { title: "ic", tag: "even" },
        ],
        "s:odd": [{ title: "ib", tag: "odd" }, { title: "id", tag: "odd" }],
      },
    });
  });

  it("stores each bucket in a document of its own, with a link to it in the result document", async () => {
    const { result } = await kept();

    const buckets = storedAt(result, ["byTag", "buckets"]) as Record<
      string,
      unknown
    >;

    expect(Object.keys(buckets)).toEqual(["s:even", "s:odd"]);
    expect(Object.values(buckets).every((link) => isPrimitiveCellLink(link)))
      .toBe(true);
    expect(titlesIn(entityOf(buckets["s:even"]))).toEqual(["ia", "ic"]);
    expect(titlesIn(entityOf(buckets["s:odd"]))).toEqual(["ib", "id"]);
  });

  it("writes the documents of two buckets and nothing of the result document when a member moves from one bucket to the other", async () => {
    const { result, items } = await kept();
    const before = JSON.stringify(storedAt(result, []));
    const written: string[] = [];
    pieces[0].transactions.onRecorded((writes) => {
      for (const { target, unchanged } of writes) {
        if (!unchanged) written.push(`${target.id}/${target.path.join("/")}`);
      }
    });

    await commit((tx) => items[0].withTx(tx).key("tag").set("odd"));

    const buckets = storedAt(result, ["byTag", "buckets"]) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(storedAt(result, []))).toBe(before);
    expect(titlesIn(entityOf(buckets["s:even"]))).toEqual(["ic"]);
    expect(titlesIn(entityOf(buckets["s:odd"]))).toEqual(["ia", "ib", "id"]);
    const resultEntity = result.getAsNormalizedFullLink().id;
    expect(written.filter((at) => at.startsWith(`${resultEntity}/`))).toEqual(
      [],
    );
    for (const key of ["s:even", "s:odd", "s:none"]) {
      expect(consumed(result, ["byTag", "buckets", key])).toEqual(EVERY_ITEM);
    }
  });

  it("writes one link of the result document when a bucket comes to exist, and removes the link and the document of a bucket that emptied", async () => {
    const { result, items } = await kept();
    const before = storedAt(result, ["byTag", "buckets"]) as Record<
      string,
      unknown
    >;

    await commit((tx) => items[0].withTx(tx).key("tag").set("prime"));
    await commit((tx) => items[2].withTx(tx).key("tag").set("prime"));

    const buckets = storedAt(result, ["byTag", "buckets"]) as Record<
      string,
      unknown
    >;
    expect(Object.keys(buckets)).toEqual(["s:odd", "s:prime"]);
    expect(buckets["s:odd"]).toEqual(before["s:odd"]);
    expect(titlesIn(entityOf(buckets["s:prime"]))).toEqual(["ia", "ic"]);
    const tx = runtime.edit();
    try {
      expect(tx.readValueOrThrow({
        space,
        id: entityOf(before["s:even"]) as never,
        path: [],
        scope: "space",
      })).toBeUndefined();
    } finally {
      tx.abort();
    }
    expect(consumed(result, ["byTag", "buckets"])).toEqual(EVERY_ITEM);
    for (const key of ["s:even", "s:odd", "s:prime"]) {
      expect(consumed(result, ["byTag", "buckets", key])).toEqual(EVERY_ITEM);
    }
  });

  it("stores as many label entries in the result document at the load for four buckets as for two", async () => {
    const two = await kept();
    const entries = labelEntries(two.result);
    for (const piece of pieces.splice(0)) piece.stop();

    const four = await kept(["t0", "t1", "t2", "t3"]);

    expect(
      Object.keys(storedAt(four.result, ["byTag", "buckets"]) as object).length,
    ).toBe(4);
    expect(labelEntries(four.result)).toBe(entries);
  });

  it("stores the clause of every item for a bucket, for a key that has no bucket, and for the record of the buckets", async () => {
    const { result } = await kept();

    for (
      const path of [
        ["byTag", "buckets", "s:even"],
        ["byTag", "buckets", "s:even", "length"],
        ["byTag", "buckets", "s:none"],
        ["byTag", "buckets"],
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

  it("stores the clause of every item for each bucket and its length after a key left and another entered", async () => {
    const { result, items } = await kept();
    await commit((tx) =>
      items.forEach((item, index) =>
        item.withTx(tx).key("tag").set(`t${index}`)
      )
    );

    await commit((tx) => items[0].withTx(tx).key("tag").set("t9"));

    expect(Object.keys(storedAt(result, ["byTag", "buckets"]) as object))
      .toEqual(["s:t1", "s:t2", "s:t3", "s:t9"]);
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
