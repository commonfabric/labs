/**
 * Runs the serving loop in a Worker over a file-backed memory server on this
 * thread, and drives it from a client runtime here: the client's authored
 * commits reach the worker's host through the port, the host's derived
 * commits land in the store through the bridge's sink, and the client reads
 * the result back through its ordinary subscription.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { toFileUrl } from "@std/path";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import * as Engine from "@commonfabric/memory/v2/engine";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { defer } from "@commonfabric/utils/defer";

import type { Cell } from "../src/cell.ts";
import { ServingWorker } from "../src/executor/serving-worker-host.ts";
import { readWatermarkSeq } from "../src/executor/watermark.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { awaitAdmitted } from "./support/serving-waits.ts";

const spaceSigner = await Identity.fromPassphrase("serving worker space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("serving worker service");
const aliceSigner = await Identity.fromPassphrase("serving worker alice");

const PARENT_PATTERN = `
import { computed, pattern } from "commonfabric";
export default pattern<{ n: number }, { total: number }>(({ n }) => ({
  total: computed(() => n + 1),
}));
`;

describe("serving-worker", () => {
  let directory: string;
  let server: MemoryV2Server.Server;
  let worker: ServingWorker;
  let clientManager: EmulatedStorageManager;
  let client: Runtime;
  let activated: ReturnType<typeof defer<void>>;

  beforeEach(async () => {
    directory = await Deno.makeTempDir({ prefix: "serving-worker-" });
    server = newSharedServer({
      subscriptionRefreshDelayMs: 0,
      store: toFileUrl(`${directory}/`),
    });
    activated = defer<void>();
    worker = new ServingWorker({
      server,
      identity: serviceSigner,
      apiUrl: new URL(import.meta.url),
      ensureSpaceRoots: false,
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
      onActivationSettled: (_space, outcome) => {
        if (outcome === "active") activated.resolve();
      },
    });
    await worker.ready;
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    client = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
  });

  afterEach(async () => {
    await worker.close();
    await client.dispose();
    await clientManager.close();
    await server.close();
    await Deno.remove(directory, { recursive: true });
  });

  it("derives a client's authored input in the worker and settles the client past it", async () => {
    const parent = await client.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: PARENT_PATTERN }],
    }, { space });
    const argument: Cell<{ n: number }> = client.getCell(
      space,
      "worker-arg",
      undefined,
    );
    const result = client.getCell<{ total: number }>(
      space,
      "worker-result",
      parent.resultSchema,
    );
    await argument.sync();
    await result.sync();
    const seed = client.edit();
    argument.withTx(seed).set({ n: 41 });
    expect((await seed.commit().settled).error).toBeUndefined();
    const run = client.edit();
    client.run(run, parent, argument, result);
    expect((await run.commit().settled).error).toBeUndefined();
    const engine = await server.engineForSpace(space);
    const authoredSeq = Engine.serverSeq(engine);
    // The client's subscription is the demand the worker's loop derives for.
    // The client reads its own speculative value at once; the worker's
    // derivation shows as the watermark passing the client's input.
    const cancelDemand = result.sink(() => {});
    try {
      await activated.promise;
      await awaitAdmitted(
        server,
        () => readWatermarkSeq(engine) >= authoredSeq,
      );
      await waitForCellValue(
        client,
        result.key("total"),
        (total: number | undefined) => total === 42,
        { stuckLabel: "the client's total to reach 42" },
      );
    } finally {
      cancelDemand();
    }

    // The derived commits are the worker's: held under a lease whose
    // holder names the service identity, through the store this thread's
    // server owns.
    const derived = engine.database.prepare(
      `SELECT seq, holder FROM "commit" WHERE class = 'derived' ORDER BY seq`,
    ).all() as { seq: number; holder: string }[];
    expect(derived.length).toBeGreaterThanOrEqual(1);
    for (const row of derived) {
      expect(row.holder.startsWith(`${serviceSigner.did()}#`)).toBe(true);
    }
    const stats = await worker.requestStats();
    expect(stats.activeSpaces).toBe(1);
    expect(stats.derivedCommits).toBeGreaterThanOrEqual(1);
  });
});
