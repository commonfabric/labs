// deno-lint-ignore-file cf-imports/no-inline-module-import -- evaluating the
// worker entry is the thing under test, and it must happen after the test has
// replaced the globals it posts through.

/**
 * The worker's own console under a display ceiling. The worker's console
 * holds whatever its code logged, a pattern's values included, and the
 * console bridge posts it to the host, so under a ceiling the bridge posts
 * none of it. This file initializes the worker entry once, with a ceiling,
 * which is why it is a file of its own.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";

import { isWorkerConsoleNotification, RequestType } from "@/protocol/mod.ts";
import { RuntimeProcessor } from "@/backends/mod.ts";

type Posted = Record<string, unknown>;

describe("the worker console under a display ceiling", () => {
  it("forwards none of the worker's console once the runtime has a ceiling", async () => {
    const posted: Posted[] = [];
    const answered = new Map<number, () => void>();
    const realConsole = {
      log: console.log,
      warn: console.warn,
      error: console.error,
    };
    const originalPostMessage =
      (globalThis as { postMessage?: unknown }).postMessage;
    (globalThis as { postMessage: (m: Posted) => void }).postMessage = (
      m: Posted,
    ) => {
      const message = fabricFromRealmValue(m as never) as Posted;
      posted.push(message);
      if (typeof message.msgId === "number") answered.get(message.msgId)?.();
    };
    /** Sends `data` as request `msgId`, settled once the worker answers. */
    const request = (msgId: number, data: unknown) => {
      const answer = new Promise<void>((resolve) =>
        answered.set(msgId, resolve)
      );
      globalThis.dispatchEvent(
        new MessageEvent("message", {
          data: realmFromFabricValue({ msgId, data } as never),
        }),
      );
      return answer;
    };
    const originalInitialize = RuntimeProcessor.initialize;
    RuntimeProcessor.initialize = (() =>
      Promise.resolve(
        { isDisposed: () => false } as unknown as RuntimeProcessor,
      )) as typeof RuntimeProcessor.initialize;

    try {
      await import("@/backends/web-worker/index.ts");
      await request(1, {
        type: RequestType.Initialize,
        data: {
          renderConfidentialityCeiling: { atoms: [] },
          forwardWorkerConsole: true,
        },
      });
      console.log("value-behind-the-seal");
      await request(2, {
        type: RequestType.SetForwardWorkerConsole,
        enabled: true,
      });
      console.warn("second-value-behind-the-seal");

      expect(posted.filter(isWorkerConsoleNotification)).toEqual([]);
      expect(JSON.stringify(posted)).not.toContain("behind-the-seal");
    } finally {
      RuntimeProcessor.initialize = originalInitialize;
      console.log = realConsole.log;
      console.warn = realConsole.warn;
      console.error = realConsole.error;
      if (originalPostMessage === undefined) {
        delete (globalThis as { postMessage?: unknown }).postMessage;
      } else {
        (globalThis as { postMessage?: unknown }).postMessage =
          originalPostMessage;
      }
    }
  });
});
