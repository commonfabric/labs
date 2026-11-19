/**
 * The write receipt `cf piece repair` prints on standard error.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type Stub, stub } from "@std/testing/mock";

import type { RepairReport } from "@commonfabric/piece/ops";

import { repairFromCommand, setQuietMode } from "../commands/piece.ts";
import { resetUnreportedRunGuardsForTest } from "../lib/unreported-run.ts";
import { resetWriteReceipts } from "../lib/write-receipt.ts";

const TARGET = {
  apiUrl: "http://127.0.0.1:8000",
  identity: "/nonexistent-but-unread.key",
  space: "did:key:z6MkRepaired",
  cell: "board",
  quiet: true,
};

describe("piece-repair", () => {
  let errors: unknown[][];
  let errorOutput: Stub;

  beforeEach(() => {
    resetUnreportedRunGuardsForTest();
    resetWriteReceipts();
    errors = [];
    errorOutput = stub(console, "error", (...args: unknown[]) => {
      errors.push(args);
    });
  });

  afterEach(() => {
    errorOutput.restore();
    setQuietMode(false);
  });

  /** Runs a repair whose engine reports writing `applied` rows. */
  function repair(applied: number): Promise<void> {
    const report: RepairReport = {
      rows: [],
      plan: {
        header: {
          kind: "piece-plan",
          v: 1,
          space: TARGET.space,
          takenAt: "2026-08-25T00:00:00.000Z",
          selector: "collection",
          enumerated: { collection: 0, registry: 0, registeredOutside: 0 },
        },
        rows: [],
      },
      applied,
      complete: true,
    };
    return repairFromCommand(
      { ...TARGET, fixer: "fix-seeds.ts", path: "topics", json: true },
      {
        runRepair: () => Promise.resolve(report),
        render: () => {},
        printHint: () => {},
        guard: { addUnloadListener: () => {} },
      },
    );
  }

  it("receipts the space once the engine reports a row it wrote", async () => {
    await repair(2);

    expect(errors).toEqual([[`wrote to space ${TARGET.space}`]]);
  });

  it("receipts nothing when the engine wrote no row", async () => {
    await repair(0);

    expect(errors).toEqual([]);
  });
});
