import type { SpaceAccessRetryState } from "@commonfabric/html/worker";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { Cancel } from "@commonfabric/runner";

/**
 * The retries of refused spaces one runtime has in flight, at most one per
 * space, and how many of each space's retries have settled. A retry asked for
 * while one of the same space is in flight shares it, so the render
 * boundaries' retry controls and the host's requests ask the memory server
 * once between them. Observers hear when each retry starts and when it
 * settles, which is how a retry control shows it is in flight. Once disposed,
 * it starts no retry and tells no observer anything.
 */
export class SpaceAccessRetries {
  readonly #retrySpaceAccess: (space: MemorySpace) => Promise<void>;

  /** The retry of each space still in flight, by space. */
  readonly #inFlight = new Map<MemorySpace, Promise<void>>();

  /** How many retries of each space have settled, by space. */
  readonly #settled = new Map<MemorySpace, number>();

  readonly #observers = new Set<(space: MemorySpace) => void>();

  #disposed = false;

  /**
   * Constructs an instance which retries a space by calling
   * `retrySpaceAccess`, ordinarily `Runtime.retrySpaceAccess()`.
   */
  constructor(retrySpaceAccess: (space: MemorySpace) => Promise<void>) {
    this.#retrySpaceAccess = retrySpaceAccess;
  }

  /**
   * Retries `space` unless a retry of it is already in flight, and returns
   * the retry that is. It settles as the retry it calls does. Once disposed,
   * it returns a resolved promise and calls nothing.
   */
  retry(space: MemorySpace): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    let retry = this.#inFlight.get(space);
    if (retry === undefined) {
      retry = this.#retrySpaceAccess(space).finally(() => {
        this.#inFlight.delete(space);
        this.#settled.set(space, (this.#settled.get(space) ?? 0) + 1);
        this.#notify(space);
      });
      this.#inFlight.set(space, retry);
      this.#notify(space);
    }
    return retry;
  }

  /** Where the retries of `space` stand. */
  state(space: MemorySpace): SpaceAccessRetryState {
    return {
      retrying: this.#inFlight.has(space),
      settled: this.#settled.get(space) ?? 0,
    };
  }

  /** Observes the start and the settling of every space's retries. */
  subscribe(observer: (space: MemorySpace) => void): Cancel {
    this.#observers.add(observer);
    return () => {
      this.#observers.delete(observer);
    };
  }

  /**
   * Stops starting retries and drops every observer, so that a retry still
   * in flight settles unheard.
   */
  dispose(): void {
    this.#disposed = true;
    this.#observers.clear();
  }

  #notify(space: MemorySpace): void {
    for (const observer of [...this.#observers]) {
      try {
        observer(space);
      } catch (cause) {
        console.error("space-access-retry subscriber threw:", cause);
      }
    }
  }
}
