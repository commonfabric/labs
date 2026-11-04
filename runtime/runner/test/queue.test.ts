import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { AsyncSemaphoreQueue } from "../src/queue.ts";

describe("AsyncSemaphoreQueue", () => {
  it("processes a single job", async () => {
    const queue = new AsyncSemaphoreQueue({ maxConcurrency: 1 });
    const result = await queue.enqueue(() => Promise.resolve(42));
    expect(result).toBe(42);
    expect(queue.stats.completed).toBe(1);
    expect(queue.stats.active).toBe(0);
    expect(queue.stats.pending).toBe(0);
  });

  it("respects maxConcurrency", async () => {
    const queue = new AsyncSemaphoreQueue({ maxConcurrency: 2 });
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const makeJob = () =>
      queue.enqueue(async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await clock.settle();
        currentConcurrent--;
        return maxConcurrent;
      });

    // Enqueue 5 jobs
    await Promise.all([
      makeJob(),
      makeJob(),
      makeJob(),
      makeJob(),
      makeJob(),
    ]);

    // Max concurrency should have been exactly 2
    expect(maxConcurrent).toBe(2);
    expect(queue.stats.completed).toBe(5);
    expect(queue.stats.active).toBe(0);
    expect(queue.stats.pending).toBe(0);
  });

  it("maintains FIFO order", async () => {
    const queue = new AsyncSemaphoreQueue({ maxConcurrency: 1 });
    const order: number[] = [];

    const makeJob = (id: number) =>
      queue.enqueue(async () => {
        order.push(id);
        await clock.settle();
      });

    await Promise.all([makeJob(1), makeJob(2), makeJob(3), makeJob(4)]);

    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("propagates errors", async () => {
    const queue = new AsyncSemaphoreQueue({ maxConcurrency: 1 });

    const error = new Error("test error");
    await expect(queue.enqueue(() => Promise.reject(error))).rejects.toThrow(
      "test error",
    );

    expect(queue.stats.failed).toBe(1);
    expect(queue.stats.completed).toBe(0);
  });

  it("continues processing after errors", async () => {
    const queue = new AsyncSemaphoreQueue({ maxConcurrency: 1 });

    // First job fails
    const p1 = queue.enqueue(() => Promise.reject(new Error("fail")));
    // Second job succeeds
    const p2 = queue.enqueue(() => Promise.resolve("ok"));

    await expect(p1).rejects.toThrow("fail");
    expect(await p2).toBe("ok");

    expect(queue.stats.failed).toBe(1);
    expect(queue.stats.completed).toBe(1);
  });

  it("updates stats correctly", async () => {
    const queue = new AsyncSemaphoreQueue({ maxConcurrency: 1 });

    const { promise, resolve } = Promise.withResolvers<void>();

    const p = queue.enqueue(() => promise);

    // While job is active
    expect(queue.stats.active).toBe(1);
    expect(queue.stats.pending).toBe(0);

    // Enqueue another while first is active
    const p2 = queue.enqueue(() => Promise.resolve("done"));
    expect(queue.stats.pending).toBe(1);
    expect(queue.stats.active).toBe(1);

    // Complete first job
    resolve();
    await p;
    await p2;

    expect(queue.stats.completed).toBe(2);
    expect(queue.stats.active).toBe(0);
    expect(queue.stats.pending).toBe(0);
  });

  it("setMaxConcurrency triggers drain", async () => {
    const queue = new AsyncSemaphoreQueue({ maxConcurrency: 1 });
    let concurrent = 0;
    let maxConcurrent = 0;

    const makeSlowJob = () =>
      queue.enqueue(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await clock.settle();
        concurrent--;
      });

    // Start 3 jobs with concurrency 1
    const p1 = makeSlowJob();
    const p2 = makeSlowJob();
    const p3 = makeSlowJob();

    // Increase concurrency — pending jobs should start
    queue.setMaxConcurrency(3);

    await Promise.all([p1, p2, p3]);

    // After bumping to 3, all 3 should have run concurrently
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it("abortPending rejects queued items and leaves the active one running", async () => {
    const queue = new AsyncSemaphoreQueue({ maxConcurrency: 1 });
    const blocker = Promise.withResolvers<string>();
    const active = queue.enqueue(() => blocker.promise);
    const pendingA = queue.enqueue(() => Promise.resolve("a"));
    const pendingB = queue.enqueue(() => Promise.resolve("b"));

    expect(queue.stats.active).toBe(1);
    expect(queue.stats.pending).toBe(2);

    queue.abortPending();

    await expect(pendingA).rejects.toThrow("Queue aborted");
    await expect(pendingB).rejects.toThrow("Queue aborted");
    expect(queue.stats.pending).toBe(0);
    expect(queue.stats.failed).toBe(2);

    blocker.resolve("done");
    expect(await active).toBe("done");
    expect(queue.stats.completed).toBe(1);
  });

  it("abortPending rejects with a caller-supplied reason", async () => {
    const queue = new AsyncSemaphoreQueue({ maxConcurrency: 1 });
    const blocker = Promise.withResolvers<void>();
    queue.enqueue(() => blocker.promise);
    const pending = queue.enqueue(() => Promise.resolve("never"));

    queue.abortPending(new Error("shutting down"));

    await expect(pending).rejects.toThrow("shutting down");
    blocker.resolve();
  });

  it("rejects a job whose function throws synchronously", async () => {
    const queue = new AsyncSemaphoreQueue({ maxConcurrency: 1 });
    await expect(
      queue.enqueue(() => {
        throw new Error("sync boom");
      }),
    ).rejects.toThrow("sync boom");
    expect(queue.stats.failed).toBe(1);
    expect(queue.stats.active).toBe(0);

    // The queue keeps draining after a synchronous failure.
    expect(await queue.enqueue(() => Promise.resolve("ok"))).toBe("ok");
    expect(queue.stats.completed).toBe(1);
  });
});
