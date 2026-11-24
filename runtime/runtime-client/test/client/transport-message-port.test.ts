import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";

import {
  type ErrorNotification,
  NotificationType,
  RequestType,
} from "@/protocol/mod.ts";
import { MessagePortRuntimeTransport } from "@/client/transports/message-port/transport-message-port.ts";
import type { MessagePortLike } from "@/shared/message-port-like.ts";

/**
 * Both ends of a real channel: the transport speaks over one, and the test
 * reads and writes the other as the worker would.
 */
function connectedPair() {
  const channel = new MessageChannel();
  const transport = new MessagePortRuntimeTransport({ port: channel.port1 });
  const received: unknown[] = [];
  let arrived: (() => void) | undefined;
  channel.port2.addEventListener("message", (event) => {
    received.push(fabricFromRealmValue(event.data as never));
    arrived?.();
    arrived = undefined;
  });
  channel.port2.start();
  return {
    transport,
    far: channel.port2,
    received,

    /** Settles on the next message the far end reads. */
    next: () => new Promise<void>((resolve) => (arrived = resolve)),
  };
}

describe("MessagePortRuntimeTransport", () => {
  describe("instance members", () => {
    describe("send()", () => {
      it("delivers the encoded envelope to the far end", async () => {
        const { transport, far, received, next } = connectedPair();
        try {
          const delivered = next();
          transport.send({
            msgId: 1,
            data: { type: RequestType.Idle },
          });
          await delivered;
          expect(received).toEqual([{
            msgId: 1,
            data: { type: RequestType.Idle },
          }]);
        } finally {
          await transport.dispose();
          far.close();
        }
      });
    });

    describe("dispose()", () => {
      it("stops emitting messages that arrive after it", async () => {
        const { transport, far } = connectedPair();
        const seen: unknown[] = [];
        transport.on("message", (message) => seen.push(message));
        try {
          await transport.dispose();
          far.postMessage(realmFromFabricValue({ msgId: 1 } as never));
          // The port is closed, so nothing can arrive; a yield gives anything
          // still queued its chance to be wrong.
          await Promise.resolve();
          expect(seen).toEqual([]);
        } finally {
          far.close();
        }
      });
    });

    describe("[Symbol.asyncDispose]()", () => {
      it("disposes the transport at the end of an `await using` block", async () => {
        const channel = new MessageChannel();
        let transport: MessagePortRuntimeTransport;
        {
          await using held = new MessagePortRuntimeTransport({
            port: channel.port1,
          });
          transport = held;
        }
        // The block ended, so the transport is disposed: a message from the
        // far end reaches no listener.
        const seen: unknown[] = [];
        transport.on("message", (message) => seen.push(message));
        channel.port2.postMessage(realmFromFabricValue({ msgId: 1 } as never));
        await Promise.resolve();
        expect(seen).toEqual([]);
        channel.port2.close();
      });
    });

    describe("message handling", () => {
      it("emits a decoded response from the far end", async () => {
        const { transport, far } = connectedPair();
        const seen: unknown[] = [];
        let arrived: (() => void) | undefined;
        transport.on("message", (message) => {
          seen.push(message);
          arrived?.();
        });
        try {
          const emitted = new Promise<void>((resolve) => (arrived = resolve));
          far.postMessage(
            realmFromFabricValue({ msgId: 7, data: { value: true } } as never),
          );
          await emitted;
          expect(seen).toEqual([{ msgId: 7, data: { value: true } }]);
        } finally {
          await transport.dispose();
          far.close();
        }
      });

      it("emits nothing after disposal over a duplex it cannot close", async () => {
        // `close` is optional on a duplex, so a transport cannot rely on the
        // channel going quiet when it lets go. What it can do is stop
        // emitting, which is what a consumer torn down alongside it needs.
        let deliver: ((event: MessageEvent) => void) | undefined;
        const uncloseable: MessagePortLike = {
          postMessage: () => {},
          addEventListener: (_type, listener) => (deliver = listener),
        };
        const transport = new MessagePortRuntimeTransport({
          port: uncloseable,
        });
        const seen: unknown[] = [];
        transport.on("message", (message) => seen.push(message));

        deliver?.(
          new MessageEvent("message", {
            data: realmFromFabricValue({ msgId: 1 } as never),
          }),
        );
        expect(seen).toHaveLength(1);

        await transport.dispose();
        deliver?.(
          new MessageEvent("message", {
            data: realmFromFabricValue({ msgId: 2 } as never),
          }),
        );
        expect(seen).toHaveLength(1);
      });

      it("reports a message that does not decode as an error notification", async () => {
        const { transport, far } = connectedPair();
        const seen: ErrorNotification[] = [];
        let arrived: (() => void) | undefined;
        transport.on("message", (message) => {
          seen.push(message as ErrorNotification);
          arrived?.();
        });
        try {
          const emitted = new Promise<void>((resolve) => (arrived = resolve));
          far.postMessage({ not: "an encoding" });
          await emitted;
          expect(seen).toHaveLength(1);
          expect(seen[0].type).toBe(NotificationType.ErrorReport);
          expect(seen[0].message).toContain("Undecodable message");
        } finally {
          await transport.dispose();
          far.close();
        }
      });
    });
  });
});
