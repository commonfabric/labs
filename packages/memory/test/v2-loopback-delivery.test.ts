// The loopback transport's delivery model. A server frame arrives on its own
// task turn, the way a socket's would: never inside the sender's await
// cascade, and never before the previous frame's microtask cascade has run
// out. The turn is claimed twice over — a zero-delay timer, which is the turn
// a fake-clock harness accounts for, and a `setImmediate`, which is the same
// turn for a fraction of the cost. These tests pin all four properties: the
// two the delivery model is for, and the two that keep it from costing a
// timer wake-up per frame. They also pin `delivered()`, which lets a caller
// wait for the frames queued at its call to be handed over.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { ServerMessage } from "../v2.ts";
import { loopback } from "../v2/client.ts";
import type { Server } from "../v2/server.ts";

// A stand-in for the server. `loopback` calls `connect` once and then only
// `receive` and `close` on what it hands back, so nothing else of Server is
// reachable from here, and emitting a frame is a synchronous call.
const harness = (onFrame?: (index: number) => void) => {
  let emit: (message: ServerMessage) => void = () => {};
  const server = {
    connect(send: (message: ServerMessage) => void) {
      emit = send;
      return { receive: () => Promise.resolve(), close: () => {} };
    },
  } as unknown as Server;

  const transport = loopback(server);
  const received: string[] = [];
  let waiting: { count: number; resolve: () => void } | null = null;
  transport.setReceiver((payload) => {
    received.push(payload);
    onFrame?.(received.length - 1);
    if (waiting !== null && received.length >= waiting.count) {
      const pending = waiting;
      waiting = null;
      pending.resolve();
    }
  });

  return {
    transport,
    received,
    emit(count: number) {
      for (let index = 0; index < count; index++) {
        emit(
          { type: "response", requestId: `frame-${index}` } as ServerMessage,
        );
      }
    },
    // Resolves when `count` frames have been delivered. No deadline: a
    // delivery that never happens quiesces the loop and Deno fails the wait.
    delivered(count: number): Promise<void> {
      if (received.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiting = { count, resolve };
      });
    },
  };
};

describe("client", () => {
  describe("loopback()", () => {
    it("delivers no frame inside the sender's own await cascade", async () => {
      const h = harness();
      h.emit(1);
      // An await cascade of any length is still microtasks, and delivery is a
      // task turn away.
      for (let hop = 0; hop < 50; hop++) await Promise.resolve();
      expect(h.received.length).toBe(0);

      await h.delivered(1);
      expect(h.received.length).toBe(1);
      await h.transport.close();
    });

    it("runs a frame's microtask cascade out before the next frame", async () => {
      const order: string[] = [];
      const cascades: Promise<void>[] = [];
      const h = harness((index) => {
        order.push(`frame:${index}`);
        cascades.push(
          Promise.resolve()
            .then(() => {
              order.push(`then:${index}`);
            })
            .then(() => {
              order.push(`then-then:${index}`);
            }),
        );
      });

      h.emit(3);
      await h.delivered(3);
      await Promise.all(cascades);

      expect(order).toEqual([
        "frame:0",
        "then:0",
        "then-then:0",
        "frame:1",
        "then:1",
        "then-then:1",
        "frame:2",
        "then:2",
        "then-then:2",
      ]);
      await h.transport.close();
    });

    it("keeps a zero-delay timer armed while a frame is queued", async () => {
      // The runner's fake-clock harness settles by counting zero-delay timers
      // that are armed and have not yet run, so an undelivered frame has to be
      // one of them. A pump carried only by `setImmediate` would deliver just
      // as promptly and leave `clock.settle()` with nothing to wait on.
      const armed = new Set<number>();
      const realSetTimeout = globalThis.setTimeout;
      const realClearTimeout = globalThis.clearTimeout;
      globalThis.setTimeout = ((
        handler: () => void,
        delay?: number,
        ...rest: unknown[]
      ) => {
        if (delay !== 0) return realSetTimeout(handler, delay, ...rest);
        let id = 0;
        id = realSetTimeout(
          () => {
            armed.delete(id);
            handler();
          },
          0,
          ...rest,
        ) as unknown as number;
        armed.add(id);
        return id;
      }) as unknown as typeof setTimeout;
      globalThis.clearTimeout = ((id?: number) => {
        if (id !== undefined) armed.delete(id);
        realClearTimeout(id);
      }) as unknown as typeof clearTimeout;

      try {
        const h = harness();
        h.emit(2);
        expect(armed.size).toBeGreaterThanOrEqual(1);

        await h.delivered(1);
        expect(armed.size).toBeGreaterThanOrEqual(1);

        await h.delivered(2);
        expect(armed.size).toBe(0);
        await h.transport.close();
      } finally {
        globalThis.setTimeout = realSetTimeout;
        globalThis.clearTimeout = realClearTimeout;
      }
    });

    it("delivers without waiting for the armed timer to come due", async () => {
      // Waking the event loop for a zero-delay timer costs milliseconds under
      // Deno, and the pump arms them one after another, so a pump that only
      // had the timer would spend a run's whole wall clock waiting for them.
      // With `setTimeout` stubbed to never fire, `setImmediate` is the only
      // turn left, and the frame still has to arrive on it.
      const realSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = (() => 0) as unknown as typeof setTimeout;
      let h: ReturnType<typeof harness>;
      try {
        h = harness();
        h.emit(1);
        await h.delivered(1);
      } finally {
        globalThis.setTimeout = realSetTimeout;
      }
      expect(h.received.length).toBe(1);
      await h.transport.close();
    });

    it("runs the pump on the timer alone where setImmediate is absent", async () => {
      const holder = globalThis as { setImmediate?: unknown };
      const original = holder.setImmediate;
      delete holder.setImmediate;
      let h: ReturnType<typeof harness>;
      try {
        h = harness();
        h.emit(1);
      } finally {
        holder.setImmediate = original;
      }
      await h.delivered(1);
      expect(h.received.length).toBe(1);
      await h.transport.close();
    });

    it("resolves delivered() once every queued frame has reached the receiver", async () => {
      // The serving loop's settle leans on this: a frame the server has sent
      // may sit behind others for several turns, and the settle must not
      // declare quiescence until it has been handed over.
      let settled = false;
      const settledAtFrame: boolean[] = [];
      const h = harness(() => settledAtFrame.push(settled));
      h.emit(3);
      await h.transport.delivered!().then(() => {
        settled = true;
      });

      expect(settledAtFrame).toEqual([false, false, false]);
      expect(h.received.length).toBe(3);
      await h.transport.close();
    });

    it("resolves delivered() without waiting for frames queued after the call", async () => {
      // A server that keeps sending must not hold the wait open. Each of the
      // first frames handed over queues another, so the queue stays non-empty
      // long past the two frames the wait covers.
      const refills = 20;
      const h = harness((index) => {
        if (index < refills) h.emit(1);
      });
      h.emit(2);
      await h.transport.delivered!();

      expect(h.received.length).toBe(2);
      await h.delivered(2 + refills);
      await h.transport.close();
    });

    it("resolves delivered() at once when no frame is queued", async () => {
      const h = harness();
      await h.transport.delivered!();
      expect(h.received.length).toBe(0);
      await h.transport.close();
    });

    it("resolves delivered() when the transport closes with frames queued", async () => {
      const h = harness();
      h.emit(2);
      const delivered = h.transport.delivered!();
      await h.transport.close();
      await delivered;
      expect(h.received.length).toBe(0);
    });

    it("drops frames staged at close", async () => {
      const h = harness();
      h.emit(2);
      await h.transport.close();
      for (let hop = 0; hop < 50; hop++) await Promise.resolve();
      expect(h.received.length).toBe(0);
    });
  });
});
