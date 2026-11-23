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

/** The pattern `Greeted` of `compare/fixtures/foreign-read.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../../base/pattern-compiler/compare/fixtures/foreign-read.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "Greeted")!;
};

// The document the piece reads is in another space than the piece, and the
// replica of that space holds it: the runtime that starts the piece wrote
// it.
describe("a compiled piece whose argument refers to a document of another space", () => {
  let runtime: Runtime;
  let storageManager: TestStorage;
  let space: MemorySpace;
  let other: MemorySpace;
  let piece: CompiledPiece | undefined;

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("pattern-compiler-compare");
    space = signer.did();
    other = (await Identity.fromPassphrase("pattern-compiler-other-space"))
      .did();
    storageManager = openStorage(signer);
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcFlowLabels: "persist",
      experimental: { compiledPatterns: true },
      servingPosture: true,
    });
    piece = undefined;
  });

  afterEach(async () => {
    piece?.stop();
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.dispose();
    await storageManager.close();
  });

  const commit = async (write: (tx: ReturnType<Runtime["edit"]>) => void) => {
    const tx = runtime.edit();
    write(tx);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.scheduler.idleWithPendingCommits();
  };

  /** Starts the piece over a source document of the other space. */
  const started = async () => {
    const source = runtime.getCell<{ name: string }>(other, "foreign source");
    await commit((tx) => source.withTx(tx).set({ name: "Ada" }));
    const result = runtime.getCell<{ greeting: string }>(
      space,
      "foreign result",
    );
    const compiled = await artifact();
    await commit((tx) => {
      piece = startCompiledPiece(
        runtime,
        tx,
        compiled,
        { source },
        result.withTx(tx),
        {},
      );
    });
    return { source, result };
  };

  it("reads the document in its own space", async () => {
    await started();

    expect(piece!.refusals).toEqual([]);
    expect((piece!.instance.result() as { greeting: string }).greeting).toBe(
      "hello Ada",
    );
  });

  it("derives again when the document of the other space changes", async () => {
    const { source } = await started();

    await commit((tx) => source.withTx(tx).key("name").set("Grace"));

    expect(piece!.refusals).toEqual([]);
    expect((piece!.instance.result() as { greeting: string }).greeting).toBe(
      "hello Grace",
    );
  });

  it("stores the result in the piece's space alone", async () => {
    const { result } = await started();

    expect(result.get()?.greeting).toBe("hello Ada");
    const there = runtime.getCell<{ greeting: string }>(
      other,
      "foreign result",
    );
    expect(there.get()).toBeUndefined();
  });
});
