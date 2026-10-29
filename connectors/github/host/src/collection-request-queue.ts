export type CollectionRequestResult =
  | "started"
  | "queued"
  | "already-queued"
  | "closed";

/** Coalesces collection requests while retaining one follow-up collection. */
export class CollectionRequestQueue {
  readonly #run: (reason: string) => Promise<void>;
  #active?: Promise<void>;
  #pendingReason?: string;
  #closed = false;

  /** Create a queue around the operation that performs a collection. */
  constructor(run: (reason: string) => Promise<void>) {
    this.#run = run;
  }

  /** Request a collection or one follow-up after the active collection. */
  request(reason: string): CollectionRequestResult {
    if (this.#closed) return "closed";
    if (this.#active) {
      if (this.#pendingReason !== undefined) return "already-queued";
      this.#pendingReason = reason;
      return "queued";
    }
    this.#start(reason);
    return "started";
  }

  /** Reject new work and wait for the active collection to settle. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#pendingReason = undefined;
    await this.#active;
  }

  #start(reason: string): void {
    const task = Promise.resolve().then(() => this.#run(reason));
    this.#active = task;
    const settled = () => {
      if (this.#active !== task) return;
      this.#active = undefined;
      if (this.#closed) {
        this.#pendingReason = undefined;
        return;
      }
      const pendingReason = this.#pendingReason;
      this.#pendingReason = undefined;
      if (pendingReason !== undefined) this.#start(pendingReason);
    };
    void task.then(settled, settled);
  }
}
