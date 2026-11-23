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

/** The pattern of `compare/fixtures/record-entries.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../../base/pattern-compiler/compare/fixtures/record-entries.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

type Table = { kind: string; rows: { name: string; title: string }[] };

// A `map` over the entries of a record of references on the runner path.
// The record is a cell under the clause `clause-names`, and each member a
// cell under a clause of its own. Which rows there are, and the name of
// each, shows which names the record has, so a read of a row's name
// consumes the clause of the record; what a row's body reads of its member
// consumes that member's clause and no other member's.
describe("a `map` over the entries of a record of references as a compiled piece", () => {
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
    ifc: { confidentiality: [inputClause(name, await scenarioAudience())] },
  } as JSONSchema);

  const ITEMS = ["ia", "ib", "ic"];

  /**
   * Starts the piece over a record that holds the first two of three
   * items, under the names `na` and `nb`.
   */
  const started = async () => {
    const items = await Promise.all(
      ITEMS.map(async (name) =>
        runtime.getCell<Record<string, unknown>>(
          space,
          `entries item ${name}`,
          await labeled(`clause-${name}`),
        )
      ),
    );
    const names = runtime.getCell<Record<string, unknown>>(
      space,
      "entries names",
      await labeled("clause-names"),
    );
    const result = runtime.getCell<Table>(space, "entries result");
    await commit((tx) => {
      items.forEach((cell, index) =>
        cell.withTx(tx).set({ title: ITEMS[index], note: "n" })
      );
      names.withTx(tx).set({ na: items[0], nb: items[1] });
    });
    const compiled = await artifact();
    let piece: CompiledPiece | undefined;
    await commit((tx) => {
      piece = startCompiledPiece(
        runtime,
        tx,
        compiled,
        { byName: names },
        result.withTx(tx),
      );
      pieces.push(piece);
    });
    expect(piece!.refusals).toEqual([]);
    return { piece: piece!, result, items, names };
  };

  /** The title of each row, by the name of its entry. */
  const titles = (result: Cell<Table>): Record<string, string> => {
    const tx = runtime.edit();
    try {
      const { rows } = JSON.parse(
        JSON.stringify(result.withTx(tx).get()),
      ) as Table;
      return Object.fromEntries(rows.map((row) => [row.name, row.title]));
    } finally {
      tx.abort();
    }
  };

  /**
   * The clauses of the inputs that a read of the value at `path` of the
   * result consumes, in the runtime's own resolution.
   */
  const consumed = (result: Cell<Table>, path: string[]): string[] => {
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

  it("gives a row for each entry of the record", async () => {
    const { result } = await started();

    expect(titles(result)).toEqual({ na: "ia!", nb: "ib!" });
  });

  it("stores the clause of the record for the name of a row and for the number of rows", async () => {
    const { result } = await started();

    // The name is bound to no stored position, so its record takes the
    // join of the transaction that derived the row, which holds the clause
    // of the record and more.
    expect(consumed(result, ["rows", "0", "name"])).toContain(
      "input:clause-names",
    );
    expect(consumed(result, ["rows", "length"])).toContain(
      "input:clause-names",
    );
  });

  it("stores the clause of a row's own member, and of no other member, for what its body reads", async () => {
    const { result } = await started();

    expect(consumed(result, ["rows", "0", "title"])).toEqual([
      "input:clause-ia",
      "input:clause-names",
    ]);
    expect(consumed(result, ["rows", "1", "title"])).toEqual([
      "input:clause-ib",
      "input:clause-names",
    ]);
  });

  it("evaluates one body when another writer changes one member, and gives a row to an entry that is added", async () => {
    const { piece, result, items, names } = await started();
    const before = piece.instance.counts.elementEvaluations;

    await commit((tx) => items[1].withTx(tx).key("title").set("edited"));

    expect(piece.instance.counts.elementEvaluations - before).toBe(1);
    expect(titles(result)).toEqual({ na: "ia!", nb: "edited!" });

    await commit((tx) => names.withTx(tx).key("nc").set(items[2]));

    expect(piece.instance.counts.elementEvaluations - before).toBe(2);
    expect(titles(result)).toEqual({ na: "ia!", nb: "edited!", nc: "ic!" });
    expect(consumed(result, ["rows", "2", "title"])).toEqual([
      "input:clause-ic",
      "input:clause-names",
    ]);
  });
});
