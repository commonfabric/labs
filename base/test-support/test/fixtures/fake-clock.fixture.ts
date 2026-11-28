// Run by `../fake-clock.test.ts` as a test file of its own, under the clock
// in the mode `FAKE_CLOCK_MODE` names.

import { join, toFileUrl } from "@std/path";
import {
  clock,
  type FakeClockMode,
  installFakeClock,
  runningClock,
} from "../../src/fake-clock.ts";
import { afterAll, describe, it } from "../../src/testing.ts";

const log = (what: string) => console.log(`LOG ${what}`);

const mode = Deno.env.get("FAKE_CLOCK_MODE") as FakeClockMode;
// A low turn limit lets the case that re-arms forever reach it quickly.
installFakeClock({ mode, turnLimit: 100 });

// The clock counts a timer as production code's where the code arming it lies
// outside every test directory, so these arm theirs from a module written to a
// temporary directory.
const helperDir = await Deno.makeTempDir({ prefix: "fake-clock-helper-" });
await Deno.writeTextFile(
  join(helperDir, "arm.js"),
  "export const arm = (ms, callback) => setTimeout(callback, ms);\n" +
    "export const armEvery = (ms, callback) => setInterval(callback, ms);\n",
);
const helper: {
  arm(ms: number, callback: () => void): number;
  armEvery(ms: number, callback: () => void): number;
} = await import(toFileUrl(join(helperDir, "arm.js")).href);

describe("clock", () => {
  it("reads the time", () => {
    log(`running ${runningClock() !== undefined}`);
    log(`date ${Date.now()}`);
  });

  it("fires a zero-delay timer on settle", async () => {
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 0);
    await clock.settle();
    log(`zero-delay fired ${fired}`);
  });

  it("fires a test timer on tick", async () => {
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 1_000);
    await clock.settle();
    log(`before tick ${fired}`);
    await clock.tick(1_000);
    log(`after tick ${fired}`);
  });
});

describe("timers", () => {
  afterAll(() => Deno.removeSync(helperDir, { recursive: true }));

  it("fires a production timer by itself only in auto-advance mode", async () => {
    // A test's own timer, pending meanwhile, is not the clock's to fire.
    const pending = setTimeout(() => {}, 1_000);
    let fired = false;
    const done = new Promise<void>((resolve) =>
      helper.arm(5_000, () => {
        fired = true;
        resolve();
      })
    );
    await clock.settle();
    if (mode === "auto-advance") {
      await done;
      log(`production timer fired by itself ${fired}`);
    } else {
      log(`production timer waits ${!fired}`);
      await clock.tick(5_000);
      log(`production timer fired on tick ${fired}`);
    }
    clearTimeout(pending);
  });

  it("repeats a production interval by itself in auto-advance mode", async () => {
    // Freeze-all mode leaves intervals real, which would take real seconds.
    if (mode !== "auto-advance") return;
    let count = 0;
    await new Promise<void>((resolve) => {
      const id = helper.armEvery(1_000, () => {
        if (++count < 3) return;
        clearInterval(id);
        resolve();
      });
    });
    log(`production interval fired ${count}`);
  });

  it("repeats a test interval on tick where the mode fakes intervals", async () => {
    let count = 0;
    const id = setInterval(() => count++, 1_000);
    await clock.tick(3_000);
    clearInterval(id);
    log(`test interval fired ${count}`);
  });

  it("drops a zero-delay timer another clears in the same turn", async () => {
    let second = false;
    const pending = setTimeout(() => {}, 1_000);
    setTimeout(() => clearTimeout(secondId), 0);
    const secondId = setTimeout(() => {
      second = true;
    }, 0);
    await clock.settle();
    clearTimeout(pending);
    log(`cleared timer fired ${second}`);
  });

  it("drops an immediate cleared before its turn", async () => {
    let ran = false;
    const id = setImmediate(() => {
      ran = true;
    });
    clearImmediate(id);
    await clock.settle();
    log(`cleared immediate ran ${ran}`);
  });

  it("refuses to tick backwards", async () => {
    try {
      await clock.tick(-1);
    } catch (error) {
      log(`negative tick refused: ${(error as Error).message}`);
    }
  });

  it("forgets every pending timer on reset", async () => {
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 1_000);
    await clock.tick(500);
    clock.reset();
    await clock.tick(1_000);
    log(`reset timer fired ${fired}`);
  });

  it("refuses to settle zero-delay work that re-arms itself forever", async () => {
    // The first turn queues the pump too, and the livelock is still settle's
    // own to report.
    let stopped = false;
    const rearm = () => {
      if (!stopped) setTimeout(rearm, 0);
    };
    rearm();
    try {
      await clock.settle();
      log("settle converged");
    } catch (error) {
      log(`settle refused: ${(error as Error).message}`);
    } finally {
      stopped = true;
    }
    await clock.settle();
  });

  it("lets a zero-delay chain shorter than the turn limit finish", async () => {
    let turns = 0;
    await new Promise<void>((resolve) => {
      const turn = () => {
        if (++turns < 50) setTimeout(turn, 0);
        else resolve();
      };
      turn();
    });
    log(`zero-delay chain ran ${turns} turns`);
  });

  it("counts a timer whose stack names no caller as production's", async () => {
    // A stack hook that yields no frames leaves the arming site unknown.
    Reflect.set(globalThis, "getStackString", () => "");
    let fired = false;
    try {
      const done = new Promise<void>((resolve) =>
        setTimeout(() => {
          fired = true;
          resolve();
        }, 1_000)
      );
      await clock.settle();
      if (mode === "auto-advance") {
        await done;
        log(`timer with no caller fired by itself ${fired}`);
      } else {
        log(`timer with no caller waits ${!fired}`);
        await clock.tick(1_000);
        log(`timer with no caller fired on tick ${fired}`);
      }
    } finally {
      Reflect.deleteProperty(globalThis, "getStackString");
    }
  });

  it("reads the stack through the hook a lockdown installs", async () => {
    Reflect.set(globalThis, "getStackString", (error: Error) => error.stack);
    try {
      let fired = false;
      setTimeout(() => {
        fired = true;
      }, 1_000);
      await clock.tick(1_000);
      log(`timer armed under the stack hook fired ${fired}`);
    } finally {
      Reflect.deleteProperty(globalThis, "getStackString");
    }
  });
});
