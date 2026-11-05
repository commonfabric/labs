import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import {
  type Action,
  Runtime,
  RuntimeTelemetryEvent,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { RuntimeClient } from "@/runtime-client.ts";
import type { IPCClientRequest } from "@/protocol/mod.ts";
import { buildProcessor } from "./backends/build-processor.ts";

describe("worker read accounting", () => {
  it("enables and disables real runtime samples through the client request route", async () => {
    const signer = await Identity.fromPassphrase("worker-read-accounting");
    const storage = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    try {
      const tx = runtime.edit();
      runtime.getCell(signer.did(), "source", undefined, tx).set({ value: 7 });
      await tx.commit().settled;
      const processor = buildProcessor({
        runtime,
        telemetry: runtime.telemetry,
      });
      const connection = {
        on: () => {},
        request: (message: IPCClientRequest) =>
          processor.handleRequest(message),
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (connection: never, options: unknown): RuntimeClient;
      })(connection, undefined);
      const measured: boolean[] = [];
      runtime.telemetry.addEventListener("telemetry", (event) => {
        if (
          event instanceof RuntimeTelemetryEvent &&
          event.marker.type === "scheduler.run.complete"
        ) {
          measured.push(event.marker.reads !== undefined);
        }
      });

      for (const enabled of [false, true, false]) {
        measured.length = 0;
        await client.setReadStatsEnabled(enabled);
        const action: Action = (tx) => {
          const data = runtime.getCell<{ value: number }>(
            signer.did(),
            "source",
            undefined,
            tx,
          ).get();
          expect(data.value).toBe(7);
          expect(data.value).toBe(7);
        };
        runtime.scheduler.subscribe(action, {
          reads: [],
          shallowReads: [],
          writes: [],
        }, { isEffect: true });
        runtime.scheduler.queueExecution();
        await runtime.idle();
        const reads = runtime.scheduler.getActionStats(action)?.reads;
        if (enabled) expect(reads?.proxyAccesses).toBe(2);
        expect(measured).toEqual([enabled]);
        runtime.scheduler.unsubscribe(action);
      }
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });
});
