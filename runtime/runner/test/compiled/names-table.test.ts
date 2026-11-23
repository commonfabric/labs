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
import { isPrimitiveCellLink } from "../../src/link-types.ts";
import { Runtime } from "../../src/runtime.ts";
import { openStorage, storedList, type TestStorage } from "./storage.ts";

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

// A `map` over the entries of a record of references
// (`compare/fixtures/names-table.tsx`): a row for each entry, which holds
// the reference at the entry and the entry's name and reads nothing of
// what the reference names. The record is a cell under the clause
// `clause-names`, and every member is a cell under a clause of its own,
// named `clause-` and the name of the cell. Which rows there are, and the
// name of each, is the enumeration of the record. The plan declares the
// values of the record as cells and a row is a record, so each row is
// stored in a document of its own (provisional decision P54).
describe("a `map` over the entries of a record of references, whose rows are documents of their own", () => {
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
      `names ${name}`,
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
      `names result ${name}`,
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
    return { result, piece: piece! };
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

  const MEMBERS = ["ma", "mb", "mc"];

  /** The record `names`, which holds the three members by the names 1 to 3. */
  const named = async () => {
    const members = await Promise.all(MEMBERS.map(labeled));
    const names = await labeled("names");
    await commit((tx) => {
      members.forEach((cell, index) =>
        cell.withTx(tx).set({ title: MEMBERS[index] })
      );
      names.withTx(tx).set(
        Object.fromEntries(
          members.map((cell, index) => [`${index + 1}`, cell]),
        ),
      );
    });
    const { result, piece } = await started("names-table", { names });
    return { result, piece, names, members };
  };

  it("gives a row for each entry, with the member the entry refers to and the entry's name", async () => {
    const { result } = await named();

    expect(valueOf(result)).toEqual({
      kind: "table",
      rows: [
        { member: { title: "ma" }, name: "1" },
        { member: { title: "mb" }, name: "2" },
        { member: { title: "mc" }, name: "3" },
      ],
    });
  });

  it("stores each row in a document of its own, with a link at the row's position", async () => {
    const { result } = await named();

    const rows = storedList(runtime, result, ["rows"]) as unknown[];
    expect(rows.length).toBe(3);
    expect(rows.every((row) => isPrimitiveCellLink(row))).toBe(true);
  });

  it("stores the clause of the record and of no member for the number of rows and for the name of a row", async () => {
    const { result } = await named();

    expect(consumed(result, ["rows", "length"])).toEqual(clauses("names"));
    expect(consumed(result, ["rows", "1", "name"])).toEqual(clauses("names"));
  });

  it("adds a row for an entry that another writer adds, and evaluates the body of that entry alone", async () => {
    const { result, piece, names } = await named();
    const added = await labeled("md");
    await commit((tx) => added.withTx(tx).set({ title: "md" }));
    const before = piece.instance.counts.elementEvaluations;

    await commit((tx) => names.withTx(tx).key("4").set(added));

    expect((valueOf(result).rows as unknown[]).at(-1)).toEqual({
      member: { title: "md" },
      name: "4",
    });
    expect(piece.instance.counts.elementEvaluations - before).toBe(1);
    expect(consumed(result, ["rows", "3", "name"])).toEqual(clauses("names"));
  });

  it("evaluates no body when another writer changes what a member holds, which no row reads", async () => {
    const { piece, members } = await named();
    const before = piece.instance.counts.elementEvaluations;

    await commit((tx) => members[1].withTx(tx).key("title").set("edited"));

    expect(piece.instance.counts.elementEvaluations).toBe(before);
  });
});
