import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import { describe, it } from "@commonfabric/test-support/test";

const ROOT = fromFileUrl(new URL("../../../", import.meta.url));
const FIXTURES = "base/test-support/test/fixtures";

/** Runs a fixture and returns its exit code and what it logged, in order. */
async function run(
  fixture: string,
  env: Record<string, string> = {},
): Promise<{ code: number; logged: string[]; output: string }> {
  const result = await runDenoCommandWithTemporaryLock({
    root: ROOT,
    args: (lock) => [
      "test",
      "--no-check",
      "-A",
      `--lock=${lock}`,
      "--frozen",
      `${FIXTURES}/${fixture}`,
    ],
    env: { NO_COLOR: "1", ...env },
  });
  const output = new TextDecoder().decode(result.stdout);
  return {
    code: result.code,
    output: output + new TextDecoder().decode(result.stderr),
    logged: output.split("\n").filter((line) => line.startsWith("LOG "))
      .map((line) => line.slice("LOG ".length)),
  };
}

describe("fake-clock", () => {
  it("runs each suite under the fake clock, with its controls running", async () => {
    const { code, logged } = await run("fake-clock.fixture.ts", {
      FAKE_CLOCK_MODE: "auto-advance",
    });
    expect(code).toBe(0);
    expect(logged).toEqual([
      "running true",
      "date 1700000000000",
      "zero-delay fired true",
      "before tick false",
      "after tick true",
      "production timer fired by itself true",
      "production interval fired 3",
      "test interval fired 3",
      "cleared timer fired false",
      "cleared immediate ran false",
      "negative tick refused: tick(ms) requires ms >= 0",
      "reset timer fired false",
      "timer armed under the stack hook fired true",
    ]);
  });

  it("leaves the time source real in freeze-all mode", async () => {
    const { code, logged } = await run("fake-clock.fixture.ts", {
      FAKE_CLOCK_MODE: "freeze-all",
    });
    expect(code).toBe(0);
    expect(logged[0]).toBe("running true");
    expect(logged[1]).not.toBe("date 1700000000000");
    expect(logged.slice(2)).toEqual([
      "zero-delay fired true",
      "before tick false",
      "after tick true",
      // A production timer waits for a tick, and intervals stay real.
      "production timer waits true",
      "production timer fired on tick true",
      "test interval fired 0",
      "cleared timer fired false",
      "cleared immediate ran false",
      "negative tick refused: tick(ms) requires ms >= 0",
      "reset timer fired false",
      "timer armed under the stack hook fired true",
    ]);
  });

  it("stops production timers that re-arm forever, naming where they were armed", async () => {
    const { code, output } = await run("fake-clock-runaway.fixture.ts");
    expect(code).not.toBe(0);
    expect(output).toContain("clock auto-advance runaway: 2000 production");
    expect(output).toMatch(
      /most of them armed at .*rearm\.js.*\(2000 of them\)/,
    );
  });

  it("keeps a file that asks for the real clock off the fake one", async () => {
    const { code, logged } = await run("real-clock.fixture.ts");
    expect(code).toBe(0);
    expect(logged).toEqual([
      "running false",
      "date after 2020 true",
      "reset refused: clock is only available inside a test running under " +
      "the fake clock",
    ]);
  });
});
