import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("sqlite query result scope");

describe("sqlite query result scope", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("throws naming the build-time read when a pattern input supplies `scope`", async () => {
    // A required input passes the type check, since its type is `CellScope`,
    // but `db.query()` reads `scope` while the pattern is built, when the
    // input is still a reference and not one of the three scopes.

    await expect(
      runtime.patternManager.compilePattern(`
        import { type CellScope, pattern, type SqliteDb } from "commonfabric";
        export default pattern<{ db: SqliteDb; scope: CellScope }>(
          ({ db, scope }) => db.query("SELECT 1", { scope }),
        );
      `),
    ).rejects.toThrow(
      "`db.query()`'s `scope` is read when the pattern is built",
    );
  });
});
