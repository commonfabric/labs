import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { LLMClient } from "@commonfabric/llm/client";

import { resolveLocalProgram } from "../src/harness/local-program.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

describe("Write and Run availability", () => {
  it("reports a provider failure without invoking the downstream compiler", async () => {
    const signer = await Identity.fromPassphrase("write and run failure");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const provider = stub(
      LLMClient.prototype,
      "sendRequest",
      () => Promise.reject(new Error("provider unavailable")),
    );

    try {
      const program = await resolveLocalProgram(
        (resolver) => runtime.harness.resolve(resolver),
        {
          main: fromFileUrl(
            new URL(
              "../../patterns/examples/write-and-run.tsx",
              import.meta.url,
            ),
          ),
        },
      );
      const compiled = await runtime.patternManager.compileOrGetPattern(
        program,
        signer.did(),
      );
      await runtime.patternManager.flushCompileCacheWrites();
      const compiler = spy(runtime.patternManager, "compileOrGetPattern");
      try {
        const tx = runtime.edit();
        const resultCell = runtime.getCell<{ error?: string }>(
          signer.did(),
          "write and run provider failure",
          compiled.resultSchema,
          tx,
        );
        const result = runtime.run(
          tx,
          compiled,
          { prompt: "Generate a counter" },
          resultCell,
        );
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit().settled).error).toBeUndefined();

        await waitForCellValue(
          runtime,
          result.key("error"),
          (value) => value === "provider unavailable",
        );
        await runtime.settled();
        await runtime.idle();
        await storageManager.synced();

        expect(result.key("error").get()).toBe("provider unavailable");
        expect(provider.calls).toHaveLength(1);
        expect(compiler.calls).toHaveLength(0);
      } finally {
        compiler.restore();
      }
    } finally {
      provider.restore();
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
