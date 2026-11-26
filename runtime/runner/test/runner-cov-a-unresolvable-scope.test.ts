import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type { Pattern } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { trustPattern } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner unresolvable scope");
const space = signer.did();

describe("runner", () => {
  describe("run of a user-scoped piece in a transaction naming no principal", () => {
    // The transaction's identity cannot resolve the piece's user instance, so
    // the run's transaction is not one that writes the piece's document for
    // the pattern watcher's purposes, and the run goes ahead.

    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let rt: Runtime;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      rt = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    });

    afterEach(async () => {
      await rt.dispose();
      await storageManager.close();
    });

    it("starts the piece, and its commit lands", async () => {
      const pattern: Pattern = trustPattern(rt, {
        argumentSchema: {
          type: "object",
          properties: { n: { type: "number" } },
        },
        resultSchema: {},
        result: { out: { $alias: { partialCause: "out", path: [] } } },
        nodes: [{
          module: {
            type: "javascript",
            implementation: (n: number) => n * 2,
          },
          inputs: { $alias: { cell: "argument", path: ["n"] } },
          outputs: { $alias: { partialCause: "out", path: [] } },
        }],
      });
      const cell = rt.getCell<{ out: number }>(
        space,
        "no-principal",
        undefined,
        undefined,
        "user",
      );
      const tx = rt.edit();
      tx.tx.scopeKeyIdentity = {};

      rt.run(tx, pattern, { n: 1 }, cell);

      expect(rt.runner.isRunning(cell)).toBe(true);
      expect((await tx.commit().settled).error).toBeUndefined();
    });
  });
});
