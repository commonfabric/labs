/**
 * Work registered with `Scheduler.trackBackgroundTask` holds `idle()` open
 * until it settles, and releases it whether it succeeded or failed.
 *
 * Reactive quiescence is a statement about the graph: nothing running on it,
 * nothing scheduled to. Work the runtime has already undertaken off the graph —
 * fetching a system pattern so a surface a builtin has already emitted can be
 * filled in — leaves the graph quiet for the whole time it is in flight. A
 * caller reading idle as "nothing more is coming" reads it wrongly there, which
 * is what tracking such work as a background task fixes.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("scheduler background work");

// One turn of the event loop. Every step of the quiescence check is a promise
// continuation, so an idle that counts nothing outstanding resolves within the
// microtask drain that precedes this — which is what makes it an ordering
// barrier rather than a delay, and why it is a message rather than a timer (a
// timer armed from a test file freezes under this package's fake clock).
const nextTurn = (): Promise<void> =>
  new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });

describe("scheduler background work", () => {
  it("holds idle() open until tracked work settles", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const order: string[] = [];
      let release!: () => void;
      runtime.scheduler.trackBackgroundTask(
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );

      const idle = runtime.scheduler.idle().then(() => order.push("idle"));
      await nextTurn();
      order.push("released");
      release();
      await idle;

      expect(order).toEqual(["released", "idle"]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("resolves idle() when tracked work fails", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      // A rejection ends the work as surely as a result does, so it releases
      // the barrier rather than propagating. Observing it is also what stops
      // the runtime reporting it as unhandled, which is why the scheduler
      // warns rather than saying nothing.
      runtime.scheduler.trackBackgroundTask(
        Promise.reject(new Error("tracked work failed")),
      );

      await runtime.scheduler.idle();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
