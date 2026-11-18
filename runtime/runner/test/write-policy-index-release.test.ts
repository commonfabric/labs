import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

describe("write-policy-index-release", () => {
  // Preparation indexes a transaction's write-policy inputs by document, and a
  // settled transaction releases the inputs it recorded. The index must go
  // with them, or every settled transaction that stays reachable keeps every
  // input it recorded through the index alone.
  //
  // The scenario runs in a subprocess because showing release needs WeakRefs,
  // a forced collection (`--expose-gc`), and a real task boundary — this
  // package's preload freezes timers armed from test files, and the test task
  // does not expose gc.

  it("keeps no write-policy input of a settled transaction reachable through the index", async () => {
    const helper = new URL(
      "./write-policy-index-release-helper.ts",
      import.meta.url,
    );
    // The Deno running this test, under the checked-in lockfile and frozen
    // resolution ("Tests that start Deno" in `docs/development/TESTING.md`).
    const output = await runDenoCommandWithTemporaryLock({
      root: fromFileUrl(new URL("../../../", import.meta.url)),
      args: (lockPath) => [
        "run",
        `--lock=${lockPath}`,
        "--frozen=true",
        "-A",
        "--v8-flags=--expose-gc",
        fromFileUrl(helper),
      ],
    });
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    expect(output.success, `helper failed:\n${stderr}\n${stdout}`).toBe(true);
    // Loggers may write above the report; the report is the last line.
    const lines = stdout.trim().split("\n");
    const report = JSON.parse(lines[lines.length - 1]) as {
      rounds: number;
      retainedTransactions: number;
      aliveInputs: number;
    };
    expect(report.rounds).toBeGreaterThan(0);
    expect(report.retainedTransactions).toBe(report.rounds);
    expect(
      report.aliveInputs,
      "a settled transaction still reaches the write-policy inputs it " +
        `recorded: ${JSON.stringify(report)}`,
    ).toBe(0);
  });
});
