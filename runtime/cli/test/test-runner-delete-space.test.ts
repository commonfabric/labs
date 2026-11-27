/**
 * Guard for the `{ deleteSpace }` test step: it deletes the space a cell's
 * value lives in, so that `spaceDeleted()` says so in the steps after, a
 * skipped one deletes nothing, and a run on a store the caller supplies
 * refuses it.
 */

import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { describe, it } from "@commonfabric/test-support/test";
import { runTestPattern, runTests } from "../lib/test-runner.ts";

const FIXTURE = resolve(
  import.meta.dirname!,
  "fixtures/delete-space/delete-space.test.tsx",
);
const ROOT = resolve(import.meta.dirname!, "fixtures/delete-space");

describe(
  "`{ deleteSpace }` test step",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("deletes the space, which a skipped step leaves live", async () => {
      // The fixture asserts the space live after the skipped step and deleted
      // after the other.
      const { passed, failed, results } = await runTests(FIXTURE, {
        root: ROOT,
      });
      expect(failed).toBe(0);
      expect(passed).toBe(2);
      // The steps add no result of their own.
      expect(results.flatMap((r) => r.results).map((r) => r.name)).toEqual([
        "assertion_1",
        "assertion_2",
      ]);
    });

    it("refuses to run on a store the caller supplies", async () => {
      const identity = await Identity.fromPassphrase("cli delete space host");
      const storageManager = StorageManager.emulate({ as: identity });
      try {
        const result = await runTestPattern(FIXTURE, {
          root: ROOT,
          storageHost: { identity, storageManager, serverExecution: false },
        });
        expect(result.error).toContain(
          "A `{ deleteSpace }` step needs the store `cf test` creates",
        );
        // A failing step ends the run with an error in place of its results.
        expect(result.results).toEqual([]);
      } finally {
        await storageManager.close();
      }
    });
  },
);
