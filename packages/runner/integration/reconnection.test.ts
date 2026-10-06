#!/usr/bin/env -S deno run -A

import { assertEquals } from "@std/assert";

import { Identity } from "@commonfabric/identity";
import { type JSONSchema, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { defer } from "@commonfabric/utils/defer";

import app from "../../toolshed/app.ts";

const createRuntime = (identity: Identity, base: URL) =>
  new Runtime({
    apiUrl: base,
    // Server-execution v2 posture (testing.md §2): this test serves
    // toolshed's `app.ts` IN-PROCESS (`Deno.serve` below) with NO
    // ExecutorHost, so it is a single-process harness — client and memory
    // server in one process, nothing serving — and its client is OFF BY
    // CONSTRUCTION, whatever EXPERIMENTAL_SERVER_EXECUTION says (a flag-ON
    // client here would divert its derivations to a server that does not
    // exist and wedge). The CI ON lane's env does not reach this file;
    // only the tests that talk to the lane's toolshed (API_URL) declare
    // the posture from the env (P7 review finding 7).
    storageManager: StorageManager.open({
      as: identity,
      memoryHost: new URL(base),
    }),
  });

Deno.test(
  "memory v2 runtime re-establishes subscriptions after server restart",
  async () => {
    const identity = await Identity.fromPassphrase(
      `runner-memory-v2-reconnect-${Date.now()}`,
    );
    let server = Deno.serve({ port: 0 }, app.fetch);
    const port = server.addr.port;
    const base = new URL(`http://${server.addr.hostname}:${port}`);
    const space = identity.did();

    const counterSchema = {
      type: "object",
      properties: {
        count: { type: "number" },
      },
      required: ["count"],
    } as const satisfies JSONSchema;

    try {
      const runtime1 = createRuntime(identity, base);
      let tx = runtime1.edit();
      const counterCell = runtime1.getCell(
        space,
        "runner-v2-reconnect-counter",
        counterSchema,
        tx,
      );
      counterCell.set({ count: 1 });
      await tx.commit().settled;
      await runtime1.storageManager.synced();
      await runtime1.dispose();

      const subscriberRuntime = createRuntime(identity, base);
      const subscriberCell = subscriberRuntime.getCell(
        space,
        "runner-v2-reconnect-counter",
        counterSchema,
      );
      await subscriberCell.sync();
      await subscriberRuntime.storageManager.synced();
      assertEquals(subscriberCell.get(), { count: 1 });

      const gotReconnectUpdate = defer<void>();
      subscriberCell.sink((value) => {
        if (value?.count === 2) {
          gotReconnectUpdate.resolve();
        }
      });

      await server.shutdown();
      server = Deno.serve({ port }, app.fetch);

      const writerRuntime = createRuntime(identity, base);
      const writerCell = writerRuntime.getCell(
        space,
        "runner-v2-reconnect-counter",
        counterSchema,
      );
      await writerCell.sync();
      tx = writerRuntime.edit();
      writerCell.withTx(tx).set({ count: 2 });
      await tx.commit().settled;
      await writerRuntime.storageManager.synced();

      await gotReconnectUpdate.promise;
      assertEquals(subscriberCell.get(), { count: 2 });

      await writerRuntime.dispose();
      await subscriberRuntime.dispose();
    } finally {
      await server.shutdown();
    }
  },
);
