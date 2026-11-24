import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { listChildSetupBatch } from "../../src/builtins/list-child-setup-batch.ts";
import { RetryImmediately } from "../../src/scheduler/retry-immediately.ts";

describe("list-child-setup-batch", () => {
  it("needs no fresh transaction when no children require loading", () => {
    expect(listChildSetupBatch().retry()).toBeUndefined();
  });

  for (
    const failure of [new Error("Child dependencies failed to load"), undefined]
  ) {
    it(`surfaces a later load failure (${String(failure)}) after a sibling requests a retry`, async () => {
      const batch = listChildSetupBatch();
      const first = Promise.withResolvers<never>();
      const second = Promise.withResolvers<never>();
      batch.add(first.promise);
      batch.add(second.promise);
      const outcome = batch.retry()!.catch((reason: unknown) => ({ reason }));
      const retry = new RetryImmediately("Child dependencies loaded");
      first.reject(retry);
      await expect(first.promise).rejects.toBe(retry);
      second.reject(failure);
      expect(await outcome).toEqual({ reason: failure });
    });
  }
});
