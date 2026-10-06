import {
  FabricUnavailable,
  UNAVAILABLE_PENDING,
} from "@commonfabric/data-model/availability";
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  CODEC,
  NULL_LIVE_ENVIRONMENT,
} from "@commonfabric/data-model/codec-common";
import { FabricError } from "@commonfabric/data-model/fabric-instances";

import { fetchProgram } from "../src/builtins/fetch-program.ts";
import { computeInputHashFromValue } from "../src/builtins/fetch-utils.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";

async function makeAction(cacheState: Record<string, unknown>) {
  const signer = await Identity.fromPassphrase("fetchProgram state-machine");
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const setup = runtime.edit();
  const inputs = runtime.getCell<any>(signer.did(), "inputs", undefined, setup);
  const parent = runtime.getCell(signer.did(), "parent", undefined, setup);
  inputs.set({ url: "https://example.test/main.ts" });
  const cells = Object.fromEntries(
    ["pending", "result", "error", "cache"].map((key) => [
      key,
      runtime.getCell<any>(
        signer.did(),
        { fetchProgram: { [key]: [] } },
        undefined,
        setup,
      ),
    ]),
  ) as Record<"pending" | "result" | "error" | "cache", Cell<any>>;
  cells.cache.setRaw(cacheState);
  await setup.commit().settled;
  const tx = runtime.edit();
  const cancels: Array<() => void> = [];
  const effects: unknown[] = [];
  // These cases examine staging, not dispatch. Keep the real transaction and
  // its runtime-owned-store authority while observing the outbox entries.
  tx.enqueuePostCommitEffect = (effect) => {
    effects.push(effect);
  };
  let sent: Record<string, Cell<unknown>> | undefined;
  const action = fetchProgram(
    inputs,
    (_tx, value) => sent = value,
    (cancel) => cancels.push(cancel),
    [],
    parent,
    runtime,
  );
  const staged = (cell: Cell<any>) => ({
    get value() {
      return cell.withTx(tx).getRaw();
    },
  });
  return {
    action,
    tx,
    runtime,
    inputs,
    pending: staged(cells.pending),
    result: staged(cells.result),
    error: staged(cells.error),
    cache: staged(cells.cache),
    cancels,
    effects,
    sent: () => sent,
    async dispose() {
      cancels.forEach((cancel) => cancel());
      tx.abort();
      await runtime.dispose();
      await storageManager.close();
    },
  };
}

describe("fetchProgram state-machine edge paths", () => {
  it("parks behind a live persisted claim", async () => {
    const startTime = Date.now();
    const inputHash = computeInputHashFromValue({
      url: "https://example.test/main.ts",
    });
    const fixture = await makeAction({
      [inputHash]: {
        inputHash,
        state: { type: "fetching", requestId: "other-owner", startTime },
      },
    });

    try {
      fixture.action(fixture.tx);

      expect(fixture.sent()).toBeDefined();
      expect(fixture.pending.value).toBe(true);
      expect(fixture.result.value).toBe(UNAVAILABLE_PENDING);
      expect(fixture.effects).toHaveLength(0);
    } finally {
      await fixture.dispose();
    }
  });

  it("takes a stale persisted claim over directly", async () => {
    const inputHash = computeInputHashFromValue({
      url: "https://example.test/main.ts",
    });
    const fixture = await makeAction({
      [inputHash]: {
        inputHash,
        state: { type: "fetching", requestId: "stale-owner", startTime: 0 },
      },
    });

    try {
      fixture.action(fixture.tx);

      expect((fixture.cache.value as any)[inputHash].state).toMatchObject({
        type: "fetching",
        requestId: expect.stringMatching(
          new RegExp(`^${fixture.runtime.id}:${inputHash}:[0-9a-f-]+:1$`),
        ),
      });
      expect(fixture.result.value).toBe(UNAVAILABLE_PENDING);
      expect(fixture.effects).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  });

  it("decodes a durable terminal error into the direct result marker", async () => {
    const inputHash = computeInputHashFromValue({
      url: "https://example.test/main.ts",
    });
    const fabricError = new FabricError({
      type: "TypeError",
      name: "TypeError",
      message: "durable failure",
      stack: undefined,
      cause: undefined,
    });
    const fixture = await makeAction({
      [inputHash]: {
        inputHash,
        state: {
          type: "error",
          error: FabricError[CODEC].encode(fabricError, NULL_LIVE_ENVIRONMENT),
        },
      },
    });

    try {
      fixture.action(fixture.tx);

      expect(fixture.pending.value).toBe(false);
      expect((fixture.result.value as FabricUnavailable).reason).toBe("error");
      expect((fixture.result.value as FabricUnavailable).errorMessage).toBe(
        "durable failure",
      );
      expect(fixture.error.value).toBe("durable failure");
    } finally {
      await fixture.dispose();
    }
  });

  it("decodes a persisted message-only terminal cache entry", async () => {
    const inputHash = computeInputHashFromValue({
      url: "https://example.test/main.ts",
    });
    const fixture = await makeAction({
      [inputHash]: {
        inputHash,
        state: { type: "error", message: "persisted failure" },
      },
    });
    try {
      fixture.action(fixture.tx);
      expect(fixture.result.value).toMatchObject({
        reason: "error",
        errorKind: "general",
        errorMessage: "persisted failure",
      });
      expect(fixture.error.value).toBe("persisted failure");
      expect(fixture.effects).toHaveLength(0);
    } finally {
      await fixture.dispose();
    }
  });
});
