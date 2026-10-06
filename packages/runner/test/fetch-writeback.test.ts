import {
  isUnavailable,
  UNAVAILABLE_PENDING,
} from "@commonfabric/data-model/availability";
/// <reference path="./clock.d.ts" />

/**
 * What the fetch builtins report when a completion writeback cannot be
 * written, which is two different things.
 *
 * The writeback is the last step of a fetch: the response has arrived, and
 * `tryWriteResult()` puts it in the result cell. Its two "did not write"
 * outcomes are _distinct_ for the caller. Inputs that moved mean the request
 * was superseded, so the new inputs' own request owns the cells and there is
 * nothing left to do. A commit the storage layer refused means the opposite —
 * the claim is still durably pending and this response was the only completion
 * it will ever get, so `fetch.ts` must not retire the effect as fulfilled. It
 * converts that refusal into an error-shaped result instead, and propagates
 * when even that cannot commit.
 *
 * Those failure reports run nowhere except where a writeback's commit is
 * refused, which a suite reaches only by tearing a runtime down around one, so
 * a suite that does not construct the refusal covers them or not according to
 * how the run was scheduled. Each case here constructs the refusal it wants,
 * which is what makes the reports run on every suite run and under every shard
 * layout. `docs/development/COVERAGE.md` ("Failure reports reached only when
 * the operation fails") carries the reasoning.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { getTransactionWriteAttempts } from "../src/storage/transaction-inspection.ts";
import { getPatternEnvironment, setPatternEnvironment } from "../src/env.ts";
import { resolveLink } from "../src/link-resolution.ts";
import {
  computeInputHashFromValue,
  internalSchema,
  tryWriteResult,
} from "../src/builtins/fetch-utils.ts";
import type { Schema } from "../src/builder/types.ts";
import { createTransactionCommitReceipt } from "../src/storage/commit-receipt.ts";

const signer = await Identity.fromPassphrase("test fetch writeback");
const space = signer.did();

/** The inputs every case in this file writes back against. */
const INPUTS = { url: "http://mock-test-server.local/api/writeback" };

const INPUT_HASH = computeInputHashFromValue(INPUTS);

/**
 * The refusal every case injects. `AuthorizationError` without the server's
 * `retriable` marker is outside the retryable vocabulary, so `editWithRetry`
 * reports it after a single commit rather than retrying against it.
 */
const REFUSAL = {
  name: "AuthorizationError",
  message: "the space refused the write",
};

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

describe("fetch builtins: a completion writeback the storage layer refuses", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let byRef: ReturnType<typeof createBuilder>["commonfabric"]["byRef"];
  let originalFetch: typeof globalThis.fetch;
  let originalPatternEnvironment: ReturnType<typeof getPatternEnvironment>;
  let pristineEdit: Runtime["edit"];

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

    originalPatternEnvironment = getPatternEnvironment();
    setPatternEnvironment({
      apiUrl: new URL("http://mock-test-server.local"),
    });

    originalFetch = globalThis.fetch;
    pristineEdit = runtime.edit.bind(runtime);
  });

  afterEach(async () => {
    // Hand the runtime its real commits back before teardown: a disposal whose
    // own writes are refused reports failures that belong to no case.
    (runtime as any).edit = pristineEdit;
    globalThis.fetch = originalFetch;
    setPatternEnvironment(originalPatternEnvironment);
    tx.abort("case over");
    // `closeStorage: false` drains the runtime's outstanding work first,
    // including the background loads a cell read starts; closing under them
    // reports each one as a sync failure.
    await runtime?.dispose({ closeStorage: false });
    await storageManager?.close();
  });

  /**
   * Refuse the commit of every transaction this runtime opens from now on
   * whose write set `wanted` accepts, up to `limit` of them, leaving the
   * transaction's reads and writes real and only its outcome injected.
   *
   * Reports how many transactions `wanted` accepted, counted past `limit`
   * rather than capped at it: a case states the number it meant, so a run that
   * opened a further matching transaction fails on the count instead of
   * quietly leaving that one to commit.
   */
  function refuseCommits(
    wanted: (writtenDocuments: readonly string[]) => boolean,
    limit: number,
  ): () => number {
    let matched = 0;
    (runtime as any).edit = (...args: Parameters<Runtime["edit"]>) => {
      const opened: IExtendedStorageTransaction = pristineEdit(...args);
      const commit = opened.commit.bind(opened);
      (opened as any).commit = (...commitArgs: unknown[]) => {
        const written = (getTransactionWriteAttempts(opened) ?? []).map(
          (attempt) => attempt.id as string,
        );
        if (wanted(written)) {
          matched++;
          if (matched <= limit) {
            opened.abort(REFUSAL);
            return createTransactionCommitReceipt(
              Promise.resolve({ error: REFUSAL }),
            );
          }
        }
        return (commit as (...args: unknown[]) => unknown)(...commitArgs);
      };
      return opened;
    };
    return () => matched;
  }

  describe("tryWriteResult()", () => {
    /** The three cells a writeback is handed, seeded and committed. */
    async function newCells(cause: string) {
      const inputsCell = runtime.getCell<typeof INPUTS>(
        space,
        `${cause}-inputs`,
        undefined,
        tx,
      );
      const internal = runtime.getCell<Schema<typeof internalSchema>>(
        space,
        `${cause}-internal`,
        internalSchema,
        tx,
      );
      const result = runtime.getCell<unknown>(
        space,
        `${cause}-result`,
        undefined,
        tx,
      );
      inputsCell.set(INPUTS);
      // A claim standing for these inputs, with no result recorded yet: the
      // state a response arrives into.
      internal.set({
        requestId: "this-replica:claim",
        lastActivity: 1,
        inputHash: "",
      });
      await tx.commit().settled;
      tx = runtime.edit();
      return { inputsCell, internal, result };
    }

    it("writes the result and records the hash when the inputs have not moved", async () => {
      const { inputsCell, internal, result } = await newCells("landed");

      const written = await tryWriteResult(
        runtime,
        internal,
        inputsCell,
        INPUT_HASH,
        (writeTx) => result.withTx(writeTx).set({ from: "the response" }),
      );

      expect(written).toEqual({ written: true });
      expect(result.get()).toEqual({ from: "the response" });
      expect(internal.get().inputHash).toBe(INPUT_HASH);
    });

    it("reports a superseded writeback without a commit error, and writes nothing", async () => {
      const { inputsCell, internal, result } = await newCells("superseded");
      const movedHash = computeInputHashFromValue({
        url: "http://mock-test-server.local/api/the-inputs-that-moved",
      });
      expect(movedHash).not.toBe(INPUT_HASH);
      let actionRan = false;

      const written = await tryWriteResult(
        runtime,
        internal,
        inputsCell,
        movedHash,
        (writeTx) => {
          actionRan = true;
          result.withTx(writeTx).set({ from: "the superseded response" });
        },
      );

      // `written: false` and no `commitError`: the inputs moved, the action
      // never ran, and the request that owns the cells now is someone else's.
      expect(written).toEqual({ written: false });
      expect(written.commitError).toBeUndefined();
      expect(actionRan).toBe(false);
      expect(result.get()).toBeUndefined();
      expect(internal.get().inputHash).toBe("");
    });

    it("carries a refused commit back as a commit error, and writes nothing", async () => {
      const { inputsCell, internal, result } = await newCells("refused");
      const refused = refuseCommits(() => true, 1);
      let actionRan = false;

      const written = await tryWriteResult(
        runtime,
        internal,
        inputsCell,
        INPUT_HASH,
        (writeTx) => {
          actionRan = true;
          result.withTx(writeTx).set({ from: "the response" });
        },
      );

      // The other "did not write" shape. Here the hash matched and the action
      // ran, so a caller reading only `written` could not tell this from the
      // superseded case above — and retiring the effect on it would leave the
      // claim pending with nothing left to complete it.
      expect(refused()).toBe(1);
      expect(actionRan).toBe(true);
      expect(written.written).toBe(false);
      expect(written.commitError).toBe(REFUSAL);
      expect(result.get()).toBeUndefined();
      expect(internal.get().inputHash).toBe("");
    });
  });

  describe("what fetchJson does with the refusal", () => {
    /**
     * Run `fetchJson` against a held response, and return the handles a case
     * needs to refuse its writeback: the pattern's result cell, the document
     * the builtin's own result cell lives in, the release for the response,
     * and every promise the builtin registered as tracked async work (the
     * channel the serving outbox counts `outbox.failed` through).
     */
    async function fetchJsonAwaitingItsResponse(cause: string) {
      const release = deferred<Response>();
      const issued = deferred<void>();
      globalThis.fetch = () => {
        issued.resolve();
        return release.promise;
      };

      const work: Promise<unknown>[] = [];
      runtime.asyncWorkObserver = (registered) => void work.push(registered);

      const fetchJson = byRef("fetchJson");
      // The staleness bound is put out of reach: the auto-advancing clock
      // would otherwise let a takeover clear `result` on its way in while the
      // response is held, which is not what these cases are about.
      const testPattern = pattern<{ url: string }>(
        ({ url }) => fetchJson({ url, options: { mutexTimeoutMs: 600_000 } }),
      );

      const resultCell = runtime.getCell(space, cause, undefined, tx);
      const result = runtime.run(tx, testPattern, INPUTS, resultCell);
      tx.commit();

      await result.pull();
      await issued.promise;
      await clock.settle();

      // The pattern's result cell holds links to the builtin's own cells, and
      // a plain link is not followed on write, so resolve them to name the
      // documents a writeback writes.
      const documentOf = (key: string) =>
        runtime.getCellFromLink(
          resolveLink(
            runtime,
            runtime.readTx(),
            result.key(key).getAsNormalizedFullLink(),
          ),
        ).getAsNormalizedFullLink().id;

      return {
        result,
        resultDocument: documentOf("result"),
        pendingDocument: documentOf("pending"),
        work,
        respond: () =>
          release.resolve(
            new Response(JSON.stringify({ from: "the response" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          ),
      };
    }

    it("turns a refused completion writeback into an error-shaped result", async () => {
      const { result, resultDocument, work, respond } =
        await fetchJsonAwaitingItsResponse("fetch-writeback-refused");

      // The writeback is the transaction that carries the response into the
      // builtin's result document. The error writeback that follows writes an
      // error marker there, so it matches too, but only the first matching
      // commit is refused.
      const refused = refuseCommits(
        (written) => written.includes(resultDocument),
        1,
      );
      respond();
      await runtime.settled();

      expect(refused()).toBe(2);
      // Not silence, and not a success: the response's failure to land is
      // reported as the node's error, which is retryable and input-driven.
      const error = result.key("error").get() as { message?: string };
      expect(error?.message).toBe(
        `fetchJson completion write failed: ${REFUSAL.message}`,
      );
      const unavailable = result.key("result").get();
      expect(isUnavailable(unavailable)).toBe(true);
      if (isUnavailable(unavailable) && unavailable.reason === "error") {
        expect(unavailable.errorMessage).toBe(
          `fetchJson completion write failed: ${REFUSAL.message}`,
        );
      }
      // The claim is released, so the node is not left showing a spinner.
      expect(result.key("pending").get()).toBe(false);
      // Nothing rejected: an error-shaped result is a completion. The count
      // is stated too, so an empty `work` cannot pass this vacuously.
      expect(work.length).toBeGreaterThan(0);
      const outcomes = await Promise.allSettled(work);
      expect(outcomes.filter((o) => o.status === "rejected")).toEqual([]);
    });

    it("rejects the tracked work when even the error-shaped result cannot commit", async () => {
      const { result, pendingDocument, work, respond } =
        await fetchJsonAwaitingItsResponse("fetch-writeback-refused-twice");

      // Both writebacks refused: the completion first, then the error-shaped
      // result that stands in for it. Both release the claim, so the pending
      // document names the two of them and nothing else — refusing every
      // commit instead would make the count depend on whatever the scheduler
      // happened to open in the same window.
      const refused = refuseCommits(
        (written) => written.includes(pendingDocument),
        Infinity,
      );
      respond();
      await runtime.settled();

      expect(refused()).toBe(2);
      // Loud rather than silent: a `return` here would retire the effect as
      // completed, and recovery depends on the failure being counted. The
      // completion failure is carried as the cause, so the report names what
      // could not be written as well as what could not be reported.
      const outcomes = await Promise.allSettled(work);
      const rejections = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason as Error] : []
      );
      expect(rejections.length).toBe(1);
      expect(rejections[0].message).toBe(
        `fetchJson error writeback failed to commit: ${REFUSAL.message}`,
      );
      expect((rejections[0].cause as Error).message).toBe(
        `fetchJson completion write failed: ${REFUSAL.message}`,
      );
      // Neither writeback landed, so the claim stays as the request left it:
      // pending, with its explicit pending marker and no error recorded.
      expect(result.key("pending").get()).toBe(true);
      expect(result.key("result").get()).toBe(UNAVAILABLE_PENDING);
      expect(result.key("error").get()).toBeUndefined();
    });
  });
});
