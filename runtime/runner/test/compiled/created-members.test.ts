import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { MemorySpace } from "../../src/cell.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../src/compiled/piece.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

/** The artifacts of `compare/fixtures/created-members.tsx`. */
const artifacts = async (): Promise<Artifact[]> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../../base/pattern-compiler/compare/fixtures/created-members.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns;
};

describe("a member that a handler of a compiled piece makes", () => {
  // The fixture's handler `add` instantiates a pattern and adds the instance
  // to a list, and its `lift` over the whole list writes a document for each
  // row of its result.

  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let space: MemorySpace;
  let pieces: CompiledPiece[];

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("compiled created members");
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

  /**
   * Starts the fixture over an empty list named with `tag` and sends `add`
   * once for each of `titles`, each settled before the next.
   */
  const startedWith = async (tag: string, titles: string[]) => {
    const patterns = await artifacts();
    const board = patterns.find(({ name }) => name === "default")!;
    const members = runtime.getCell<unknown[]>(space, `${tag} members`);
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      `${tag} result`,
    );
    const seed = runtime.edit();
    members.withTx(seed).set([]);
    expect((await seed.commit().settled).error).toBeUndefined();
    const tx = runtime.edit();
    const piece = startCompiledPiece(
      runtime,
      tx,
      board,
      { members: members.withTx(tx) },
      result.withTx(tx),
      {
        artifacts: (id) =>
          patterns.find(({ plan }) =>
            (plan as { patterns?: string[] }).patterns?.[0] === id
          ),
      },
    );
    pieces.push(piece);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await settled();
    for (const title of titles) {
      result.key("add").send({ title } as never);
      await settled();
    }
    expect(piece.refusals).toEqual([]);
    return { piece, result };
  };

  it("derives the row of a member the handler made", async () => {
    const { result } = await startedWith("row", ["a", "b"]);
    expect(read(result, "rows")).toEqual([{ title: "a!" }, { title: "b!" }]);
  });

  it("derives the member in a transaction before the one that derives what reads it", async () => {
    const { piece, result } = await startedWith("order", ["a"]);
    const before = piece.counts.derivations;
    result.key("add").send({ title: "b" } as never);
    await settled();
    // One derivation for the instance the handler made, and one for what
    // reads the list.
    expect(piece.counts.derivations - before).toBe(2);
    expect(read(result, "rows")).toEqual([{ title: "a!" }, { title: "b!" }]);
  });

  it("gives no more write records for one more member where the list is longer", async () => {
    // The `lift` reads every member, and each row it wrote before holds
    // what it held, under the labels it had.

    const given = async (tag: string, length: number) => {
      const titles = Array.from({ length }, (_, index) => `t${index}`);
      const { piece, result } = await startedWith(tag, titles);
      const before = piece.transactions.counts.recordsGiven;
      result.key("add").send({ title: "last" } as never);
      await settled();
      expect(read(result, "rows")).toHaveLength(length + 1);
      return piece.transactions.counts.recordsGiven - before;
    };
    expect(await given("long", 12)).toBe(await given("short", 3));
  });

  it("has no more labels named for one more member where the list is longer", async () => {
    // The `lift` asks for the label of each position it read of every
    // member, and the members before consume the labels they consumed.

    const resolved = async (tag: string, length: number) => {
      const titles = Array.from({ length }, (_, index) => `t${index}`);
      const { piece, result } = await startedWith(tag, titles);
      const before = piece.transactions.counts.labelsResolved;
      result.key("add").send({ title: "last" } as never);
      await settled();
      return piece.transactions.counts.labelsResolved - before;
    };
    expect(await resolved("long ids", 12)).toBe(await resolved("short ids", 3));
  });
});
