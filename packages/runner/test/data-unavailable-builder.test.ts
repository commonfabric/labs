import {
  UNAVAILABLE_PENDING,
  UNAVAILABLE_SYNCING,
  unavailableError,
  unavailableMismatch,
} from "@commonfabric/data-model/availability";
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { exportCell } from "../src/cell.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase(
  "data-unavailability builder test operator",
);

describe("data-unavailability builder helpers", () => {
  const { commonfabric } = createBuilder();

  it("injects pure concrete-brand guards", () => {
    const pending = UNAVAILABLE_PENDING;
    const error = unavailableError(new Error("failed"));
    const syncing = UNAVAILABLE_SYNCING;
    const mismatch = unavailableMismatch();

    expect(commonfabric.isPending(pending)).toBe(true);
    expect(commonfabric.hasError(error)).toBe(true);
    expect(commonfabric.isSyncing(syncing)).toBe(true);
    expect(commonfabric.hasSchemaMismatch(mismatch)).toBe(true);
    expect(commonfabric.isPending({ reason: "pending", pending: true })).toBe(
      false,
    );
  });

  it("observeAvailability is a zero-node identity", () => {
    const pending = UNAVAILABLE_PENDING;

    expect(commonfabric.observeAvailability(pending)).toBe(pending);
    expect(commonfabric.observeAvailability(pending, "error")).toBe(pending);
  });

  it("resultOf is a zero-node identity", () => {
    const pending = UNAVAILABLE_PENDING;

    expect(commonfabric.resultOf(pending)).toBe(pending);
    expect(commonfabric.resultOf("ready")).toBe("ready");
  });

  it("rejects values without an associated streaming partial result", () => {
    const message =
      "partialResultOf() requires a request returned by a streaming built-in";

    expect(() => commonfabric.partialResultOf("not-a-request" as never))
      .toThrow(message);
    expect(() => commonfabric.partialResultOf({} as never))
      .toThrow(message);
  });

  it("projects direct async results without adding projection nodes", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const frame = pushFrame({ runtime, space: signer.did() });

    try {
      const AsyncResults = commonfabric.pattern(() => {
        const fetched = commonfabric.fetchText({ url: "/text" });
        const availableFetched = commonfabric.resultOf(fetched);
        const generated = commonfabric.generateText({ prompt: "hello" });
        const availableGenerated = commonfabric.resultOf(generated);
        const advanced = commonfabric.generateTextStream({ prompt: "hello" });
        return {
          fetched,
          availableFetched,
          generated,
          availableGenerated,
          partial: commonfabric.partialResultOf(advanced),
        };
      });

      expect(AsyncResults.nodes).toHaveLength(3);
      expect((AsyncResults.result as any).fetched.$alias.path).toEqual([
        "result",
      ]);
      expect((AsyncResults.result as any).generated.$alias.path).toEqual([
        "result",
      ]);
      expect((AsyncResults.result as any).availableFetched.$alias).toEqual(
        (AsyncResults.result as any).fetched.$alias,
      );
      expect((AsyncResults.result as any).availableGenerated.$alias).toEqual(
        (AsyncResults.result as any).generated.$alias,
      );
      expect((AsyncResults.result as any).partial.$alias.path).toEqual([
        "partial",
      ]);
    } finally {
      popFrame(frame);
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("associates final and usable partial results without projection nodes", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const frame = pushFrame({ runtime, space: signer.did() });

    try {
      const StreamingResults = commonfabric.pattern(() => {
        const request = commonfabric.generateTextStream({ prompt: "hello" });
        const final = commonfabric.resultOf(request);
        const partial = commonfabric.partialResultOf(request);
        return { request, final, partial };
      });

      expect(StreamingResults.nodes).toHaveLength(1);
      expect((StreamingResults.result as any).request.$alias.path).toEqual([
        "result",
      ]);
      expect((StreamingResults.result as any).final.$alias).toEqual(
        (StreamingResults.result as any).request.$alias,
      );
      expect((StreamingResults.result as any).partial.$alias.path).toEqual([
        "partial",
      ]);
    } finally {
      popFrame(frame);
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("retains the partial association after pattern naming", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const frame = pushFrame({ runtime, space: signer.did() });

    try {
      const request = commonfabric.generateTextStream({ prompt: "hello" });
      const namedRequest = (
        request as unknown as {
          for(cause: unknown, allowIfSet?: boolean): typeof request;
        }
      ).for("request", true);

      const partial = commonfabric.partialResultOf(namedRequest);
      expect(exportCell(partial).path).toEqual(["partial"]);
    } finally {
      popFrame(frame);
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
