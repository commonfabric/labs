/**
 * A terminal CFC refusal ends the RETRY sequence, not the subscription.
 *
 * Classifying the boundary refusal as terminal stops the scheduler
 * re-running a doomed computation against unchanged inputs. It must not also
 * strand the action: when a value the run READ changes, the action re-runs on
 * that change like any other. Nothing in the terminal path touches
 * subscription or trigger registration — the resubscribe is on the run path,
 * keyed on the run having happened at all — and this pins that end to end.
 *
 * It asserts that the action RE-RUNS, not that the re-run's write lands: CFC
 * labels are monotone, so a source cannot be un-labelled and a re-run over
 * still-labelled data is refused again, correctly. Re-running is the property
 * under test; whether the fresh verdict differs is policy's business.
 *
 * A METADATA-only change (widening a declared label over a byte-identical
 * value) does NOT re-trigger a reader, and that is correct rather than a gap.
 * A result computed under the policy that existed at the time was computed
 * legitimately; it does not retroactively fall under a later policy, it comes
 * under one when it is recomputed. The next run over a changed value sees the
 * widened label and is judged by it, and the existing derived document keeps
 * the label it was actually derived with — so nothing is laundered, and what
 * a tightening does not get is retroactivity.
 *
 * Monotonicity is the other half of why: a label can only widen, so a re-run
 * provoked by a metadata change could only ever be refused — it cannot repair
 * anything. Revisiting already-derived values under a new policy would be a
 * re-enforcement sweep, which is a different design from a trigger.
 *
 * The behaviour is pre-existing either way — an action that succeeds and
 * never meets a refusal does not re-run on a metadata change either — so it
 * is documented here rather than pinned as a test.
 */

import { describe, it } from "@std/testing/bdd";

import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import type { Action } from "../src/scheduler.ts";

const signer = await Identity.fromPassphrase("runner-cfc-terminal-rerun");

/**
 * The source's schema DECLARES its labels, rather than the seed hand-writing
 * a `cfc` envelope: an envelope has to name a schema hash, and an invented
 * one refuses at the memory boundary, where a content-addressed schema
 * document must be included in the commit or already stored. Declaring it
 * lets the runtime derive the label and persist the canonical schema document
 * itself, which is also how a pattern author would write it.
 */
const sourceSchema = (confidentiality: readonly string[]) => ({
  type: "object" as const,
  properties: {
    secret: { type: "string" as const, ifc: { confidentiality } },
  },
});

const SOURCE = "terminal-rerun-source";

const seedSource = async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    // Persisting flow labels puts the source's confidentiality on the
    // copy the action writes. That carried label is what
    // `expect(out.get()?.copied).toBeUndefined()` needs refused.
    cfcFlowLabels: "persist",
  });
  const space = signer.did();
  const tx = runtime.edit();
  const source = runtime.getCell<{ secret: string }>(
    space,
    SOURCE,
    sourceSchema(["secret"]),
    tx,
  );
  source.set({ secret: "s3cr3t" });
  runtime.prepareTxForCommit(tx);
  // Assert on the ERROR, not on `ok`: a seed that cannot land says why in the
  // failure message instead of reporting an undefined `ok`.
  expect((await tx.commit().settled).error).toBeUndefined();
  return { storageManager, runtime, space, source };
};

/**
 * Subscribes an action whose own transaction runs at enforce-strict, the rung
 * at which a writer-fit misfit refuses the commit rather than flagging it.
 */
const subscribeRefusedCopy = (
  runtime: Runtime,
  space: MemorySpace,
  source: Cell<{ secret: string }>,
  outName: string,
) => {
  const out = runtime.getCell<{ copied?: string }>(space, outName, {
    type: "object",
    properties: { copied: { type: "string" } },
  });
  const state = { runs: 0 };
  const copy: Action = (tx) => {
    state.runs++;
    tx.setCfcEnforcementMode("enforce-strict");
    const secret = source.withTx(tx).get()?.secret ?? "";
    out.withTx(tx).set({ copied: `${secret}!` });
  };
  runtime.scheduler.subscribe(copy, { isEffect: true });
  return { out, state };
};

describe("cfc terminal refusal re-run", () => {
  it("re-runs the refused action when a read VALUE changes", async () => {
    const { storageManager, runtime, space, source } = await seedSource();
    try {
      const { out, state } = subscribeRefusedCopy(
        runtime,
        space,
        source,
        "terminal-rerun-out-value",
      );
      await runtime.scheduler.idleWithPendingCommits();

      // The derived write carries the source's confidentiality and is
      // refused. Terminal: exactly one run, where the bounded retry used to
      // spend ten and then defer past the convergence budget.
      expect(state.runs).toBe(1);
      expect(out.get()?.copied).toBeUndefined();
      await runtime.scheduler.idleWithPendingCommits();
      expect(state.runs).toBe(1);

      // A change to what the run READ re-triggers it, exactly as it would
      // after a successful commit.
      const update = runtime.edit();
      runtime.getCell<{ secret: string }>(
        space,
        SOURCE,
        sourceSchema(["secret"]),
        update,
      ).set({ secret: "rotated" });
      runtime.prepareTxForCommit(update);
      expect((await update.commit().settled).error).toBeUndefined();
      await runtime.scheduler.idleWithPendingCommits();

      expect(state.runs).toBeGreaterThan(1);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});

describe("cfc prepared-state drift", () => {
  it("keeps a read-after-prepare refusal retryable, not terminal", async () => {
    // `invalidateCfc("read-after-prepare")` says the prepared state no longer
    // holds — the verdict was never reached, so it is not one. A fresh
    // attempt prepares against what the transaction actually read. Making it
    // terminal would strand a write whose only fault was reading late.
    const { storageManager, runtime, space, source } = await seedSource();
    try {
      const tx = runtime.edit();
      // The transaction reads the source, so what it writes here carries
      // the source's confidentiality. The schema declares that
      // confidentiality, leaving the drift invalidation as the only
      // thing that refuses this commit.
      const out = runtime.getCell<{ n?: number }>(space, "drift-out", {
        type: "object",
        properties: { n: { type: "number" } },
        ifc: { confidentiality: ["secret"] },
      }, tx);
      out.set({ n: 1 });
      // The labeled read makes the transaction CFC-relevant, so prepare
      // actually prepares it — an irrelevant transaction skips preparation
      // and would refuse through the unprepared arm instead of the drift one.
      source.withTx(tx).get();
      runtime.prepareTxForCommit(tx);
      // A read AFTER prepare invalidates the prepared digest.
      source.withTx(tx).get();
      const { error } = await tx.commit().settled;
      expect(error).toBeDefined();
      expect(error!.name).toBe("StorageTransactionAborted");
      expect(error!.message).toContain("read-after-prepare");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
