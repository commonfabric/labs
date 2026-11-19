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

describe("space history", () => {
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
    it("forks a branch that a restore can name, and that can be deleted", async () => {
      await write("first");
      const { steps: [first] } = await client.spaceHistory({ space });
      await write("second");

      await client.createSpaceBranch({
        space,
        name: "fork",
        forkSeq: first.seq,
      });
      await client.restoreSpace({ space, branch: "fork" });
      await client.deleteSpaceBranch({ space, name: "fork" });

      await storedBecomes("first");
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
});
