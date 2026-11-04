export type CollectionRequestResult =
  | "started"
  | "queued"
  | "already-queued"
  | "closed";

export class CollectionRequestQueue {
  readonly #run: (reason: string) => Promise<void>;
  #active?: Promise<void>;
  #pendingReason?: string;
  #closed = false;

  constructor(run: (reason: string) => Promise<void>) {
    this.#run = run;
  }

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
