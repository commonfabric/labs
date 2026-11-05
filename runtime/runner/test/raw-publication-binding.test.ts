import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createNodeFactory } from "../src/builder/module.ts";
import { cellTx } from "../src/cell.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
import { raw, type RawNodeCause } from "../src/module.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("raw-publication-binding");

describe("Raw builtin publication binding", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    try {
      await runtime?.dispose({ closeStorage: false });
    } finally {
      await storageManager?.close();
      runtime = undefined;
      storageManager = undefined;
    }
  });

  for (const scope of ["user", "session"] as const) {
    it(`separates a declared ${scope} result scope from its space publication`, async () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const captured: Array<{
        cause: RawNodeCause;
        declared?: NormalizedFullLink;
        awaitSync?: boolean;
        publication?: NormalizedFullLink;
      }> = [];
      runtime.moduleRegistry.addModuleByRef(
        "publication-test-builtin",
        raw((
          inputs,
          sendResult,
          _addCancel,
          cause,
          _parent,
          _runtime,
          declared,
          awaitSync,
          publication,
        ) => {
          captured.push({ cause, declared, awaitSync, publication });
          sendResult(cellTx(inputs)!, "published");
          return () => undefined;
        }),
      );
      const tx = runtime.edit();
      const result = runtime.getCell(
        signer.did(),
        `raw-publication-${scope}`,
        undefined,
        tx,
      );
      runtime.runner.run(
        tx,
        createNodeFactory({
          type: "ref",
          implementation: "publication-test-builtin",
        }).asScope(scope),
        {},
        result,
      );
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.idle();

      expect(captured).toHaveLength(1);
      const { cause, declared, awaitSync, publication } = captured[0];
      expect(declared?.scope).toBe(scope);
      expect(awaitSync).toBe(false);
      expect(publication?.scope).toBe("space");
      expect(declared).toEqual({ ...publication, scope });
      expect(cause.outputSpot).toEqual({
        space: publication!.space,
        id: publication!.id,
        path: publication!.path,
      });
      expect(runtime.getCellFromLink(publication!).getRaw()).toBe("published");
      expect(result.withTx(undefined).get()).toBe("published");
    });
  }
});
