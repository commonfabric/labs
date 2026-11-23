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

/** The pattern of `compare/fixtures/chained-maps.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../../base/pattern-compiler/compare/fixtures/chained-maps.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

type Kept = { count: number; tags: string[]; texts: string[] };

// A `map` over the result of a `map` over an array of item references.
// A row of the first `map` holds the item's tag and a text of the item's
// note as references, and the body of the second reads the value each
// reference names. Each item is a cell under a clause of its own
// (`clause-ia` to `clause-id`), and each note is a cell under another
// clause of its own (`clause-na` to `clause-nd`). What the second `map`
// computes from a tag depends on the item that holds the tag, and what it
// computes from a text on the note that holds the text.
describe("a `map` over the result of a `map` over an array of references, whose body reads the value a reference in the upstream row names", () => {
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
   * turn, each with a note of its own.
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
        { items: itemList },
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
      it("computes each text from the value the upstream row refers to", async () => {
        const { result } = await kept({ rows });

        expect(valueOf(result)).toEqual({
          count: 4,
          tags: ["even!", "odd!", "even!", "odd!"],
          texts: ["text a!", "text b!", "text c!", "text d!"],
        });
      });

      it("stores, for what a body computed from a tag, the clause of the item that holds the tag and of no other item", async () => {
        const { result } = await kept({ rows });

        expect(consumed(result, ["tags", "0"])).toEqual(["input:clause-ia"]);
        expect(consumed(result, ["tags", "3"])).toEqual(["input:clause-id"]);
        expect(consumed(result, ["tags"])).toEqual(EVERY_ITEM);
      });

      it("stores, for what a body computed from a text, the clause of the note that holds the text and of no other note", async () => {
        const { result } = await kept({ rows });

        expect(consumed(result, ["texts", "1"])).toEqual(notes("b"));
        expect(consumed(result, ["texts"])).toEqual(
          notes("a", "b", "c", "d"),
        );
      });

      it("stores no clause for the number of items, which no tag and no text decides", async () => {
        const { result } = await kept({ rows });

        expect(consumed(result, ["count"])).toEqual([]);
      });

      it("stores the clause of the item again after another writer changes its tag", async () => {
        const { result, items } = await kept({ rows });

        await commit((tx) => items[1].withTx(tx).key("tag").set("changed"));

        expect(valueOf(result).tags[1]).toBe("changed!");
        expect(consumed(result, ["tags", "1"])).toEqual(["input:clause-ib"]);
        expect(consumed(result, ["count"])).toEqual([]);
      });
    });
  }
});
