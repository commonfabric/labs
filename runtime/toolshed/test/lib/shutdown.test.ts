import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { runShutdown } from "@/lib/shutdown.ts";

describe("shutdown", () => {
  /**
   * Runs `steps` within `limitMs`, and returns the status and the errors it
   * logged. `during` runs while the shutdown is under way.
   */
  async function shutDown(
    steps: () => Promise<void>,
    limitMs = 60_000,
    during: () => Promise<void> = () => Promise.resolve(),
  ) {
    const logged: unknown[][] = [];
    using _error = stub(console, "error", (...parts) => logged.push(parts));
    const running = runShutdown(steps, limitMs);
    await during();
    return { status: await running, logged };
  }

  it("returns 0 and logs nothing when every step finishes", async () => {
    const ran: string[] = [];
    expect(
      await shutDown(() => {
        ran.push("closed");
        return Promise.resolve();
      }),
    ).toEqual({ status: 0, logged: [] });
    expect(ran).toEqual(["closed"]);
  });

  it("leaves no timer running once every step finishes", async () => {
    using time = new FakeTime();
    await shutDown(() => Promise.resolve());
    expect(time.next()).toBe(false);
  });

  it("returns 1 and logs the error when a step throws", async () => {
    const failure = new Error("the store would not close");
    expect(await shutDown(() => Promise.reject(failure))).toEqual({
      status: 1,
      logged: [["Error during shutdown:", failure]],
    });
  });

  it("returns 1 and logs the time limit when a step never finishes", async () => {
    using time = new FakeTime();
    expect(
      await shutDown(
        () => new Promise(() => {}),
        10_000,
        () => time.tickAsync(10_000),
      ),
    ).toEqual({
      status: 1,
      logged: [["Error during shutdown:", new Error("Shutdown timed out")]],
    });
  });
});
