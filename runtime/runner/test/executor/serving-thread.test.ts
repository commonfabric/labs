import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  MIN_SERVING_THREAD_HEAP_LIMIT_MB,
  type ServingThread,
  type ServingThreadFailure,
  startServingThread,
} from "../../src/executor/serving-thread.ts";

const ECHO = new URL("../fixtures/serving-thread-echo.ts", import.meta.url);
const HOG = new URL("../fixtures/serving-thread-hog.ts", import.meta.url);
const GROWS = new URL(
  "../fixtures/serving-thread-that-grows.ts",
  import.meta.url,
);

describe("startServingThread()", () => {
  let threads: ServingThread[];
  let failures: string[];
  let causes: ServingThreadFailure[];
  let failed: PromiseWithResolvers<string>;

  /** Starts `module`, recording what fails it. */
  const start = (module: URL, heapLimitMb?: number): ServingThread => {
    const thread = startServingThread(module, {
      ...(heapLimitMb === undefined ? {} : { heapLimitMb }),
      onFailed: (message, cause) => {
        failures.push(message);
        causes.push(cause);
        failed.resolve(message);
      },
    });
    threads.push(thread);
    return thread;
  };

  /** Resolves with the next message `thread` posts. */
  const nextMessage = (thread: ServingThread): Promise<unknown> =>
    new Promise((resolve) => {
      const listener = (event: MessageEvent) => {
        thread.port.removeEventListener("message", listener);
        resolve(event.data);
      };
      thread.port.addEventListener("message", listener);
    });

  beforeEach(() => {
    threads = [];
    failures = [];
    causes = [];
    failed = Promise.withResolvers();
  });

  afterEach(async () => {
    for (const thread of threads) await thread.terminate(undefined);
  });

  for (const heapLimitMb of [undefined, 256]) {
    const kind = heapLimitMb === undefined
      ? "with no heap limit"
      : "with a heap limit";

    it(`carries messages both ways as message events ${kind}`, async () => {
      const thread = start(ECHO, heapLimitMb);
      expect(await nextMessage(thread)).toBe("listening");

      const answer = nextMessage(thread);
      thread.port.postMessage({ n: 1 });

      expect(await answer).toEqual({ echo: { n: 1 } });
    });

    it(`reports no failure for a thread terminate() ends ${kind}`, async () => {
      const thread = start(ECHO, heapLimitMb);
      expect(await nextMessage(thread)).toBe("listening");

      await thread.terminate(undefined);
      // A message through a second thread, started after the first ended,
      // comes after any failure the first would have reported.
      const after = start(ECHO, heapLimitMb);
      expect(await nextMessage(after)).toBe("listening");

      expect(failures).toEqual([]);
    });
  }

  it("ends a thread that reaches its heap limit alone, and reports it once", async () => {
    const bystander = start(ECHO, 64);
    expect(await nextMessage(bystander)).toBe("listening");

    start(HOG, 64);
    const message = await failed.promise;

    expect(message).not.toBe("");
    expect(causes).toEqual([{ atHeapLimit: true }]);
    const answer = nextMessage(bystander);
    bystander.port.postMessage("still here");
    expect(await answer).toEqual({ echo: "still here" });
    expect(failures).toHaveLength(1);
  });

  it("reports a thread with a heap limit that exits on its own", async () => {
    const thread = start(ECHO, 64);
    expect(await nextMessage(thread)).toBe("listening");

    thread.port.postMessage("exit");

    expect(await failed.promise).toContain("exited with code 3");
    expect(causes).toEqual([{ atHeapLimit: false }]);
  });

  it("throws for a heap limit below the least a thread can be started with, and starts no thread", () => {
    for (
      const heapLimitMb of [0, 1, MIN_SERVING_THREAD_HEAP_LIMIT_MB - 1, 64.5]
    ) {
      expect(() => start(ECHO, heapLimitMb)).toThrow(RangeError);
    }
    expect(failures).toEqual([]);
  });
});

describe("watchHeapLimit()", () => {
  let thread: ServingThread | undefined;
  let failures: string[];

  /** Starts the thread that grows on request, under `heapLimitMb`. */
  const start = (heapLimitMb?: number): ServingThread => {
    thread = startServingThread(GROWS, {
      ...(heapLimitMb === undefined ? {} : { heapLimitMb }),
      onFailed: (message) => failures.push(message),
    });
    return thread;
  };

  /** Resolves with the first message `thread` posts that `matches`. */
  const messageMatching = <Data>(
    thread: ServingThread,
    matches: (data: unknown) => data is Data,
  ): Promise<Data> =>
    new Promise((resolve) => {
      const listener = (event: MessageEvent) => {
        if (!matches(event.data)) return;
        thread.port.removeEventListener("message", listener);
        resolve(event.data);
      };
      thread.port.addEventListener("message", listener);
    });

  /** Resolves once `thread` posts `data` itself. */
  const posted = (thread: ServingThread, data: string): Promise<unknown> =>
    messageMatching(thread, (posted): posted is string => posted === data);

  /** Resolves with the next report `thread` posts of its heap limit. */
  const nextReport = (thread: ServingThread): Promise<boolean> =>
    messageMatching(
      thread,
      (data): data is { heapLimitReached: boolean } =>
        typeof data === "object" && data !== null &&
        "heapLimitReached" in data,
    ).then((report) => report.heapLimitReached);

  /** Resolves once `thread` reports that it reached its heap limit. */
  const reportedReached = async (thread: ServingThread): Promise<void> => {
    while (!await nextReport(thread));
  };

  beforeEach(() => {
    thread = undefined;
    failures = [];
  });

  afterEach(async () => {
    await thread?.terminate(undefined);
  });

  it("says that a thread reached its limit in a message's handler, which the thread reports as no failure", async () => {
    const growing = start(64);
    await posted(growing, "listening");

    growing.port.postMessage("handler");
    await reportedReached(growing);

    expect(failures).toEqual([]);
  });

  it("says so of a limit reached in a promise's continuation, after which the thread still answers", async () => {
    const growing = start(64);
    await posted(growing, "listening");

    growing.port.postMessage("continuation");
    await reportedReached(growing);
    const answer = messageMatching(
      growing,
      (data): data is { echo: string } =>
        typeof data === "object" && data !== null && "echo" in data,
    );
    growing.port.postMessage("still here");

    expect(await answer).toEqual({ echo: "still here" });
    expect(failures).toEqual([]);
  });

  for (const heapLimitMb of [undefined, 64]) {
    const kind = heapLimitMb === undefined
      ? "with no heap limit"
      : "under its limit";

    it(`says that a thread whose heap grew ${kind} has reached none`, async () => {
      const steady = start(heapLimitMb);
      await posted(steady, "listening");

      steady.port.postMessage("hold");
      await posted(steady, "held");

      expect(await nextReport(steady)).toBe(false);
      expect(failures).toEqual([]);
    });
  }
});
