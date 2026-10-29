import { assert, assertEquals, assertThrows } from "@std/assert";

import { applyDefaults, DEFAULT_TEST_TIMEOUT_MS } from "../config.ts";
import { runDenoWebTest } from "./utils.ts";

Deno.test("a stuck test fails by name and the run continues", async function () {
  // A test that waits on something which never arrives used to take the whole
  // run down: astral's own deadline on `page.evaluate` eventually threw a
  // `RetryError` that named no test, printed no summary, and skipped every test
  // file after it. The harness now stops waiting on a test of its own accord,
  // so a stuck test is one named failure among otherwise normal results.
  const run = await runDenoWebTest("timeout-project");

  run.assert(!run.success, "the run fails");
  run.assert(
    /hangs-forever \.\.\. .*FAILED/.test(run.stdoutText),
    "names the test",
  );
  run.assert(
    /Timed out after 1000ms/.test(run.stdoutText),
    "reports how long it waited",
  );
  run.assert(
    /a test at that point and calls it stuck/.test(run.stdoutText),
    "explains that this is a stuck-test detector",
  );

  // The point of failing the test rather than the run: everything else still
  // reports, including the tests queued behind the stuck one.
  run.assert(
    /before-hang \.\.\. .*ok/.test(run.stdoutText),
    "earlier test ran",
  );
  run.assert(
    /after-hang \.\.\. .*ok/.test(run.stdoutText),
    "later test still ran",
  );
  run.assert(/2 passed \| 1 failed/.test(run.stdoutText), "summary is printed");
  run.assert(
    !/RetryError/.test(run.stdoutText),
    "the harness reports before astral's deadline",
  );
});

Deno.test("the default fires before astral's retries run out", function () {
  // The detector is only worth having while it fires before astral does. Astral
  // gives each `page.evaluate` five retried 10-second deadlines and throws a
  // `RetryError` once they run out, measured at 53 to 57 seconds; past that the
  // run dies without naming the test. Raising the default above that would put
  // the diagnostic back out of reach, so the relationship is pinned here rather
  // than left in a comment.

  assert(
    DEFAULT_TEST_TIMEOUT_MS < 50_000,
    `${DEFAULT_TEST_TIMEOUT_MS}ms leaves no room before astral's RetryError`,
  );
});

Deno.test("testTimeout must be a usable number", function () {
  assertEquals(applyDefaults({}).testTimeout, DEFAULT_TEST_TIMEOUT_MS);
  assertEquals(applyDefaults({ testTimeout: 5000 }).testTimeout, 5000);

  // Each of these would otherwise reach `setTimeout` as an immediate fire and
  // fail every test in the suite, or be silently swapped for the default.
  for (const testTimeout of [0, -1, Infinity, NaN]) {
    assertThrows(
      () => applyDefaults({ testTimeout }),
      Error,
      "must be a positive number",
    );
  }
});
