import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { fabricFromRealmValue } from "@commonfabric/data-model/codecs";
import { Identity } from "@commonfabric/identity";
import { env } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import {
  experimentalOptionsFromEnv,
  withServerExecutionDefault,
} from "@commonfabric/runner";
import {
  type IPCClientMessage,
  RequestType,
} from "@commonfabric/runtime-client";

import "../src/globals.ts";

describe("view-scoped replication environment", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  it("passes deployment flags through the shell into its browser worker", async () => {
    const expected = withServerExecutionDefault(
      experimentalOptionsFromEnv(Deno.env.get),
    );
    const response = await fetch(new URL("/api/meta", env.API_URL));
    expect(response.ok).toBe(true);
    const meta = await response.json();
    for (
      const name of [
        "serverExecution",
        "viewScopedReplication",
        "webViewScopedReplication",
      ] as const
    ) {
      if (expected[name] !== undefined) {
        expect(meta.experimental[name]).toBe(expected[name]);
      }
    }

    const page = shell.page();
    await page.goto(env.FRONTEND_URL);
    await page.evaluate(() => {
      const probe = globalThis as typeof globalThis & {
        __workerInitialization?: unknown;
        __restoreWorkerPost?: () => void;
      };
      const postMessage = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, options) {
        // Inspect only the envelope's request type; decode the captured
        // message with the canonical realm codec in the test process.
        if (Array.isArray(message) && message[1]?.data?.type === "initialize") {
          probe.__workerInitialization = structuredClone(message);
        }
        return postMessage.call(
          this,
          message,
          Array.isArray(options) ? { transfer: options } : options,
        );
      };
      probe.__restoreWorkerPost = () => {
        Worker.prototype.postMessage = postMessage;
        delete probe.__workerInitialization;
        delete probe.__restoreWorkerPost;
      };
    });
    try {
      const identity = await Identity.generate({ implementation: "noble" });
      await shell.login(identity);
      const encoded = await page.evaluate(() =>
        (globalThis as typeof globalThis & {
          __workerInitialization?: unknown;
        }).__workerInitialization
      );
      expect(encoded).toBeDefined();
      const message = fabricFromRealmValue(
        encoded as never,
      ) as IPCClientMessage;
      expect(message.data.type).toBe(RequestType.Initialize);
      if (message.data.type !== RequestType.Initialize) {
        throw new Error("Expected the browser worker's initialization request");
      }
      for (
        const name of [
          "serverExecution",
          "viewScopedReplication",
          "webViewScopedReplication",
        ] as const
      ) {
        expect(message.data.data.experimental?.[name]).toBe(expected[name]);
      }
      // Login waits for the worker's initialized runtime, so the assertion
      // covers an accepted initialization through RootView and RuntimeInternals.
      expect(await page.evaluate(() => !!globalThis.commonfabric?.rt)).toBe(
        true,
      );
    } finally {
      await page.evaluate(() =>
        (globalThis as typeof globalThis & {
          __restoreWorkerPost?: () => void;
        }).__restoreWorkerPost?.()
      );
    }
  });
});
