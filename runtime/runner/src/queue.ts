export interface QueueConfig {
  maxConcurrency: number;
}

export interface QueueStats {
  pending: number;
  active: number;
  completed: number;
  failed: number;
}

interface QueueItem<T> {
  fn: () => Promise<T>;
  resolvers: PromiseWithResolvers<T>;
}

export class AsyncSemaphoreQueue {
  #maxConcurrency: number;
  #queue: QueueItem<unknown>[] = [];
  #active: number = 0;
  #completed: number = 0;
  #failed: number = 0;

  constructor(config: QueueConfig) {
    this.#maxConcurrency = Math.max(
      1,
      Number.isFinite(config.maxConcurrency)
        ? Math.floor(config.maxConcurrency)
        : 1,
    );
  }

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const resolvers = Promise.withResolvers<T>();
    this.#queue.push({ fn, resolvers } as QueueItem<unknown>);
    this.#drain();
    return resolvers.promise;
  }

  get stats(): QueueStats {
    return {
      pending: this.#queue.length,
      active: this.#active,
      completed: this.#completed,
      failed: this.#failed,
    };
  }

  get maxConcurrency(): number {
    return this.#maxConcurrency;
  }

  setMaxConcurrency(n: number): void {
    this.#maxConcurrency = Math.max(
      1,
      Number.isFinite(n) ? Math.floor(n) : 1,
    );
    this.#drain();
  }

  /**
   * Reject all pending (not-yet-started) queue items immediately.
   * In-flight (active) items continue running to completion.
   */
  abortPending(reason?: unknown): void {
    const pending = this.#queue.splice(0);
    for (const item of pending) {
      this.#failed++;
      item.resolvers.reject(
        reason ?? new DOMException("Queue aborted", "AbortError"),
      );
    }
  }

  #drain(): void {
    while (this.#active < this.#maxConcurrency && this.#queue.length > 0) {
      const item = this.#queue.shift();
      if (!item) {
        break;
      }

      this.#active++;
      const { fn, resolvers } = item;

      const settleFailure = (error: unknown) => {
        this.#active--;
        this.#failed++;
        resolvers.reject(error);
        this.#drain();
      };

      let promise: Promise<unknown>;
      try {
        promise = fn();
      } catch (error) {
        settleFailure(error);
        continue;
      }

      promise.then((result) => {
        this.#active--;
        this.#completed++;
        resolvers.resolve(result);
        this.#drain();
      }, settleFailure);
    }
  }
}
