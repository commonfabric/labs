/** Initialization over a real iframe wrapper while native confirmations are held. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { createInitializeConfirmationFixture } from "../support/initialize-confirmation-fixture.ts";

describe("initialization confirmation", () => {
  it("returns the real wrapper's confirmed state while an unrelated producer remains pending", async () => {
    const fixture = await createInitializeConfirmationFixture();
    let initializing: Promise<unknown> | undefined;
    try {
      const provider = fixture.storage.open(fixture.identity.did());
      const synced = provider.synced.bind(provider);
      const waiting = Promise.withResolvers<void>();
      using _confirmation = stub(provider, "synced", () => {
        waiting.resolve();
        return synced();
      });
      initializing = fixture.processor.handleCellInitialize(fixture.request);
      expect(
        await Promise.race([
          waiting.promise.then(() => "waiting"),
          initializing.then(() => "returned"),
        ]),
      ).toBe("waiting");
      fixture.releaseA.resolve();
      expect((await fixture.committing)?.error).toBeUndefined();
      expect(await initializing).toEqual({ value: fixture.changed });
      expect(fixture.storage.hasPendingCommits()).toBe(true);
      expect(fixture.target.get()).toEqual(fixture.changed);
    } finally {
      fixture.releaseA.resolve();
      fixture.releaseB.resolve();
      await initializing;
      await fixture.close();
    }
  });

  it("keeps the full barrier before storing a default after optimistic state is withdrawn", async () => {
    const fixture = await createInitializeConfirmationFixture({
      stored: false,
      rejectEdit: true,
    });
    let initializing: Promise<unknown> | undefined;
    try {
      const provider = fixture.storage.open(fixture.identity.did());
      const synced = provider.synced.bind(provider);
      const waiting = Promise.withResolvers<void>();
      using _confirmation = stub(provider, "synced", () => {
        waiting.resolve();
        return synced();
      });
      const settled = fixture.storage.pendingCommitsSettled.bind(
        fixture.storage,
      );
      const fallback = Promise.withResolvers<void>();
      using _fallback = stub(fixture.storage, "pendingCommitsSettled", () => {
        fallback.resolve();
        return settled();
      });
      initializing = fixture.processor.handleCellInitialize(fixture.request);
      await Promise.race([waiting.promise, fallback.promise]);
      fixture.releaseA.resolve();
      await fixture.committing;
      expect(
        await Promise.race([
          fallback.promise.then(() => "fallback"),
          initializing.then(() => "returned"),
        ]),
      ).toBe("fallback");
      expect(fixture.target.getRaw({ lastNode: "writeRedirect" }))
        .toBeUndefined();
      fixture.releaseB.resolve();
      expect(await initializing).toEqual({ value: fixture.initial });
      expect(fixture.target.get()).toEqual(fixture.initial);
    } finally {
      fixture.releaseA.resolve();
      fixture.releaseB.resolve();
      await initializing;
      await fixture.close();
    }
  });

  it("falls back after a confirmation failure without retrying the failed synchronization", async () => {
    const fixture = await createInitializeConfirmationFixture();
    let initializing: Promise<unknown> | undefined;
    try {
      const provider = fixture.storage.open(fixture.identity.did());
      const synced = provider.synced.bind(provider);
      let failed = false;
      using confirmation = stub(provider, "synced", () => {
        if (failed) return synced();
        failed = true;
        return Promise.reject(new Error("confirmation unavailable"));
      });
      const settled = fixture.storage.pendingCommitsSettled.bind(
        fixture.storage,
      );
      const fallback = Promise.withResolvers<void>();
      using _fallback = stub(fixture.storage, "pendingCommitsSettled", () => {
        fallback.resolve();
        return settled();
      });
      initializing = fixture.processor.handleCellInitialize(fixture.request);
      await fallback.promise;
      expect(confirmation.calls.length).toBe(1);
      fixture.releaseA.resolve();
      fixture.releaseB.resolve();
      expect(await initializing).toEqual({ value: fixture.changed });
    } finally {
      fixture.releaseA.resolve();
      fixture.releaseB.resolve();
      await initializing;
      await fixture.close();
    }
  });

  it("falls back while a verdict-only state edit awaits coverage instead of polling its optimistic layer", async () => {
    const fixture = await createInitializeConfirmationFixture({
      holdCoverage: false,
    });
    let initializing: Promise<unknown> | undefined;
    try {
      const provider = fixture.storage.open(fixture.identity.did());
      const synced = provider.synced.bind(provider);
      const waiting = Promise.withResolvers<void>();
      using _confirmation = stub(provider, "synced", () => {
        waiting.resolve();
        return synced();
      });
      const settled = fixture.storage.pendingCommitsSettled.bind(
        fixture.storage,
      );
      const fallback = Promise.withResolvers<void>();
      using _fallback = stub(fixture.storage, "pendingCommitsSettled", () => {
        fallback.resolve();
        return settled();
      });
      initializing = fixture.processor.handleCellInitialize(fixture.request);
      await Promise.race([waiting.promise, fallback.promise]);
      fixture.releaseA.resolve();
      expect(
        await Promise.race([
          fallback.promise.then(() => "fallback"),
          initializing.then(() => "returned"),
        ]),
      ).toBe("fallback");
      expect(fixture.storage.hasPendingCommits()).toBe(true);
      expect(fixture.target.get()).toEqual(fixture.changed);
      fixture.releaseB.resolve();
      expect(await initializing).toEqual({ value: fixture.changed });
    } finally {
      fixture.releaseA.resolve();
      fixture.releaseB.resolve();
      await initializing;
      await fixture.close();
    }
  });
});
