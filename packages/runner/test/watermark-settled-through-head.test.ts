// `waitForSettledThroughHead()`: a client that knows only the store's head
// settles on a quiet space, where the head is the serving loop's own
// watermark write and W rests below it.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import type { ExecutorHost } from "../src/executor/host.ts";
import {
  type ServingMemoryServer,
  startServingMemoryServer,
} from "../src/executor/serving-memory-server.deno.ts";
import {
  readWatermarkSeq,
  SERVER_EXECUTION_WATERMARK_DOC_ID,
  waitForSettled,
  waitForSettledThroughHead,
} from "../src/executor/watermark.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

const space = (await Identity.fromPassphrase("settled through head space"))
  .did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "settled through head service",
);
const aliceSigner = await Identity.fromPassphrase("settled through head alice");

describe("waitForSettledThroughHead()", () => {
  let serving: ServingMemoryServer;
  let server: MemoryV2Server.Server;
  let host: ExecutorHost;
  let manager: EmulatedStorageManager;
  let runtime: Runtime;

  beforeEach(async () => {
    serving = await startServingMemoryServer({
      apiUrl: new URL(import.meta.url),
      serviceIdentity: serviceSigner,
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    });
    ({ server, host } = serving);
    manager = EmulatedStorageManager.connectTo(server, { as: aliceSigner });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await manager.close();
    await host.close();
    await serving.close();
  });

  /** Commits one authored write and returns the store's sequence after it. */
  const authoredWrite = async (n: number): Promise<number> => {
    const cell = runtime.getCell<{ n: number }>(
      space,
      "settled-through-head-arg",
      undefined,
    );
    await cell.sync();
    const tx = runtime.edit();
    cell.withTx(tx).set({ n });
    expect((await tx.commit().settled).error).toBeUndefined();
    return await runtime.storageManager.open(space).serverHeadSeq!();
  };

  it("resolves on a quiet space whose head is the loop's own watermark write", async () => {
    const authoredSeq = await authoredWrite(1);
    await waitForSettled(runtime, space, authoredSeq);
    const engine = await server.engineForSpace(space);
    const head = await runtime.storageManager.open(space).serverHeadSeq!();
    // The scenario: W covers the authored commit and rests below the head,
    // which is the watermark write itself.
    expect(readWatermarkSeq(engine)).toBeGreaterThanOrEqual(authoredSeq);
    expect(readWatermarkSeq(engine)).toBeLessThan(head);
    const revision = engine.database.prepare(
      `SELECT commit_seq FROM revision WHERE id = :id ORDER BY seq DESC LIMIT 1`,
    ).get({ id: SERVER_EXECUTION_WATERMARK_DOC_ID }) as { commit_seq: number };
    expect(revision.commit_seq).toBe(head);
    await waitForSettledThroughHead(runtime, space, head);
  });

  it("waits for the serving loop to react to an authored commit at the head", async () => {
    const authoredSeq = await authoredWrite(2);
    await waitForSettledThroughHead(runtime, space, authoredSeq);
    const engine = await server.engineForSpace(space);
    expect(readWatermarkSeq(engine)).toBeGreaterThanOrEqual(authoredSeq);
  });
});
