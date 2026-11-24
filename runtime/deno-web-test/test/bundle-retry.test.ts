import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  BUNDLE_RETRYABLE_ESBUILD_COPY,
  BUNDLE_RETRYABLE_ETXTBSY,
  isRetryableBundleFailure,
  runBundleWithRetry,
  sleepForRetry,
} from "../utils.ts";

const encoder = new TextEncoder();

// Replaces the global setTimeout with one that fires the callback
// synchronously and records each requested delay, for the duration of `fn`.
// This keeps the backoff-driven tests instant while letting them assert the
// delays that were requested.
async function withInstantTimers(
  fn: (delays: number[]) => Promise<void>,
): Promise<void> {
  const delays: number[] = [];
  const original = globalThis.setTimeout;
  globalThis.setTimeout =
    ((cb: (...args: unknown[]) => void, delay?: number) => {
      delays.push(delay ?? 0);
      cb();
      return 0;
    }) as typeof setTimeout;
  try {
    await fn(delays);
  } finally {
    globalThis.setTimeout = original;
  }
}

Deno.test("isRetryableBundleFailure detects the ETXTBSY race marker", () => {
  assert(
    isRetryableBundleFailure(
      `error: ${BUNDLE_RETRYABLE_ETXTBSY} while spawning esbuild`,
    ),
  );
});

Deno.test("isRetryableBundleFailure detects the esbuild copy marker", () => {
  assert(
    isRetryableBundleFailure(
      `deno: ${BUNDLE_RETRYABLE_ESBUILD_COPY} to the cache dir`,
    ),
  );
});

Deno.test("isRetryableBundleFailure rejects unrelated bundle errors", () => {
  assertEquals(
    isRetryableBundleFailure("error: Module not found 'jsr:@foo/bar'"),
    false,
  );
});

Deno.test("sleepForRetry resolves and backs off exponentially", async () => {
  await withInstantTimers(async (delays) => {
    await sleepForRetry(1);
    await sleepForRetry(2);
    await sleepForRetry(3);
    assertEquals(delays, [250, 500, 1000]);
  });
});

Deno.test(
  "runBundleWithRetry retries a retryable failure then succeeds",
  async () => {
    await withInstantTimers(async (delays) => {
      const outcomes = [
        { success: false, stderr: encoder.encode(BUNDLE_RETRYABLE_ETXTBSY) },
        { success: true, stderr: new Uint8Array() },
      ];
      let calls = 0;
      let succeeded = 0;
      await runBundleWithRetry(
        () => {
          calls++;
          return Promise.resolve(outcomes.shift()!);
        },
        () => {
          succeeded++;
          return Promise.resolve();
        },
        "fixture.test.ts",
      );
      assertEquals(calls, 2);
      assertEquals(succeeded, 1);
      assertEquals(delays, [250]);
    });
  },
);

Deno.test(
  "runBundleWithRetry throws immediately on a non-retryable failure",
  async () => {
    await withInstantTimers(async (delays) => {
      let calls = 0;
      await assertRejects(
        () =>
          runBundleWithRetry(
            () => {
              calls++;
              return Promise.resolve({
                success: false,
                stderr: encoder.encode("error: Module not found"),
              });
            },
            () => Promise.resolve(),
            "fixture.test.ts",
          ),
        Error,
        "Failed to bundle fixture.test.ts",
      );
      assertEquals(calls, 1);
      assertEquals(delays, []);
    });
  },
);

Deno.test(
  "runBundleWithRetry gives up after the retry budget is exhausted",
  async () => {
    await withInstantTimers(async (delays) => {
      let calls = 0;
      await assertRejects(
        () =>
          runBundleWithRetry(
            () => {
              calls++;
              return Promise.resolve({
                success: false,
                stderr: encoder.encode(BUNDLE_RETRYABLE_ETXTBSY),
              });
            },
            () => Promise.resolve(),
            "fixture.test.ts",
          ),
        Error,
        "Failed to bundle",
      );
      assertEquals(calls, 5);
      assertEquals(delays, [250, 500, 1000, 2000]);
    });
  },
);
