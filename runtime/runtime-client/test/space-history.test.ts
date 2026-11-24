/**
 * The space history requests, each driven from a real `RuntimeClient` over a
 * `MessageChannel` to a real processor whose runtime writes to an in-process
 * memory server.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { Runtime } from "@commonfabric/runner";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { RuntimeClient } from "@/runtime-client.ts";
import { attachedClient } from "./attached-client.ts";

describe("space-history", () => {
  let runtime: Runtime;
  let client: RuntimeClient;
  let space: MemorySpace;

  /** Commits `value` to the cell the cases read, and waits for the server. */
  const write = async (value: string): Promise<void> => {
    const tx = runtime.edit();
    runtime.getCell<string>(space, "space-history").withTx(tx).set(value);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.storageManager.synced();
  };

  /** Resolves once the runtime's replica holds `value` in the cell. */
  const storedBecomes = (value: string): Promise<void> => {
    const arrived = Promise.withResolvers<void>();
    const cell = runtime.getCell<string>(space, "space-history");
    const cancel = cell.sink((current) => {
      if (current === value) arrived.resolve();
    });
    return arrived.promise.finally(cancel);
  };

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("space history requests");
    space = signer.did() as MemorySpace;
    runtime = new Runtime({
      apiUrl: new URL("http://localhost/"),
      storageManager: EmulatedStorageManager.emulate({ as: signer }),
    });
    client = await attachedClient(runtime, signer, space);
  });

  afterEach(async () => {
    await client.dispose();
    await runtime.dispose();
  });

  describe("spaceHistory()", () => {
    it("returns the space's steps newest first", async () => {
      await write("first");
      await write("second");

      const { steps, next } = await client.spaceHistory({ space });

      expect(steps.length).toBeGreaterThanOrEqual(2);
      expect(steps.map((step) => step.seq)).toEqual(
        steps.map((step) => step.seq).toSorted((a, b) => b - a),
      );
      expect(steps[0]).toMatchObject({ kind: "write", settled: true });
      expect(next).toBeUndefined();
    });

    it("returns only steps that began below `before`", async () => {
      await write("first");
      await write("second");
      const { steps } = await client.spaceHistory({ space });

      const older = await client.spaceHistory({
        space,
        before: steps[0].startSeq,
      });

      expect(older.steps.map((step) => step.seq))
        .toEqual(steps.slice(1).map((step) => step.seq));
    });
  });

  describe("spaceHistory() over more commits than one page of the log", () => {
    // The processor reads the commit log 500 commits at a time, so a space
    // with more than that returns its steps over more than one request.

    const PAGE = 500;
    const REST = 2;

    beforeEach(async () => {
      const cell = runtime.getCell<number>(space, "space-history-pages");
      const commits: Promise<unknown>[] = [];
      for (let n = 0; n < PAGE + REST; n++) {
        const tx = runtime.edit();
        cell.withTx(tx).set(n);
        commits.push(tx.commit().settled);
      }
      await Promise.all(commits);
      await runtime.storageManager.synced();
    });

    it("returns one page of steps and a `next` at the oldest one's first commit", async () => {
      const { steps, next } = await client.spaceHistory({ space });

      expect(steps).toHaveLength(PAGE);
      expect(next).toBe(steps.at(-1)!.startSeq);
    });

    it("returns the remaining steps and no `next` for a request `before` the first page's `next`", async () => {
      const first = await client.spaceHistory({ space });

      const rest = await client.spaceHistory({ space, before: first.next });

      expect(rest.steps).toHaveLength(REST);
      expect(rest.steps[0].seq).toBeLessThan(first.steps.at(-1)!.startSeq);
      expect(rest.steps.map((step) => step.seq)).toEqual(
        rest.steps.map((step) => step.seq).toSorted((a, b) => b - a),
      );
      expect(rest).not.toHaveProperty("next");
    });
  });

  describe("restoreSpace()", () => {
    it("sets the space back to what a step left, as a new step", async () => {
      await write("first");
      const { steps: [first] } = await client.spaceHistory({ space });
      await write("second");

      const seq = await client.restoreSpace({ space, seq: first.seq });

      await storedBecomes("first");
      const { steps: [newest] } = await client.spaceHistory({ space });
      expect(newest).toMatchObject({
        seq,
        kind: "restore",
        restoredSeq: first.seq,
      });
    });

    it("returns `undefined` when the space already holds the state", async () => {
      await write("only");
      const { steps: [newest] } = await client.spaceHistory({ space });

      expect(await client.restoreSpace({ space, seq: newest.seq }))
        .toBeUndefined();
    });
  });

  describe("createSpaceBranch()", () => {
    it("forks a branch at a step, which a restore to that step leaves the space holding", async () => {
      await write("first");
      const { steps: [first] } = await client.spaceHistory({ space });
      await write("second");

      await client.createSpaceBranch({
        space,
        name: "fork",
        forkSeq: first.seq,
      });
      await client.restoreSpace({ space, seq: first.seq });

      await storedBecomes("first");
    });

    it("resolves for a repeat of a branch that is not deleted", async () => {
      await write("only");
      const { steps: [{ seq: forkSeq }] } = await client.spaceHistory({
        space,
      });
      await client.createSpaceBranch({ space, name: "fork", forkSeq });

      await client.createSpaceBranch({ space, name: "fork", forkSeq });
    });

    it("rejects for a fork point past the space's history", async () => {
      await write("only");
      const { steps: [newest] } = await client.spaceHistory({ space });

      await expect(
        client.createSpaceBranch({
          space,
          name: "fork",
          forkSeq: newest.seq + 1000,
        }),
      ).rejects.toThrow("out of range");
    });
  });

  describe("deleteSpaceBranch()", () => {
    it("deletes the branch, whose name a later fork then rejects for", async () => {
      // A repeat of an active branch resolves, as the case above pins, so
      // the rejection is the deletion showing through the client.

      await write("only");
      const { steps: [{ seq: forkSeq }] } = await client.spaceHistory({
        space,
      });
      await client.createSpaceBranch({ space, name: "fork", forkSeq });

      await client.deleteSpaceBranch({ space, name: "fork" });

      await expect(client.createSpaceBranch({ space, name: "fork", forkSeq }))
        .rejects.toThrow("branch name is taken: fork");
    });
  });

  describe("watchSpaceHistory()", () => {
    /** Resolves with the first `spaceseqadvanced` the client emits. */
    const nextAdvance = (): Promise<{ space: string; seq: number }> => {
      const advanced = Promise.withResolvers<{ space: string; seq: number }>();
      const listener = (event: { space: string; seq: number }) => {
        advanced.resolve(event);
      };
      client.on("spaceseqadvanced", listener);
      return advanced.promise.finally(() =>
        client.off("spaceseqadvanced", listener)
      );
    };

    it("emits `spaceseqadvanced` with the seq of a commit to the watched space", async () => {
      await client.watchSpaceHistory(space, true);
      const advanced = nextAdvance();

      await write("first");

      const { steps: [newest] } = await client.spaceHistory({ space });
      expect(await advanced).toEqual({ space, seq: newest.seq });
    });

    it("emits nothing once the watch is stopped", async () => {
      const seen: number[] = [];
      client.on("spaceseqadvanced", ({ seq }) => seen.push(seq));
      await client.watchSpaceHistory(space, true);
      await client.watchSpaceHistory(space, false);

      await write("first");
      // A reply crosses the channel behind any report the commit posted.
      await client.spaceHistory({ space });

      expect(seen).toEqual([]);
    });
  });
});
