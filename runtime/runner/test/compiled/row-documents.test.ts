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
import { openStorage, storedList, type TestStorage } from "./storage.ts";

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
  let storageManager: TestStorage;
  let space: MemorySpace;
  let pieces: CompiledPiece[];
  /** The entities each commit changed since the list was cleared. */
  let changed: Set<string>;

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
    fixture?: string,
    /** The titles of the items; the piece starts over all but the last. */
    titles: string[] = ["one", "two", "three"],
    /** What tells the cells of this piece from those of another one. */
    tag = "",
  ) => {
    const cells = await Promise.all(
      titles.map(async (title, index) => ({
        cell: runtime.getCell<Record<string, unknown>>(
          space,
          `${tag}item ${index}`,
          await labeled(`clause-${title}`),
        ),
        value: { id: `i${index}`, title, done: false, note: "" },
      })),
    );
    const items = runtime.getCell<unknown[]>(space, `${tag}items`);
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      `${tag}result`,
    );
    const artifact = await artifactOf(name, fixture);
    let piece: CompiledPiece | undefined;
    // The inputs are stored before the piece starts, so that the piece
    // reads the labels they store.
    await commit((tx) => {
      for (const { cell, value } of cells) cell.withTx(tx).set(value);
      items.withTx(tx).set(cells.slice(0, -1).map(({ cell }) => cell));
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

  /**
   * The links to the row documents that the storage holds for `rows` of
   * the result, in the list document the result links to.
   */
  const storedRows = (result: Cell<Record<string, unknown>>): unknown[] =>
    storedList(runtime, result, ["rows"]) as unknown[];

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

  describe("the load in bounded transactions", () => {
    const titles = ["one", "two", "three", "four", "five", "six"];

    /** The documents each commit changed, in the order of the commits. */
    const commitsOf = () => {
      const commits: string[][] = [];
      storageManager.subscribe({
        next(notification) {
          if (notification.type === "commit") {
            commits.push(
              [...new Set([...notification.changes].map((c) => c.address.id))],
            );
          }
          return undefined;
        },
      });
      return commits;
    };

    it("commits the row documents in transactions of at most the given number of rows, before the result", async () => {
      const commits = commitsOf();
      const { piece, result } = await started(
        "Cells",
        { loadRows: 2 },
        undefined,
        titles,
      );

      expect(piece.refusals).toEqual([]);
      const rows: string[] = storedRows(result).map((row) =>
        parseLink(row as never).id!
      );
      expect(rows.length).toBe(5);
      const resultId = result.getAsNormalizedFullLink().id;
      const holding = (id: string) =>
        commits.findIndex((changed) => changed.includes(id));
      // No commit holds more than two rows, and each row is stored by a
      // commit before the one that stores the links to the rows.
      for (const changed of commits) {
        expect(changed.filter((id) => rows.includes(id)).length)
          .toBeLessThanOrEqual(2);
      }
      const linked = commits.findLastIndex((changed) =>
        changed.includes(resultId)
      );
      for (const row of rows) {
        expect(holding(row)).toBeGreaterThanOrEqual(0);
        expect(holding(row)).toBeLessThan(linked);
      }
      expect(rowsOf(result)).toEqual(
        titles.slice(0, -1).map((title) => ({
          label: `${title}!`,
          done: false,
        })),
      );
    });

    it("stores each row under the labels a load in one transaction stores", async () => {
      const bounded = await started(
        "Cells",
        { loadRows: 2 },
        undefined,
        titles,
        "bounded ",
      );
      const whole = await started(
        "Cells",
        { loadRows: Infinity },
        undefined,
        titles,
        "whole ",
      );
      expect(bounded.piece.refusals).toEqual([]);
      expect(whole.piece.refusals).toEqual([]);
      const labels = (result: Cell<Record<string, unknown>>) =>
        storedRows(result).map((row) =>
          // The two pieces read items of their own, whose entities differ.
          JSON.parse(labelsOf(parseLink(row as never).id!)).labelMap
        );
      const strip = (text: string) => text.replaceAll(/(bounded|whole) /g, "");
      expect(labels(bounded.result).length).toBe(5);
      expect(strip(JSON.stringify(labels(bounded.result)))).toEqual(
        strip(JSON.stringify(labels(whole.result))),
      );
    });

    it("stores the documents of the creation under what the caller read before the start", async () => {
      // The caller can have computed the argument from what it read in the
      // transaction it hands, so the creation, which is committed apart,
      // holds those reads.

      const secret = runtime.getCell<Record<string, unknown>>(
        space,
        "caller secret",
        await labeled("clause-of-the-caller"),
      );
      const items = runtime.getCell<unknown[]>(space, "caller items");
      const result = runtime.getCell<Record<string, unknown>>(
        space,
        "caller result",
      );
      await commit((tx) => {
        secret.withTx(tx).set({ id: "s", title: "secret", done: false });
        items.withTx(tx).set([]);
      });
      const artifact = await artifactOf("Cells");
      let piece: CompiledPiece | undefined;
      await commit((tx) => {
        secret.withTx(tx).get();
        piece = startCompiledPiece(
          runtime,
          tx,
          artifact,
          { items },
          result.withTx(tx),
          { loadRows: 2 },
        );
        pieces.push(piece);
      });
      expect(piece!.refusals).toEqual([]);
      const argument = piece!.transactions.entityOf(piece!.instance.argument);
      expect(labelsOf(argument)).toContain("clause-of-the-caller");
    });

    it("loads in the handed transaction where the caller wrote into it before the start", async () => {
      // A position the caller staged holds its label in the handed
      // transaction alone, so no row is stored by another one.

      const commits = commitsOf();
      const item = runtime.getCell<Record<string, unknown>>(
        space,
        "staged item",
        await labeled("clause-staged"),
      );
      const items = runtime.getCell<unknown[]>(space, "staged items");
      const result = runtime.getCell<Record<string, unknown>>(
        space,
        "staged result",
      );
      const artifact = await artifactOf("Cells");
      let piece: CompiledPiece | undefined;
      await commit((tx) => {
        item.withTx(tx).set({ id: "i", title: "staged", done: false });
        items.withTx(tx).set([item]);
        piece = startCompiledPiece(
          runtime,
          tx,
          artifact,
          { items },
          result.withTx(tx),
          { loadRows: 2 },
        );
        pieces.push(piece);
      });
      expect(piece!.refusals).toEqual([]);
      expect(commits.length).toBe(1);
      expect(rowsOf(result)).toEqual([{ label: "staged!", done: false }]);
    });

    it("takes a change of a member after such a load", async () => {
      const { piece, result, cells } = await started(
        "Cells",
        { loadRows: 2 },
        undefined,
        titles,
      );
      await commit((tx) => cells[3].withTx(tx).key("title").set("fourth"));
      expect(piece.refusals).toEqual([]);
      expect((rowsOf(result) as { label: string }[]).map(({ label }) => label))
        .toEqual(["one!", "two!", "three!", "fourth!", "five!"]);
    });
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

  describe("a write by another writer into what the piece stored", () => {
    /** What the executor holds of the result, without the schemas of links. */
    const held = (piece: CompiledPiece) =>
      withoutSchemas(piece.instance.store.docs.get(piece.instance.id)?.value);

    /** The label each row the executor holds has. */
    const labels = (piece: CompiledPiece) =>
      (held(piece) as { rows: { label: string }[] }).rows.map(({ label }) =>
        label
      );

    it("is applied to the row the executor holds, for a write into the document of a row", async () => {
      const { piece, result } = await started("Cells");
      const row = parseLink(storedRows(result)[1] as never).id!;

      await commit((tx) =>
        tx.writeValueOrThrow(
          { space, id: row, path: ["label"], scope: "space" },
          "overwritten",
        )
      );

      expect(piece.refusals).toEqual([]);
      expect(labels(piece)).toEqual(["one!", "overwritten"]);
      expect(withoutSchemas(piece.transactions.stored().get(piece.instance.id)))
        .toEqual(held(piece));
    });

    it("is reported and not applied, for a write of the array of links", async () => {
      const { piece, result } = await started("Cells");
      const [, second] = storedRows(result);

      await commit((tx) =>
        tx.writeValueOrThrow(
          { ...result.getAsNormalizedFullLink(), path: ["rows"] },
          [second] as never,
        )
      );

      expect(piece.refusals.length).toBe(1);
      expect(piece.refusals[0]).toContain("array of the row documents");
      expect(labels(piece)).toEqual(["one!", "two!"]);
    });

    it("gives the join of the rows as the label of a read of the array", async () => {
      const { piece, result } = await started("Cells");
      const [first] = storedRows(result).map((row) =>
        parseLink(row as never).id!
      );
      const { transactions, instance } = piece;

      const array = transactions.labelOf(instance.id, ["rows"], "value");
      const row = transactions.labelOf(instance.id, ["rows", "0"], "value");

      expect(array).toBeDefined();
      expect(row).toBeDefined();
      // The first row holds the clause of its member alone, and the array
      // the clauses of both.
      expect(array).not.toBe(row);
      expect(labelsOf(first)).toContain("clause-one");
    });
  });

  describe("a change of the members of the array", () => {
    /** The titles of `count` items. */
    const titles = (count: number) =>
      Array.from({ length: count }, (_, index) => `t${index}`);

    /**
     * `Cells` over all but the last of `count` items, and then `change`,
     * which is given the cells of the items. Returns the links to row
     * documents that the change wrote into the array, the row documents
     * that stayed among the entities its commits wrote, and the write
     * records the piece gave.
     */
    const after = async (
      count: number,
      change: (cells: Cell<Record<string, unknown>>[]) => unknown[],
      options: CompiledPieceOptions = {},
    ) => {
      const { piece, result, items, cells } = await started(
        "Cells",
        options,
        undefined,
        titles(count),
        `${count} `,
      );
      const rowsBefore = storedRows(result).map((row) =>
        parseLink(row as never).id!
      );
      const before = piece.transactions.counts;
      changed.clear();
      await commit((tx) => items.withTx(tx).set(change(cells)));
      expect(piece.refusals).toEqual([]);
      const counts = piece.transactions.counts;
      const rowsNow = new Set(
        storedRows(result).map((row) => parseLink(row as never).id!),
      );
      return {
        result,
        links: counts.rowLinks - before.rowLinks,
        stayedWritten: rowsBefore.filter((row) =>
          changed.has(row) && rowsNow.has(row)
        ),
        records: counts.recordsGiven - before.recordsGiven,
      };
    };

    it("writes the list document, the number of members and one row document for a member added at the end", async () => {
      const { result, links, stayedWritten } = await after(
        5,
        (cells) => cells,
      );

      expect(rowsOf(result)).toEqual(
        titles(5).map((title) => ({ label: `${title}!`, done: false })),
      );
      // The list of five links is one document, written with the link added.
      expect(links).toBe(5);
      expect(stayedWritten).toEqual([]);
      expect(storedRows(result).length).toBe(5);
    });

    it("writes the links of one chunk at most, and gives as many records, for a member added at the end of 4 members as of 200 where the option `listWhole` puts a long list in chunks", async () => {
      const chunked: CompiledPieceOptions = { listWhole: 128 };
      const few = await after(5, (cells) => cells, chunked);
      const many = await after(201, (cells) => cells, chunked);

      expect(many.links).toBeLessThanOrEqual(64);
      expect(many.records).toBe(few.records);
    });

    it("writes the one list document with every link, and gives as many records, for a member added at the end of 4 members as of 200", async () => {
      const few = await after(5, (cells) => cells);
      const many = await after(201, (cells) => cells);

      expect(many.links).toBe(201);
      expect(many.records).toBe(few.records);
      expect(storedRows(many.result).length).toBe(201);
    });

    it("writes one link, and gives as many records, for a member added at the end of 4 members as of 200 where the links are in the result document", async () => {
      const inPlace: CompiledPieceOptions = { lists: "in-place" };
      const few = await after(5, (cells) => cells, inPlace);
      const many = await after(201, (cells) => cells, inPlace);

      expect(few.links).toBe(1);
      expect(many.links).toBe(1);
      expect(many.records).toBe(few.records);
    });

    it("writes no row document that stayed, and gives as many records, for a member added before 4 members as before 200", async () => {
      const prepended = (cells: Cell<Record<string, unknown>>[]) => [
        cells.at(-1)!,
        ...cells.slice(0, -1),
      ];
      const few = await after(5, prepended);
      const many = await after(201, prepended);

      expect(rowsOf(few.result)).toEqual(
        ["t4", "t0", "t1", "t2", "t3"].map((title) => ({
          label: `${title}!`,
          done: false,
        })),
      );
      expect(few.stayedWritten).toEqual([]);
      expect(many.stayedWritten).toEqual([]);
      expect(many.records).toBe(few.records);
    });

    it("gives as many records for the first member removed of 4 members as of 200", async () => {
      const removed = (cells: Cell<Record<string, unknown>>[]) =>
        cells.slice(1, -1);
      const few = await after(5, removed);
      const many = await after(201, removed);

      expect(rowsOf(few.result)).toEqual(
        ["t1", "t2", "t3"].map((title) => ({
          label: `${title}!`,
          done: false,
        })),
      );
      expect(few.stayedWritten).toEqual([]);
      expect(many.records).toBe(few.records);
    });
  });

  describe("over the fixture `handle-reads.tsx`", () => {
    /** The path of the array of rows of `Viewed` in its result. */
    const VIEW_ROWS = ["$UI", "children", "1", "children", "0"];

    /** What the entity of the result holds at `path`, as stored. */
    const storedAt = (
      result: Cell<Record<string, unknown>>,
      path: string[],
    ): unknown => storedList(runtime, result, path);

    it("stores a row that is a view node among the children of a view node in a document of its own", async () => {
      const { piece, result } = await started("Viewed", {}, "handle-reads");

      expect(piece.refusals).toEqual([]);
      const stored = storedAt(result, VIEW_ROWS) as unknown[];
      expect(stored.length).toBe(2);
      expect(stored.every((row) => isPrimitiveCellLink(row))).toBe(true);
    });

    it("writes the document of one such row, and not the result, for an edit of one member", async () => {
      const { piece, result, cells } = await started(
        "Viewed",
        {},
        "handle-reads",
      );
      const stored = storedAt(result, VIEW_ROWS) as unknown[];
      const row = parseLink(stored[1] as never).id!;
      changed.clear();

      await commit((tx) => cells[1].withTx(tx).key("title").set("second"));

      expect(piece.refusals).toEqual([]);
      expect(changed.has(row)).toBe(true);
      expect(changed.has(result.getAsNormalizedFullLink().id)).toBe(false);
      expect(JSON.stringify(storedAt({
        getAsNormalizedFullLink: () => ({
          ...result.getAsNormalizedFullLink(),
          id: row,
        }),
      } as Cell<Record<string, unknown>>, []))).toContain("second");
    });

    it("evaluates nothing and writes nothing for an edit of a field of a member that no derivation reads", async () => {
      const { piece, result, cells } = await started(
        "Derived",
        {},
        "handle-reads",
      );
      const tx = runtime.edit();
      try {
        expect(result.withTx(tx).key("titles").get()).toBe("ONE,TWO");
        expect(result.withTx(tx).key("count").get()).toBe(2);
      } finally {
        tx.abort();
      }
      const transactions = piece.instance.transactions.length;
      changed.clear();

      await commit((tx) => cells[1].withTx(tx).key("note").set("edited"));

      expect(piece.refusals).toEqual([]);
      expect(
        piece.instance.transactions.slice(transactions).flatMap((
          { evaluated },
        ) => evaluated),
      ).toEqual([]);
      // The one entity written is the member's own: no document of the
      // piece was written.
      expect([...changed].filter((id) => id.startsWith("of:"))).toEqual([
        cells[1].getAsNormalizedFullLink().id,
      ]);
    });

    it("evaluates the `lift` over the members and not the count for an edit of a title", async () => {
      const { piece, result, cells } = await started(
        "Derived",
        {},
        "handle-reads",
      );
      const transactions = piece.instance.transactions.length;

      await commit((tx) => cells[1].withTx(tx).key("title").set("second"));

      expect(piece.refusals).toEqual([]);
      const tx = runtime.edit();
      try {
        expect(result.withTx(tx).key("titles").get()).toBe("ONE,SECOND");
      } finally {
        tx.abort();
      }
      const evaluated = piece.instance.transactions.slice(transactions)
        .flatMap(({ evaluated }) => evaluated);
      expect(evaluated).toContain("rows");
      expect(evaluated).not.toContain("count");
    });
  });

  describe("a label that changes at a position a `lift` read through a handle", () => {
    /**
     * `Derived` of `handle-reads.tsx`, whose `lift` reads the title of each
     * member, and then a write by another writer of the note of the second
     * member under a schema with one more clause than the member has: the
     * label of the member changes, and no value the `lift` read does.
     */
    const relabeled = async () => {
      const { piece, result, cells } = await started(
        "Derived",
        {},
        "handle-reads",
      );
      const rows = () =>
        storedRows(result).map((row) => parseLink(row as never).id!);
      const before = rows().map(labelsOf);
      const transactions = piece.instance.transactions.length;
      const audience = await scenarioAudience();
      const schema = {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          done: { type: "boolean" },
        },
        ifc: {
          confidentiality: [
            inputClause("clause-two", audience),
            inputClause("clause-added", audience),
          ],
        },
      } as JSONSchema;
      await commit((tx) =>
        cells[1].asSchema(schema).withTx(tx).set({
          id: "i1",
          title: "two",
          done: false,
          note: "edited",
        })
      );
      const evaluated = piece.instance.transactions.slice(transactions)
        .flatMap(({ evaluated }) => evaluated);
      return { piece, result, cells, rows, before, evaluated };
    };

    it("changes the stored label of the member and runs no `lift` again", async () => {
      const { piece, cells, evaluated } = await relabeled();

      expect(piece.refusals).toEqual([]);
      expect(labelsOf(cells[1].getAsNormalizedFullLink().id)).toContain(
        "clause-added",
      );
      expect(evaluated).toEqual([]);
    });

    it("forms the label of each row document again, which then holds the added clause", async () => {
      const { rows, before } = await relabeled();

      for (const text of before) expect(text).not.toContain("clause-added");
      for (const row of rows()) {
        expect(labelsOf(row)).toContain("clause-added");
      }
    });

    it("forms the label of the output derived from the rows again", async () => {
      const { result } = await relabeled();

      const { labelMap } = JSON.parse(
        labelsOf(result.getAsNormalizedFullLink().id),
      ) as { labelMap: { entries: { path: string[] }[] } };
      const titles = labelMap.entries.filter(({ path }) =>
        path[0] === "titles"
      );
      expect(JSON.stringify(titles)).toContain("clause-added");
    });
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
      const linksOf = () =>
        (storedList(runtime, result, ["sorted"]) as unknown[]).map((row) =>
          parseLink(row as never).id
        );
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
