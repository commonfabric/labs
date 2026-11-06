import type { DID } from "@commonfabric/identity";

/** A runtime's notice of a refused space, as `RuntimeClient` emits it. */
interface SpaceAccessLostNotice {
  /** The refused space. */
  space: DID;

  /** Present when the space is deleted, which no retry can undo. */
  deleted?: true;
}

/** What an `UnavailableSpaceRetry` uses of a `RuntimeClient`. */
interface RetryingRuntime {
  /** Adds a listener for the runtime's notices of a refused space. */
  on(
    event: "spaceaccesslost",
    listener: (notice: SpaceAccessLostNotice) => void,
  ): unknown;

  /** Removes a listener `on()` added. */
  off(
    event: "spaceaccesslost",
    listener: (notice: SpaceAccessLostNotice) => void,
  ): unknown;

  /** Asks the memory server once more for `space`. */
  retrySpaceAccess(space: DID): Promise<void>;

  /** Dials once more every space the runtime could not reach. */
  retryUnreachableSpaces(): Promise<void>;
}

/**
 * Asks a runtime once more for the spaces it could not use, on the occasions
 * one may since have become usable. The runtime never asks again on its own
 * for either kind. A refused session cannot read the access list that would
 * say a grant was made, and a grant sends the session nothing. A space whose
 * first connection never completed a handshake, as when its memory host was
 * down or out of the network's reach, fails its loads at once rather than
 * dialing the host again for each.
 *
 * The refused spaces are the ones the runtime's `spaceaccesslost` notices
 * named, and a space stays among them once readmitted, since nothing reports
 * a readmission to the host. Retrying one that is no longer refused is a no-op
 * the runtime decides without the server, and a retry asked for while one of
 * the same space is in flight shares it. A space a notice marked deleted is
 * never asked for again, since no retry can admit anyone to it.
 *
 * The unreachable spaces are not named to the host at all, since no notice
 * reports one, so each occasion asks the runtime to retry every space it has
 * not reached (`retryUnreachableSpaces()`), which does nothing where there is
 * none. A change of network is an occasion for these alone, since it grants
 * nobody anything.
 */
export class UnavailableSpaceRetry {
  readonly #runtime: RetryingRuntime;

  /** Every space the runtime has reported refused, and not deleted. */
  readonly #refused = new Set<DID>();

  /** Every space the runtime has reported deleted. */
  readonly #deleted = new Set<DID>();

  readonly #onSpaceAccessLost = (
    { space, deleted }: SpaceAccessLostNotice,
  ): void => {
    if (deleted === true) {
      this.#refused.delete(space);
      this.#deleted.add(space);
    } else if (!this.#deleted.has(space)) {
      this.#refused.add(space);
    }
  };

  /**
   * Constructs an instance which listens for `runtime`'s refusals until
   * `dispose()`.
   */
  constructor(runtime: RetryingRuntime) {
    this.#runtime = runtime;
    runtime.on("spaceaccesslost", this.#onSpaceAccessLost);
  }

  /** Stops listening for the runtime's refusals. */
  dispose(): void {
    this.#runtime.off("spaceaccesslost", this.#onSpaceAccessLost);
  }

  /**
   * Retries `space`, if the runtime has reported it refused and not deleted,
   * and every space the runtime could not reach. It is for navigating into
   * `space`, which is where a person goes back to a space that failed, and a
   * view can show spaces other than its own through links.
   */
  retry(space: DID | undefined): void {
    if (space !== undefined && this.#refused.has(space)) this.#retry(space);
    this.retryUnreachable();
  }

  /**
   * Retries every space the runtime has reported refused and not deleted,
   * and every space it could not reach. A view can show a space other than
   * its own through a link, and which ones it shows is known only to the
   * renderer, so this asks for each of them.
   */
  retryAll(): void {
    for (const space of this.#refused) this.#retry(space);
    this.retryUnreachable();
  }

  /**
   * Retries every space the runtime could not reach, and no refused one. It
   * is for a sign that the network changed.
   */
  retryUnreachable(): void {
    // Unlike a retry of one space, which rejects when its dial fails again,
    // this resolves however many spaces stay out of reach, since that is
    // the expected answer while the network is down. What lands here is a
    // failure to reach the runtime, and the next occasion asks again.
    this.#runtime.retryUnreachableSpaces().catch((error) => {
      console.warn(
        "[UnavailableSpaceRetry] Retrying unreachable spaces failed:",
        error,
      );
    });
  }

  #retry(space: DID): void {
    // A refusal resolves, so what lands here is a failure to reach the
    // runtime or the memory server, and the next occasion asks again.
    this.#runtime.retrySpaceAccess(space).catch((error) => {
      console.warn(`[UnavailableSpaceRetry] Retrying ${space} failed:`, error);
    });
  }
}
