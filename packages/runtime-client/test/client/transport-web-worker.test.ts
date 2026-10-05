import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { defer } from "@commonfabric/utils/defer";

import {
  ClientTransportNotificationType,
  type ErrorNotification,
  NotificationType,
  TransportNotificationType,
} from "@/protocol/mod.ts";
import { WebWorkerRuntimeTransport } from "@/client/transports/web-worker/transport-web-worker.ts";

// Exercises the transport's handling of forwarded worker console output
// without a real worker: a fake Worker class lets us construct the transport,
// then we drive its private message handler directly.
class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];
  posted: unknown[] = [];
  terminated = false;
  constructor() {
    super();
    FakeWorker.instances.push(this);
  }
  postMessage(message: unknown, transfer?: unknown[]): void {
    this.posted.push(transfer === undefined ? message : [message, transfer]);
  }
  terminate(): void {
    this.terminated = true;
  }
}

function makeTransport(): WebWorkerRuntimeTransport {
  const OriginalWorker = (globalThis as { Worker: unknown }).Worker;
  (globalThis as { Worker: unknown }).Worker = FakeWorker;
  try {
    return new WebWorkerRuntimeTransport({
      workerUrl: new URL("http://localhost/worker.js"),
    });
  } finally {
    (globalThis as { Worker: unknown }).Worker = OriginalWorker;
  }
}

/**
 * Calls `connect()` with the fake worker in place, handing back both the
 * pending connection and the fake the call constructed. Unlike the tests that
 * drive a transport they already hold, one of `connect()` has to reach the
 * worker through the transport it is not given.
 */
function connectWithFakeWorker(): {
  connection: Promise<WebWorkerRuntimeTransport>;
  worker: FakeWorker;
} {
  const OriginalWorker = (globalThis as { Worker: unknown }).Worker;
  (globalThis as { Worker: unknown }).Worker = FakeWorker;
  FakeWorker.instances.length = 0;
  try {
    // `connect()` constructs the transport before its first `await`, so the
    // swap only has to cover the call itself, not the promise it returns.
    const connection = WebWorkerRuntimeTransport.connect({
      workerUrl: new URL("http://localhost/worker.js"),
    });
    return { connection, worker: FakeWorker.instances[0] };
  } finally {
    (globalThis as { Worker: unknown }).Worker = OriginalWorker;
  }
}

/**
 * A `MessageEvent` carrying `data` as the worker would actually post it. The
 * clone is what a real `postMessage()` inserts between the encode and the
 * decode, and it matters here: the decode cedes and freezes what it is given,
 * so without one a test would be watching a tree it still holds a reference to.
 */
function posted(data: unknown): MessageEvent {
  return new MessageEvent("message", {
    data: structuredClone(realmFromFabricValue(data as never)),
  });
}

/** The worker's ready notification, naming a lock nothing holds. */
function readyNotification(): unknown {
  return {
    type: TransportNotificationType.WorkerReady,
    lifetimeLock: crypto.randomUUID(),
  };
}

function handlerOf(
  transport: WebWorkerRuntimeTransport,
): (event: MessageEvent) => void {
  return transport.accessForTestingOnly.handleMessage;
}

describe("WebWorkerRuntimeTransport", () => {
  describe("ready handshake", () => {
    it("settles `ready()` on the worker's ready notification", async () => {
      const transport = makeTransport();
      let settled = false;
      const ready = transport.ready().then(() => {
        settled = true;
      });

      const handle = handlerOf(transport);

      // Anything else leaves it pending, the notification being the one message
      // that says the worker's entry has run.
      handle(posted({ msgId: 1 }));
      handle(
        posted({
          type: TransportNotificationType.WorkerReady,
          lifetimeLock: 1,
        }),
      );
      await Promise.resolve();
      expect(settled).toBe(false);

      handle(
        posted({ type: TransportNotificationType.WorkerReady }),
      );
      await ready;
      expect(settled).toBe(true);

      await transport.dispose();
    });
  });

  describe("connect()", () => {
    // A failed `connect()` never hands the caller a transport, so there is
    // nothing left to call `dispose()` on -- and `dispose()` holds the only
    // `terminate()`. The worker would run for as long as the page did. Both
    // ways readiness can fail are covered below.

    it("terminates the worker when a pre-ready worker error rejects it", async () => {
      const { connection, worker } = connectWithFakeWorker();

      worker.dispatchEvent(
        new ErrorEvent("error", {
          message: "worker failed to load",
          cancelable: true,
        }),
      );

      await expect(connection).rejects.toThrow("worker failed to load");
      expect(worker.terminated).toBe(true);
    });

    it("terminates the worker when a pre-ready decode failure rejects it", async () => {
      const { connection, worker } = connectWithFakeWorker();

      worker.dispatchEvent(
        new MessageEvent("message", { data: { not: "an encoding" } }),
      );

      await expect(connection).rejects.toThrow("Undecodable message");
      expect(worker.terminated).toBe(true);
    });
  });

  describe("a worker error after the worker is ready", () => {
    it("is reported as an error report, with the error's name, message and stack", async () => {
      const { connection, worker } = connectWithFakeWorker();
      worker.dispatchEvent(posted(readyNotification()));
      const transport = await connection;
      const emitted: unknown[] = [];
      transport.on("message", (m) => emitted.push(m));
      const failure = new RangeError("worker ran out of room");

      const event = new ErrorEvent("error", {
        error: failure,
        message: failure.message,
        cancelable: true,
      });
      worker.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(emitted).toEqual([{
        type: NotificationType.ErrorReport,
        message: "RangeError: worker ran out of room",
        stackTrace: failure.stack,
      }]);
      expect(worker.terminated).toBe(false);
    });
  });

  describe("dispose()", () => {
    it("settles only once the worker has released the lock its ready notification names", async () => {
      const { connection, worker } = connectWithFakeWorker();

      // The test holds the lock in the worker's place, and releasing it stands
      // in for the worker's runtime being torn down.
      const lifetimeLock = crypto.randomUUID();
      const held = defer<void>();
      const teardown = defer<void>();
      const holding = navigator.locks.request(lifetimeLock, () => {
        held.resolve();
        return teardown.promise;
      });
      await held.promise;
      worker.dispatchEvent(
        posted({ type: TransportNotificationType.WorkerReady, lifetimeLock }),
      );
      const transport = await connection;

      let disposed = false;
      const disposal = transport.dispose().then(() => {
        disposed = true;
      });

      expect(worker.terminated).toBe(true);
      const { pending } = await navigator.locks.query();
      expect(pending?.map(({ name }) => name)).toContain(lifetimeLock);
      expect(disposed).toBe(false);

      teardown.resolve();
      await holding;
      await disposal;
      expect(disposed).toBe(true);
    });
  });

  describe("what a decode delivers", () => {
    it("emits a message the consumer cannot edit", () => {
      // `BaseRequest` states this as one contract for both directions: a
      // receiver owns what it is given and may cede it, but does not edit it,
      // because every container a decode returns is frozen. Pinned here rather
      // than only stated -- and at the seam a consumer actually reads from.
      const transport = makeTransport();
      const emitted: unknown[] = [];
      transport.on("message", (m) => emitted.push(m));
      const handle = handlerOf(transport);
      handle(posted(readyNotification()));

      handle(posted({ msgId: 3, data: { nested: { a: [1, 2] } } }));

      expect(emitted).toHaveLength(1);
      const message = emitted[0] as { data: { nested: { a: number[] } } };
      expect(Object.isFrozen(message)).toBe(true);
      expect(Object.isFrozen(message.data.nested)).toBe(true);
      expect(Object.isFrozen(message.data.nested.a)).toBe(true);
    });
  });

  describe("an undecodable message", () => {
    it("reports it and leaves the listener standing", () => {
      const transport = makeTransport();
      const emitted: unknown[] = [];
      transport.on("message", (m) => emitted.push(m));
      const handle = handlerOf(transport);

      // Ready first: before that there is no dispatch to keep standing, and a
      // decode failure lands on `ready()` instead (see below).
      handle(posted(readyNotification()));

      // Not an encoding at all, which is what a non-conforming sender or a
      // damaged one would deliver. The worker proves each payload encodable
      // before sending, so this should never happen -- the point is what
      // happens if it does.
      handle(new MessageEvent("message", { data: { not: "an encoding" } }));

      expect(emitted).toHaveLength(1);
      const reported = emitted[0] as ErrorNotification;
      expect(reported.type).toBe(NotificationType.ErrorReport);
      expect(reported.message).toContain("Undecodable message");

      // The transport still works afterwards, which is the whole point of
      // reporting rather than throwing out of the listener.
      handle(posted({ msgId: 7, data: { value: true } }));
      expect(emitted).toHaveLength(2);
    });

    it("rejects `ready()` when it arrives before the worker is ready", async () => {
      // `connect()` awaits `ready()`, so a pre-ready failure reported into an
      // emitter nobody is listening to yet would leave that promise pending
      // for good -- and a caller waiting on a promise that will not settle has
      // no way back. `WebWorkerRuntimeTransport.#handleError()` puts a
      // pre-ready worker error on the promise for the same reason; this is the
      // decode's half of that.
      const transport = makeTransport();
      const emitted: unknown[] = [];
      transport.on("message", (m) => emitted.push(m));

      handlerOf(transport)(
        new MessageEvent("message", { data: { not: "an encoding" } }),
      );

      await expect(transport.ready()).rejects.toThrow("Undecodable message");
      expect(emitted).toHaveLength(0);

      await transport.dispose();
    });

    it("reports a failure that refuses to be stringified", () => {
      const transport = makeTransport();
      const emitted: unknown[] = [];
      transport.on("message", (m) => emitted.push(m));
      handlerOf(transport)(
        posted(readyNotification()),
      );

      // A decode failure can throw a value with no `toString` to reach, and
      // deriving the report's text must not fail in turn.
      const hostile = new Proxy({}, {
        get() {
          throw Object.create(null);
        },
        ownKeys() {
          return ["x"];
        },
        getOwnPropertyDescriptor() {
          return { enumerable: true, configurable: true };
        },
      });
      handlerOf(transport)(new MessageEvent("message", { data: hostile }));

      expect(emitted).toHaveLength(1);
      expect((emitted[0] as ErrorNotification).message)
        .toContain("Undecodable message");
    });
  });

  describe("worker-console re-emit", () => {
    it("re-emits forwarded worker console at the matching level and stops", async () => {
      const transport = makeTransport();
      const emitted: unknown[] = [];
      transport.on("message", (m) => emitted.push(m));

      const calls: Array<[string, string]> = [];
      const realConsole = {
        log: console.log,
        warn: console.warn,
        error: console.error,
      };
      console.log = (m: string) => calls.push(["log", m]);
      console.warn = (m: string) => calls.push(["warn", m]);
      console.error = (m: string) => calls.push(["error", m]);

      try {
        const handle = handlerOf(transport);

        handle(
          posted({
            type: TransportNotificationType.WorkerConsole,
            level: "error",
            text: "kaboom",
          }),
        );
        handle(
          posted({
            type: TransportNotificationType.WorkerConsole,
            level: "warn",
            text: "careful",
          }),
        );

        expect(calls).toEqual([
          ["error", "[worker] kaboom"],
          ["warn", "[worker] careful"],
        ]);
        // Neither was treated as an IPC message.
        expect(emitted).toEqual([]);

        // A level outside the forwarded roster is not this transport's traffic,
        // so it is forwarded on rather than logged. The roster is one constant
        // that the worker's bridge posts from and this transport recognizes by,
        // so nothing the bridge sends can land here.
        const offRoster = {
          type: TransportNotificationType.WorkerConsole,
          level: "fatal",
          text: "not console traffic",
        };
        handle(posted(offRoster));
        expect(calls).toHaveLength(2);
        expect(emitted).toEqual([offRoster]);
      } finally {
        console.log = realConsole.log;
        console.warn = realConsole.warn;
        console.error = realConsole.error;
      }

      // A non-console message still flows through as an emitted IPC message.
      const ipc = { msgId: 7, data: { value: true } };
      handlerOf(transport)(posted(ipc));
      expect(emitted).toContainEqual(ipc);

      await transport.dispose();
    });
  });

  describe("attachClientPort()", () => {
    // A further document reaches the runtime over a port this worker is
    // handed. Only the page holding this transport can hand one over -- it is
    // the page that spawned the worker -- so this is where that happens.

    it("transfers the port alongside the marker saying what it is for", () => {
      const transport = makeTransport();
      const worker = FakeWorker.instances[FakeWorker.instances.length - 1];
      const channel = new MessageChannel();
      try {
        transport.attachClientPort(channel.port2);
        expect(worker.posted).toHaveLength(1);
        const [message, transfer] = worker.posted[0] as [unknown, unknown[]];
        expect(fabricFromRealmValue(message as never)).toEqual({
          type: ClientTransportNotificationType.AttachPort,
        });
        // The port rides the transfer list rather than the message: a port is
        // no `FabricValue` and has no encoding.
        expect(transfer).toEqual([channel.port2]);
      } finally {
        channel.port1.close();
      }
    });
  });
});
