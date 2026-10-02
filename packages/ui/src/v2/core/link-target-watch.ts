import { type CellHandle, isCellHandle } from "@commonfabric/runtime-client";

/** What a `LinkTargetWatch` reports to, and consults, as its target moves. */
interface LinkTargetWatchOptions {
  /**
   * Called when the watched link starts pointing at a different cell, with
   * that cell, or `undefined` when the link no longer names a readable one.
   * Not called for a write within the current target.
   */
  onRetarget(target: CellHandle | undefined): void;

  /**
   * Whether `cell` is still the one its owner wants followed. A watch whose
   * cell is no longer current drops what it observes. Defaults to always
   * `true`, which leaves dropping a stale watch to `watch()` and `cancel()`.
   */
  isCurrent?(cell: CellHandle): boolean;
}

/**
 * Follows where a cell holding a link points. A component handed such a cell
 * keeps the same handle while the link inside it moves, as a list row's does
 * when an entry is inserted above it, so resolving the handle once leaves the
 * component on the old target. This keeps one subscription on the link and
 * reports each change of target identity to the owner.
 *
 * One cell is followed at a time: watching a different cell drops the
 * previous subscription.
 */
export class LinkTargetWatch {
  #onRetarget: (target: CellHandle | undefined) => void;
  #isCurrent: (cell: CellHandle) => boolean;
  #cell?: CellHandle;
  #observed?: CellHandle;
  #pendingSetup?: Promise<CellHandle | undefined>;
  #token?: object;
  #unsubscribe?: () => void;

  /** Constructs an instance which reports and consults per `options`. */
  constructor(options: LinkTargetWatchOptions) {
    this.#onRetarget = options.onRetarget;
    this.#isCurrent = options.isCurrent ?? (() => true);
  }

  /** The active subscription's teardown, if there is one. */
  get accessForTestingOnly(): {
    readonly unsubscribe: (() => void) | undefined;
  } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      get unsubscribe() {
        return outerThis.#unsubscribe;
      },
    };
  }

  /**
   * Starts following `cell`, whose `resolveAsCell()` returned `resolved`, and
   * returns its current target, or `undefined` when the link names nothing
   * readable. A cell that resolves to itself holds no link, so it is returned
   * as is and nothing is followed. Watching a cell already followed returns
   * the latest target observed, sharing a setup still in flight.
   *
   * @throws whatever synchronizing the link throws.
   */
  async watch(
    cell: CellHandle,
    resolved: CellHandle,
  ): Promise<CellHandle | undefined> {
    if (this.#token !== undefined && this.#cell?.equals(cell)) {
      if (this.#pendingSetup !== undefined) {
        return await this.#pendingSetup;
      }
      return this.#observed;
    }
    if (resolved.equals(cell)) {
      this.cancel();
      return resolved;
    }

    this.cancel();
    const token = {};
    this.#cell = cell;
    this.#token = token;
    const setup = this.#subscribe(cell, token);
    this.#pendingSetup = setup;
    try {
      return await setup;
    } finally {
      if (this.#pendingSetup === setup) {
        this.#pendingSetup = undefined;
      }
    }
  }

  /** Stops following, so that no further retarget is reported. */
  cancel(): void {
    const unsubscribe = this.#unsubscribe;
    this.#token = undefined;
    this.#unsubscribe = undefined;
    this.#cell = undefined;
    this.#observed = undefined;
    this.#pendingSetup = undefined;
    unsubscribe?.();
  }

  /**
   * Helper for `watch()`, which synchronizes the link, subscribes to it, and
   * returns the target it names.
   */
  async #subscribe(
    cell: CellHandle,
    token: object,
  ): Promise<CellHandle | undefined> {
    // This schema reports the current target as a Cell. The subscription can
    // also wake for a write within that target, so the callback compares target
    // identity before reporting a retarget.
    const linkCell = cell.asSchema<CellHandle>({ asCell: ["cell"] });
    try {
      const synchronizedTarget = await linkCell.sync();
      if (this.#token !== token || !this.#isCurrent(cell)) {
        return undefined;
      }
      let observedTarget = isCellHandle(synchronizedTarget)
        ? synchronizedTarget
        : undefined;
      this.#observed = observedTarget;
      const unsubscribe = linkCell.subscribe((nextTarget) => {
        const validTarget = isCellHandle(nextTarget) ? nextTarget : undefined;
        if (
          validTarget === undefined
            ? observedTarget === undefined
            : validTarget.equals(observedTarget)
        ) {
          return;
        }
        if (this.#token !== token) return;
        if (!this.#isCurrent(cell)) return;
        observedTarget = validTarget;
        this.#observed = validTarget;
        this.#onRetarget(validTarget);
      });
      if (this.#token === token) {
        this.#unsubscribe = unsubscribe;
      } else {
        unsubscribe();
      }
      return observedTarget;
    } catch (error) {
      if (this.#token === token) {
        this.#token = undefined;
        this.#cell = undefined;
        this.#observed = undefined;
      }
      throw error;
    }
  }
}
