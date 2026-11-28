import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import {
  noteWroteTo,
  resetWriteReceipts,
  transactionWroteTo,
} from "../lib/write-receipt.ts";

const SPACE = "did:key:z6MkjcdxtxTiUWkPkPffhs8ENkCcJjuRCQPpJFb2xyzwHqEk";
const OTHER = "did:key:z6MkqyUta9P4wHtvDmwebQtXBjyJ3bSzmY2wFEkPL9ZAdp4W";

const signer = await Identity.fromPassphrase("write-receipt");

// Collects what a receipt writes, and restores the console afterwards.
function captureStderr(body: () => void): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    body();
  } finally {
    console.error = original;
  }
  return lines;
}

describe("write-receipt", () => {
  it("names the space that was written to", () => {
    resetWriteReceipts();
    const lines = captureStderr(() => noteWroteTo(SPACE));
    expect(lines).toEqual([`wrote to space ${SPACE}`]);
  });

  it("names a space once however many writes reach it", () => {
    // A command whose work runs through several write functions reports the
    // space it acted on, not one line per function it happened to call.
    resetWriteReceipts();
    const lines = captureStderr(() => {
      noteWroteTo(SPACE);
      noteWroteTo(SPACE);
      noteWroteTo(SPACE);
    });
    expect(lines).toHaveLength(1);
  });

  it("names each space a run wrote to", () => {
    resetWriteReceipts();
    const lines = captureStderr(() => {
      noteWroteTo(SPACE);
      noteWroteTo(OTHER);
    });
    expect(lines).toEqual([
      `wrote to space ${SPACE}`,
      `wrote to space ${OTHER}`,
    ]);
  });

  it("writes to stderr, which is what keeps stdout parseable", () => {
    // `get` and `call` reserve stdout for machine-readable output, so a
    // receipt on stdout would corrupt the thing a caller parses. Capturing
    // only `console.error` and seeing the line proves which stream it took.
    resetWriteReceipts();
    const lines = captureStderr(() => noteWroteTo(SPACE));
    expect(lines).toHaveLength(1);
  });

  describe("transactionWroteTo()", () => {
    const space = signer.did();
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
    });

    afterEach(async () => {
      await runtime.dispose();
      await storageManager.close();
    });

    it("returns `true` for the space a transaction wrote, and `false` for another", () => {
      const tx = runtime.edit();
      runtime.getCell(space, "written", undefined, tx).set({ n: 1 });

      expect(transactionWroteTo(tx, space)).toBe(true);
      expect(transactionWroteTo(tx, OTHER)).toBe(false);
      tx.abort();
    });

    it("returns `false` for a transaction that wrote nothing", () => {
      const tx = runtime.edit();

      expect(transactionWroteTo(tx, space)).toBe(false);
      tx.abort();
    });

    it("returns `false` for an aborted transaction that had written", () => {
      const tx = runtime.edit();
      runtime.getCell(space, "aborted", undefined, tx).set({ n: 1 });
      tx.abort();

      expect(tx.status().status).toBe("error");
      expect(transactionWroteTo(tx, space)).toBe(false);
    });
  });
});
