/**
 * Runs projections in separate processes over one store. A fresh process resets
 * the CLI's transform discriminator while its mapped children remain stored.
 */

import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

/** A projected survey row, including its canonical source address. */
interface Row {
  /** Source cell address. */
  $link: string;

  /** Selected title. */
  title: string;

  /** Selected creation timestamp. */
  createdAt: number;

  /** Selected activity timestamp. */
  lastActivityAt: number;

  /** Selected comment count. */
  commentCount: number;
}

/** The values and storage effects observed by one projection process. */
interface ReplayResult {
  /** Rows returned by the selection. */
  value: Row[];

  /** Runtime execution failures. */
  errors: string[];

  /** Rejected projection commits. */
  rejected: { name: string; message: string }[];

  /** Commit requests with no response when the projection settled. */
  unanswered: number;

  /** Mutable shared writes from source setup before the projection. */
  setupMutableSharedWrites: number;

  /** Shared write operations excluding immutable content-addressed documents. */
  mutableSharedWrites: number;
}

const root = fromFileUrl(new URL("../../../", import.meta.url));
const fixture = fromFileUrl(
  new URL("./fixtures/projection-replay-process.ts", import.meta.url),
);

/** Runs one projection with a fresh process-local transform registry. */
async function replay(
  directory: string,
  mode: "seed" | "read" | "change",
): Promise<ReplayResult> {
  const frames = join(directory, `${mode}.jsonl`);
  const output = await runDenoCommandWithTemporaryLock({
    root,
    args: (lock) => [
      "run",
      "--quiet",
      "--frozen",
      `--lock=${lock}`,
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-ffi",
      fixture,
      mode,
      join(directory, "store"),
      frames,
    ],
    env: { CF_MEMORY_FRAME_LOG: frames },
  });
  expect(output.success, new TextDecoder().decode(output.stderr)).toBe(true);
  return JSON.parse(new TextDecoder().decode(output.stdout)) as ReplayResult;
}

describe("CLI projection replay", () => {
  it("reuses stored mapped children without shared writes and reads source updates", async () => {
    // This single-client store pins redundant writes, which cause conflicts
    // with concurrent clients on a shared server. Rejection counts here check
    // storage health; they do not exercise multi-client contention.

    const directory = await Deno.makeTempDir({ prefix: "projection-replay-" });
    try {
      const seed = await replay(directory, "seed");
      expect(seed.value).toEqual(
        Array.from({ length: 8 }, (_, index) => ({
          $link: expect.any(String),
          title: `Row ${index}`,
          createdAt: index,
          lastActivityAt: index,
          commentCount: index,
        })),
      );
      expect(seed.setupMutableSharedWrites).toBeGreaterThan(0);
      expect(seed.mutableSharedWrites).toBe(0);
      expect(seed.rejected).toEqual([]);
      expect(seed.unanswered).toBe(0);
      expect(seed.errors).toEqual([]);

      const cold = await replay(directory, "read");
      expect(cold.value).toEqual(seed.value);
      expect(cold.mutableSharedWrites).toBe(0);
      expect(cold.rejected).toEqual([]);
      expect(cold.unanswered).toBe(0);
      expect(cold.errors).toEqual([]);

      const changed = await replay(directory, "change");
      expect(changed.value).toEqual(
        seed.value.map((row, index) =>
          index === 3 ? { ...row, title: "Updated row", commentCount: 99 } : row
        ),
      );
      expect(changed.setupMutableSharedWrites).toBeGreaterThan(0);
      expect(changed.mutableSharedWrites).toBe(0);
      expect(changed.rejected).toEqual([]);
      expect(changed.unanswered).toBe(0);
      expect(changed.errors).toEqual([]);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });
});
