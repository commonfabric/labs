import type { DID } from "@commonfabric/identity";

/** What a `RefusedSpaceRetry` uses of a `RuntimeClient`. */
interface RefusingRuntime {
  /** Adds a listener for the runtime's notices of a refused space. */
  on(
    event: "spaceaccesslost",
    listener: (notice: { space: DID }) => void,
  ): unknown;

  /** Removes a listener `on()` added. */
  off(
    event: "spaceaccesslost",
    listener: (notice: { space: DID }) => void,
  ): unknown;

  /** Asks the memory server once more for `space`. */
  retrySpaceAccess(space: DID): Promise<void>;
}

/**
 * Asks a runtime once more for the spaces it reported refused, on the
 * occasions a person may since have been granted access: navigating into one
 * of them, and coming back to the page. The runtime never asks again on its
 * own, since a refused session cannot read the access list that would say
 * so, and a grant sends the session nothing.
 *
 * The spaces are the ones the runtime's `spaceaccesslost` notices named, and
 * a space stays among them once readmitted, since nothing reports a
 * readmission to the host. Retrying one that is no longer refused is a no-op
 * the runtime decides without the server, and a retry asked for while one of
 * the same space is in flight shares it.
 */
export class RefusedSpaceRetry {
  readonly #runtime: RefusingRuntime;

  /** Every space the runtime has reported refused. */
  readonly #refused = new Set<DID>();

  readonly #onSpaceAccessLost = ({ space }: { space: DID }): void => {
    this.#refused.add(space);
  };

  /**
   * Constructs an instance which listens for `runtime`'s refusals until
   * `dispose()`.
   */
  constructor(runtime: RefusingRuntime) {
    this.#runtime = runtime;
    runtime.on("spaceaccesslost", this.#onSpaceAccessLost);
  }

  /** Stops listening for the runtime's refusals. */
  dispose(): void {
    this.#runtime.off("spaceaccesslost", this.#onSpaceAccessLost);
  }

  /** Retries `space`, if the runtime has reported it refused. */
  retry(space: DID | undefined): void {
    if (space !== undefined && this.#refused.has(space)) this.#retry(space);
  }

  /**
   * Retries every space the runtime has reported refused. A view can show a
   * space other than its own through a link, and which ones it shows is known
   * only to the renderer, so this asks for each of them.
   */
  retryAll(): void {
    for (const space of this.#refused) this.#retry(space);
  }

  #retry(space: DID): void {
    // A refusal resolves rather than rejects, so what lands here is a failure
    // to reach the runtime or the server, and the next trigger asks again.
    this.#runtime.retrySpaceAccess(space).catch((error) => {
      console.warn(`[RefusedSpaceRetry] Retrying ${space} failed:`, error);
    });
  }
}
