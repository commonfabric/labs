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
  type CompiledPieceOptions,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { Runtime } from "../../src/runtime.ts";
import { openStorage, type TestStorage } from "./storage.ts";

/** The pattern of `compare/fixtures/index-of-rows.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../../base/pattern-compiler/compare/fixtures/index-of-rows.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

type Kept = {
  count: number;
  byTag: Record<string, unknown>;
  picked: string[];
};

// A `groupBy` over the result of a `map` over an array of item references.
// The rows of that `map` hold the item's tag and a text read through the
// item's reference to its note, so a bucket holds copies of rows and no
// references to the items. Each item is a cell under a clause of its own
// (`clause-ia` to `clause-id`), and each note is a cell under another
// clause of its own (`clause-na` to `clause-nd`). The membership of a
// bucket depends on the tag of every item (PL §3.17); the text a bucket's
// member holds depends on that member's note as well, and on no other
// note.
describe("a collection index over the rows of a `map` over an array of references, whose buckets hold copies of the rows", () => {
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

  /** A schema of a record with the one clause `name`. */
  const labeled = async (name: string): Promise<JSONSchema> => ({
    type: "object",
    ifc: { confidentiality: [inputClause(name, await scenarioAudience())] },
  } as JSONSchema);

  const NAMES = ["a", "b", "c", "d"];
  const EVERY_ITEM = NAMES.map((name) => `input:clause-i${name}`);
  const notes = (...names: string[]) =>
    names.map((name) => `input:clause-n${name}`);

  /**
   * Starts the piece over four items, whose tags are `even` and `odd` in
   * turn, each with a note of its own, and with `even` as the tag whose
   * bucket the result reads.
   */
  const kept = async (options: CompiledPieceOptions = {}) => {
    const noteCells = await Promise.all(
      NAMES.map(async (name) =>
        runtime.getCell<Record<string, unknown>>(
          space,
          `rows note ${name}`,
          await labeled(`clause-n${name}`),
        )
      ),
    );
    const items = await Promise.all(
      NAMES.map(async (name) =>
        runtime.getCell<Record<string, unknown>>(
          space,
          `rows item ${name}`,
          await labeled(`clause-i${name}`),
        )
      ),
    );
    const itemList = runtime.getCell<unknown[]>(space, "rows items");
    const result = runtime.getCell<Kept>(space, "rows result");
    await commit((tx) => {
      noteCells.forEach((cell, index) =>
        cell.withTx(tx).set({ text: `text ${NAMES[index]}` })
      );
      items.forEach((cell, index) =>
        cell.withTx(tx).set({
          tag: index % 2 === 0 ? "even" : "odd",
          note: noteCells[index],
        })
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
        { items: itemList, pick: "even" },
        result.withTx(tx),
        options,
      );
      pieces.push(piece);
    });
    expect(piece!.refusals).toEqual([]);
    return { result, items, noteCells };
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

  for (const rows of ["documents", "in-place"] as const) {
    describe(`with the rows of a \`map\` over references stored as ${rows}`, () => {
      it("stores each bucket as the rows of its members", async () => {
        const { result } = await kept({ rows });

        expect(valueOf(result)).toMatchObject({
          count: 4,
          byTag: {
            buckets: {
              "s:even": [
                { tag: "even", text: "text a" },
                { tag: "even", text: "text c" },
              ],
              "s:odd": [
                { tag: "odd", text: "text b" },
                { tag: "odd", text: "text d" },
              ],
            },
          },
          picked: ["text a", "text c"],
        });
      });

      it("stores, for a bucket, the clause of every item and the clause of the note of each of its members", async () => {
        const { result } = await kept({ rows });

        const even = consumed(result, ["byTag", "buckets", "s:even"]);
        expect(even).toEqual(expect.arrayContaining(EVERY_ITEM));
        expect(even).toEqual(expect.arrayContaining(notes("a", "c")));
        const odd = consumed(result, ["byTag", "buckets", "s:odd"]);
        expect(odd).toEqual(expect.arrayContaining(EVERY_ITEM));
        expect(odd).toEqual(expect.arrayContaining(notes("b", "d")));
      });

      it("stores the clause of no note for the occupied keys, for the length of a bucket and for the number of items, which no text decides", async () => {
        const { result } = await kept({ rows });

        expect(consumed(result, ["byTag", "keys"])).toEqual(EVERY_ITEM);
        expect(consumed(result, ["byTag", "buckets", "s:even", "length"]))
          .toEqual(EVERY_ITEM);
        expect(consumed(result, ["count"])).toEqual([]);
      });

      it("stores, for the texts a lookup gave, the clause of every item and of the notes of the bucket's members, and of no other note", async () => {
        const { result } = await kept({ rows });

        expect(consumed(result, ["picked"])).toEqual(
          [...EVERY_ITEM, ...notes("a", "c")].sort(),
        );
      });

      it("stores the clause of a note for the bucket its row enters, after another writer changes the item's tag", async () => {
        const { result, items } = await kept({ rows });

        await commit((tx) => items[1].withTx(tx).key("tag").set("even"));

        expect(valueOf(result).picked).toEqual(["text a", "text b", "text c"]);
        const even = consumed(result, ["byTag", "buckets", "s:even"]);
        expect(even).toEqual(expect.arrayContaining(notes("a", "b", "c")));
        expect(consumed(result, ["picked"])).toEqual(
          [...EVERY_ITEM, ...notes("a", "b", "c")].sort(),
        );
        expect(consumed(result, ["count"])).toEqual([]);
      });

      it("follows a change of a note's text by another writer in the bucket that holds its row", async () => {
        const { result, noteCells } = await kept({ rows });

        await commit((tx) => noteCells[2].withTx(tx).key("text").set("new"));

        expect(valueOf(result).picked).toEqual(["text a", "new"]);
        expect(
          (valueOf(result).byTag as { buckets: Record<string, unknown> })
            .buckets["s:even"],
        ).toEqual([{ tag: "even", text: "text a" }, {
          tag: "even",
          text: "new",
        }]);
      });
    });
  }
});
