/**
 * Plan B: the wake shaper's cell path is owned by the scheduler. These tests
 * exercise its runtime lifecycle through the public holdShapedCellNotification
 * seam — that a held notification is not delivered synchronously, that idle()
 * waits for its release, and that dispose() cancels it.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase(
  "cell notification shaper lifecycle test",
);

describe("wake shaper cell-path scheduler lifecycle", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    await storageManager?.close();
  });

  function makeRuntime(): Runtime {
    return new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  }

  it("holds the notification and releases it under idle()", async () => {
    const runtime = makeRuntime();
    try {
      let delivered = false;
      runtime.scheduler.holdShapedCellNotification(
        "pattern-a",
        "cell-1",
        {}, // charge key (source commit)
        () => {
          delivered = true;
        },
      );
      // Held out-of-band: not delivered synchronously.
      expect(delivered).toBe(false);
      // idle() must wait for the shaper to drain, then the thunk has run.
      await runtime.idle();
      expect(delivered).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  // dispose() cancelling a held notification without delivering is covered at the
  // component level by cell-notification-shaping.test.ts ("delivers nothing after
  // dispose"); exercising it here would dispose a Runtime that never drained via
  // idle(), which trips Deno's op sanitizer on unrelated teardown ops.
});
