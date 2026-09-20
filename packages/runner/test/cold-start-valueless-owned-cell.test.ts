import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { join } from "@std/path";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { resolveLocalProgram } from "../src/harness/local-program.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("cold start valueless owned cell");
const space = signer.did() as MemorySpace;
const patternsRoot = join(import.meta.dirname!, "..", "..", "patterns");

// The staged-publish pattern runs three trusted surfaces as sub-pieces, each
// holding a computed cell. Under server execution a client's computed writes
// are speculative, so the creating client leaves those cells in the store
// with their `result` back-link and no value. A second client that starts the
// piece cold finds each sub-piece's family incomplete and runs it in a
// transaction of its own, once its name-sync has landed.
//
// That separation is what this pins. A sub-piece's re-run stages writes over
// fields only a trusted event may write, and its commit is refused. Run
// inline, in the parent's instantiation transaction, the refusal takes the
// parent's graph down with it and `stage` is never computed. A document that
// has metadata and no value has to keep reading absent for the separation to
// hold; only a stream's document, which never holds a value, is present on
// its record alone.
describe("cold start over an owned cell that holds no value", () => {
  let server: MemoryV2Server.Server;
  let managers: EmulatedStorageManager[];
  let runtimes: Runtime[];

  const client = (): Runtime => {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
    managers.push(manager);
    runtimes.push(runtime);
    return runtime;
  };

  const quiesce = async (runtime: Runtime) => {
    for (let i = 0; i < 4; i++) {
      await runtime.idle();
      await runtime.storageManager.synced();
    }
  };

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    managers = [];
    runtimes = [];
  });

  afterEach(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    for (const manager of managers) await manager.close();
    await server.close();
  });

  it("keeps the parent's graph when its sub-pieces' re-runs are refused", async () => {
    const creator = client();
    const program = await resolveLocalProgram(
      (resolver) => creator.harness.resolve(resolver),
      {
        main: join(patternsRoot, "cfc-staged-publish", "main.tsx"),
        root: patternsRoot,
      },
    );
    const compiled = await creator.patternManager.compilePattern(program, {
      space,
    });
    const result = creator.getCell<Record<string, unknown>>(
      space,
      "staged-publish",
      compiled.resultSchema,
    );
    await result.sync();
    const tx = creator.edit();
    creator.run(tx, compiled, {}, result);
    creator.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    const cancelCreator = result.sink(() => {});
    await quiesce(creator);

    const cold = client();
    const coldResult = cold.getCell<Record<string, unknown>>(
      space,
      "staged-publish",
      compiled.resultSchema,
    );
    await coldResult.sync();
    await cold.start(coldResult);
    const cancelCold = coldResult.sink(() => {});
    await quiesce(cold);

    expect(await coldResult.key("stage").pull()).toBe("drafting");

    cancelCold();
    cancelCreator();
  });
});
