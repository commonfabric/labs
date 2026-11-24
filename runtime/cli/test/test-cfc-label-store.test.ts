import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import {
  cfcConfidentialityForObservationNode,
  cfcLabelViewForDereferenceTraces,
} from "@commonfabric/runner/cfc";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { runTestPattern } from "../lib/test-runner.ts";

describe("test-cfc-label-store", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  it("labels SQLite columns with flow off and persists copied labels only in persist mode", async () => {
    // On the OFF arm. What this compares is the test runtime's
    // `cfcFlowLabels` deciding the labels its own handlers commit. On the ON
    // arm the seed and the copy are served handlers, which run under the
    // serving runtime's CFC posture rather than the test's (`docs/development/
    // TESTING.md`, "The ON topology in one process"), and a run that resolves
    // ON refuses the caller-supplied store this reads afterwards.
    for (const cfcFlowLabels of ["off", "persist"] as const) {
      const identity = await Identity.fromPassphrase(
        `test-cfc-store-${cfcFlowLabels}`,
      );
      const storageManager = StorageManager.emulate({ as: identity });
      const resultCause = { test: "labeled-fixture", run: crypto.randomUUID() };
      const reader = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        cfcEnforcementMode: "enforce-explicit",
      });
      try {
        const result = await runTestPattern(
          resolve(
            import.meta.dirname!,
            "fixtures/cfc-flow-labels/mapped-render.test.tsx",
          ),
          {
            cfcEnforcementMode: "enforce-explicit",
            cfcFlowLabels,
            noIdempotencyCheck: true,
            storageHost: {
              identity,
              storageManager,
              resultCause,
              serverExecution: false,
            },
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.runtimeErrors).toEqual([]);
        expect(result.results.every((r) => r.passed)).toBe(true);
        const root = reader.getCell<{
          small: { query: { result: { id: number; title: string }[] } };
          copied: { id: number; title: string }[];
        }>(identity.did(), resultCause);
        await root.sync();
        for (
          const [cell, labeled] of [
            [
              root.key("small").key("query").key("result").key(0).key("title"),
              true,
            ],
            [
              root.key("copied").key(0).key("title"),
              cfcFlowLabels === "persist",
            ],
          ] as const
        ) {
          await cell.sync();
          const tx = reader.edit();
          try {
            expect(cell.withTx(tx).get()).toBe("Message 1");
            const view = cfcLabelViewForDereferenceTraces(
              tx,
              tx.getCfcState().dereferenceTraces,
            );
            const label = cfcConfidentialityForObservationNode({
              labelView: view,
              logicalPath: [],
            });
            expect(label.includes("fixture-private")).toBe(labeled);
          } finally {
            tx.abort();
          }
        }
      } finally {
        await reader.dispose();
      }
    }
  });
});
