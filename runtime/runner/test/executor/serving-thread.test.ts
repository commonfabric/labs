import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  type ServingThread,
  startServingThread,
} from "../../src/executor/serving-thread.ts";

const ECHO = new URL("../fixtures/serving-thread-echo.ts", import.meta.url);
const HOG = new URL("../fixtures/serving-thread-hog.ts", import.meta.url);

describe("startServingThread()", () => {
  let threads: ServingThread[];
  let failures: string[];
  let failed: PromiseWithResolvers<string>;

  /** Starts `module`, recording what fails it. */
  const start = (module: URL, heapLimitMb?: number): ServingThread => {
    const thread = startServingThread(module, {
      ...(heapLimitMb === undefined ? {} : { heapLimitMb }),
      onFailed: (message) => {
        failures.push(message);
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

    expect(message).toContain("memory limit");
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
  });
});
