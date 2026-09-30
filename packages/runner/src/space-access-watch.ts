import type { MemorySpace } from "@commonfabric/memory/interface";

import type { Cancel } from "./cancel.ts";
import type { Action, Scheduler } from "./scheduler.ts";
import type { IStorageManager } from "./storage/interface.ts";

/**
 * Runs actions again when the memory server starts or stops refusing a
 * runtime a space. Neither change touches a document an action has read, so
 * an action whose value depends on the verdict, as `spaceAccess(target)`'s does,
 * registers here to learn of it. A runtime holds one of these for as long as
 * it lives, and disposing it cancels the storage manager subscription, which
 * matters when the manager outlives the runtime.
 */
export class SpaceAccessWatch {
  #storage: Pick<IStorageManager, "subscribeSpaceAccessChange">;
  #scheduler: Pick<Scheduler, "invalidateAction">;
  #waiting = new Map<MemorySpace, Set<Action>>();
  #cancel: Cancel | undefined;
  #subscribed = false;

  /**
   * Constructs an instance which subscribes to `storage` on first use and
   * runs actions again through `scheduler`.
   */
  constructor(
    storage: Pick<IStorageManager, "subscribeSpaceAccessChange">,
    scheduler: Pick<Scheduler, "invalidateAction">,
  ) {
    this.#storage = storage;
    this.#scheduler = scheduler;
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
      this.#cancel = this.#storage.subscribeSpaceAccessChange?.((changed) =>
        this.#changed(changed)
      );
    }
    if (this.#cancel === undefined) return;

    let actions = this.#waiting.get(space);
    if (actions === undefined) this.#waiting.set(space, actions = new Set());
    actions.add(action);
  }

  /** Cancels the subscription and drops every registration. */
  dispose(): void {
    this.#cancel?.();
    this.#cancel = undefined;
    this.#waiting.clear();
  }

  /** Helper for the subscription, which runs `space`'s waiting actions. */
  #changed(space: MemorySpace): void {
    const actions = this.#waiting.get(space);
    if (actions === undefined) return;
    this.#waiting.delete(space);
    for (const action of actions) this.#scheduler.invalidateAction(action);
  }
}
