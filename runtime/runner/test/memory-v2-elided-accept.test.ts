/**
 * A commit the store accepts as an identity — stale, but leaving the document
 * as the store already holds it — writes nothing, and the writer's replica
 * promotes its pending layer to the document its transaction computed. That
 * promoted document is the replica's confirmed value from then on, which a
 * later transaction reads and writes over.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("memory-v2 elided accept");
const space = signer.did();

const CAUSE = "memory-v2 elided accept target";

const schema = {
  type: "object",
  properties: { count: { type: "number" } },
  required: ["count"],
} as const satisfies JSONSchema;

describe("memory-v2-elided-accept", () => {
  let server: MemoryV2Server.Server;
  let runtimes: Runtime[];

  /** A runtime with its own replica of `space`, on the shared server. */
  const newRuntime = (): Runtime => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
    });
    runtimes.push(runtime);
    return runtime;
  };

  beforeEach(() => {
    // Manual fan-out: a replica sees another's write only once the test
    // flushes it, so the staleness the store elides is gated, not timed.
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    runtimes = [];
  });

  // Each runtime's `dispose()` closes its own manager; only the shared server
  // is this hook's to close.
  afterEach(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    await server?.close();
  });

  /**
   * Commits `count` into the target document from `runtime`, and delivers the
   * commit to every replica.
   */
  const writeCount = async (runtime: Runtime, count: number) => {
    const tx = runtime.edit();
    runtime.getCell(space, CAUSE, schema, tx).key("count").set(count);
    expect(
      (await tx.commit({ holdSyncedUntilCovered: false }).verdict).error,
    ).toBeUndefined();
    await server.flushSessions();
  };

  it("records a later write over the document an identity accept promoted", async () => {
    const first = newRuntime();
    const second = newRuntime();
    await writeCount(first, 0);

    // The second runtime reads the document, and the first then writes the
    // value the second is about to write. The second's commit is stale, and
    // leaves the document as the store holds it, so the store accepts it as
    // an identity and the second's replica promotes the document its
    // transaction computed.
    const watched = second.getCell(space, CAUSE, schema);
    await watched.sync();
    const stale = second.edit();
    expect(watched.withTx(stale).get()).toEqual({ count: 0 });
    const ahead = first.edit();
    first.getCell(space, CAUSE, schema, ahead).key("count").set(1);
    expect(
      (await ahead.commit({ holdSyncedUntilCovered: false }).verdict).error,
    ).toBeUndefined();
    watched.withTx(stale).key("count").set(1);
    const staleCommit = stale.commit({ holdSyncedUntilCovered: false });
    expect((await staleCommit.verdict).error).toBeUndefined();
    // The accept is parked until the flushed frames cover it, and settles once
    // the replica has promoted it.
    await server.flushSessions();
    expect((await staleCommit.settled).error).toBeUndefined();
    expect(watched.get()).toEqual({ count: 1 });

    // A write over the promoted document reaches the store.
    await writeCount(second, 2);

    const reader = newRuntime().getCell(space, CAUSE, schema);
    await reader.sync();
    expect(reader.get()).toEqual({ count: 2 });
  });
});
