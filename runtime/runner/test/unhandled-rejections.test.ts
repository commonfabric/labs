import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { logUnhandledRejections } from "../src/sandbox/unhandled-rejections.ts";
import { runLockedDownProcess } from "./support/run-locked-down-process.ts";

type WorkerOutcome = { message: string } | { error: string };

/**
 * Starts `test/support/unhandled-rejection-worker.ts` with `start` as its
 * first message, waits for the rejection it posts, then sends `ping`, and
 * returns what the worker did next: the message it posted, or the error it
 * ended with. The worker's messages and its error arrive by separate routes,
 * so one pair of listeners records every outcome from the start, in the order
 * it arrives. The worker posts `rejected` from inside the rejection's
 * dispatch, before the rejection can end it, so that message arrives first.
 */
async function outcomeAfterRejection(start: string): Promise<WorkerOutcome> {
  const worker = new Worker(
    new URL("./support/unhandled-rejection-worker.ts", import.meta.url),
    { type: "module" },
  );
  const arrived: WorkerOutcome[] = [];
  const waiting: ((outcome: WorkerOutcome) => void)[] = [];
  const record = (outcome: WorkerOutcome) => {
    const waiter = waiting.shift();
    if (waiter) waiter(outcome);
    else arrived.push(outcome);
  };
  const next = (): Promise<WorkerOutcome> => {
    const outcome = arrived.shift();
    return outcome
      ? Promise.resolve(outcome)
      : new Promise((resolve) => waiting.push(resolve));
  };
  worker.onmessage = (event) => record({ message: event.data });
  worker.onerror = (event) => {
    event.preventDefault();
    record({ error: event.message });
  };
  try {
    worker.postMessage(start);
    expect(await next()).toEqual({ message: "rejected" });
    worker.postMessage("ping");
    return await next();
  } finally {
    worker.terminate();
  }
}

describe("unhandled-rejections", () => {
  describe("logUnhandledRejections()", () => {
    it("logs an unhandled rejection by its reason and marks it handled", () => {
      const target = new EventTarget();
      const logged: unknown[][] = [];
      using _error = stub(console, "error", (...args: unknown[]) => {
        logged.push(args);
      });
      const reason = new Error("stale batch");
      const promise = Promise.reject(reason);
      promise.catch(() => {});
      const event = new PromiseRejectionEvent("unhandledrejection", {
        promise,
        reason,
        cancelable: true,
      });

      logUnhandledRejections(target);
      target.dispatchEvent(event);

      expect(logged).toEqual([["Unhandled promise rejection:", reason]]);
      expect(event.defaultPrevented).toBe(true);
    });

    it("lets a locked-down process exit with status 0 after a rejection nothing handles", async () => {
      const { code, stdout, stderr } = await runLockedDownProcess("contain");

      expect(stdout).toContain("intrinsics frozen: true");
      expect(stderr).toContain("Unhandled promise rejection:");
      expect(stderr).toContain("rejected with no handler");
      expect(stderr).not.toContain("Uncaught");
      expect(code).toBe(0);
    });

    it("keeps a locked-down worker answering after a rejection nothing handles", async () => {
      expect(await outcomeAfterRejection("contained")).toEqual({
        message: "pong",
      });
    });

    it("ends a locked-down worker on a rejection nothing handles when it is not installed", async () => {
      const outcome = await outcomeAfterRejection("uncontained");

      expect(outcome).toEqual({
        error: expect.stringContaining("rejected with no handler"),
      });
    });
  });
});
