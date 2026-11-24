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
import { type SharedStorage, shareStorage } from "./storage.ts";

/** A pattern of a fixture of the crate, as the crate emitted it. */
const artifactOf = async (fixture: string, pattern: string) => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        `../../../../base/pattern-compiler/compare/fixtures/${fixture}.emit.json`,
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === pattern)!;
};

// Two sessions of one memory server: the first writes the documents the
// piece reads, and the second, whose replica holds none of them, starts
// the piece. The document a piece reads is in another space than the
// piece.
describe("a compiled piece that reads a document of another space", () => {
  let signer: Identity;
  let space: MemorySpace;
  let other: MemorySpace;
  let shared: SharedStorage;
  let runtimes: Runtime[];
  let piece: CompiledPiece | undefined;

  const session = (): Runtime => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: shared.open(signer),
      cfcFlowLabels: "persist",
      experimental: { compiledPatterns: true },
      servingPosture: true,
    });
    runtimes.push(runtime);
    return runtime;
  };

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("pattern-compiler-compare");
    space = signer.did();
    other = (await Identity.fromPassphrase("pattern-compiler-other-space"))
      .did();
    shared = shareStorage();
    runtimes = [];
    piece = undefined;
  });

  afterEach(async () => {
    piece?.stop();
    for (const runtime of runtimes) {
      await runtime.scheduler.idleWithPendingCommits();
      await runtime.dispose();
    }
    await shared.close();
  });

  const settled = async (runtime: Runtime) => {
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.storageManager.synced();
    await runtime.scheduler.idleWithPendingCommits();
  };

  const commit = async (
    runtime: Runtime,
    write: (tx: ReturnType<Runtime["edit"]>) => void,
  ) => {
    const tx = runtime.edit();
    write(tx);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await settled(runtime);
  };

  /** Starts a pattern of a fixture in `runtime` over `argument`. */
  const started = async (
    runtime: Runtime,
    fixture: string,
    pattern: string,
    argument: unknown,
  ) => {
    const compiled = await artifactOf(fixture, pattern);
    const result = runtime.getCell<unknown>(space, `${fixture} result`);
    await commit(runtime, (tx) => {
      piece = startCompiledPiece(
        runtime,
        tx,
        compiled,
        argument,
        result.withTx(tx),
        {},
      );
    });
    await settled(runtime);
    return piece!;
  };

  it("brings a document its replica does not hold, and derives again when it is there", async () => {
    const writer = session();
    await commit(
      writer,
      (tx) =>
        writer.getCell(other, "foreign source", undefined, tx).set(
          { name: "Ada" } as never,
        ),
    );

    const reader = session();
    const running = await started(reader, "foreign-read", "Greeted", {
      source: reader.getCell(other, "foreign source"),
    });

    expect(running.refusals).toEqual([]);
    expect((running.instance.result() as { greeting: string }).greeting).toBe(
      "hello Ada",
    );
  });

  it("follows a link that names no space inside a document of another space into that space", async () => {
    const writer = session();
    // The field `name` of the source is a link to a document of the same
    // space, which the stored link does not name.
    await commit(writer, (tx) => {
      const name = writer.getCell<string>(other, "foreign name", undefined, tx);
      name.set("Ada");
      writer.getCell(other, "foreign source", undefined, tx).set(
        { name } as never,
      );
    });

    const reader = session();
    const running = await started(reader, "foreign-read", "Greeted", {
      source: reader.getCell(other, "foreign source"),
    });

    expect(running.refusals).toEqual([]);
    expect((running.instance.result() as { greeting: string }).greeting).toBe(
      "hello Ada",
    );
  });

  it("tells two documents of one entity apart by their spaces", async () => {
    const runtime = session();
    // The same cause names the same entity in both spaces.
    const here = runtime.getCell<{ name: string }>(space, "one cause");
    const there = runtime.getCell<{ name: string }>(other, "one cause");
    await commit(runtime, (tx) => here.withTx(tx).set({ name: "Ada" }));
    await commit(runtime, (tx) => there.withTx(tx).set({ name: "Grace" }));
    expect(here.getAsNormalizedFullLink().id).toBe(
      there.getAsNormalizedFullLink().id,
    );

    const running = await started(runtime, "foreign-pair", "Paired", {
      here,
      there,
    });

    expect(running.refusals).toEqual([]);
    expect((running.instance.result() as { both: string }).both).toBe(
      "Ada and Grace",
    );

    await commit(runtime, (tx) => there.withTx(tx).key("name").set("Hedy"));
    expect((running.instance.result() as { both: string }).both).toBe(
      "Ada and Hedy",
    );
  });
});
