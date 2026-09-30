import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

interface Report {
  transactions: number;
  aliveTransactions: number;
  values: number;
  aliveValues: number;
  heldLoads: number;
  settledTransactions: number;
}

/**
 * Runs `read-release-helper.ts` for `scenario` in a subprocess and returns its
 * report. The helper needs `--expose-gc` and the real clock, which this
 * package's test task does not give it.
 */
async function runHelper(scenario: string): Promise<Report> {
  const helper = new URL("./read-release-helper.ts", import.meta.url);
  // Spawned by name so the launch matches the task's `--allow-run=deno`
  // grant, which resolves the name through PATH the same way.
  const command = new Deno.Command("deno", {
    args: ["run", "-A", "--v8-flags=--expose-gc", helper.pathname, scenario],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  expect(output.success, `helper failed:\n${stderr}\n${stdout}`).toBe(true);
  // Loggers may write above the report; the report is the last line.
  const lines = stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]) as Report;
}

describe("read-release", () => {
  it("releases a reading transaction while the document load its read started is still in flight", async () => {
    // A read starts a load of the document it reads and does not wait for it.
    // The load holds the cell it was handed until it lands, so that cell must
    // not reach the reading transaction: a transaction holds every value its
    // reads returned. The helper reads once directly and once through a handle
    // an earlier read minted, since such a handle is the root of the family of
    // cells derived from it, and holds the transaction that minted it.

    const report = await runHelper("in-flight-load");
    expect(report.heldLoads).toBeGreaterThan(0);
    expect(report.transactions).toBe(1);
    expect(report.values).toBe(2);
    expect(
      report.aliveTransactions,
      `an in-flight load keeps its reader's transaction: ${
        JSON.stringify(report)
      }`,
    ).toBe(0);
    expect(report.aliveValues).toBe(0);
  });

  it("releases what a transaction's reads returned once it aborts or commits, while the transaction stays reachable", async () => {
    const report = await runHelper("settled-transaction");
    expect(report.settledTransactions).toBe(2);
    expect(report.aliveTransactions).toBe(2);
    expect(report.values).toBe(4);
    expect(
      report.aliveValues,
      `a settled transaction keeps what its reads returned: ${
        JSON.stringify(report)
      }`,
    ).toBe(0);
  });
});
