import { assert } from "@std/assert";

import {
  Cancel,
  CellHandle,
  type CellHandleRead,
} from "@commonfabric/runtime-client";

/**
 * What the wrapped handle holds of its cell after a change, as its
 * `lastRead()` says: the value, the refusal that stands in its place when the
 * worker refused the read, or nothing yet, so that a listener never takes a
 * refused read, or one not answered, for a cell that holds nothing.
 */
export class CellUpdateEvent<T> extends CustomEvent<CellHandleRead<T>> {
  constructor(read: CellHandleRead<T>) {
    super("update", { detail: read });
  }
}

// Wraps a `CellHandle` as an `EventTarget`, firing `"update"`
// events when the cell's sink callback is fired, or its read is refused.
export class CellEventTarget<T> extends EventTarget {
  #cell: CellHandle<T>;
  #cancel?: Cancel;
  #subscribers = 0;

  constructor(cell: CellHandle<T>) {
    super();
    this.#cell = cell;
  }

  cell() {
    return this.#cell;
  }

  #isEnabled(): boolean {
    return !!this.#cancel;
  }

  #enable() {
    assert(!this.#isEnabled());
    // Each event carries what the handle holds, so the echo of a handle that
    // has read nothing yet arrives as unread, not as a cell holding nothing.
    const update = () => {
      this.dispatchEvent(
        new CellUpdateEvent<Readonly<T>>(this.#cell.lastRead()),
      );
    };
    this.#cancel = this.#cell.subscribe(update, { onRefused: update });
  }

  #disable() {
    assert(this.#isEnabled());
    this.#cancel!();
    this.#cancel = undefined;
  }

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    if (type === "update") {
      this.#subscribers += 1;
      if (!this.#isEnabled()) {
        this.#enable();
      }
    }
    return super.addEventListener(type, callback, options);
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    if (type === "update") {
      this.#subscribers -= 1;
      if (this.#subscribers === 0) {
        this.#disable();
      }
    }
    return super.removeEventListener(type, callback, options);
  }
}
