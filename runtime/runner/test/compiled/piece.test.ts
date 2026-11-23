import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { MemorySpace } from "../../src/cell.ts";
import { readStoredCfcMetadata } from "../../src/cfc/metadata.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { Runtime } from "../../src/runtime.ts";
import { openStorage, type TestStorage } from "./storage.ts";

/**
 * The artifact of a pattern of a fixture of `base/pattern-compiler`, as
 * the crate emitted it (`compare/fixtures/<name>.emit.json`).
 */
const artifactOf = async (
  name: string,
  pattern = "default",
): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        `../../../../base/pattern-compiler/compare/fixtures/${name}.emit.json`,
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find((artifact) => artifact.name === pattern) ??
    patterns[patterns.length - 1];
};

describe("startCompiledPiece()", () => {
  let runtime: Runtime;
  let storageManager: TestStorage;
  let space: MemorySpace;
  let pieces: CompiledPiece[];

  /** A runtime with the experimental option as given. */
  const runtimeWith = (compiledPatterns: boolean): Runtime =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcFlowLabels: "persist",
      experimental: { compiledPatterns },
      servingPosture: true,
    });

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("compiled piece");
    space = signer.did();
    storageManager = openStorage(signer);
    runtime = runtimeWith(true);
    pieces = [];
  });

  afterEach(async () => {
    for (const piece of pieces) piece.stop();
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.dispose();
    await storageManager.close();
  });

  /**
   * Starts a piece from a fixture in a transaction of its own and waits
   * until the runtime is settled.
   */
  const started = async (
    fixture: string,
    pattern: string,
    argument: (tx: ReturnType<Runtime["edit"]>) => unknown,
  ) => {
    const artifact = await artifactOf(fixture, pattern);
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      `result of ${fixture}`,
    );
    const tx = runtime.edit();
    const piece = startCompiledPiece(
      runtime,
      tx,
      artifact,
      argument(tx),
      result.withTx(tx),
    );
    pieces.push(piece);
    runtime.prepareTxForCommit(tx);
    const { error } = await tx.commit().settled;
    expect(error).toBeUndefined();
    await settled();
    return { piece, result };
  };

  /** Waits until no event is queued, no action is due and no commit open. */
  const settled = () => runtime.scheduler.idleWithPendingCommits();

  /** Reads a path of a cell, with every link in it followed. */
  const read = (cell: ReturnType<Runtime["getCell"]>, ...path: string[]) => {
    const tx = runtime.edit();
    try {
      let at = cell.withTx(tx);
      for (const segment of path) at = at.key(segment as never);
      return JSON.parse(JSON.stringify(at.get()));
    } finally {
      tx.abort();
    }
  };

  it("refuses to start a piece with the experimental option off", async () => {
    const off = runtimeWith(false);
    const tx = off.edit();
    try {
      const result = off.getCell(space, "off", undefined, tx);
      const artifact = await artifactOf("handler");
      expect(() => startCompiledPiece(off, tx, artifact, {}, result))
        .toThrow("compiledPatterns");
    } finally {
      tx.abort();
      await off.dispose();
    }
  });

  it("stores the result of the first derivation in the entity of the result cell", async () => {
    const { piece, result } = await started(
      "handler",
      "default",
      () => ({ secret: "s", note: "n" }),
    );

    expect(piece.refusals).toEqual([]);
    expect(read(result, "note")).toBe("n");
    // The executor holds the same: the result document is the entity of
    // the result cell.
    expect(piece.instance.id).toBe(result.getAsNormalizedFullLink().id);
    expect((piece.instance.result() as { note: string }).note).toBe("n");
  });

  it("runs a compiled handler for an event sent to the stream cell of the result", async () => {
    const { piece, result } = await started(
      "handler",
      "default",
      () => ({ secret: "s", note: "n" }),
    );

    result.key("record").send({ text: "t", extra: "e" } as never);
    await settled();

    expect(piece.refusals).toEqual([]);
    expect(piece.counts.events).toBe(1);
    expect(read(result, "last")).toBe("ts");
    expect(read(result, "log")).toEqual([{ text: "t" }]);
  });

  it("takes no commit of its own for a change by another writer", async () => {
    const { piece, result } = await started(
      "handler",
      "default",
      () => ({ secret: "s", note: "n" }),
    );

    result.key("record").send({ text: "t", extra: "e" } as never);
    await settled();

    expect(piece.counts.changesByOthers).toBe(0);
  });

  it("stores the label that the plan's template gives a handler's write", async () => {
    // `fixtures/declared-writes.tsx`: `overwrite` sets `mine`, whose type
    // is `Confidential<string, ["alice"]>`.
    const { piece, result } = await started(
      "declared-writes",
      "default",
      () => ({ mine: "m", sealed: [] }),
    );

    result.key("overwrite").send({} as never);
    await settled();

    expect(piece.refusals).toEqual([]);
    const tx = runtime.edit();
    try {
      const metadata = readStoredCfcMetadata(tx, {
        space,
        id: piece.transactions.entityOf(piece.instance.argument),
        scope: "space",
      });
      expect(JSON.stringify(metadata ?? {})).toContain("alice");
    } finally {
      tx.abort();
    }
  });

  it("commits one transaction for an event and one for the derivation behind it", async () => {
    const { piece, result } = await started(
      "handler",
      "default",
      () => ({ secret: "s", note: "n" }),
    );
    const commits: number[] = [];
    storageManager.subscribe({
      next(notification) {
        if (notification.type === "commit") {
          commits.push([...notification.changes].length);
        }
        return undefined;
      },
    });
    const derivations = piece.counts.derivations;

    result.key("record").send({ text: "t", extra: "e" } as never);
    await settled();

    // The event's transaction writes; the derivation behind it runs once
    // and commits where it wrote something.
    expect(piece.counts.derivations - derivations).toBe(1);
    expect(commits.length).toBeGreaterThanOrEqual(1);
    expect(commits.length).toBeLessThanOrEqual(2);
  });

  it("reads an input cell through the replica and derives from it", async () => {
    const items = runtime.getCell<unknown[]>(space, "items of plain");
    const seed = runtime.edit();
    items.withTx(seed).set([
      { id: "a", title: "one", done: false },
      { id: "b", title: "two", done: true },
    ]);
    expect((await seed.commit().settled).error).toBeUndefined();

    const { piece, result } = await started("lists", "Plain", () => ({
      items,
    }));

    expect(piece.refusals).toEqual([]);
    expect(read(result, "rows")).toEqual([
      { label: "one:false" },
      { label: "two:true" },
    ]);
  });

  it("derives again what read a field that another writer set", async () => {
    const items = runtime.getCell<unknown[]>(space, "items of plain");
    const seed = runtime.edit();
    items.withTx(seed).set([
      { id: "a", title: "one", done: false },
      { id: "b", title: "two", done: true },
    ]);
    expect((await seed.commit().settled).error).toBeUndefined();
    const { piece, result } = await started("lists", "Plain", () => ({
      items,
    }));
    const evaluations = piece.instance.counts.elementEvaluations;

    const tx = runtime.edit();
    items.withTx(tx).key(1).key("title" as never).set("second" as never);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await settled();

    expect(piece.counts.changesByOthers).toBeGreaterThan(0);
    expect(read(result, "rows")).toEqual([
      { label: "one:false" },
      { label: "second:true" },
    ]);
    // The row of the member that did not change is not evaluated again.
    expect(piece.instance.counts.elementEvaluations - evaluations).toBe(1);
  });

  it("adds the row of a member that another writer appended", async () => {
    const items = runtime.getCell<unknown[]>(space, "items of plain");
    const seed = runtime.edit();
    items.withTx(seed).set([{ id: "a", title: "one", done: false }]);
    expect((await seed.commit().settled).error).toBeUndefined();
    const { result } = await started("lists", "Plain", () => ({ items }));

    const tx = runtime.edit();
    items.withTx(tx).push({ id: "b", title: "two", done: false } as never);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await settled();

    expect(read(result, "rows")).toEqual([
      { label: "one:false" },
      { label: "two:false" },
    ]);
  });

  it("evaluates one row for a member that another writer put first in an array of references", async () => {
    const cells = ["one", "two", "three"].map((title, index) => {
      const cell = runtime.getCell<unknown>(space, `item ${index}`);
      return { cell, value: { id: `i${index}`, title, done: false } };
    });
    const items = runtime.getCell<unknown[]>(space, "items of references");
    const seed = runtime.edit();
    for (const { cell, value } of cells) cell.withTx(seed).set(value);
    items.withTx(seed).set(cells.slice(1).map(({ cell }) => cell));
    expect((await seed.commit().settled).error).toBeUndefined();
    const { piece, result } = await started("lists", "Plain", () => ({
      items,
    }));
    const evaluations = piece.instance.counts.elementEvaluations;

    // The array is written whole, each position with another link.
    const tx = runtime.edit();
    items.withTx(tx).set(cells.map(({ cell }) => cell));
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await settled();

    expect(piece.instance.result()).toEqual({
      rows: [
        { label: "one:false" },
        { label: "two:false" },
        { label: "three:false" },
      ],
    });
    expect(read(result, "rows")).toEqual([
      { label: "one:false" },
      { label: "two:false" },
      { label: "three:false" },
    ]);
    expect(piece.instance.counts.elementEvaluations - evaluations).toBe(1);
  });

  it("holds each document in memory and does not read it again for a later event", async () => {
    const { piece, result } = await started(
      "handler",
      "default",
      () => ({ secret: "s", note: "n" }),
    );
    const log = piece.instance.stateCells().find(({ name }) => name === "log")!;
    result.key("record").send({ text: "t", extra: "e" } as never);
    await settled();
    const held = piece.instance.store.docs.get(log.id)?.value as unknown[];

    result.key("record").send({ text: "u", extra: "e" } as never);
    await settled();

    // A change of the list replaces the array with a copy that shares its
    // members, and a document read again from the storage would hold new
    // objects: the member the first event added is the object it was.
    const now = piece.instance.store.docs.get(log.id)?.value as unknown[];
    expect(now).toHaveLength(2);
    expect(now[0]).toBe(held[0]);
    expect(read(result, "log")).toEqual([{ text: "t" }, { text: "u" }]);
  });
});
