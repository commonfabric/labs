import {
  isUnavailable,
  UNAVAILABLE_PENDING,
} from "@commonfabric/data-model/availability";

/// <reference path="./clock.d.ts" />
// The fetch builtins coordinate across replicas through durable state: a claim
// in `internal` for fetch.ts, a `fetching` cache entry for fetch-program.ts. A
// staleness bound decides when a claim left by another replica is treated as
// abandoned, because nothing reports whether that replica is still there.
//
// Two of these cases pin what keeps an early takeover survivable. Both are
// about the request that is *not* the stale one: it must still reach its
// result.
//
//   - a resolution running in this replica is never judged by the clock, so a
//     slow one is neither restarted underneath itself nor left with nowhere to
//     write when it finishes;
//   - a failing request never erases a result another request already recorded
//     for the same inputs.
//
// The rest cover the claim's other transitions: handing it back when the
// pattern stops, the staleness branch that decides a takeover, a resolution
// that fails, and an empty URL.
//
// docs/features/fetch-request-deadlines.md carries the reasoning.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { setPatternEnvironment } from "../src/env.ts";
import { resolveLink } from "../src/link-resolution.ts";
import {
  computeInputHashFromValue,
  internalSchema,
  MUTEX_STALE_AFTER,
  tryClaimMutex,
} from "../src/builtins/fetch-utils.ts";
import type { Schema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("test fetch claim takeover");
const space = signer.did();

function moduleResponse(): Response {
  return new Response("export const value = 1;\n", {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function rawResultChild(
  runtime: Runtime,
  container: any,
): Promise<unknown> {
  await runtime.storageManager.synced();
  const child = runtime.getCellFromLink(
    resolveLink(
      runtime,
      runtime.readTx(),
      container.key("result").getAsNormalizedFullLink(),
    ),
  );
  await child.sync();
  return child.getRaw();
}

describe("fetch builtins: taking over a claim", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let byRef: ReturnType<typeof createBuilder>["commonfabric"]["byRef"];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    pattern = commonfabric.pattern;
    byRef = commonfabric.byRef;

    setPatternEnvironment({
      apiUrl: new URL("http://mock-test-server.local"),
    });

    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("releases the entry it claimed when the pattern is stopped", async () => {
    const slowUrl = "http://mock-test-server.local/stopped-program.ts";

    const heldRequests: Deferred<Response>[] = [];
    const firstRequest = deferred<void>();
    globalThis.fetch = () => {
      const held = deferred<Response>();
      heldRequests.push(held);
      firstRequest.resolve();
      return held.promise;
    };

    const fetchProgram = byRef("fetchProgram");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchProgram({ url }),
    );

    const resultCell = runtime.getCell(
      space,
      "program-stop-result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, testPattern, { url: slowUrl }, resultCell);
    tx.commit();

    await result.pull();
    await firstRequest.promise;
    await clock.settle();
    expect(heldRequests.length).toBe(1);

    // Stopping the pattern hands the claim back, so the entry is available
    // again rather than left standing by a replica that has gone.
    runtime.runner.stop(resultCell);
    await clock.settle();

    // Running again is how that shows: a released entry is claimable, so a
    // second resolution starts. A claim still standing would be left alone.
    const restartTx = runtime.edit();
    const restarted = runtime.run(
      restartTx,
      testPattern,
      { url: slowUrl },
      resultCell,
    );
    restartTx.commit();
    await restarted.pull();
    await clock.settle();

    expect(heldRequests.length).toBe(2);

    for (const held of heldRequests) held.resolve(moduleResponse());
    await runtime.settled();
  });

  it("surfaces a program that fails to resolve as an error", async () => {
    const missingUrl = "http://mock-test-server.local/missing-program.ts";

    globalThis.fetch = () =>
      Promise.resolve(
        new Response("not found", { status: 404, statusText: "Not Found" }),
      );

    const fetchProgram = byRef("fetchProgram");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchProgram({ url }),
    );

    const resultCell = runtime.getCell(
      space,
      "program-error-result",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      testPattern,
      { url: missingUrl },
      resultCell,
    );
    tx.commit();

    await result.pull();
    await runtime.settled();
    await result.pull();

    const unavailable = await rawResultChild(runtime, result);
    expect(isUnavailable(unavailable)).toBe(true);
    expect(
      isUnavailable(unavailable) ? unavailable.errorMessage : undefined,
    ).toContain("404");
    expect(result.key("pending").get()).toBe(false);
  });

  it("publishes schema mismatch when the program URL is empty", async () => {
    let requests = 0;
    globalThis.fetch = () => {
      requests++;
      return Promise.resolve(moduleResponse());
    };

    const fetchProgram = byRef("fetchProgram");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchProgram({ url }),
    );

    const resultCell = runtime.getCell(
      space,
      "program-empty-url-result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, testPattern, { url: "" }, resultCell);
    tx.commit();

    await result.pull();
    await runtime.settled();

    expect(requests).toBe(0);
    expect(result.key("pending").get()).toBe(false);
    expect(await rawResultChild(runtime, result)).toMatchObject({
      reason: "error",
      errorKind: "invalidInput",
    });
    expect(result.key("error").get()).toBeUndefined();
  });

  it("publishes a slow program resolution that outlives the staleness bound", async () => {
    const slowUrl = "http://mock-test-server.local/slow-program.ts";
    const otherUrl = "http://mock-test-server.local/other-program.ts";

    // The slow program's module request is held open, so the resolution
    // started for it stays in flight until this case releases it.
    const heldRequests: Deferred<Response>[] = [];
    const firstSlowRequest = deferred<void>();
    globalThis.fetch = (input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      if (url.includes("slow-program")) {
        const held = deferred<Response>();
        heldRequests.push(held);
        firstSlowRequest.resolve();
        return held.promise;
      }
      return Promise.resolve(moduleResponse());
    };

    const fetchProgram = byRef("fetchProgram");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchProgram({ url }),
    );

    const inputs = runtime.getCell<{ url: string }>(
      space,
      "program-takeover-inputs",
      undefined,
      tx,
    );
    inputs.set({ url: slowUrl });
    const resultCell = runtime.getCell(
      space,
      "program-takeover-result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, testPattern, inputs, resultCell);
    tx.commit();

    await result.pull();
    await firstSlowRequest.promise;
    await clock.settle();
    expect(heldRequests.length).toBe(1);

    // Point the pattern at a different program and back again. That round trip
    // is the wake-up: the staleness check is a predicate the action evaluates
    // when it next runs, not a timer, so it is only ever reached because
    // something else re-ran the action. The first resolution is in flight
    // throughout — an input change does not abort it.
    await runtime.editWithRetry((edit) => {
      inputs.withTx(edit).key("url").set(otherUrl);
    });
    await result.pull();
    await clock.settle();

    // Well past any staleness bound this builtin would plausibly use.
    await clock.tick(120_000);

    await runtime.editWithRetry((edit) => {
      inputs.withTx(edit).key("url").set(slowUrl);
    });
    await result.pull();
    await clock.settle();

    // The resolution was never restarted, and its cache entry is still the one
    // it will write into.
    expect(heldRequests.length).toBe(1);

    heldRequests[0].resolve(moduleResponse());
    await runtime.settled();
    await result.pull();

    const program = result.key("result").get() as
      | { main: string; files: { name: string }[] }
      | undefined;
    expect(program).toBeDefined();
    expect(program!.main).toBe("/slow-program.ts");
    expect(program!.files.map((file) => file.name)).toEqual([
      "/slow-program.ts",
    ]);
    expect(result.key("error").get()).toBeUndefined();
    expect(result.key("pending").get()).toBe(false);
  });

  it("keeps a result recorded for the same inputs when a request fails", async () => {
    const url = "http://mock-test-server.local/api/takeover";

    const heldRequest = deferred<Response>();
    const requestIssued = deferred<void>();
    globalThis.fetch = () => {
      requestIssued.resolve();
      return heldRequest.promise;
    };

    const fetchJson = byRef("fetchJson");
    // This case is about the error path, not about the bound, so it puts the
    // bound out of reach: the auto-advance clock jumps logical time forward
    // whenever the loop idles, and a takeover here would clear `result` on its
    // way in and mask what is being pinned.
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchJson({ url, options: { mutexTimeoutMs: 600_000 } }),
    );

    const resultCell = runtime.getCell(
      space,
      "fetch-takeover-result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, testPattern, { url }, resultCell);
    tx.commit();

    await result.pull();
    await requestIssued.promise;
    await clock.settle();

    // Stand in for the replica that took the claim over and got there first: a
    // result for these very inputs is now recorded. The pattern's result cell
    // holds a link to the builtin's own result cell, and a plain link is not
    // followed on write, so resolve it and write the cell the builtin writes.
    const builtinResult = runtime.getCellFromLink(
      resolveLink(
        runtime,
        runtime.readTx(),
        result.key("result").getAsNormalizedFullLink(),
      ),
    );
    await runtime.editWithRetry((edit) => {
      builtinResult.withTx(edit).set({ from: "the other replica" });
    });
    await clock.settle();

    heldRequest.reject(new Error("simulated network failure"));
    await runtime.settled();

    expect(await rawResultChild(runtime, result)).toEqual({
      from: "the other replica",
    });
    expect(result.key("error").get()).toBeUndefined();
    expect(result.key("pending").get()).toBe(false);
  });

  describe("the staleness branch of the mutex", () => {
    // The takeover itself, driven through `tryClaimMutex` directly: a claim
    // another replica made is believed until it goes stale, and then taken
    // over. This is the one branch where the clock decides anything.

    const inputs = { url: "http://mock-test-server.local/api/claimed" };

    async function claimAgainst(
      claimAgeMs: number,
    ): Promise<{ claimed: boolean; requestId: string; pending: boolean }> {
      const inputsCell = runtime.getCell<typeof inputs>(
        space,
        `mutex-staleness-inputs-${claimAgeMs}`,
        undefined,
        tx,
      );
      const pending = runtime.getCell<boolean>(
        space,
        `mutex-staleness-pending-${claimAgeMs}`,
        undefined,
        tx,
      );
      const result = runtime.getCell<unknown>(
        space,
        `mutex-staleness-result-${claimAgeMs}`,
        undefined,
        tx,
      );
      const error = runtime.getCell<unknown>(
        space,
        `mutex-staleness-error-${claimAgeMs}`,
        undefined,
        tx,
      );
      const internal = runtime.getCell<Schema<typeof internalSchema>>(
        space,
        `mutex-staleness-internal-${claimAgeMs}`,
        undefined,
        tx,
      );

      // A claim standing in the durable state, made by a replica that is not
      // this one, `claimAgeMs` ago.
      inputsCell.set(inputs);
      pending.set(true);
      internal.set({
        requestId: "another-replica:whatever",
        lastActivity: Date.now() - claimAgeMs,
        inputHash: computeInputHashFromValue(inputs),
      });
      await tx.commit().settled;
      tx = runtime.edit();

      const claim = await tryClaimMutex(
        runtime,
        inputsCell,
        pending,
        result,
        error,
        internal,
        "this-replica:whatever",
        (cell) => cell.get() ?? ({} as typeof inputs),
      );
      return {
        claimed: claim.claimed,
        requestId: internal.get().requestId,
        pending: pending.get(),
      };
    }

    it("leaves a claim younger than the bound alone", async () => {
      const outcome = await claimAgainst(MUTEX_STALE_AFTER / 2);
      expect(outcome.claimed).toBe(false);
      expect(outcome.requestId).toBe("another-replica:whatever");
      expect(outcome.pending).toBe(true);
    });

    it("takes over a claim older than the bound", async () => {
      const outcome = await claimAgainst(MUTEX_STALE_AFTER * 2);
      expect(outcome.claimed).toBe(true);
      expect(outcome.requestId).toBe("this-replica:whatever");
      expect(outcome.pending).toBe(true);
    });
  });

  describe("the completed-request guard of the mutex", () => {
    // The claim-time memo guard (server-execution v2 stage G,
    // serving-loop.md §4): a COMPLETED request — stored hash matching the
    // expected inputs AND a result (or error-shaped result) present — is
    // never re-claimed; the stored value IS the value. The serving
    // posture's deferred flush can re-admit a key whose first effect
    // already completed, and without this guard the late claim would
    // clear the result and issue a second egress for inputs that already
    // have their answer.

    const inputs = { url: "http://mock-test-server.local/api/completed" };

    async function claimWithStored(
      stored: "result" | "error" | "pending" | "none",
    ): Promise<{ claimed: boolean; result: unknown; pending: boolean }> {
      const inputsCell = runtime.getCell<typeof inputs>(
        space,
        `mutex-completed-inputs-${stored}`,
        undefined,
        tx,
      );
      const pending = runtime.getCell<boolean>(
        space,
        `mutex-completed-pending-${stored}`,
        undefined,
        tx,
      );
      const result = runtime.getCell<unknown>(
        space,
        `mutex-completed-result-${stored}`,
        undefined,
        tx,
      );
      const error = runtime.getCell<unknown>(
        space,
        `mutex-completed-error-${stored}`,
        undefined,
        tx,
      );
      const internal = runtime.getCell<Schema<typeof internalSchema>>(
        space,
        `mutex-completed-internal-${stored}`,
        undefined,
        tx,
      );

      // The completed request's durable shape: hash recorded for these
      // very inputs, pending long false, and — in the guarded arms —
      // the settled value standing.
      inputsCell.set(inputs);
      pending.set(false);
      if (stored === "result") {
        result.set({ from: "the completed request" });
      } else if (stored === "error") {
        error.set({ message: "the stored error-shaped result" });
      } else if (stored === "pending") {
        result.setRaw(UNAVAILABLE_PENDING);
      }
      internal.set({
        requestId: "",
        lastActivity: 0,
        inputHash: computeInputHashFromValue(inputs),
      });
      await tx.commit().settled;
      tx = runtime.edit();

      const claim = await tryClaimMutex(
        runtime,
        inputsCell,
        pending,
        result,
        error,
        internal,
        "this-replica:whatever",
        (cell) => cell.get() ?? ({} as typeof inputs),
        computeInputHashFromValue(inputs),
      );
      return {
        claimed: claim.claimed,
        result: result.get(),
        pending: pending.get(),
      };
    }

    it("never claims over a stored result whose hash matches", async () => {
      const outcome = await claimWithStored("result");
      expect(outcome.claimed).toBe(false);
      // The stored value stands untouched — no clear on the way out.
      expect(outcome.result).toEqual({ from: "the completed request" });
      expect(outcome.pending).toBe(false);
    });

    it("never claims over a stored error-shaped result whose hash matches", async () => {
      const outcome = await claimWithStored("error");
      expect(outcome.claimed).toBe(false);
      expect(outcome.pending).toBe(false);
    });

    it("still claims when the hash matches but nothing has landed", async () => {
      const outcome = await claimWithStored("none");
      expect(outcome.claimed).toBe(true);
      expect(outcome.pending).toBe(true);
    });

    it("still claims when the direct result is the pending marker", async () => {
      const outcome = await claimWithStored("pending");
      expect(outcome.claimed).toBe(true);
      expect(outcome.pending).toBe(true);
    });
  });
});
