import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import { inputClause } from "../../../../base/pattern-compiler/compare/generate.ts";
import { scenarioAudience } from "../../../../base/pattern-compiler/compare/harness.ts";
import type { JSONSchema } from "../../src/builder/types.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import { readStoredCfcMetadata } from "../../src/cfc/metadata.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import {
  resumeCompiledPiece,
  resumeCompiledPieceFromBasis,
} from "../../src/compiled/resume.ts";
import { isPrimitiveCellLink } from "../../src/link-types.ts";
import { parseLink } from "../../src/link-utils.ts";
import { Runtime } from "../../src/runtime.ts";
import { openStorage, storedList, type TestStorage } from "./storage.ts";

/** The pattern `name` of `compare/fixtures/unit-resume.tsx`. */
const artifactOf = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../../base/pattern-compiler/compare/fixtures/unit-resume.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find((artifact) => artifact.name === name)!;
};

/**
 * A schema of an item with one confidentiality clause for each of `names`:
 * the atom the comparison generates for the input of that name, with the
 * audience of the space as an alternative, which every store of the space
 * admits.
 */
const labeled = async (...names: string[]): Promise<JSONSchema> => {
  const audience = await scenarioAudience();
  return {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      done: { type: "boolean" },
    },
    ifc: {
      confidentiality: names.map((name) => inputClause(name, audience)),
    },
  } as JSONSchema;
};

type Result = Record<string, unknown>;

// A piece is started over an array of references, each to an item in a
// document of its own, and stopped. The same runtime then starts it again
// from what the storage holds. Its replica holds every document the piece
// wrote, so the storage manager is made to say that a read gives what the
// store holds (`readsThroughStore`), as the replica of a serving runtime
// does, and the piece is woken by units: the rows it can leave are left as
// the storage holds them.
describe("resumeCompiledPieceByUnits()", () => {
  let runtime: Runtime;
  let storageManager: TestStorage;
  let space: MemorySpace;
  let pieces: CompiledPiece[];

  beforeEach(async () => {
    // The identity whose space is the audience the clauses name
    // (`scenarioAudience`).
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

  const settled = () => runtime.scheduler.idleWithPendingCommits();

  /** Commits what `write` writes and waits until the runtime is settled. */
  const commit = async (write: (tx: ReturnType<Runtime["edit"]>) => void) => {
    const tx = runtime.edit();
    write(tx);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await settled();
  };

  /**
   * Starts the pattern `name` over an item for each of `titles`, each a
   * cell of its own under a clause of its own, and stops the piece once
   * the runtime is settled.
   */
  const stopped = async (
    name: string,
    titles: string[],
    more: Record<string, unknown> = {},
  ) => {
    const cells = await Promise.all(
      titles.map(async (title, index) => ({
        cell: runtime.getCell<Record<string, unknown>>(
          space,
          `item ${index}`,
          await labeled(`clause-${title}`),
        ),
        value: { id: `i${index}`, title, done: false },
      })),
    );
    const items = runtime.getCell<unknown[]>(space, "items");
    const result = runtime.getCell<Result>(space, "result");
    const artifact = await artifactOf(name);
    let piece: CompiledPiece | undefined;
    await commit((tx) => {
      for (const { cell, value } of cells) cell.withTx(tx).set(value);
      items.withTx(tx).set(cells.map(({ cell }) => cell));
    });
    await commit((tx) => {
      piece = startCompiledPiece(
        runtime,
        tx,
        artifact,
        { items, ...more },
        result.withTx(tx),
      );
      pieces.push(piece);
    });
    piece!.stop();
    return { artifact, result, cells: cells.map(({ cell }) => cell) };
  };

  /**
   * Wakes the piece of `result` from its basis, by units, and waits until
   * the runtime is settled.
   */
  const wokenByUnits = async (artifact: Artifact, result: Cell<Result>) => {
    Object.assign(runtime.storageManager, { readsThroughStore: () => true });
    const resumed = await resumeCompiledPieceFromBasis(
      runtime,
      artifact,
      result,
    );
    expect(resumed.current).toBe(true);
    const piece = await resumed.wake();
    pieces.push(piece);
    await settled();
    return piece;
  };

  /** What `result` holds at `name`, every link followed, as plain values. */
  const read = (result: Cell<Result>, name: string): unknown => {
    const tx = runtime.edit();
    try {
      return JSON.parse(JSON.stringify(result.withTx(tx).key(name).get()));
    } finally {
      tx.abort();
    }
  };

  /** The labels of the rows `result` holds at `name`. */
  const labelsAt = (result: Cell<Result>, name: string): string[] =>
    (read(result, name) as { label: string }[]).map(({ label }) => label);

  /** Sends `event` to the stream the result holds at `name`. */
  const send = async (result: Cell<Result>, name: string, event: unknown) => {
    (result.key(name) as unknown as Cell<unknown>).send(event);
    await settled();
  };

  /** The stored labels of the document of the row at `at`, as JSON text. */
  const rowLabels = (result: Cell<Result>, at: number): string => {
    // The links to the rows, through their list document where they are
    // in one.
    const rows = storedList(
      runtime,
      result as unknown as Cell<unknown>,
      ["rows"],
    ) as unknown[];
    const tx = runtime.edit();
    try {
      expect(isPrimitiveCellLink(rows[at])).toBe(true);
      const id = parseLink(rows[at] as never).id!;
      return JSON.stringify(
        readStoredCfcMetadata(tx, { space, id: id as never, scope: "space" }) ??
          {},
      );
    } finally {
      tx.abort();
    }
  };

  const TITLES = ["one", "two", "three", "four"];

  it("evaluates no body at the wake, and the body of one row for an event that changes one item", async () => {
    const { artifact, result } = await stopped("Once", TITLES);

    const piece = await wokenByUnits(artifact, result);
    expect(piece.instance.counts.elementEvaluations).toBe(0);
    await send(result, "rename", { at: 2, title: "third" });

    expect(piece.refusals).toEqual([]);
    expect(piece.instance.counts.elementEvaluations).toBe(1);
    expect(labelsAt(result, "rows")).toEqual([
      "one!",
      "two!",
      "third!",
      "four!",
    ]);
  });

  it("evaluates the body of the row of an item that another writer changes after the wake", async () => {
    const { artifact, result, cells } = await stopped("Once", TITLES);
    const piece = await wokenByUnits(artifact, result);

    await commit((tx) => cells[2].withTx(tx).key("title").set("third"));

    expect(piece.refusals).toEqual([]);
    expect(piece.instance.counts.elementEvaluations).toBe(1);
    expect(labelsAt(result, "rows")).toEqual([
      "one!",
      "two!",
      "third!",
      "four!",
    ]);
  });

  // The argument holds the array itself, so each element is a plain value
  // in place in the argument document. The body of such an element reads
  // through a reference by key, which the lists of the readers do not
  // hold.
  it("evaluates every body at the wake where the array holds plain values in place", async () => {
    const result = runtime.getCell<Result>(space, "result");
    const artifact = await artifactOf("Once");
    let first: CompiledPiece | undefined;
    await commit((tx) => {
      first = startCompiledPiece(
        runtime,
        tx,
        artifact,
        {
          items: TITLES.map((title, index) => ({
            id: `i${index}`,
            title,
            done: false,
          })),
        },
        result.withTx(tx),
      );
    });
    first!.stop();

    const piece = await wokenByUnits(artifact, result);
    expect(piece.instance.counts.elementEvaluations).toBe(TITLES.length);
    await send(result, "rename", { at: 2, title: "third" });

    expect(piece.refusals).toEqual([]);
    expect(labelsAt(result, "rows")).toEqual([
      "one!",
      "two!",
      "third!",
      "four!",
    ]);
  });

  // An array of plain records that a client writes through a cell holds a
  // link at each position: the runtime stores each record in an entity of
  // its own.
  it("leaves the rows as stored where a client wrote the array as plain records through a cell", async () => {
    const items = runtime.getCell<unknown[]>(space, "items");
    const result = runtime.getCell<Result>(space, "result");
    const artifact = await artifactOf("Once");
    let first: CompiledPiece | undefined;
    await commit((tx) => {
      items.withTx(tx).set(
        TITLES.map((title, index) => ({ id: `i${index}`, title, done: false })),
      );
    });
    await commit((tx) => {
      first = startCompiledPiece(
        runtime,
        tx,
        artifact,
        { items },
        result.withTx(tx),
      );
    });
    first!.stop();

    const piece = await wokenByUnits(artifact, result);
    expect(piece.instance.counts.elementEvaluations).toBe(0);
    await send(result, "rename", { at: 2, title: "third" });

    expect(piece.refusals).toEqual([]);
    expect(piece.instance.counts.elementEvaluations).toBe(1);
    expect(labelsAt(result, "rows")).toEqual([
      "one!",
      "two!",
      "third!",
      "four!",
    ]);
  });

  // The result keeps the collection at `again` and at `rows`. The rows of
  // one place are documents that the storage holds, and the unit at the
  // other place takes the rows as values, which evaluates every body.
  it("holds the rows at both places of a result that keeps one collection twice, after the wake and after an event", async () => {
    const { artifact, result } = await stopped("Twice", TITLES);

    const piece = await wokenByUnits(artifact, result);
    expect(labelsAt(result, "rows")).toEqual([
      "one!",
      "two!",
      "three!",
      "four!",
    ]);
    expect(labelsAt(result, "again")).toEqual([
      "one!",
      "two!",
      "three!",
      "four!",
    ]);
    await send(result, "rename", { at: 2, title: "third" });

    expect(piece.refusals).toEqual([]);
    expect(labelsAt(result, "rows")).toEqual([
      "one!",
      "two!",
      "third!",
      "four!",
    ]);
    expect(labelsAt(result, "again")).toEqual([
      "one!",
      "two!",
      "third!",
      "four!",
    ]);
    expect(piece.instance.counts.elementEvaluations).toBe(TITLES.length + 1);
  });

  // The body of each element uses the value of another cone, so a change
  // of that value changes a row whose documents did not change: the lists
  // of the readers do not say so, and every body is evaluated at the wake.
  it("evaluates every body at the wake where the body of an element uses a value another cone computes", async () => {
    const mark = runtime.getCell<string>(space, "mark");
    await commit((tx) => mark.withTx(tx).set("?"));
    const { artifact, result } = await stopped("Shared", TITLES, { mark });

    const piece = await wokenByUnits(artifact, result);
    expect(piece.instance.counts.elementEvaluations).toBe(TITLES.length);
    await commit((tx) => mark.withTx(tx).set("#"));

    expect(piece.refusals).toEqual([]);
    expect(labelsAt(result, "rows")).toEqual([
      "one##",
      "two##",
      "three##",
      "four##",
    ]);
  });

  // The item of one row is written again with the value it holds, under a
  // schema with one more clause: the label of the document changes and no
  // value does.
  describe("a change of the label alone of a document that a row read", () => {
    const relabeled = async (cell: Cell<Record<string, unknown>>) => {
      const again = runtime.getCell<Record<string, unknown>>(
        space,
        "item 1",
        await labeled("clause-two", "clause-late"),
      );
      expect(again.getAsNormalizedFullLink().id).toBe(
        cell.getAsNormalizedFullLink().id,
      );
      await commit((tx) =>
        again.withTx(tx).set({ id: "i1", title: "two", done: false })
      );
    };

    it("stores the label on the row of a piece that was resumed whole", async () => {
      const { artifact, result, cells } = await stopped("Once", TITLES);
      const piece = await resumeCompiledPiece(runtime, artifact, result);
      pieces.push(piece);
      await settled();
      expect(rowLabels(result, 1)).not.toContain("clause-late");

      await relabeled(cells[1]);

      expect(piece.refusals).toEqual([]);
      expect(rowLabels(result, 1)).toContain("clause-late");
    });

    it("stores the label on a row that the piece left as stored", async () => {
      const { artifact, result, cells } = await stopped("Once", TITLES);
      const piece = await wokenByUnits(artifact, result);
      expect(piece.instance.counts.elementEvaluations).toBe(0);
      expect(rowLabels(result, 1)).not.toContain("clause-late");

      await relabeled(cells[1]);

      expect(piece.refusals).toEqual([]);
      expect(rowLabels(result, 1)).toContain("clause-late");
    });
  });
});
