import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { defer } from "@commonfabric/async/defer";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { streamData } from "../../src/builtins/stream-data.ts";
import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import { isCfcEnforcementRejection } from "../../src/storage/rejection.ts";
import { refuseAtCommitBoundary } from "../refused-commit.ts";

const signer = await Identity.fromPassphrase("test stream-data builtin");
const space = signer.did();

type StreamDataInputs = {
  url?: string;
  options?: {
    body?: unknown;
    method?: string;
    headers?: Record<string, string>;
  };
};

type StreamDataCells = {
  pending: Cell<boolean>;
  result: Cell<unknown>;
  error: Cell<unknown>;
};

describe("streamData", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;
  let respond: (init: RequestInit | undefined) => Promise<Response>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    respond = () => Promise.resolve(new Response(""));
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init });
      return respond(init);
    };
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await runtime.dispose();
    await storageManager.close();
  });

  /** Builds a `streamData` node over an inputs document holding `inputs`. */
  async function setUp(name: string, inputs: StreamDataInputs) {
    const setupTx = runtime.edit();
    const parentCell = runtime.getCell(
      space,
      `${name}-parent`,
      undefined,
      setupTx,
    );
    const inputsCell = runtime.getCell<StreamDataInputs>(
      space,
      `${name}-inputs`,
      undefined,
      setupTx,
    );
    inputsCell.set(inputs);
    expect((await setupTx.commit().settled).ok).toBeDefined();

    let cells: StreamDataCells | undefined;
    const { action } = streamData(
      inputsCell,
      (_tx, sent: StreamDataCells) => cells = sent,
      () => {},
      [],
      parentCell,
      runtime,
    );
    return {
      inputsCell,
      action,
      cells: () => {
        if (cells === undefined) throw new Error("no cells were announced");
        return cells;
      },
    };
  }

  /** A fetch that hangs until its signal aborts, as a real fetch does. */
  function abortableFetch(init: RequestInit | undefined): Promise<Response> {
    return new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The request was aborted", "AbortError"));
      });
    });
  }

  describe("request options", () => {
    it("sends a non-string body as JSON beside the request's other options", async () => {
      const node = await setUp("options-object-body", {
        url: "http://stream.test/object-body",
        options: {
          method: "POST",
          body: { query: 1 },
          headers: { "x-test": "yes" },
        },
      });
      const tx = runtime.edit();
      node.action(tx);
      expect((await tx.commit().settled).ok).toBeDefined();
      await runtime.settled();

      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0].url).toBe("http://stream.test/object-body");
      expect(fetchCalls[0].init?.method).toBe("POST");
      expect(fetchCalls[0].init?.body).toBe('{"query":1}');
      expect(fetchCalls[0].init?.headers).toEqual({ "x-test": "yes" });
    });

    it("sends a string body unchanged", async () => {
      const node = await setUp("options-string-body", {
        url: "http://stream.test/string-body",
        options: { method: "POST", body: "raw text" },
      });
      const tx = runtime.edit();
      node.action(tx);
      expect((await tx.commit().settled).ok).toBeDefined();
      await runtime.settled();

      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0].init?.body).toBe("raw text");
    });
  });

  describe("a request that goes away", () => {
    it("clears its cells and leaves no error when the url goes away mid-request", async () => {
      // The request in flight is aborted, and the abort it rejects with is
      // the request ending rather than failing.

      respond = abortableFetch;
      const node = await setUp("url-removed", {
        url: "http://stream.test/removed",
      });
      const firstTx = runtime.edit();
      node.action(firstTx);
      expect((await firstTx.commit().settled).ok).toBeDefined();
      await runtime.settled();
      expect(fetchCalls.length).toBe(1);
      expect(node.cells().pending.get()).toBe(true);
      const signal = fetchCalls[0].init?.signal;

      const clearTx = runtime.edit();
      node.inputsCell.withTx(clearTx).set({});
      node.action(clearTx);
      expect((await clearTx.commit().settled).ok).toBeDefined();
      await runtime.settled();
      await clock.settle();

      expect(signal?.aborted).toBe(true);
      expect(fetchCalls.length).toBe(1);
      expect(node.cells().pending.get()).toBe(false);
      expect(node.cells().result.get()).toBeUndefined();
      expect(node.cells().error.get()).toBeUndefined();
    });

    it("starts no fetch for a request superseded before its transaction committed", async () => {
      const node = await setUp("superseded-before-start", {
        url: "http://stream.test/superseded",
      });
      const firstTx = runtime.edit();
      node.action(firstTx);
      const supersedingTx = runtime.edit();
      node.inputsCell.withTx(supersedingTx).set({});
      node.action(supersedingTx);

      expect((await firstTx.commit().settled).ok).toBeDefined();
      await runtime.settled();
      expect(fetchCalls).toEqual([]);

      await supersedingTx.commit().settled;
      await runtime.settled();
      expect(fetchCalls).toEqual([]);
    });

    it("stops reading a stream whose request was superseded", async () => {
      // The source enqueues nothing itself, so it is pulled once for each read
      // the loop makes.

      const pulls: Array<ReadableStreamDefaultController<Uint8Array>> = [];
      const firstPull = defer<void>();
      respond = () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                pulls.push(controller);
                firstPull.resolve();
              },
            }, { highWaterMark: 0 }),
          ),
        );
      const node = await setUp("superseded-mid-stream", {
        url: "http://stream.test/mid-stream",
      });
      const firstTx = runtime.edit();
      node.action(firstTx);
      expect((await firstTx.commit().settled).ok).toBeDefined();
      await firstPull.promise;

      const clearTx = runtime.edit();
      node.inputsCell.withTx(clearTx).set({});
      node.action(clearTx);
      expect((await clearTx.commit().settled).ok).toBeDefined();

      // Half an event: had the loop read on, the rest of it would complete
      // the event and land on the result cell.
      pulls[0].enqueue(new TextEncoder().encode("id:1\n"));
      await clock.settle();
      await runtime.settled();

      expect(pulls.length).toBe(1);
      expect(node.cells().result.get()).toBeUndefined();
      expect(node.cells().pending.get()).toBe(false);
    });
  });

  describe("a failed request", () => {
    it("reports a response without a readable body and lets the same request start again", async () => {
      const logged: unknown[] = [];
      const originalConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        for (const arg of args) logged.push(arg);
      };
      respond = () => Promise.resolve(new Response(null));
      try {
        const node = await setUp("unreadable-body", {
          url: "http://stream.test/unreadable",
        });
        const firstTx = runtime.edit();
        node.action(firstTx);
        expect((await firstTx.commit().settled).ok).toBeDefined();

        const error = await waitForCellValue<{ message?: string }>(
          runtime,
          node.cells().error,
          (value) => value !== undefined,
        );
        expect(error.message).toBe("Response body is not readable");
        expect(node.cells().pending.get()).toBe(false);
        expect(node.cells().result.get()).toBeUndefined();
        expect(logged).toEqual([new Error("Response body is not readable")]);

        // The failure handler re-arms the request after its writeback
        // commits, which the cell read above can run ahead of.
        await clock.settle();
        const retryTx = runtime.edit();
        node.action(retryTx);
        expect((await retryTx.commit().settled).ok).toBeDefined();
        await runtime.settled();
        expect(fetchCalls.length).toBe(2);
      } finally {
        console.error = originalConsoleError;
      }
    });

    it("leaves the cells to a newer request when an older one's transaction is refused", async () => {
      // The refused request's ending is written after a newer request
      // started, so it re-announces the cells and leaves them as the newer
      // request set them.

      respond = abortableFetch;
      const node = await setUp("refused-then-superseded", {
        url: "http://stream.test/refused",
      });
      const refusedTx = runtime.edit();
      refuseAtCommitBoundary(refusedTx, space, "streamData supersession");
      node.action(refusedTx);

      const newerTx = runtime.edit();
      node.inputsCell.withTx(newerTx).set({
        url: "http://stream.test/newer",
      });
      node.action(newerTx);

      expect((await newerTx.commit().settled).ok).toBeDefined();
      const refused = await refusedTx.commit().settled;
      expect(isCfcEnforcementRejection(refused.error)).toBe(true);
      const logged: unknown[] = [];
      const originalConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        for (const arg of args) logged.push(arg);
      };
      try {
        // What the scheduler does once it stops retrying a refused action.
        refusedTx.abandonStagedWork(refused.error!);
        await runtime.settled();
      } finally {
        console.error = originalConsoleError;
      }

      expect(logged[0]).toBe(
        "[cfc] streamData-start was abandoned before it started; the " +
          "request is not sent.",
      );
      expect(fetchCalls.map((call) => call.url)).toEqual([
        "http://stream.test/newer",
      ]);
      expect(node.cells().pending.get()).toBe(true);
      expect(node.cells().error.get()).toBeUndefined();
    });
  });
});
