import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { type MemorySpace, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import type { CallableResolution } from "../lib/callable.ts";
import { executeResolvedCallable } from "../lib/callable.ts";
import { sendThroughStandIn } from "./utils.ts";

/**
 * A `FabricInstance` crossing `Cell.pull()` arrives as a query-result proxy
 * over an empty ordinary stub (the `getPrototypeOf` note in
 * packages/runner/src/query-result-proxy.ts), so prototype and key
 * enumeration on the materialized value cannot tell a real instance result
 * from the value-less witness — a shape check swallowed it as "no result".
 * Presence must come from the receipt's STORED value.
 *
 * The receipt here is a REAL runtime cell written, committed, and read back
 * through the real pull boundary; only the verb dispatch is a double, so the
 * seam under test — readback classification — is the production one. A mock
 * receipt cannot witness this defect at all: it hands back whatever the test
 * decided, never a proxy over an empty stub.
 */
describe("piece-call-instance-result-live", () => {
  async function withRuntime(
    run: (runtime: Runtime, space: MemorySpace) => Promise<void>,
  ): Promise<void> {
    const signer = await Identity.fromPassphrase("instance-result-live");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      await run(runtime, signer.did());
    } finally {
      await runtime.dispose?.();
      await storageManager.close?.();
    }
  }

  async function executeAgainstStoredReceipt(
    runtime: Runtime,
    space: MemorySpace,
    cause: string,
    stored: unknown,
  ) {
    const tx = runtime.edit();
    const receipt = runtime.getCell<unknown>(space, cause, undefined, tx);
    receipt.withTx(tx).set(stored);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    const link = receipt.getAsNormalizedFullLink();

    const resolution = {
      callableCell: {
        schema: { asCell: ["stream"] },
        send: (
          _value: unknown,
          onCommit?: (tx: unknown) => void,
        ) => {
          onCommit?.({
            status: () => ({ status: "done" }),
            handlingReceiptLink: link,
          });
        },
      },
      callableKind: "handler",
      cellKey: "exportInstance",
      pieces: { runtime, getSpace: () => space },
      space,
    } as unknown as CallableResolution;

    return await executeResolvedCallable(resolution, {}, {
      sendEvent: sendThroughStandIn,
      invocation: { id: `inv-${cause}`, session: "ses:instance-live" },
    });
  }

  it("returns a stored instance result instead of reading it as value-less", async () => {
    await withRuntime(async (runtime, space) => {
      const executed = await executeAgainstStoredReceipt(
        runtime,
        space,
        "instance-receipt",
        new FabricError({
          type: "Error",
          message: "stored instance",
          stack: undefined,
          cause: undefined,
        }),
      );
      expect(executed.invocation?.status).toBe("settled");
      expect(executed.invocation?.result).not.toBe(undefined);
    });
  });

  it("still reads a real empty-record receipt as the value-less witness", async () => {
    await withRuntime(async (runtime, space) => {
      const executed = await executeAgainstStoredReceipt(
        runtime,
        space,
        "value-less-receipt",
        {},
      );
      expect(executed.invocation?.status).toBe("settled");
      expect(executed.invocation?.result).toBe(undefined);
    });
  });
});
