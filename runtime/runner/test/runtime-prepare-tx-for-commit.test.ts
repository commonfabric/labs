import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { CfcFlowLabelsMode } from "../src/cfc/types.ts";

const signer = await Identity.fromPassphrase(
  "runner-prepare-tx-for-commit",
);
const space = signer.did();

const LABELED_SCHEMA = {
  type: "object",
  properties: {
    secret: {
      type: "string",
      ifc: { confidentiality: ["secret"] },
    },
  },
  required: ["secret"],
} as const;

describe("Runtime.prepareTxForCommit()", () => {
  // `prepareTxForCommit` reaches storage through the transaction it prepares,
  // by two routes: the flow-labels relevance probe reads stored metadata, and
  // `prepareCfc` reads and writes the derived label map. A settled transaction
  // refuses both, and cannot commit either, so prepare on one returns without
  // touching it and leaves the terminal state to the commit result.

  const started: {
    runtime: Runtime;
    storageManager: ReturnType<typeof StorageManager.emulate>;
  }[] = [];

  // The flow dial is the one thing that varies between the cases below, so
  // each test names its own rather than sharing one from `beforeEach`.
  const makeRuntime = (cfcFlowLabels?: CfcFlowLabelsMode): Runtime => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      ...(cfcFlowLabels === undefined ? {} : { cfcFlowLabels }),
    });
    started.push({ runtime, storageManager });
    return runtime;
  };

  afterEach(async () => {
    for (const { runtime, storageManager } of started.splice(0)) {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("leaves an aborted transaction unprepared when its write is unlabeled and the flow dial is `persist`", () => {
    // At `persist` the probe runs for every prepared transaction, so a plain
    // unlabeled write is enough to reach the metadata read. An aborted
    // transaction keeps its journal, so the probe finds that write and goes on
    // to read the document's stored metadata.

    const runtime = makeRuntime("persist");
    const tx = runtime.edit();
    const cell = runtime.getCell<{ note: string }>(
      space,
      "prepare-aborted-flow-probe",
      undefined,
      tx,
    );
    cell.set({ note: "discarded" });
    tx.abort("scheduler retry discarded this attempt");
    expect(tx.status().status).toBe("error");

    expect(() => runtime.prepareTxForCommit(tx)).not.toThrow();
    expect(tx.getCfcState().relevant).toBe(false);
    expect(tx.getCfcState().prepare.status).toBe("unprepared");
  });

  it("leaves an aborted transaction unprepared when it is already CFC-relevant and the flow dial is at its default", () => {
    // The flow dial defaults to `off`, which skips the probe. A labeled write
    // marks the transaction relevant on its own, so prepare reaches
    // `prepareCfc` instead, which also reads and writes through the
    // transaction.

    const runtime = makeRuntime();
    const tx = runtime.edit();
    const cell = runtime.getCell(
      space,
      "prepare-aborted-relevant",
      LABELED_SCHEMA,
      tx,
    );
    cell.set({ secret: "value" });
    expect(tx.getCfcState().relevant).toBe(true);
    tx.abort("scheduler retry discarded this attempt");
    expect(tx.status().status).toBe("error");

    expect(() => runtime.prepareTxForCommit(tx)).not.toThrow();
    expect(tx.getCfcState().prepare.status).toBe("unprepared");
  });

  it("returns without throwing when the transaction has already committed", async () => {
    // A committed transaction releases its journal, so the probe finds no
    // writes to check and reaches no read. This pins the contract rather than a
    // throw.

    const runtime = makeRuntime("persist");
    const tx = runtime.edit();
    const cell = runtime.getCell<{ note: string }>(
      space,
      "prepare-committed",
      undefined,
      tx,
    );
    cell.set({ note: "durable" });
    expect((await tx.commit().settled).ok).toBeDefined();
    expect(tx.status().status).toBe("done");

    expect(() => runtime.prepareTxForCommit(tx)).not.toThrow();
  });

  it("returns the abort as `editWithRetry`'s result when the action read before aborting", async () => {
    // The guard at a caller rather than at the chokepoint. `editWithRetry`
    // prepares outside the block that turns a throwing action into a result, so
    // a throw out of prepare escapes it synchronously and defeats the `Result`
    // it promises. The abort cases in the `editWithRetry` suite abort without
    // reading or writing first, which leaves the probe nothing to walk.

    const runtime = makeRuntime("persist");
    const seed = runtime.edit();
    const cell = runtime.getCell<{ note: string }>(
      space,
      "prepare-edit-with-retry",
      undefined,
      seed,
    );
    cell.set({ note: "seeded" });
    expect((await seed.commit().settled).ok).toBeDefined();

    const { error } = await runtime.editWithRetry((tx) => {
      cell.withTx(tx).get();
      tx.abort("done with this one");
    }, 0);

    expect(error?.name).toBe("StorageTransactionAborted");
  });

  it("prepares a ready transaction whose write is CFC-relevant", async () => {
    const runtime = makeRuntime("persist");
    const tx = runtime.edit();
    const cell = runtime.getCell(
      space,
      "prepare-ready-relevant",
      LABELED_SCHEMA,
      tx,
    );
    cell.set({ secret: "value" });

    runtime.prepareTxForCommit(tx);

    expect(tx.getCfcState().prepare.status).toBe("prepared");
    expect((await tx.commit().settled).ok).toBeDefined();
  });
});
