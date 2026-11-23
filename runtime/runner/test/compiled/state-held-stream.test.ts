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

/** The pattern `Relayed` of `compare/fixtures/state-held-stream.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../../base/pattern-compiler/compare/fixtures/state-held-stream.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "Relayed")!;
};

describe("a compiled piece whose handler sends to a stream that the state of a binding alone holds", () => {
  let runtime: Runtime;
  let storageManager: TestStorage;
  let space: MemorySpace;
  let piece: CompiledPiece;

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
    const result = runtime.getCell<{ total: number }>(space, "relayed result");
    const tx = runtime.edit();
    piece = startCompiledPiece(
      runtime,
      tx,
      await artifact(),
      {},
      result.withTx(tx),
      {},
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.scheduler.idleWithPendingCommits();
  });

  afterEach(async () => {
    piece.stop();
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.dispose();
    await storageManager.close();
  });

  /** Sends `event` to the stream `relay` of the result. */
  const relay = async (event: { by: number }) => {
    const plan = piece.instance.plan as { bindings: { name: unknown }[] };
    const binding = plan.bindings.findIndex(({ name }) => name === "relay");
    const stream = piece.instance.streams().find((held) =>
      held.binding === binding
    )!;
    const entity = piece.transactions.entityOfStream({
      binding: stream.binding,
      keys: stream.keys,
    })!;
    runtime.scheduler.queueEvent(
      { space, id: entity, path: [], scope: "space" },
      piece.transactions.encode(event),
    );
    await runtime.scheduler.idleWithPendingCommits();
  };

  it("runs the handler of that stream for the event sent", async () => {
    await relay({ by: 3 });

    expect(piece.refusals).toEqual([]);
    expect((piece.instance.result() as { total: number }).total).toBe(3);
  });

  it("writes the marker of the stream once, and takes a second event through it", async () => {
    await relay({ by: 3 });
    await relay({ by: 4 });

    expect(piece.refusals).toEqual([]);
    expect(piece.counts.events).toBe(4);
    expect((piece.instance.result() as { total: number }).total).toBe(7);
  });
});
