// Runs before every test module in this package (wired in through `--preload`
// on the package's test task). It installs the shared fake clock in
// "auto-advance" mode: the runtime's own positive-delay timers (armed from
// `src/` — throttle windows, backoff, conflict retries) advance logical time on
// their own so `runtime.idle()`, `cell.pull()`, and commit resolve without real
// sleeping, while a wall-clock sleep armed from a `test/` file freezes and its
// waiter deadlocks. A test reaches the controls through `clock` from
// `@commonfabric/test-support/fake-clock`, and a test file that needs the real
// clock calls `useRealClock()` from there. See the shared harness at
// `base/test-support/src/fake-clock.ts` and
// `docs/development/waiting-in-tests.md`.

import { installFakeClock } from "@commonfabric/test-support/fake-clock";
import { installSilentBackstopGuard } from "./support/silent-backstop-guard.ts";

installFakeClock({ mode: "auto-advance" });

// Installed after the clock, so its check runs inside the clock's wrapper. A
// backstop listed here fires only when the event a wait is gated on never
// arrives, and under auto-advance that firing is a logical jump a test would
// otherwise ride in silence: the module logger sits above the warn, so the
// count is its only trace. See the guard's header and
// `docs/development/waiting-in-tests.md`.
installSilentBackstopGuard([
  {
    logger: "storage.v2",
    key: "conflict-read-repair-timeout",
    meaning: "the conflict read-repair wait in src/storage/v2.ts gave up on " +
      "the caught-up sync after CONFLICT_READ_REPAIR_TIMEOUT_MS and returned " +
      "the rejection with the replica not caught up. Under auto-advance that " +
      "is a 30 s logical jump the test rode instead of the frame: either the " +
      "fixture withholds the frame (a manual fan-out it never flushed) or the " +
      "caught-up path regressed.",
  },
]);
