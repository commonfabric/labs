import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { MemorySpace } from "../../../../runtime/runner/src/cell.ts";
import {
  PatternCompileError,
  PatternCompiler,
} from "../../../../runtime/runner/src/compiled/compile.deno.ts";
import {
  type CompiledPiece,
  startCompiledPiece,
} from "../../../../runtime/runner/src/compiled/piece.ts";
import type { RuntimeProgram } from "../../../../runtime/runner/src/harness/types.ts";
import { Runtime } from "../../../../runtime/runner/src/runtime.ts";
import { StorageManager } from "../../../../runtime/runner/src/storage/cache.deno.ts";

/** The program of one file of `compare/fixtures/`. */
const programOf = async (fixture: string): Promise<RuntimeProgram> => ({
  main: `/${fixture}`,
  files: [{
    name: `/${fixture}`,
    contents: await Deno.readTextFile(
      new URL(`../fixtures/${fixture}`, import.meta.url),
    ),
  }],
});

// These cases run the release build of the crate, which
// `cargo build --release` in `base/pattern-compiler` makes.
describe("a pattern compiled from its source by the crate's binary", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let space: MemorySpace;
  let cacheDir: string;
  let pieces: CompiledPiece[];

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("compile on load");
    space = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcFlowLabels: "persist",
      experimental: { compiledPatterns: true },
      servingPosture: true,
    });
    cacheDir = await Deno.makeTempDir();
    pieces = [];
  });

  afterEach(async () => {
    for (const piece of pieces) piece.stop();
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.dispose();
    await storageManager.close();
    await Deno.remove(cacheDir, { recursive: true });
  });

  /**
   * Starts a piece of `fixtures/handler.tsx` from what `compiler` gives
   * for its source, sends one event, and returns what `last` holds.
   */
  const lastAfterAnEvent = async (compiler: PatternCompiler) => {
    const compiled = await compiler.compile(await programOf("handler.tsx"));
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      `result ${pieces.length}`,
    );
    const tx = runtime.edit();
    pieces.push(
      startCompiledPiece(
        runtime,
        tx,
        compiled.main,
        { secret: "s", note: "n" },
        result.withTx(tx),
        { artifacts: compiled.artifacts },
      ),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.scheduler.idleWithPendingCommits();
    result.key("record").send({ text: "t", extra: "e" } as never);
    await runtime.scheduler.idleWithPendingCommits();
    const read = runtime.edit();
    try {
      return {
        cached: compiled.cached,
        last: result.withTx(read).key("last").get(),
      };
    } finally {
      read.abort();
    }
  };

  it("runs as a piece that handles an event", async () => {
    expect(await lastAfterAnEvent(new PatternCompiler())).toEqual({
      cached: false,
      last: "ts",
    });
  });

  it("runs the same from the artifacts the cache directory holds", async () => {
    await lastAfterAnEvent(new PatternCompiler({ cacheDir }));

    expect(await lastAfterAnEvent(new PatternCompiler({ cacheDir })))
      .toEqual({ cached: true, last: "ts" });
  });

  it("is refused where a body names the host object of the value code", async () => {
    const program = await programOf("handler.tsx");
    program.files[0].contents = program.files[0].contents.replace(
      "last.set(event.text + secret);",
      "last.set(String($h));",
    );

    const compiling = new PatternCompiler().compile(program);

    await expect(compiling).rejects.toThrow(PatternCompileError);
    await expect(compiling).rejects.toThrow("`$h` is not a listed");
  });
});
