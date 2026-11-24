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

/** The pattern of `compare/fixtures/window-construct.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../../base/pattern-compiler/compare/fixtures/window-construct.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

type Item = { text: string; shown: boolean };

type Windows = {
  latest: Item[];
  oldest: Item[];
  latestShown: Item[];
  texts: string[];
  lastTexts: string[];
};

// The windows `last` and `first` over an array of item references, each
// item a cell under a clause of its own. An element of a window is the
// element of the source, passed through, and its stored label is the join
// of the labels of the references at every position of the source, as for
// an element of the result of a `filter` or of a `sortBy`.
describe("a window of a collection as a compiled piece, over an array of references each under a clause of its own", () => {
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
    properties: { text: { type: "string" }, shown: { type: "boolean" } },
    ifc: { confidentiality: [inputClause(name, await scenarioAudience())] },
  } as JSONSchema);

  const ITEMS = ["ia", "ib", "ic", "id", "ie"];
  const EVERY_ITEM = ITEMS.map((name) => `input:clause-${name}`);

  /** An item cell with the text `name` under the clause `clause-<name>`. */
  const itemOf = async (name: string) =>
    runtime.getCell<Record<string, unknown>>(
      space,
      `window item ${name}`,
      await labeled(`clause-${name}`),
    );

  /**
   * Starts the piece over five items, whose texts are their names and
   * whose clauses are `clause-ia` to `clause-ie`. The first is not shown.
   */
  const windowed = async () => {
    const items = await Promise.all(ITEMS.map(itemOf));
    const itemList = runtime.getCell<unknown[]>(space, "window items");
    const result = runtime.getCell<Windows>(space, "window result");
    await commit((tx) => {
      items.forEach((cell, index) =>
        cell.withTx(tx).set({ text: ITEMS[index], shown: index !== 0 })
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
    return { result, itemList };
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

  /** The texts of each window of the result. */
  const textsOf = (result: Cell<Windows>) => {
    const { latest, oldest, latestShown, texts, lastTexts } = valueOf(result);
    const of = (items: Item[]) => items.map(({ text }) => text);
    return {
      latest: of(latest),
      oldest: of(oldest),
      latestShown: of(latestShown),
      texts,
      lastTexts,
    };
  };

  /**
   * The clauses of the inputs that a read of the value at `path` of the
   * result consumes, in the runtime's own resolution.
   */
  const consumed = (result: Cell<Windows>, path: string[]): string[] => {
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

  it("stores the last and the first items, and the rows of a `map` over a window", async () => {
    const { result } = await windowed();

    expect(textsOf(result)).toEqual({
      latest: ["ic", "id", "ie"],
      oldest: ["ia", "ib"],
      latestShown: ["ic", "id", "ie"],
      texts: ["ic", "id", "ie"],
      lastTexts: ["id", "ie"],
    });
  });

  it("stores the clause of every item for an element of a window over the array, and for the length of the window", async () => {
    const { result } = await windowed();

    expect({
      latest: consumed(result, ["latest", "0", "text"]),
      oldest: consumed(result, ["oldest", "1", "text"]),
      length: consumed(result, ["latest", "length"]),
    }).toEqual({ latest: EVERY_ITEM, oldest: EVERY_ITEM, length: EVERY_ITEM });
  });

  it("stores the clause of every item for an element of a window over a `filter` that read every item", async () => {
    const { result } = await windowed();

    expect(consumed(result, ["latestShown", "0", "text"])).toEqual(EVERY_ITEM);
  });

  it("moves each window over the array by one when another writer appends an item", async () => {
    const { result, itemList } = await windowed();
    const added = await itemOf("if");

    await commit((tx) => {
      added.withTx(tx).set({ text: "if", shown: true });
      itemList.withTx(tx).push(added);
    });

    expect(textsOf(result)).toEqual({
      latest: ["id", "ie", "if"],
      oldest: ["ia", "ib"],
      latestShown: ["id", "ie", "if"],
      texts: ["id", "ie", "if"],
      lastTexts: ["ie", "if"],
    });
    expect(pieces[0].refusals).toEqual([]);
    expect(consumed(result, ["latest", "2", "text"])).toEqual([
      ...EVERY_ITEM,
      "input:clause-if",
    ]);
  });
});
