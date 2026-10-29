import { assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { toDocumentPath } from "@commonfabric/memory/v2";

import {
  debugTransactionWrites,
  formatTransactionSummary,
  summarizeTransaction,
} from "../src/storage/transaction-summary.ts";
import type {
  IAttestation,
  IExtendedStorageTransaction,
  ITransactionJournal,
  TransactionWriteDetail,
} from "../src/storage/interface.ts";

// Simple test transaction journal
class TestJournal implements ITransactionJournal {
  #noveltyData: IAttestation[];
  #historyData: IAttestation[];
  #activityData: any[];

  constructor(
    noveltyData: IAttestation[] = [],
    historyData: IAttestation[] = [],
    activityData: any[] = [],
  ) {
    this.#noveltyData = noveltyData;
    this.#historyData = historyData;
    this.#activityData = activityData;
  }

  activity(): Iterable<any> {
    return this.#activityData;
  }

  novelty(_space: any): Iterable<IAttestation> {
    return this.#noveltyData;
  }

  history(_space: any): Iterable<IAttestation> {
    return this.#historyData;
  }
}

// Helper to create test attestations
function attestation(id: string, path: string[], value?: any): IAttestation {
  return {
    address: {
      id: id as any, // Cast to URI type
      type: "application/json",
      path,
    },
    value,
  };
}

// Simple test transaction
function createTestTransaction(
  novelty: IAttestation[],
  history: IAttestation[] = [],
  activity: any[] = [],
): IExtendedStorageTransaction {
  const journal = new TestJournal(novelty, history, activity);
  return {
    journal,
    status: () => ({ status: "done" as const, journal }),
  } as any;
}

function createInspectableTransaction(
  writes: TransactionWriteDetail[],
  activity: any[] = [],
): IExtendedStorageTransaction {
  const journal = new TestJournal([], [], activity);
  return {
    journal,
    getWriteDetails: () => writes,
    status: () => ({ status: "done" as const, journal }),
  } as any;
}

function createStatusTransaction(
  status: "done" | "error",
  activity: any[] = [],
): IExtendedStorageTransaction {
  const journal = new TestJournal([], [], activity);
  return {
    journal,
    status: () => ({ status, journal }),
  } as any;
}

describe("transaction-summary", () => {
  it("should extract a single write with no previous value", () => {
    const tx = createTestTransaction([
      attestation("of:abc123", ["value", "count"], 42),
    ]);

    const summary = summarizeTransaction(tx, "did:key:test" as any);

    assertEquals(summary.writes.length, 1);
    assertEquals(summary.writes[0].path, "value.count");
    assertEquals(summary.writes[0].value, 42);
    assertEquals(summary.writes[0].previousValue, undefined);
    assertEquals(summary.writes[0].isDeleted, false);
  });

  it("should extract a write with previous value (before → after)", () => {
    const tx = createTestTransaction(
      [attestation("of:abc123", ["value", "count"], 42)],
      [attestation("of:abc123", ["value", "count"], 10)],
    );

    const summary = summarizeTransaction(tx, "did:key:test" as any);

    assertEquals(summary.writes.length, 1);
    assertEquals(summary.writes[0].value, 42);
    assertEquals(summary.writes[0].previousValue, 10);
  });

  it("should format a single new value without arrow", () => {
    const tx = createTestTransaction([
      attestation("of:abc123", ["value", "count"], 1),
    ]);

    const formatted = formatTransactionSummary(tx, "did:key:test" as any);

    assertEquals(formatted, "value.count = 1");
  });

  it("should format a changed value with arrow", () => {
    const tx = createTestTransaction(
      [attestation("of:abc123", ["value", "count"], 5)],
      [attestation("of:abc123", ["value", "count"], 3)],
    );

    const formatted = formatTransactionSummary(tx, "did:key:test" as any);

    assertEquals(formatted, "value.count: 3 → 5");
  });

  it("should group multiple writes to same object", () => {
    const tx = createTestTransaction(
      [
        attestation("of:abc123", ["value", "count"], 5),
        attestation("of:abc123", ["value", "title"], "Test"),
      ],
      [
        attestation("of:abc123", ["value", "count"], 3),
      ],
    );

    const formatted = formatTransactionSummary(tx, "did:key:test" as any);

    assertEquals(formatted.includes("value.count: 3 → 5"), true);
    assertEquals(formatted.includes('value.title = "Test"'), true);
  });

  it("should show object headers for multiple objects", () => {
    const tx = createTestTransaction([
      attestation("of:abc123", ["value"], 1),
      attestation("of:def456", ["value"], 2),
    ]);

    const formatted = formatTransactionSummary(tx, "did:key:test" as any);

    assertEquals(formatted.includes("Object abc123"), true);
    assertEquals(formatted.includes("Object def456"), true);
  });

  it("keeps the computed: scheme visible in shortened object headers", () => {
    // `of:` drops for brevity, but `computed:` is the ONLY thing
    // distinguishing a computed cell from a state sibling of the same cause
    // (the hash preimage is kind-free), so the header must keep it.
    const tx = createTestTransaction([
      attestation("computed:fid1:AAAABBBBCCCCDDDD", ["value"], 1),
      attestation("of:fid1:EEEEFFFFGGGGHHHH", ["value"], 2),
    ]);

    const formatted = formatTransactionSummary(tx, "did:key:test" as any);

    assertEquals(formatted.includes("Object computed:fid1:AAAABBB..."), true);
    assertEquals(formatted.includes("Object fid1:EEEEFFF..."), true);
  });

  it("should handle deletions", () => {
    const tx = createTestTransaction(
      [attestation("of:abc123", ["value", "old"], undefined)],
      [attestation("of:abc123", ["value", "old"], "previous")],
      [{
        write: {
          space: "did:key:test" as any,
          id: "of:abc123",
          type: "application/json",
          path: ["value", "old"],
        },
      }],
    );

    const summary = summarizeTransaction(tx, "did:key:test" as any);

    assertEquals(summary.writes.length, 1);
    assertEquals(summary.writes[0].isDeleted, true);
    assertEquals(summary.summary, "Deleted value.old");
    assertEquals(
      formatTransactionSummary(tx, "did:key:test" as any),
      "value.old: deleted",
    );
  });

  it("should handle empty transaction", () => {
    const tx = createTestTransaction([]);

    const summary = summarizeTransaction(tx, "did:key:test" as any);
    assertEquals(summary.writes.length, 0);

    const formatted = formatTransactionSummary(tx, "did:key:test" as any);
    assertEquals(formatted, "Empty transaction");
  });

  it("should summarize failed, read-only, and hidden-write transactions", () => {
    assertEquals(
      summarizeTransaction(createStatusTransaction("error")).summary,
      "Transaction failed",
    );

    const readOnly = createStatusTransaction("done", [
      { read: { id: "of:read", type: "application/json", path: [] } },
    ]);
    assertEquals(
      summarizeTransaction(readOnly).summary,
      "Read-only transaction",
    );

    const hiddenWrite = createStatusTransaction("done", [
      { write: { id: "of:write", type: "application/json", path: [] } },
    ]);
    assertEquals(
      formatTransactionSummary(hiddenWrite),
      "(pass space parameter to see what was written)",
    );
  });

  it("should include large read counts in formatted output", () => {
    const activity = Array.from({ length: 11 }, (_, index) => ({
      read: { id: `of:read-${index}`, type: "application/json", path: [] },
    }));
    const tx = createStatusTransaction("done", activity);

    assertEquals(
      formatTransactionSummary(tx),
      "Read-only transaction\n(11 reads for context)",
    );
  });

  it("should summarize direct write details without journal novelty/history", () => {
    const tx = createInspectableTransaction([
      {
        address: {
          space: "did:key:test" as any,
          id: "of:abc123" as any,
          type: "application/json",
          path: toDocumentPath(["value", "count"]),
        },
        value: 42,
        previousValue: 10,
      },
    ]);

    const summary = summarizeTransaction(tx, "did:key:test" as any);

    assertEquals(summary.writes, [{
      objectId: "abc123...",
      fullObjectId: "of:abc123",
      path: "value.count",
      value: 42,
      previousValue: 10,
      isDeleted: false,
    }]);
  });

  it("should summarize direct reactivity activity", () => {
    const tx = {
      journal: new TestJournal(),
      getReactivityLog: () => ({
        reads: [
          { id: "of:read", type: "application/json", path: [] },
        ],
        shallowReads: [
          { id: "of:shallow", type: "application/json", path: [] },
        ],
        writes: [
          { id: "of:write", type: "application/json", path: [] },
        ],
      }),
      getWriteDetails: () => [],
      status: () => ({
        status: "done" as const,
        journal: new TestJournal(),
      }),
    } as any;

    const summary = summarizeTransaction(tx);

    assertEquals(summary.activity, { reads: 2, writes: 1 });
    assertEquals(
      summary.summary,
      "1 write(s) (details unavailable without space parameter)",
    );
  });

  it("should debug direct reactivity write activity", () => {
    const journal = new TestJournal([
      attestation("of:direct123", ["value"], null),
    ]);
    const tx = {
      journal,
      getReactivityLog: () => ({
        reads: [],
        shallowReads: [],
        writes: [
          {
            space: "did:key:test" as any,
            id: "of:direct123",
            type: "application/json",
            path: ["value"],
          },
        ],
      }),
      status: () => ({
        status: "done" as const,
        journal,
      }),
    } as any;

    const debug = debugTransactionWrites(tx);

    assertEquals(debug.includes("Total writes in activity: 1"), true);
    assertEquals(
      debug.includes("Write to: of:direct123/value (space: did:key:test)"),
      true,
    );
  });

  it("should format null write values", () => {
    const tx = createInspectableTransaction([{
      address: {
        space: "did:key:test" as any,
        id: "short-id" as any,
        type: "application/json",
        path: toDocumentPath(["nothing"]),
      },
      value: null,
    }], [{
      write: {
        space: "did:key:test" as any,
        id: "short-id",
        type: "application/json",
        path: ["nothing"],
      },
    }]);

    assertEquals(
      formatTransactionSummary(tx, "did:key:test" as any),
      "nothing = null",
    );
  });

  it("renders a verbose write value bounded in the summary line, and carries it whole in the summary", () => {
    const longText = "x".repeat(120);
    const tx = createInspectableTransaction(
      [
        {
          address: {
            space: "did:key:test" as any,
            id: "a-very-long-object-identifier" as any,
            type: "application/json",
            path: toDocumentPath(["long"]),
          },
          value: longText,
        },
        {
          address: {
            space: "did:key:test" as any,
            id: "of:array123" as any,
            type: "application/json",
            path: toDocumentPath(["items"]),
          },
          value: [1, 2, 3],
        },
        {
          address: {
            space: "did:key:test" as any,
            id: "of:object123" as any,
            type: "application/json",
            path: toDocumentPath(["details"]),
          },
          value: { nested: { count: 1 } },
        },
        {
          address: {
            space: "did:key:test" as any,
            id: "of:boolean123" as any,
            type: "application/json",
            path: toDocumentPath(["done"]),
          },
          value: true,
        },
      ],
      Array.from({ length: 4 }, (_, index) => ({
        write: {
          space: "did:key:test" as any,
          id: `of:write-${index}`,
          type: "application/json",
          path: [],
        },
      })),
    );

    const summary = summarizeTransaction(tx, "did:key:test" as any);
    const formatted = formatTransactionSummary(tx, "did:key:test" as any);

    assertEquals(summary.writes[0].objectId, "a-very-long-object-i...");
    expect(summary.writes[0].value).toBe(longText);
    expect(summary.writes[1].value).toEqual([1, 2, 3]);
    expect(summary.writes[2].value).toEqual({ nested: { count: 1 } });
    expect(formatted).toContain(
      `long = "${"x".repeat(50)}"+...length:120`,
    );
    expect(formatted).toContain("items = [1,2,...length:3]");
    expect(formatted).toContain("details = {nested:{count:1}}");
    expect(formatted).toContain("done = true");
    assertEquals(
      summarizeTransaction(
        createInspectableTransaction([{
          address: {
            space: "did:key:test" as any,
            id: "of:null123" as any,
            type: "application/json",
            path: toDocumentPath(["nothing"]),
          },
          value: null,
        }]),
        "did:key:test" as any,
      ).writes[0].value,
      null,
    );
    expect(summary.summary).toContain("... and 1 more");
    expect(formatted).toContain("Object a-very-long-object-i...");
  });

  it("should debug journal write activity", () => {
    const tx = createTestTransaction(
      [attestation("of:abc123", ["value"], 1)],
      [],
      [
        {
          write: {
            space: "did:key:test" as any,
            id: "of:abc123",
            type: "application/json",
            path: ["value"],
          },
        },
      ],
    );

    const debug = debugTransactionWrites(tx);

    assertEquals(debug.includes("Total writes in activity: 1"), true);
    assertEquals(
      debug.includes("Write to: of:abc123/value (space: did:key:test)"),
      true,
    );
    assertEquals(debug.includes("did:key:test: 1 attestation(s)"), true);
  });
});
