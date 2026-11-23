import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import { inputClause } from "../../../../base/pattern-compiler/compare/generate.ts";
import { scenarioAudience } from "../../../../base/pattern-compiler/compare/harness.ts";
import { rowDocumentCollections } from "../../../../base/pattern-compiler/exec/row-documents.ts";
import { isLink } from "../../../../base/pattern-compiler/exec/store.ts";
import type { JSONSchema } from "../../src/builder/types.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import { readStoredCfcMetadata } from "../../src/cfc/metadata.ts";
import {
  type CompiledPiece,
  type CompiledPieceOptions,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { isPrimitiveCellLink } from "../../src/link-types.ts";
import { parseLink } from "../../src/link-utils.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

/**
 * The artifact of a pattern of a fixture of `base/pattern-compiler`, by
 * default of `compare/fixtures/runner-lists.tsx`.
 */
const artifactOf = async (
  pattern: string,
  fixture = "runner-lists",
): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        `../../../../base/pattern-compiler/compare/fixtures/${fixture}.emit.json`,
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find((artifact) => artifact.name === pattern)!;
};

/**
 * A schema with one confidentiality clause, of the atom the comparison
 * generates for the input `name` with the audience of the space as an
 * alternative, which every store of the space admits.
 */
const labeled = async (name: string): Promise<JSONSchema> => ({
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    done: { type: "boolean" },
  },
  ifc: { confidentiality: [inputClause(name, await scenarioAudience())] },
} as JSONSchema);

/** A value with the schema of each of the executor's links left out. */
const withoutSchemas = (value: unknown): unknown => {
  if (isLink(value)) {
    return { $link: { doc: value.$link.doc, path: value.$link.path } };
  }
  if (Array.isArray(value)) return value.map(withoutSchemas);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([name, member]) => [
        name,
        withoutSchemas(member),
      ]),
    );
  }
  return value;
};

describe("the rows of a `map` over an array declared as references", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let space: MemorySpace;
  let pieces: CompiledPiece[];
  /** The entities each commit changed since the list was cleared. */
  let changed: Set<string>;

  beforeEach(async () => {
    // The identity whose space is the audience the clauses name
    // (`scenarioAudience`).
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
    changed = new Set();
    storageManager.subscribe({
      next(notification) {
        if (notification.type !== "commit") return undefined;
        for (const { address } of notification.changes) changed.add(address.id);
        return undefined;
      },
    });
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
   * Starts the pattern `name` over three items, each a cell of its own
   * under a clause of its own, and waits until the runtime is settled.
   */
  const started = async (
    name: string,
    options: CompiledPieceOptions = {},
  ) => {
    const cells = await Promise.all(
      ["one", "two", "three"].map(async (title, index) => ({
        cell: runtime.getCell<Record<string, unknown>>(
          space,
          `item ${index}`,
          await labeled(`clause-${title}`),
        ),
        value: { id: `i${index}`, title, done: false },
      })),
    );
    const items = runtime.getCell<unknown[]>(space, "items");
    const result = runtime.getCell<Record<string, unknown>>(space, "result");
    const artifact = await artifactOf(name);
    let piece: CompiledPiece | undefined;
    // The inputs are stored before the piece starts, so that the piece
    // reads the labels they store.
    await commit((tx) => {
      for (const { cell, value } of cells) cell.withTx(tx).set(value);
      items.withTx(tx).set(cells.slice(0, 2).map(({ cell }) => cell));
    });
    await commit((tx) => {
      piece = startCompiledPiece(
        runtime,
        tx,
        artifact,
        { items },
        result.withTx(tx),
        options,
      );
      pieces.push(piece);
    });
    return {
      piece: piece!,
      result,
      items,
      cells: cells.map(({ cell }) => cell),
    };
  };

  /** What the entity of the result holds at `rows`, as the storage has it. */
  const storedRows = (result: Cell<Record<string, unknown>>): unknown[] => {
    const tx = runtime.edit();
    try {
      return tx.readValueOrThrow({
        ...result.getAsNormalizedFullLink(),
        path: ["rows"],
      }) as unknown[];
    } finally {
      tx.abort();
    }
  };

  /** The rows as the runtime's own read gives them, every link followed. */
  const rowsOf = (result: Cell<Record<string, unknown>>): unknown => {
    const tx = runtime.edit();
    try {
      return JSON.parse(JSON.stringify(result.withTx(tx).key("rows").get()));
    } finally {
      tx.abort();
    }
  };

  /** The stored labels of an entity, as JSON text. */
  const labelsOf = (id: string): string => {
    const tx = runtime.edit();
    try {
      return JSON.stringify(
        readStoredCfcMetadata(tx, { space, id: id as never, scope: "space" }) ??
          {},
      );
    } finally {
      tx.abort();
    }
  };

  it("names the collection by the plan alone", async () => {
    expect([...rowDocumentCollections(await artifactOf("Cells"))]).toEqual([0]);
    // The same `map` over an array the type declares as plain values.
    expect([...rowDocumentCollections(await artifactOf("Plain"))]).toEqual([]);
  });

  it("stores each row in a document of its own, with a link the runtime follows at its position", async () => {
    const { piece, result } = await started("Cells");

    expect(piece.refusals).toEqual([]);
    const stored = storedRows(result);
    expect(stored.length).toBe(2);
    expect(stored.every((row) => isPrimitiveCellLink(row))).toBe(true);
    expect(rowsOf(result)).toEqual([
      { label: "one!", done: false },
      { label: "two!", done: false },
    ]);
    // The store gives the rows back in place, as the executor holds them.
    expect(
      withoutSchemas(piece.transactions.stored().get(piece.instance.id)),
    ).toEqual(
      withoutSchemas(piece.instance.store.docs.get(piece.instance.id)?.value),
    );
  });

  it("writes the document of one row, and not the result, for an edit of one member", async () => {
    const { piece, result, cells } = await started("Cells");
    const row = parseLink(storedRows(result)[1] as never).id!;
    changed.clear();

    await commit((tx) => cells[1].withTx(tx).key("title").set("second"));

    expect(piece.refusals).toEqual([]);
    expect(rowsOf(result)).toEqual([
      { label: "one!", done: false },
      { label: "second!", done: false },
    ]);
    expect(changed.has(row)).toBe(true);
    expect(changed.has(result.getAsNormalizedFullLink().id)).toBe(false);
  });

  it("writes the result for an edit of one member where the rows are kept in place", async () => {
    const { result, cells } = await started("Cells", { rows: "in-place" });
    expect(storedRows(result).some((row) => isPrimitiveCellLink(row)))
      .toBe(false);
    changed.clear();

    await commit((tx) => cells[1].withTx(tx).key("title").set("second"));

    expect(rowsOf(result)).toEqual([
      { label: "one!", done: false },
      { label: "second!", done: false },
    ]);
    expect(changed.has(result.getAsNormalizedFullLink().id)).toBe(true);
  });

  it("keeps the rows of a `map` over an array declared as plain values in place", async () => {
    const { result } = await started("Plain");

    expect(storedRows(result).some((row) => isPrimitiveCellLink(row)))
      .toBe(false);
  });

  it("adds a document for a member that enters and a link at its position", async () => {
    const { piece, result, items, cells } = await started("Cells");
    const before = storedRows(result).map((row) => parseLink(row as never).id);

    await commit((tx) => items.withTx(tx).set([cells[2], cells[0], cells[1]]));

    expect(piece.refusals).toEqual([]);
    expect(rowsOf(result)).toEqual([
      { label: "three!", done: false },
      { label: "one!", done: false },
      { label: "two!", done: false },
    ]);
    // The rows that stayed keep their documents: a document is named by
    // the key of its row and not by the row's position.
    const after = storedRows(result).map((row) => parseLink(row as never).id);
    expect(after.slice(1)).toEqual(before);
  });

  it("puts the row of a member that enters first where the rows are kept in place", async () => {
    const { piece, result, items, cells } = await started("Cells", {
      rows: "in-place",
    });

    await commit((tx) => items.withTx(tx).set([cells[2], cells[0], cells[1]]));

    expect(piece.refusals).toEqual([]);
    expect(rowsOf(result)).toEqual([
      { label: "three!", done: false },
      { label: "one!", done: false },
      { label: "two!", done: false },
    ]);
  });

  it("removes the document of a member that leaves", async () => {
    const { piece, result, items, cells } = await started("Cells");
    const [first] = storedRows(result).map((row) =>
      parseLink(row as never).id!
    );

    await commit((tx) => items.withTx(tx).set([cells[1]]));

    expect(piece.refusals).toEqual([]);
    expect(rowsOf(result)).toEqual([{ label: "two!", done: false }]);
    const tx = runtime.edit();
    try {
      expect(
        tx.readValueOrThrow({ space, id: first, path: [], scope: "space" }),
      ).toBeUndefined();
    } finally {
      tx.abort();
    }
  });

  describe("over the fixture `ordered-rows.tsx`", () => {
    /**
     * Starts the fixture over three items, each a cell of its own, and two
     * notes in place. `sorted` and `nested` are a `map` over the result of
     * a `lift` that gives the references by rank, `filed` is a `map` over
     * the array of references, and `plain` a `map` over plain values in
     * place.
     */
    const ordered = async () => {
      const cells = [
        { title: "a", rank: 2, tags: ["x", "y"] },
        { title: "b", rank: 1, tags: ["z"] },
        { title: "c", rank: 3, tags: [] },
      ].map((value, index) => ({
        cell: runtime.getCell<Record<string, unknown>>(space, `row ${index}`),
        value,
      }));
      const items = runtime.getCell<unknown[]>(space, "ordered items");
      const result = runtime.getCell<Record<string, unknown>>(
        space,
        "ordered result",
      );
      const artifact = await artifactOf("default", "ordered-rows");
      await commit((tx) => {
        for (const { cell, value } of cells) cell.withTx(tx).set(value);
        items.withTx(tx).set(cells.map(({ cell }) => cell));
      });
      let piece: CompiledPiece | undefined;
      await commit((tx) => {
        piece = startCompiledPiece(
          runtime,
          tx,
          artifact,
          { items, notes: [{ text: "n" }, { text: "m" }] },
          result.withTx(tx),
        );
        pieces.push(piece);
      });
      return { piece: piece!, result, cells: cells.map(({ cell }) => cell) };
    };

    /** A member of the result as the runtime's own read gives it. */
    const member = (result: Cell<Record<string, unknown>>, name: string) => {
      const tx = runtime.edit();
      try {
        return JSON.parse(JSON.stringify(result.withTx(tx).key(name).get()));
      } finally {
        tx.abort();
      }
    };

    it("names the three collections over references and not the one over plain values", async () => {
      const artifact = await artifactOf("default", "ordered-rows");
      const named = [...rowDocumentCollections(artifact)].map((index) =>
        artifact.plan.outputs.find((output) => output.collection === index)
          ?.path.join("/")
      );

      expect(named.sort()).toEqual(["filed", "nested", "sorted"]);
    });

    it("gives the runtime's read the rows the executor holds, a row with a collection in it included", async () => {
      const { piece, result } = await ordered();

      expect(piece.refusals).toEqual([]);
      expect(member(result, "sorted")).toEqual([
        { text: "B" },
        { text: "A" },
        { text: "C" },
      ]);
      expect(member(result, "filed")).toEqual([
        { text: "A" },
        { text: "B" },
        { text: "C" },
      ]);
      expect(member(result, "nested")).toEqual([
        { tags: [{ text: "Z" }] },
        { tags: [{ text: "X" }, { text: "Y" }] },
        { tags: [] },
      ]);
    });

    it("moves the links and keeps the documents of the rows when a rank changes the order", async () => {
      const { piece, result, cells } = await ordered();
      const linksOf = () => {
        const tx = runtime.edit();
        try {
          return (tx.readValueOrThrow({
            ...result.getAsNormalizedFullLink(),
            path: ["sorted"],
          }) as unknown[]).map((row) => parseLink(row as never).id);
        } finally {
          tx.abort();
        }
      };
      const links = linksOf();

      await commit((tx) => cells[2].withTx(tx).key("rank").set(0));

      expect(piece.refusals).toEqual([]);
      expect(member(result, "sorted")).toEqual([
        { text: "C" },
        { text: "B" },
        { text: "A" },
      ]);
      expect(linksOf()).toEqual([links[2], links[0], links[1]]);
    });

    it("stores what a handler that changes the order of the array leaves", async () => {
      const { piece, result } = await ordered();

      result.key("rotate").send({} as never);
      await settled();

      expect(piece.refusals).toEqual([]);
      expect(member(result, "filed")).toEqual([
        { text: "B" },
        { text: "C" },
        { text: "A" },
      ]);
      expect(member(result, "sorted")).toEqual([
        { text: "B" },
        { text: "A" },
        { text: "C" },
      ]);
    });

    it("writes a tag of a row into the document of the row", async () => {
      const { piece, result, cells } = await ordered();
      const resultId = result.getAsNormalizedFullLink().id;
      changed.clear();

      await commit((tx) =>
        cells[0].withTx(tx).key("tags").set(["x", "y", "w"])
      );

      expect(piece.refusals).toEqual([]);
      expect(member(result, "nested")).toEqual([
        { tags: [{ text: "Z" }] },
        { tags: [{ text: "X" }, { text: "Y" }, { text: "W" }] },
        { tags: [] },
      ]);
      expect(changed.has(resultId)).toBe(false);
    });
  });

  it("stores in the document of a row the clause of its member and of no other member", async () => {
    const { result } = await started("Cells");
    const [first, second] = storedRows(result).map((row) =>
      parseLink(row as never).id!
    );

    expect(labelsOf(first)).toContain("clause-one");
    expect(labelsOf(first)).not.toContain("clause-two");
    expect(labelsOf(second)).toContain("clause-two");
    expect(labelsOf(second)).not.toContain("clause-one");
  });

  it("stores no label entry at or below the position of a row", async () => {
    const { result } = await started("Cells");

    const { labelMap } = JSON.parse(
      labelsOf(result.getAsNormalizedFullLink().id),
    ) as { labelMap: { entries: { path: string[] }[] } };
    const below = labelMap.entries.filter(({ path }) =>
      path[0] === "rows" && path.length > 1
    );
    expect(below).toEqual([]);
  });

  it("stores the clause of each member in the result where the rows are kept in place", async () => {
    const { result } = await started("Cells", { rows: "in-place" });

    const labels = labelsOf(result.getAsNormalizedFullLink().id);
    expect(labels).toContain("clause-one");
    expect(labels).toContain("clause-two");
  });
});
