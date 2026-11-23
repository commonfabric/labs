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
import { openStorage } from "./storage.ts";

// `fixtures/relay.tsx`: the handler of `relay` counts its runs in `relayed`
// and sends an event to the stream `bump`, whose handler adds to `total`.
describe("an event a handler of a compiled piece sends to a stream of the piece, in a runtime that runs the piece itself", () => {
  let space: MemorySpace;
  let runtime: Runtime;
  let piece: CompiledPiece | undefined;

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("compiled piece handler send");
    space = signer.did();
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: openStorage(signer),
      cfcFlowLabels: "persist",
      experimental: { compiledPatterns: true },
      servingPosture: true,
    });
  });

  afterEach(async () => {
    piece?.stop();
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.dispose();
  });

  it("is handled by the scheduler behind the handler that sent it", async () => {
    const [{ patterns }] = JSON.parse(
      await Deno.readTextFile(
        new URL(
          "../../../../base/pattern-compiler/compare/fixtures/relay.emit.json",
          import.meta.url,
        ),
      ),
    ) as { patterns: Artifact[] }[];
    const result = runtime.getCell<Record<string, unknown>>(space, "relay");
    const tx = runtime.edit();
    piece = startCompiledPiece(
      runtime,
      tx,
      patterns.find(({ name }) => name === "default")!,
      { start: 1 },
      result.withTx(tx),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();

    result.key("relay").send({ by: 3 } as never);
    await runtime.scheduler.idleWithPendingCommits();
    result.key("relay").send({ by: 4 } as never);
    await runtime.scheduler.idleWithPendingCommits();

    expect(piece.refusals).toEqual([]);
    expect(piece.counts.events).toBe(4);
    expect(piece.instance.result()).toMatchObject({ total: 7, relayed: 2 });
  });
});
