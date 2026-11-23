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

/** The pattern `name` of `compare/fixtures/unit-resume-body.tsx`. */
const artifactOf = async (
  name: string,
  fixture = "unit-resume-body",
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

// A piece whose rows are those of a `map` over an array of references is
// started, stopped, and woken by units in the same runtime, as in
// `unit-resume.test.ts`. The body of an element holds more than one cone,
// reads the position of its element, or holds another collection.
describe("resumeCompiledPieceByUnits() by what the body of an element holds", () => {
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
    more: Record<string, unknown> = {},
  ) => {
    const result = runtime.getCell<Result>(space, "result");
    const artifact = await artifactOf(name);
    let piece: CompiledPiece | undefined;
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
    return { artifact, result };
  };

  /**
   * Starts the pattern `name` over an array of references, one to an item
   * for each of `titles`, each a cell of its own, and stops the piece.
   */
  const stopped = async (
    name: string,
    titles: readonly string[],
    more: Record<string, unknown> = {},
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
    return { ...await stoppedOver(name, items, more), cells, items };
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

  describe("a body that holds a `computed` with a function body", () => {
    /** The text of each row among the children of the view of `result`. */
    const texts = (result: Cell<Result>): unknown[] => {
      const tx = runtime.edit();
      try {
        const { $UI: view } = JSON.parse(
          JSON.stringify(result.withTx(tx).get()),
        ) as { $UI: { children: [{ children: unknown[] }[]] } };
        return view.children[0].map((row) => row.children[0]);
      } finally {
        tx.abort();
      }
    };

    it("evaluates no entry of a body at the wake, and the two of one row for an event that changes one item", async () => {
      const { artifact, result } = await stopped("WithFunction", TITLES);

      const piece = await wokenByUnits(artifact, result);
      expect(piece.instance.counts.elementEvaluations).toBe(0);
      expect(piece.instance.counts.rowsLeftStored).toBe(TITLES.length);
      await send(result, "rename", { at: 2, title: "third" });

      expect(piece.refusals).toEqual([]);
      expect(piece.instance.counts.elementEvaluations).toBe(2);
      expect(texts(result)).toEqual(["ONE!", "TWO!", "THIRD!", "FOUR!"]);
    });

    it("evaluates the entries of the row of an item that another writer changes after the wake", async () => {
      const { artifact, result, cells } = await stopped(
        "WithFunction",
        TITLES,
      );
      const piece = await wokenByUnits(artifact, result);

      await commit((tx) => cells[1].withTx(tx).key("title").set("second"));

      expect(piece.refusals).toEqual([]);
      expect(piece.instance.counts.elementEvaluations).toBe(2);
      expect(texts(result)).toEqual(["ONE!", "SECOND!", "THREE!", "FOUR!"]);
    });
  });

  describe("a body that reads the position of its element", () => {
    it("evaluates no body at the wake, and the body of one row for an event that changes one item", async () => {
      const { artifact, result } = await stopped("WithIndex", TITLES);

      const piece = await wokenByUnits(artifact, result);
      expect(piece.instance.counts.elementEvaluations).toBe(0);
      await send(result, "rename", { at: 2, title: "third" });

      expect(piece.refusals).toEqual([]);
      expect(piece.instance.counts.elementEvaluations).toBe(1);
      expect(labels(result)).toEqual(["0 one", "1 two", "2 third", "3 four"]);
    });

    it("evaluates the body of each item behind one that another writer puts in after the wake", async () => {
      const { artifact, result, items, cells } = await stopped(
        "WithIndex",
        TITLES,
      );
      const piece = await wokenByUnits(artifact, result);
      const half = runtime.getCell<Record<string, unknown>>(space, "item half");

      await commit((tx) => {
        half.withTx(tx).set({ id: "h", title: "half", done: false });
        items.withTx(tx).set([...cells.slice(0, 2), half, ...cells.slice(2)]);
      });

      expect(piece.refusals).toEqual([]);
      // The item that entered and the two behind it.
      expect(piece.instance.counts.elementEvaluations).toBe(3);
      expect(labels(result)).toEqual([
        "0 one",
        "1 two",
        "2 half",
        "3 three",
        "4 four",
      ]);
    });
  });

  describe("a body that holds a `map` over another array of references", () => {
    /** The marks, each a cell of its own, and the array of them. */
    const marked = async (texts: readonly string[]) => {
      const cells = texts.map((_, index) =>
        runtime.getCell<Record<string, unknown>>(space, `mark ${index}`)
      );
      const marks = runtime.getCell<unknown[]>(space, "marks");
      await commit((tx) => {
        texts.forEach((text, index) => cells[index].withTx(tx).set({ text }));
        marks.withTx(tx).set(cells);
      });
      return marks;
    };

    /** The labels of the inner rows of the row at `at`. */
    const inner = (result: Cell<Result>, at: number): string[] => {
      const tx = runtime.edit();
      try {
        const rows = JSON.parse(
          JSON.stringify(result.withTx(tx).key("rows").get()),
        ) as { marked: { label: string }[] }[];
        return rows[at].marked.map(({ label }) => label);
      } finally {
        tx.abort();
      }
    };

    it("evaluates no body at the wake, and the bodies of one row for an event that changes one item", async () => {
      const marks = await marked(["?", "#"]);
      const { artifact, result } = await stopped("WithInner", TITLES, {
        marks,
      });

      const piece = await wokenByUnits(artifact, result);
      expect(piece.instance.counts.elementEvaluations).toBe(0);
      expect(piece.instance.counts.rowsLeftStored).toBe(TITLES.length);
      await send(result, "rename", { at: 2, title: "third" });

      expect(piece.refusals).toEqual([]);
      // The body of the item and the body of each of the two marks.
      expect(piece.instance.counts.elementEvaluations).toBe(3);
      expect(labels(result)).toEqual(["one!", "two!", "third!", "four!"]);
      expect(inner(result, 2)).toEqual(["third?", "third#"]);
      expect(inner(result, 1)).toEqual(["two?", "two#"]);
    });

    it("evaluates the bodies of every row for an event that changes one mark", async () => {
      const marks = await marked(["?", "#"]);
      const { artifact, result } = await stopped("WithInner", TITLES, {
        marks,
      });
      const piece = await wokenByUnits(artifact, result);

      await send(result, "remark", { at: 1, text: "+" });

      expect(piece.refusals).toEqual([]);
      expect(TITLES.map((_, at) => inner(result, at))).toEqual(
        TITLES.map((title) => [`${title}?`, `${title}+`]),
      );
    });
  });
});
