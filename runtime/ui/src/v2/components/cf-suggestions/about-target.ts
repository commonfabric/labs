/**
 * Resolution of a `cf-suggestions` element's `about` to the thing it names,
 * kept apart from the element so that a Deno unit test can drive it.
 */

import { type CellHandle, isCellHandle } from "@commonfabric/runtime-client";

import { LinkTargetWatch } from "../../core/link-target-watch.ts";

/** What an `AboutTarget` consults, and reports to, as `about` resolves. */
interface AboutTargetOptions {
  /** Whether the owner is connected. A disconnected owner follows nothing. */
  isConnected(): boolean;

  /** Called each time `target` changes. */
  onChange(): void;
}

/**
 * The cell an `about` resolves to. A pattern usually binds a cell holding a
 * link to the thing, as the element of a `.map()` over a list is, so the cell
 * itself names nothing. This resolves it, holds no target until it has, and
 * resolves it again whenever the link moves.
 */
export class AboutTarget {
  #options: AboutTargetOptions;
  #about: unknown = undefined;
  #target: CellHandle | undefined = undefined;

  /** Counts resolutions, so a superseded one changes nothing. */
  #generation = 0;

  #resolution: Promise<void> = Promise.resolve();

  /** Follows the link `about` holds, resolving it again when it moves. */
  #watch = new LinkTargetWatch({
    isCurrent: () => this.#options.isConnected(),
    onRetarget: () => this.#resolve(),
  });

  /** Constructs an instance which consults and reports per `options`. */
  constructor(options: AboutTargetOptions) {
    this.#options = options;
  }

  /** The cell `about` resolved to, or `undefined` until it has. */
  get target(): CellHandle | undefined {
    return this.#target;
  }

  /** The resolution under way, or the last one, settled once it is done. */
  get resolution(): Promise<void> {
    return this.#resolution;
  }

  /** Starts resolving `about`, superseding any resolution under way. */
  resolve(about: unknown): void {
    this.#about = about;
    this.#resolve();
  }

  /** Drops the target and stops following, as the owner disconnects. */
  clear(): void {
    this.#generation++;
    this.#target = undefined;
    this.#watch.cancel();
  }

  /** Helper for `resolve()` and a retarget, which resolves `#about` again. */
  #resolve(): void {
    const generation = ++this.#generation;
    const superseded = () => generation !== this.#generation;
    const about = this.#about;
    if (this.#target !== undefined) {
      this.#target = undefined;
      this.#options.onChange();
    }
    if (!isCellHandle(about) || !this.#options.isConnected()) {
      this.#watch.cancel();
      this.#resolution = Promise.resolve();
      return;
    }
    this.#resolution = this.#watch.follow(about, superseded).then(
      (followed) => {
        // A resolution started after `follow()` settled supersedes this one.
        if (!followed || superseded()) return;
        this.#target = followed.cell;
        this.#options.onChange();
      },
      (error) => {
        if (superseded()) return;
        this.#watch.cancel();
        // A disposal race cancels the resolution; that is no failure.
        if (about.runtime().signal.aborted) return;
        console.error("Failed to resolve about:", error);
      },
    );
  }
}
