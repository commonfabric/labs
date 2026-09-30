/**
 * What the worker's outbound side carries, and what it does with a message the
 * encoding refuses.
 *
 * `postToClient()` is the whole of that side. A successful message crosses as
 * one realm encoding; a failure to encode is answered here. What a failure
 * becomes differs by whether anyone is awaiting a reply, and it must not throw
 * either way.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { fabricFromRealmValue } from "@commonfabric/data-model/codecs";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import type { SetPropOp } from "@commonfabric/html/vdom-ops";
import { WorkerReconciler } from "@commonfabric/html/worker";

import { postToClient } from "@/backends/post-to-client.ts";
import {
  NotificationType,
  type VDomBatchNotification,
} from "@/protocol/mod.ts";

/**
 * A value that passes every `FabricValue` check and has no encoding: an object
 * forged onto a `FabricPrimitive`'s prototype. Building one takes deliberate
 * effort, which is why nothing probes for it -- and why what happens when one
 * arrives is worth pinning.
 */
function forged(): unknown {
  return Object.create(FabricBytes.prototype);
}

/**
 * Captures what the worker posts after the clone-and-decode the client's
 * transport performs.
 */
function capturing(): {
  posted: Record<string, unknown>[];
  restore: () => void;
} {
  const posted: Record<string, unknown>[] = [];
  const original = (globalThis as { postMessage?: unknown }).postMessage;
  (globalThis as { postMessage: (m: unknown) => void }).postMessage = (m) => {
    posted.push(
      fabricFromRealmValue(structuredClone(m) as never) as Record<
        string,
        unknown
      >,
    );
  };
  return {
    posted,
    restore: () => {
      (globalThis as { postMessage?: unknown }).postMessage = original;
    },
  };
}

describe("post-to-client", () => {
  describe("a VDOM batch", () => {
    it("carries a FabricBytes prop emitted by the reconciler", () => {
      const content = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const { posted, restore } = capturing();
      let sent = false;

      const reconciler = new WorkerReconciler({
        onOps: (ops) => {
          sent = postToClient({
            type: NotificationType.VDomBatch,
            batchId: 7,
            ops,
          });
          return 7;
        },
      });
      const cancel = reconciler.mount({
        type: "vnode",
        name: "cf-image",
        props: { bytes: new FabricBytes(content) } as never,
        children: [],
      });

      try {
        // Mount queues operations onto a microtask. Flush them at the explicit
        // boundary so the assertion observes exactly one complete batch.
        reconciler.flush();

        expect(sent).toBe(true);
        expect(posted).toHaveLength(1);
        const batch = posted[0] as unknown as VDomBatchNotification;
        const prop = batch.ops.find((op): op is SetPropOp =>
          op.op === "set-prop" && op.key === "bytes"
        );
        expect(prop?.value).toBeInstanceOf(FabricBytes);
        expect((prop?.value as FabricBytes).slice()).toEqual(content);
      } finally {
        cancel();
        restore();
      }
    });
  });

  describe("a message the encoding refuses", () => {
    it("answers a reply as a failure, so the request settles", () => {
      // The client is awaiting this `msgId`. Dropping the message would leave
      // that request pending until disposal, so it is answered rather than
      // reported.
      const { posted, restore } = capturing();

      try {
        // The return says a substitute went. The worker's ledger reads it to
        // tell `responded` from `responded-error`, so a regression that kept
        // substituting while returning `true` would corrupt the accounting
        // with every posted message still looking right.
        expect(
          postToClient({ msgId: 7, data: { value: forged() } } as never),
        ).toBe(false);

        expect(posted).toHaveLength(1);
        expect(posted[0].msgId).toBe(7);
        expect(posted[0].error).toContain("Undeliverable message");
      } finally {
        restore();
      }
    });

    it("reports a notification, carrying a rendering of what was lost", () => {
      // Nobody is awaiting a notification, so there is no reply to make -- but
      // dropping it silently is the outcome worth avoiding, most of all for
      // the console.
      const { posted, restore } = capturing();

      try {
        expect(
          postToClient(
            {
              type: NotificationType.ConsoleMessage,
              method: "log",
              args: [forged()],
            } as never,
          ),
        ).toBe(false);

        expect(posted).toHaveLength(1);
        expect(posted[0].type).toBe(NotificationType.ErrorReport);
        expect(posted[0].message).toContain("Undeliverable message");
        // The rendering names the message, so a reader can tell which one went.
        expect(posted[0].message).toContain("console");
      } finally {
        restore();
      }
    });

    it("says `true` for a message that goes as asked", () => {
      // Without this the two assertions above pass for an implementation that
      // returns `false` unconditionally, which would misclassify every reply.
      const { posted, restore } = capturing();

      try {
        expect(
          postToClient({ msgId: 8, data: { value: 1 } } as never),
        ).toBe(true);

        expect(posted).toHaveLength(1);
        expect(posted[0].msgId).toBe(8);
        expect(posted[0].error).toBeUndefined();
      } finally {
        restore();
      }
    });

    it("does not throw, which is the whole point", () => {
      // On the console path this runs inside a synchronous `EventTarget`
      // listener, where a throw is an uncaught error rather than something a
      // caller can catch -- fatal under Deno.
      const { restore } = capturing();

      try {
        let delivered: boolean | undefined;
        expect(() => {
          delivered = postToClient({ type: "x", args: [forged()] } as never);
        }).not.toThrow();
        expect(delivered).toBe(false);
      } finally {
        restore();
      }
    });
  });
});
