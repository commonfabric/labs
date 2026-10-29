import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { handler } from "../src/builder/module.ts";
import { pattern } from "../src/builder/pattern.ts";
import { sendEvent } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import type { EventAppendDeliveryOutcome } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("stream send appended");
const space = signer.did();

describe("a stream send's appended hook off server execution", () => {
  it("fires with the commit callback, on the same transaction, as delivered", async () => {
    // Off server execution the handling's commit is the sender's own
    // authored act, so the hook and the commit callback report the same
    // moment; a caller written for the served arm sees one contract.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      // Explicit schemas: a unit test compiles without the CTS transforms.
      const bump = handler(
        true as const,
        { type: "object", properties: {} } as const,
        (_event, _ctx) => {},
      );
      const counter = pattern<{ value: number }>(({ value }) => ({
        value,
        bump: bump({}),
      }));
      const tx = runtime.edit();
      const result = runtime.getCell<{ value: number; bump: unknown }>(
        space,
        "stream-send-appended-result",
        undefined,
        tx,
      );
      runtime.run(tx, counter, { value: 0 }, result);
      await tx.commit().settled;
      await runtime.idle();

      const settled: string[] = [];
      let appended: EventAppendDeliveryOutcome | undefined;
      let appendedTx: unknown;
      let committedTx: unknown;
      await new Promise<void>((resolve) => {
        sendEvent(result.key("bump"), {}, (committed: unknown) => {
          settled.push("commit");
          committedTx = committed;
          resolve();
        }, {
          onAppended: (delivery: EventAppendDeliveryOutcome, at: unknown) => {
            settled.push("appended");
            appended = delivery;
            appendedTx = at;
          },
        });
      });
      expect(settled).toEqual(["appended", "commit"]);
      expect(appended).toEqual({ delivered: true });
      expect(appendedTx).toBe(committedTx);

      // A handling that throws reports its act as refused, with the
      // transaction's reason (the handler's own error is on the runtime's
      // error log, which the CLI reads), on the same transaction the commit
      // callback carries as failed.
      const failing = handler(
        true as const,
        { type: "object", properties: {} } as const,
        (_event, _ctx) => {
          throw new Error("the handler declined");
        },
      );
      const declining = pattern<{ value: number }>(({ value }) => ({
        value,
        bump: failing({}),
      }));
      const tx2 = runtime.edit();
      const declined = runtime.getCell<{ value: number; bump: unknown }>(
        space,
        "stream-send-appended-declined",
        undefined,
        tx2,
      );
      runtime.run(tx2, declining, { value: 0 }, declined);
      await tx2.commit().settled;
      await runtime.idle();
      let refused: EventAppendDeliveryOutcome | undefined;
      let failedStatus: string | undefined;
      await new Promise<void>((resolve) => {
        sendEvent(declined.key("bump"), {}, (committed: any) => {
          failedStatus = committed.status().status;
          resolve();
        }, {
          onAppended: (delivery: EventAppendDeliveryOutcome) => {
            refused = delivery;
          },
        });
      });
      expect(failedStatus).toBe("error");
      expect(refused).toEqual({
        delivered: false,
        refused: expect.any(String),
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
