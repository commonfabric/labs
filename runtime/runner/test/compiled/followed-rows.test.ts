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
import { openStorage, type TestStorage } from "./storage.ts";

/** The pattern of `compare/fixtures/followed-rows.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../../base/pattern-compiler/compare/fixtures/followed-rows.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

describe("an add to the rows of a compiled piece that follow a link", () => {
  let runtime: Runtime;
  let storageManager: TestStorage;
  let space: MemorySpace;
  let pieces: CompiledPiece[];

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("compiled followed rows");
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

  const cost = async (tag: string, size: number) => {
    const pattern = await artifact();
    const owner = runtime.getCell<{ name: string }>(space, `${tag} owner`);
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      `${tag} result`,
    );
    const seed = runtime.edit();
    owner.withTx(seed).set({ name: "Ada" });
    expect((await seed.commit().settled).error).toBeUndefined();
    const tx = runtime.edit();
    const piece = startCompiledPiece(
      runtime,
      tx,
      pattern,
      { items: [], notes: [{ title: "t0" }], owner: owner.withTx(tx) },
      result.withTx(tx),
    );
    pieces.push(piece);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await settled();
    for (let index = 0; index < size; index++) {
      result.key("add").send({ title: `t${index}` } as never);
      await settled();
    }
    const before = {
      records: piece.transactions.counts.recordsGiven,
      copied: piece.instance.store.copiedByReads,
      ...piece.instance.counts,
    };
    result.key("add").send({ title: "last" } as never);
    await settled();
    expect(piece.refusals).toEqual([]);
    const after = {
      records: piece.transactions.counts.recordsGiven,
      copied: piece.instance.store.copiedByReads,
      ...piece.instance.counts,
    };
    return Object.fromEntries(
      Object.entries(after).map(([name, value]) => [
        name,
        (value as number) - (before as Record<string, number>)[name],
      ]),
    );
  };

  it("gives as many records for an add at 10 rows as at 100, and reaches as many readers of labels", async () => {
    // The add appends to `items`, which the facts read, and changes the
    // labels of the argument there. Each row's record names the facts, whose
    // inputs read every note through `*`, a position of the argument that no
    // changed label reaches.
    const small = await cost("records small", 10);
    const large = await cost("records large", 100);

    expect(large.records).toBe(small.records);
    expect(large.labelReaders).toBe(small.labelReaders);
  });
});
