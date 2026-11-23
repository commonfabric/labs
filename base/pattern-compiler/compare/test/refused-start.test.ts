import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import { PatternCompiler } from "../../../../runtime/runner/src/compiled/compile.deno.ts";
import type { CompiledPiece } from "../../../../runtime/runner/src/compiled/piece.ts";
import { runCompiledPatterns } from "../../../../runtime/runner/src/compiled/run.ts";
import type { RuntimeProgram } from "../../../../runtime/runner/src/harness/types.ts";
import { Runtime } from "../../../../runtime/runner/src/runtime.ts";
import { StorageManager } from "../../../../runtime/runner/src/storage/cache.deno.ts";

// This case runs the release build of the crate, which
// `cargo build --release` in `base/pattern-compiler` makes.
describe("a compiled piece whose start `Runtime.run` could not commit", () => {
  // `fixtures/principal-integrity.tsx`: the first value of the state cell
  // `signed` adds integrity of the current principal, so a start that acts
  // for no one is refused.

  let signer: Identity;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: CompiledPiece[];

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("refused start");
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcFlowLabels: "persist",
      servingPosture: true,
      experimental: { compiledPatterns: true },
    });
    pieces = [];
    const compiler = new PatternCompiler();
    runCompiledPatterns(runtime, {
      compile: (program) => compiler.compile(program),
      started: (piece) => pieces.push(piece),
    });
  });

  afterEach(async () => {
    await runtime.scheduler.idleWithPendingCommits();
    await runtime.dispose({ closeStorage: false });
    await storageManager.close();
  });

  it("is stopped, and derives nothing into the result document afterwards", async () => {
    const program: RuntimeProgram = {
      main: "/principal-integrity.tsx",
      files: [{
        name: "/principal-integrity.tsx",
        contents: await Deno.readTextFile(
          new URL("../fixtures/principal-integrity.tsx", import.meta.url),
        ),
      }],
    };
    const pattern = await runtime.patternManager.compilePattern(program);
    const result = runtime.getCell<unknown>(signer.did(), "refused start");
    const tx = runtime.edit();
    runtime.run(tx, pattern, {}, result.withTx(tx));

    const { error } = await tx.commit().settled;
    await runtime.scheduler.idleWithPendingCommits();

    expect(error?.message).toContain(
      "current-principal integrity requires the run's actor at /",
    );
    expect(pieces).toHaveLength(1);
    expect(pieces[0].counts.derivations).toBe(0);
    expect(await result.pull()).toBeUndefined();
  });
});
