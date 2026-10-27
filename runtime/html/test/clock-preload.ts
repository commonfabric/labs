// Runs before every test module in this package (wired in through `--preload`
// on the package's test task). It installs the shared fake clock in
// "freeze-all" mode: every positive-delay timer freezes, so a wall-clock sleep
// (`setTimeout(resolve, 10)`, in any spelling) never resolves and its waiter
// deadlocks, which Deno's async-op sanitizer reports at once. A zero-delay
// `setTimeout(fn, 0)` still fires through the real event loop, so scheduler
// dispatch, the worker reconciler's flush, and teardown resolve on their own.
// Tests write plain `Deno.test` and `await t.settle()`; nothing is imported.
// `test/clock.d.ts` gives `t.settle` its type. See the shared harness at
// `base/test-support/test/clock-preload.ts` and
// `docs/development/waiting-in-tests.md`.

import { installFakeClock } from "@commonfabric/test-support/clock-preload";

installFakeClock({ mode: "freeze-all" });
