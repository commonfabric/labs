import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ProtocolError } from "@commonfabric/memory/v2";
import { PortEndpoint } from "../../src/executor/serving-port-protocol.ts";
import { LifecycleVerbFailure } from "../../src/executor/lifecycle-verb.ts";

type Requests = { value: { params: null; result: unknown } };
type Endpoint = PortEndpoint<
  Requests,
  Record<string, never>,
  Requests,
  Record<string, never>
>;
type Notices = { tick: number };
type NoticeEndpoint = PortEndpoint<Requests, Notices, Requests, Notices>;

/**
 * Two endpoints over the two ends of one channel, each reporting its faults
 * to its own list, and a raw port on the side of `near` that posts messages
 * as the far side would, without an endpoint's framing.
 */
const connected = () => {
  const channel = new MessageChannel();
  const raw = new MessageChannel();
  const nearFaults: Error[] = [];
  const farFaults: Error[] = [];
  const near: NoticeEndpoint = new PortEndpoint(
    channel.port1,
    (error) => nearFaults.push(error),
  );
  const far: NoticeEndpoint = new PortEndpoint(
    channel.port2,
    (error) => farFaults.push(error),
  );
  const rawNear: NoticeEndpoint = new PortEndpoint(
    raw.port1,
    (error) => nearFaults.push(error),
  );
  return {
    near,
    far,
    nearFaults,
    farFaults,
    rawNear,
    rawFar: raw.port2,
    [Symbol.dispose]: () => {
      near.close();
      far.close();
      rawNear.close();
      for (const port of [channel.port1, channel.port2, raw.port1, raw.port2]) {
        port.close();
      }
    },
  };
};

/** The first message `port` receives. */
const nextMessage = (port: MessagePort): Promise<unknown> => {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  port.addEventListener("message", (event) => resolve(event.data), {
    once: true,
  });
  port.start();
  return promise;
};

describe("serving-port-protocol", () => {
  it("preserves the refusal class for delegated appends and lifecycle causes", async () => {
    const channel = new MessageChannel();
    const client: Endpoint = new PortEndpoint(channel.port1, () => {});
    const server: Endpoint = new PortEndpoint(channel.port2, () => {});
    const refusal = new ProtocolError("append refused");
    const timings = [{ phase: "upload.run", ms: 123 }];
    try {
      for (const timed of [false, true]) {
        server.onRequest("value", () => {
          throw timed ? new LifecycleVerbFailure(refusal, timings) : refusal;
        });
        const failure = await client.request("value", null).then(
          () => {
            throw new Error("expected refusal");
          },
          (error) => error,
        );
        if (timed) {
          expect(failure).toBeInstanceOf(LifecycleVerbFailure);
          expect(failure.cause).toBeInstanceOf(ProtocolError);
          expect(failure.timings).toEqual(timings);
        } else {
          expect(failure).toBeInstanceOf(ProtocolError);
        }
        expect(failure.name).toBe("ProtocolError");
        expect(failure.message).toBe("append refused");
      }
    } finally {
      client.close();
      server.close();
      channel.port1.close();
      channel.port2.close();
    }
  });

  it("rejects the caller when a handler's result cannot be cloned", async () => {
    const channel = new MessageChannel();
    const faults: Error[] = [];
    const client: Endpoint = new PortEndpoint(
      channel.port1,
      (error) => faults.push(error),
    );
    const server: Endpoint = new PortEndpoint(
      channel.port2,
      (error) => faults.push(error),
    );
    server.onRequest("value", () => () => {});
    try {
      await expect(client.request("value", null)).rejects.toThrow(
        "posting a ok message",
      );
      expect(faults).toHaveLength(1);
    } finally {
      client.close();
      server.close();
      channel.port1.close();
      channel.port2.close();
    }
  });

  it("carries completed lifecycle phases with a refusal across the port", async () => {
    const channel = new MessageChannel();
    const client: Endpoint = new PortEndpoint(channel.port1, () => {});
    const server: Endpoint = new PortEndpoint(channel.port2, () => {});
    const refusal = Object.assign(new Error("cannot compile"), {
      name: "ServedLifecycleRefusal",
      code: "compile-failed",
    });
    const timings = [{ phase: "upload.run", ms: 123 }];
    server.onRequest("value", () => {
      throw new LifecycleVerbFailure(refusal, timings);
    });
    try {
      const failure = await client.request("value", null).then(
        () => {
          throw new Error("expected refusal");
        },
        (error) => error,
      );
      expect(failure).toBeInstanceOf(LifecycleVerbFailure);
      expect(failure.name).toBe(refusal.name);
      expect(failure.code).toBe(refusal.code);
      expect(failure.timings).toEqual(timings);
    } finally {
      client.close();
      server.close();
      channel.port1.close();
      channel.port2.close();
    }
  });

  describe("request()", () => {
    it("rejects with the reason the endpoint was closed with, before and after the close", async () => {
      using ends = connected();
      ends.far.onRequest("value", () => new Promise(() => {}));
      const reason = new Error("shut down");
      const waiting = ends.near.request("value", null);
      expect(ends.near.closed).toBe(false);
      ends.near.close(reason);
      expect(ends.near.closed).toBe(true);
      await expect(waiting).rejects.toBe(reason);
      await expect(ends.near.request("value", null)).rejects.toBe(reason);
    });

    it("rejects with the failure to post when the port refuses the request, and reports it as a fault", async () => {
      const refusal = new Error("port refused");
      const port = {
        postMessage: () => {
          throw refusal;
        },
        addEventListener: () => {},
        removeEventListener: () => {},
      };
      const faults: Error[] = [];
      const endpoint: NoticeEndpoint = new PortEndpoint(
        port,
        (error) => faults.push(error),
      );
      const failure = await endpoint.request("value", null).then(
        () => undefined,
        (error: Error) => error,
      );
      expect(failure?.message).toBe(
        "posting a req message on the serving port failed",
      );
      expect(failure?.cause).toBe(refusal);
      expect(faults).toEqual([failure]);
    });

    it("rejects with a fault naming the method when the other side has no handler for it", async () => {
      using ends = connected();
      await expect(ends.near.request("value", null)).rejects.toThrow(
        'no handler for the request "value"',
      );
      ends.far.onRequest("value", () => 7);
      expect(await ends.near.request("value", null)).toBe(7);
      expect(ends.farFaults).toEqual([]);
    });

    it("carries a thrown non-error as an `Error` whose message is its string form", async () => {
      using ends = connected();
      ends.far.onRequest("value", () => {
        throw "plain refusal";
      });
      const failure = await ends.near.request("value", null).then(
        () => undefined,
        (error: Error) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(failure?.name).toBe("Error");
      expect(failure?.message).toBe("plain refusal");
    });

    it("ignores an answer naming no request it is waiting on, and settles the one it names", async () => {
      using ends = connected();
      const waiting = ends.rawNear.request("value", null);
      const { id } = await nextMessage(ends.rawFar) as { id: number };
      ends.rawFar.postMessage({ t: "ok", id: id + 1, result: "stray" });
      ends.rawFar.postMessage({ t: "ok", id, result: "answer" });
      expect(await waiting).toBe("answer");
      expect(ends.rawNear.messagesReceived).toBe(2);
      expect(ends.nearFaults).toEqual([]);
    });
  });

  describe("notify()", () => {
    it("delivers a notice to its handler", async () => {
      using ends = connected();
      const ticks: number[] = [];
      ends.far.onNotice("tick", (tick) => ticks.push(tick));
      ends.far.onRequest("value", () => [...ticks]);
      ends.near.notify("tick", 1);
      expect(await ends.near.request("value", null)).toEqual([1]);
    });

    it("posts nothing once the endpoint is closed", () => {
      const posted: unknown[] = [];
      const endpoint: NoticeEndpoint = new PortEndpoint({
        postMessage: (message) => posted.push(message),
        addEventListener: () => {},
        removeEventListener: () => {},
      }, () => {});
      endpoint.notify("tick", 1);
      endpoint.close();
      endpoint.notify("tick", 2);
      expect(posted).toEqual([{ t: "note", method: "tick", params: 1 }]);
    });

    it("reports a notice with no handler, and one whose handler throws, as faults, and keeps reading", async () => {
      using ends = connected();
      const broken = new Error("handler broke");
      ends.near.notify("tick", 1);
      ends.far.onRequest("value", () => "after");
      expect(await ends.near.request("value", null)).toBe("after");
      ends.far.onNotice("tick", () => {
        throw broken;
      });
      ends.near.notify("tick", 2);
      expect(await ends.near.request("value", null)).toBe("after");
      expect(ends.farFaults.map((fault) => fault.message)).toEqual([
        'no handler for the notice "tick"',
        'the handler for the notice "tick" threw',
      ]);
      expect(ends.farFaults[1].cause).toBe(broken);
      expect(ends.nearFaults).toEqual([]);
    });
  });

  describe("close()", () => {
    it("keeps the reason it was first closed with", async () => {
      using ends = connected();
      const first = new Error("first");
      ends.near.close(first);
      ends.near.close(new Error("second"));
      await expect(ends.near.request("value", null)).rejects.toBe(first);
    });
  });
});
