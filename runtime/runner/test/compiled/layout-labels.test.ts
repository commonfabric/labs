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

/**
 * A pattern of `compare/fixtures/runner-lists.tsx`, or of
 * `compare/fixtures/handle-reads.tsx` where the first has none of the name.
 */
const artifactOf = async (pattern: string): Promise<Artifact> => {
  for (const fixture of ["runner-lists", "handle-reads"]) {
    const [{ patterns }] = JSON.parse(
      await Deno.readTextFile(
        new URL(
          `../../../../base/pattern-compiler/compare/fixtures/${fixture}.emit.json`,
          import.meta.url,
        ),
      ),
    ) as { patterns: Artifact[] }[];
    const found = patterns.find((artifact) => artifact.name === pattern);
    if (found !== undefined) return found;
  }
  throw new Error(`No fixture holds a pattern named ${pattern}.`);
};

/** The paths of the result a read is made at, each with what it is. */
const PROBES: [string, string[]][] = [
  ["the root", []],
  ["the array", ["rows"]],
  ["the number of members", ["rows", "length"]],
  ["the first position", ["rows", "0"]],
  ["the second position", ["rows", "1"]],
  ["the last position", ["rows", "2"]],
  ["a leaf of the first row", ["rows", "0", "label"]],
  ["another leaf of the first row", ["rows", "0", "done"]],
  ["a leaf of the second row", ["rows", "1", "label"]],
  ["a leaf of the last row", ["rows", "2", "label"]],
];

// Where the rows of a `map` are documents of their own, a read of the
// result, of the array, of a position and of a leaf of a row consumes, in
// the runtime's own resolution, at least the clauses it consumes where the
// rows are stored in place: a clause that only the layout in place gives is
// an under-label of the other.
describe("what a read of a compiled result consumes, with rows as documents and in place", () => {
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
      id: { type: "string" },
      title: { type: "string" },
      done: { type: "boolean" },
    },
    ifc: { confidentiality: [inputClause(name, await scenarioAudience())] },
  } as JSONSchema);

  /**
   * Starts `pattern` in the layout `rows` over three of four items, each a
   * cell under a clause of its own, as references where `references` is
   * set and as plain values in place under the clause of the array
   * otherwise.
   */
  const started = async (
    pattern: string,
    rows: "documents" | "in-place",
    references: boolean,
  ) => {
    const names = ["one", "two", "three", "four"];
    const cells = await Promise.all(
      names.map(async (name, index) =>
        runtime.getCell<Record<string, unknown>>(
          space,
          `${pattern} ${rows} item ${index}`,
          await labeled(`clause-${name}`),
        )
      ),
    );
    const values = names.map((title, index) => ({
      id: `i${index}`,
      title,
      done: index === 1,
    }));
    const items = runtime.getCell<unknown[]>(
      space,
      `${pattern} ${rows} items`,
      references ? undefined : {
        type: "array",
        ifc: {
          confidentiality: [
            inputClause("clause-items", await scenarioAudience()),
          ],
        },
      } as JSONSchema,
    );
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      `${pattern} ${rows} result`,
    );
    const artifact = await artifactOf(pattern);
    await commit((tx) => {
      cells.forEach((cell, index) => cell.withTx(tx).set(values[index]));
      items.withTx(tx).set(references ? cells.slice(0, 3) : values.slice(0, 3));
    });
    let piece: CompiledPiece | undefined;
    await commit((tx) => {
      piece = startCompiledPiece(
        runtime,
        tx,
        artifact,
        { items },
        result.withTx(tx),
        { rows },
      );
      pieces.push(piece);
    });
    expect(piece!.refusals).toEqual([]);
    return { piece: piece!, result, items, cells, values };
  };

  /**
   * The clauses of the inputs that a read of the value at `path` of the
   * result consumes: the read is made through a cell in a transaction of
   * its own, every link followed, and the clauses are those of the join
   * the runtime derives from what the transaction read.
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
      return [...new Set(text.match(/input:clause-[a-z]+/g) ?? [])].sort();
    } finally {
      tx.abort();
    }
  };

  /** What each probe consumes, by what the probe is. */
  const consumedAt = (result: Cell<Record<string, unknown>>) =>
    Object.fromEntries(
      PROBES.map(([name, path]) => [name, consumed(result, path)]),
    );

  /**
   * The probes at which the layout in place gives a clause that rows as
   * documents do not, each with those clauses.
   */
  const missing = (
    documents: Record<string, string[]>,
    inPlace: Record<string, string[]>,
  ) =>
    Object.entries(inPlace).flatMap(([name, clauses]) => {
      const lacking = clauses.filter((clause) =>
        !documents[name].includes(clause)
      );
      return lacking.length === 0 ? [] : [`${name}: ${lacking.join(", ")}`];
    });

  /** The changes a comparison is made after, in order. */
  const CHANGES: [
    string,
    (
      at: Awaited<ReturnType<typeof started>>,
      references: boolean,
    ) => Promise<void>,
  ][] = [
    ["the load", () => Promise.resolve()],
    [
      "an edit of the second member",
      ({ cells, items }, references) =>
        commit((tx) =>
          references
            ? cells[1].withTx(tx).key("title").set("second")
            : items.withTx(tx).key(1).key("title").set("second")
        ),
    ],
    [
      "a member added at the end",
      ({ cells, items, values }, references) =>
        commit((tx) =>
          items.withTx(tx).set(
            references
              ? cells
              : [{ ...values[0] }, { ...values[1], title: "second" }, {
                ...values[2],
              }, values[3]],
          )
        ),
    ],
    [
      "the first member removed",
      ({ cells, items, values }, references) =>
        commit((tx) =>
          items.withTx(tx).set(
            references ? cells.slice(1) : [
              { ...values[1], title: "second" },
              { ...values[2] },
              values[3],
            ],
          )
        ),
    ],
  ];

  for (
    const [name, pattern, references] of [
      ["a `map` over an array declared as references", "Cells", true],
      [
        "a `map` over an array of references declared as plain values",
        "Plain",
        true,
      ],
      ["a `map` over an array of plain values in place", "Plain", false],
      [
        "a `map` over the result of a `filter` over plain values in place",
        "Chained",
        false,
      ],
    ] as const
  ) {
    it(`gives no less with rows as documents than in place, for ${name}`, async () => {
      const documents = await started(pattern, "documents", references);
      const inPlace = await started(pattern, "in-place", references);

      for (const [, change] of CHANGES) {
        await change(documents, references);
        await change(inPlace, references);
        expect(documents.piece.refusals).toEqual([]);
        expect(inPlace.piece.refusals).toEqual([]);
        expect(
          missing(consumedAt(documents.result), consumedAt(inPlace.result)),
        ).toEqual([]);
      }
    });
  }

  // The result of `Cells` holds nothing but the array of links, which the
  // runtime takes for a structure of links: it stores the join of the
  // transaction that wrote it for every child of the root, so every read
  // below the root consumes every clause. `Counted` of `handle-reads.tsx`
  // holds a number beside the array.
  it("consumes the clause of one member at a leaf of its row, where the result holds a plain value beside the array", async () => {
    const { result } = await started("Counted", "documents", true);

    expect(consumed(result, ["rows", "0", "title"])).toEqual([
      "input:clause-one",
    ]);
    expect(consumed(result, ["rows", "1"])).toEqual(["input:clause-two"]);
    expect(consumed(result, ["rows"])).toEqual([
      "input:clause-one",
      "input:clause-three",
      "input:clause-two",
    ]);
  });

  it("consumes every clause at a leaf of a row where the result holds nothing but the array of links", async () => {
    const { result } = await started("Cells", "documents", true);

    expect(consumed(result, ["rows", "0", "label"])).toEqual([
      "input:clause-one",
      "input:clause-three",
      "input:clause-two",
    ]);
  });
});
