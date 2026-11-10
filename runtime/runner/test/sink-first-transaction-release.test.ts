import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

describe("sink-first-transaction-release", () => {
  it("leaves no transaction reachable from a live sink once its first run has committed", async () => {
    // The scenario runs in a subprocess because proving release needs
    // `WeakRef`s, a forced collection (`--expose-gc`), and a real task
    // boundary, none of which this package's test task provides.

    const output = await runDenoCommandWithTemporaryLock({
      root: fromFileUrl(new URL("../../../", import.meta.url)),
      args: (lock) => [
        "run",
        "-A",
        "--frozen",
        `--lock=${lock}`,
        "--v8-flags=--expose-gc",
        fromFileUrl(
          new URL(
            "./sink-first-transaction-release-helper.ts",
            import.meta.url,
          ),
        ),
      ],
    });
    const stdout = new TextDecoder().decode(output.stdout);
    expect(output.success, new TextDecoder().decode(output.stderr)).toBe(true);
    const report = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(report.sinks).toBe(3);
    expect(report.delivered).toBe(3);
    expect(report.transactions).toBeGreaterThanOrEqual(report.sinks);
    expect(report.reachable).toBe(0);
  });
});
