import { assertEquals, assertRejects } from "@std/assert";

import type { LaunchOptions } from "@astral/astral";
import {
  BOOT_FAILURE_MESSAGE,
  type BrowserProcess,
} from "@commonfabric/integration/browser-process";

import { isRetryableAstralLaunchError, launchWithRetry } from "../browser.ts";

Deno.test("isRetryableAstralLaunchError matches transient browser-launch failures", () => {
  assertEquals(
    isRetryableAstralLaunchError(
      new Error("open '/tmp/chrome': Text file busy (os error 26)"),
    ),
    true,
  );
  assertEquals(
    isRetryableAstralLaunchError(new Error(BOOT_FAILURE_MESSAGE)),
    true,
  );
  assertEquals(
    isRetryableAstralLaunchError(
      new Error(`${BOOT_FAILURE_MESSAGE} due to missing system dependencies`),
    ),
    false,
  );
  assertEquals(
    isRetryableAstralLaunchError(new Error("permission denied")),
    false,
  );
});

Deno.test("launchWithRetry retries retryable ETXTBSY launch failures", async () => {
  const launchCalls: LaunchOptions[] = [];
  const sleepCalls: number[] = [];
  const browser = {} as BrowserProcess;
  let attempts = 0;

  const launched = await launchWithRetry(
    { headless: true },
    (options) => {
      launchCalls.push(options);
      attempts += 1;
      if (attempts < 3) {
        return Promise.reject(
          new Error(
            "Could not load test/console.test.ts: Text file busy (os error 26)",
          ),
        );
      }
      return Promise.resolve(browser);
    },
    (ms) => {
      sleepCalls.push(ms);
      return Promise.resolve();
    },
  );

  assertEquals(launched, browser);
  assertEquals(launchCalls.length, 3);
  assertEquals(sleepCalls, [250, 500]);
});

Deno.test("launchWithRetry does not retry non-retryable launch failures", async () => {
  let attempts = 0;

  await assertRejects(
    () =>
      launchWithRetry(
        { headless: true },
        () => {
          attempts += 1;
          return Promise.reject(new Error("permission denied"));
        },
        () => Promise.resolve(),
      ),
    Error,
    "permission denied",
  );

  assertEquals(attempts, 1);
});

Deno.test("launchWithRetry rethrows ETXTBSY after exhausting retries", async () => {
  let attempts = 0;
  const sleepCalls: number[] = [];

  await assertRejects(
    () =>
      launchWithRetry(
        { headless: true },
        () => {
          attempts += 1;
          return Promise.reject(new Error("Text file busy (os error 26)"));
        },
        (ms) => {
          sleepCalls.push(ms);
          return Promise.resolve();
        },
      ),
    Error,
    "Text file busy",
  );

  assertEquals(attempts, 5);
  assertEquals(sleepCalls, [250, 500, 1000, 2000]);
});
