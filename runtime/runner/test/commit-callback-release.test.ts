import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";

describe("commit callback release", () => {
  // A settled transaction must not keep the callbacks it already dispatched.
  // Commit callbacks are closures over whatever registered them — a result
  // cell, a child registry, an action's captured frame — and long-lived
  // structures do hold references to settled transactions, so a retained
  // callback set turns one settled transaction into a root for everything its
  // callbacks closed over.
  //
  // The scenario runs in a subprocess because proving release needs WeakRefs, a
  // forced collection (`--expose-gc`), and a real task boundary — this
  // package's preload freezes timers armed from test files, and the test task
  // does not expose gc.

  it("drops dispatched callbacks so a settled transaction roots nothing", async () => {
    const helper = new URL(
      "./commit-callback-release-helper.ts",
      import.meta.url,
    );
    // Spawned by name so the launch matches the task's `--allow-run=deno`
    // grant, which resolves the name through PATH the same way.
    const command = new Deno.Command("deno", {
      args: ["run", "-A", "--v8-flags=--expose-gc", fromFileUrl(helper)],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    expect(output.success, `helper failed:\n${stderr}\n${stdout}`).toBe(true);
    // Loggers may write above the report; the report is the last line.
    const lines = stdout.trim().split("\n");
    const report = JSON.parse(lines[lines.length - 1]) as {
      rounds: number;
      retainedTransactions: number;
      aliveSentinels: number;
    };
    expect(report.rounds).toBeGreaterThan(0);
    expect(report.retainedTransactions).toBe(report.rounds);
    expect(
      report.aliveSentinels,
      "a settled transaction is still holding what its commit callbacks " +
        `closed over: ${JSON.stringify(report)}`,
    ).toBe(0);
  });
});
