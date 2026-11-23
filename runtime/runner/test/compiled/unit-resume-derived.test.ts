import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { resumeCompiledPieceFromBasis } from "../../src/compiled/resume.ts";
import { Runtime } from "../../src/runtime.ts";
import { openStorage, type TestStorage } from "./storage.ts";

/**
 * The pattern `name` of `compare/fixtures/unit-resume-derived.tsx`, or of
 * the fixture `fixture`.
 */
const artifactOf = async (
  name: string,
  fixture = "unit-resume-derived",
): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        `../../../../base/pattern-compiler/compare/fixtures/${fixture}.emit.json`,
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find((artifact) => artifact.name === name)!;
};

type Result = Record<string, unknown>;

// A piece whose rows are those of a `map` is started, stopped, and woken by
// units in the same runtime, as in `unit-resume.test.ts`. Where the `map`
// is over something that is no slot, the wake evaluates that once, and
// leaves the rows as the storage holds them.
describe("resumeCompiledPieceByUnits() by what a `map` is over", () => {
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

  const settled = () => runtime.scheduler.idleWithPendingCommits();

  /** Commits what `write` writes and waits until the runtime is settled. */
  const commit = async (write: (tx: ReturnType<Runtime["edit"]>) => void) => {
    const tx = runtime.edit();
    write(tx);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await settled();
  };

  const itemsOf = (titles: readonly string[]) =>
    titles.map((title, index) => ({ id: `i${index}`, title, done: false }));

  /**
   * Starts the pattern `name` over `items`, and stops the piece once the
   * runtime is settled.
   */
  const stoppedOver = async (
    name: string,
    items: unknown,
    fixture?: string,
  ) => {
    const result = runtime.getCell<Result>(space, "result");
    const artifact = await artifactOf(name, fixture);
    let piece: CompiledPiece | undefined;
    await commit((tx) => {
      piece = startCompiledPiece(
        runtime,
        tx,
        artifact,
        { items },
        result.withTx(tx),
      );
      pieces.push(piece);
    });
    piece!.stop();
    return { artifact, result };
  };

  /**
   * Starts the pattern `name` over an array of references, one to an item
   * for each of `titles`, each a cell of its own, and stops the piece.
   */
  const stopped = async (
    name: string,
    titles: readonly string[],
    fixture?: string,
  ) => {
    const cells = titles.map((_, index) =>
      runtime.getCell<Record<string, unknown>>(space, `item ${index}`)
    );
    const items = runtime.getCell<unknown[]>(space, "items");
    await commit((tx) => {
      itemsOf(titles).forEach((value, index) =>
        cells[index].withTx(tx).set(value)
      );
      items.withTx(tx).set(cells);
    });
    return { ...await stoppedOver(name, items, fixture), cells, items };
  };

  /** Wakes the piece of `result` from its basis, by units. */
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

  /** The labels of the rows `result` holds at `rows`, every link followed. */
  const labels = (result: Cell<Result>): string[] => {
    const tx = runtime.edit();
    try {
      const rows = JSON.parse(
        JSON.stringify(result.withTx(tx).key("rows").get()),
      ) as { label: string }[];
      return rows.map(({ label }) => label);
    } finally {
      tx.abort();
    }
  };

  /** Sends `event` to the stream the result holds at `name`. */
  const send = async (result: Cell<Result>, name: string, event: unknown) => {
    (result.key(name) as unknown as Cell<unknown>).send(event);
    await settled();
  };

  const TITLES = ["one", "two", "three", "four"];

  describe("a `map` over the output of a `lift` that gives the members of an array of references", () => {
    it("evaluates no body at the wake, and the body of one row for an event that changes one item", async () => {
      const { artifact, result } = await stopped("OverLift", TITLES);

      const piece = await wokenByUnits(artifact, result);
      expect(piece.instance.counts.elementEvaluations).toBe(0);
      expect(piece.instance.counts.rowsLeftStored).toBe(TITLES.length);
      await send(result, "rename", { at: 2, title: "third" });

      expect(piece.refusals).toEqual([]);
      expect(piece.instance.counts.elementEvaluations).toBe(1);
      expect(labels(result)).toEqual(["one!", "two!", "third!", "four!"]);
    });

    it("evaluates the body of the row of an item that another writer changes after the wake", async () => {
      const { artifact, result, cells } = await stopped("OverLift", TITLES);
      const piece = await wokenByUnits(artifact, result);

      await commit((tx) => cells[1].withTx(tx).key("title").set("second"));

      expect(piece.refusals).toEqual([]);
      expect(piece.instance.counts.elementEvaluations).toBe(1);
      expect(labels(result)).toEqual(["one!", "second!", "three!", "four!"]);
    });

    it("evaluates no body when an item leaves the output, and one when it enters again", async () => {
      const { artifact, result } = await stopped("OverLift", TITLES);
      const piece = await wokenByUnits(artifact, result);

      await send(result, "finish", { at: 1, done: true });

      expect(piece.refusals).toEqual([]);
      expect(piece.instance.counts.elementEvaluations).toBe(0);
      expect(labels(result)).toEqual(["one!", "three!", "four!"]);

      await send(result, "finish", { at: 1, done: false });

      expect(piece.refusals).toEqual([]);
      expect(piece.instance.counts.elementEvaluations).toBe(1);
      expect(labels(result)).toEqual(["one!", "two!", "three!", "four!"]);
    });

    // The argument holds the array itself, so each member is a plain value
    // in place in the argument document, and the output of the `lift` is an
    // array of plain values generated from scratch.
    it("evaluates every body at the wake where the array holds plain values in place", async () => {
      const { artifact, result } = await stoppedOver(
        "OverLift",
        itemsOf(TITLES),
      );

      const piece = await wokenByUnits(artifact, result);
      expect(piece.instance.counts.elementEvaluations).toBe(TITLES.length);
      await send(result, "rename", { at: 2, title: "third" });

      expect(piece.refusals).toEqual([]);
      expect(labels(result)).toEqual(["one!", "two!", "third!", "four!"]);
    });
  });

  describe("a `map` over a `filter` over an array of references", () => {
    it("evaluates the body of the `filter` for each item at the wake and no body of the `map`", async () => {
      const { artifact, result } = await stopped("OverFilter", TITLES);

      const piece = await wokenByUnits(artifact, result);
      expect(piece.instance.counts.elementEvaluations).toBe(TITLES.length);
      expect(piece.instance.counts.rowsLeftStored).toBe(TITLES.length);
      await send(result, "rename", { at: 2, title: "third" });

      expect(piece.refusals).toEqual([]);
      expect(piece.instance.counts.elementEvaluations).toBe(TITLES.length + 1);
      expect(labels(result)).toEqual(["one!", "two!", "third!", "four!"]);
    });

    it("takes the row of an item out that the `filter` drops, with no body of the `map` evaluated", async () => {
      const { artifact, result } = await stopped("OverFilter", TITLES);
      const piece = await wokenByUnits(artifact, result);

      await send(result, "finish", { at: 1, done: true });

      expect(piece.refusals).toEqual([]);
      // The body of the `filter` for the item that changed.
      expect(piece.instance.counts.elementEvaluations).toBe(TITLES.length + 1);
      expect(labels(result)).toEqual(["one!", "three!", "four!"]);
    });

    it("evaluates every body at the wake where the array holds plain values in place", async () => {
      const { artifact, result } = await stoppedOver(
        "OverFilter",
        itemsOf(TITLES),
      );

      const piece = await wokenByUnits(artifact, result);
      expect(piece.instance.counts.elementEvaluations).toBe(
        2 * TITLES.length,
      );
      expect(labels(result)).toEqual(["one!", "two!", "three!", "four!"]);
    });
  });

  describe("a `map` over a `sortBy` over an array of references", () => {
    it("evaluates the key of each item at the wake and no body of the `map`", async () => {
      const { artifact, result } = await stopped("OverSort", TITLES);

      const piece = await wokenByUnits(artifact, result);
      expect(piece.instance.counts.elementEvaluations).toBe(TITLES.length);
      expect(piece.instance.counts.rowsLeftStored).toBe(TITLES.length);
      expect(labels(result)).toEqual(["four!", "one!", "three!", "two!"]);
    });

    it("evaluates the key and the row of an item whose title moves it in the order", async () => {
      const { artifact, result } = await stopped("OverSort", TITLES);
      const piece = await wokenByUnits(artifact, result);

      await send(result, "rename", { at: 1, title: "alpha" });

      expect(piece.refusals).toEqual([]);
      expect(piece.instance.counts.elementEvaluations).toBe(TITLES.length + 2);
      expect(labels(result)).toEqual(["alpha!", "four!", "one!", "three!"]);
    });
  });

  // `Once` of `compare/fixtures/unit-resume.tsx`: the `map` is over the
  // slot that holds the array.
  describe("a `map` over a slot that holds an array of references", () => {
    it("evaluates the body of an item that another writer puts before the others, and then of one item that an event changes", async () => {
      const { artifact, result, items, cells } = await stopped(
        "Once",
        TITLES,
        "unit-resume",
      );
      const piece = await wokenByUnits(artifact, result);
      const zero = runtime.getCell<Record<string, unknown>>(space, "item zero");

      await commit((tx) => {
        zero.withTx(tx).set({ id: "z", title: "zero", done: false });
        items.withTx(tx).set([zero, ...cells]);
      });

      expect(piece.instance.counts.elementEvaluations).toBe(1);
      await send(result, "rename", { at: 3, title: "third" });

      expect(piece.refusals).toEqual([]);
      expect(piece.instance.counts.elementEvaluations).toBe(2);
      expect(labels(result)).toEqual([
        "zero!",
        "one!",
        "two!",
        "third!",
        "four!",
      ]);
    });
  });

  // The rows of the second `map` are plain values in place in the result:
  // each is computed from a row of the first, which the body reads as the
  // result of another body.
  describe("a `map` over the result of another `map` over an array of references", () => {
    it("evaluates every body of both at the wake", async () => {
      const { artifact, result } = await stopped("OverMap", TITLES);

      const piece = await wokenByUnits(artifact, result);
      expect(piece.instance.counts.elementEvaluations).toBe(
        2 * TITLES.length,
      );
      await send(result, "rename", { at: 2, title: "third" });

      expect(piece.refusals).toEqual([]);
      expect(labels(result)).toEqual(["one!", "two!", "third!", "four!"]);
    });
  });
});
