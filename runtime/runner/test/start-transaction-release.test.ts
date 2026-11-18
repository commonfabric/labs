/**
 * What a running piece keeps of the transaction that started it. The start
 * reads and writes through that transaction, and a piece that kept it would
 * keep every document the transaction touched, and whatever else the runtime
 * indexes under it, for as long as it runs.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

describe("start-transaction-release", () => {
  // Collection needs `--expose-gc` and the real clock, which this package's
  // test task does not give, so the helper runs in a process of its own,
  // once for both cases.
  let report: Promise<Record<string, unknown>> | undefined;
  const helperReport = () => {
    report ??= (async () => {
      const helper = new URL(
        "./start-transaction-release-gc-helper.ts",
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
      expect(
        output.success,
        `helper failed:\n${new TextDecoder().decode(output.stderr)}\n${stdout}`,
      ).toBe(true);
      // Loggers may write above the report; the report is the last line.
      const lines = stdout.trim().split("\n");
      return JSON.parse(lines[lines.length - 1]);
    })();
    return report;
  };

  it("lets the transaction that started a piece be collected while the piece runs", async () => {
    const { running, collected } = await helperReport();
    expect({ running, collected }).toEqual({ running: true, collected: true });
  });

  it("lets a cell's transaction be collected while a sibling made without it lives", async () => {
    expect((await helperReport()).siblingCollected).toBe(true);
  });
});
