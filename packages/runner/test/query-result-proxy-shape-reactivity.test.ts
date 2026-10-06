// Verification for review feedback on #4220's query-result-proxy SHAPE_READ
// change. Several container reads in the proxy were made `nonRecursive` so the
// engine applies shape-only conflict granularity. The concern: that this drops
// the reactive dependency on what those reads observe, at two spots —
//   - `query-result-proxy.ts:179` — the `$stream` marker check at proxy creation
//     reads `value.$stream` off the SHAPE_READ result.
//   - `query-result-proxy.ts:217` — the array proxy stub is sized from
//     `value.length` off the SHAPE_READ result.
//
// Neither drops reactivity:
//   - The SHAPE_READ records a *nonRecursive* read of the container, and a
//     nonRecursive read is re-triggered by a write to a DIRECT child (the
//     scheduler's length+1 overlap rule). `$stream` and array elements are
//     direct children, so adding/removing/flipping them re-runs the consumer.
//   - The `length` *stub* at :217 is just a placeholder; live `length` access
//     goes through the proxy's get trap, which reads recursively and is tracked.
//
// These tests assert the reads are actually in the reactivity log.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { txToReactivityLog } from "../src/scheduler.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("qrp-shape-reactivity");
const space = signer.did();

describe("query-result-proxy nonRecursive shape reads stay reactive", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    tx = runtime.edit();
  });
  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("reading an array proxy's length registers a tracked read (so growth/shrink re-triggers)", () => {
    const c = runtime.getCell<{ array: number[] }>(
      space,
      "qrp-length",
      undefined,
      tx,
    );
    c.set({ array: [1, 2, 3] });

    const proxy = c.getAsQueryResult() as { array: number[] };
    expect(proxy.array.length).toBe(3);

    // The length get trap reads the array live, so the access is a registered
    // dependency — a later element add/remove (which changes length) re-triggers.
    const log = txToReactivityLog(tx);
    const reads = [...log.reads, ...log.shallowReads].map((a) =>
      a.path.join(".")
    );
    expect(reads.some((p) => p.endsWith("array"))).toBe(true);
  });

  it("materializing a proxy registers the nonRecursive container read the $stream check uses", () => {
    const c = runtime.getCell<{ inner: { value: number } }>(
      space,
      "qrp-stream",
      undefined,
      tx,
    );
    c.set({ inner: { value: 1 } });

    // createQueryResultProxy SHAPE_READs each container it materializes (this is
    // the read isStreamValue inspects). It lands in the log as a nonRecursive
    // (shallow) read, so adding/removing/flipping a `$stream` direct child
    // re-triggers and re-decides stream-vs-proxy.
    const proxy = c.getAsQueryResult() as { inner: { value: number } };
    expect(proxy.inner.value).toBe(1);

    const shallow = txToReactivityLog(tx).shallowReads.map((a) =>
      a.path.join(".")
    );
    // The top-level container (where a `$stream` marker would live) is recorded
    // as a nonRecursive read.
    expect(shallow).toContain("value");
    expect(shallow.some((p) => p.endsWith("inner"))).toBe(true);
  });
});
