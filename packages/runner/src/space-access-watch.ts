import type { MemorySpace } from "@commonfabric/memory/interface";

import type { Cancel } from "./cancel.ts";
import type { Action, Scheduler } from "./scheduler.ts";
import type { IStorageManager } from "./storage/interface.ts";

/**
 * Runs actions again when the memory server starts or stops refusing a
 * runtime a space. Neither change touches a document an action has read, so
 * an action whose value depends on the verdict, as the value of
 * `spaceAccess(target)` does, registers here to learn of it. A runtime holds
 * one of these for as long as it lives, and disposing it cancels its
 * subscriptions, which matters when the storage manager outlives the runtime.
 * An action the scheduler unsubscribes is let go at once, so a discarded
 * computation is not held until its space next changes.
 */
export class SpaceAccessWatch {
  #storage: Pick<IStorageManager, "subscribeSpaceAccessChange">;
  #scheduler: Pick<Scheduler, "invalidateAction" | "observeUnsubscribe">;
  #waiting = new Map<MemorySpace, Set<Action>>();
  #cancels: Cancel[] | undefined;
  #subscribed = false;

  /**
   * Constructs an instance which subscribes to `storage` and `scheduler` on
   * first use, and runs actions again through `scheduler`.
   */
  constructor(
    storage: Pick<IStorageManager, "subscribeSpaceAccessChange">,
    scheduler: Pick<Scheduler, "invalidateAction" | "observeUnsubscribe">,
  ) {
    this.#storage = storage;
    this.#scheduler = scheduler;
  }

  /** The registrations waiting for a change, by space. */
  get accessForTestingOnly(): {
    readonly waiting: Map<MemorySpace, Set<Action>>;
  } {
    return { waiting: this.#waiting };
  }

  /**
   * Runs `action` again at the next change of the verdict on `space`. The
   * registration lasts for that one change; an action that still depends on
   * the verdict registers again when it runs. Does nothing once disposed, or
   * with a storage manager that reports no such changes.
   */
  rerunOnChange(space: MemorySpace, action: Action): void {
    if (!this.#subscribed) {
      this.#subscribed = true;
      const cancelChanges = this.#storage.subscribeSpaceAccessChange?.((
        changed,
      ) => this.#changed(changed));
      if (cancelChanges !== undefined) {
        this.#cancels = [
          cancelChanges,
          this.#scheduler.observeUnsubscribe((gone) => this.#forget(gone)),
        ];
      }
    }
    if (this.#cancels === undefined) return;

    let actions = this.#waiting.get(space);
    if (actions === undefined) this.#waiting.set(space, actions = new Set());
    actions.add(action);
  }

  /** Cancels the subscriptions and drops every registration. */
  dispose(): void {
    for (const cancel of this.#cancels ?? []) cancel();
    this.#cancels = undefined;
    this.#waiting.clear();
  }

  /**
   * Helper for the scheduler subscription, which drops every registration of
   * `action`.
   */
  #forget(action: Action): void {
    for (const [space, actions] of this.#waiting) {
      actions.delete(action);
      if (actions.size === 0) this.#waiting.delete(space);
    }
  }

  /**
   * Helper for the storage subscription, which runs `space`'s waiting actions.
   */
  #changed(space: MemorySpace): void {
    const actions = this.#waiting.get(space);
    if (actions === undefined) return;
    this.#waiting.delete(space);
    for (const action of actions) this.#scheduler.invalidateAction(action);
  }
}
