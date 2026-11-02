import type { MemorySpace } from "@commonfabric/memory/interface";

import type { Cancel } from "./cancel.ts";
import type { Action, Scheduler } from "./scheduler.ts";
import type { IStorageManager } from "./storage/interface.ts";

/**
 * Runs actions again when the memory server starts or stops refusing a
 * runtime a space, or first answers for one. Neither change touches a
 * document an action has read, so an action whose value depends on the
 * verdict, as the value of `spaceAccess(target)` does, registers here to learn
 * of it. A runtime holds one of these for as long as it lives, and disposing
 * it cancels its subscriptions, which matters when the storage manager
 * outlives the runtime. An action the scheduler unsubscribes is let go at
 * once, so a discarded computation is not held until its space next changes.
 */
export class SpaceAccessWatch {
  #storage: Pick<
    IStorageManager,
    "subscribeSpaceAccessChange" | "awaitSpaceAnswer"
  >;
  #scheduler: Pick<Scheduler, "invalidateAction" | "observeUnsubscribe">;
  #waiting = new Map<MemorySpace, Set<Action>>();

  /** The registrations waiting for the server's first answer, by space. */
  #answering = new Map<MemorySpace, Set<Action>>();

  #cancels: Cancel[] = [];
  #subscribed = false;
  #observingUnsubscribes = false;
  #disposed = false;

  /**
   * Constructs an instance which subscribes to `storage` and `scheduler` on
   * first use, and runs actions again through `scheduler`.
   */
  constructor(
    storage: Pick<
      IStorageManager,
      "subscribeSpaceAccessChange" | "awaitSpaceAnswer"
    >,
    scheduler: Pick<Scheduler, "invalidateAction" | "observeUnsubscribe">,
  ) {
    this.#storage = storage;
    this.#scheduler = scheduler;
  }

  /** The registrations waiting for a change, by space. */
  get accessForTestingOnly(): {
    readonly waiting: Map<MemorySpace, Set<Action>>;
    readonly answering: Map<MemorySpace, Set<Action>>;
  } {
    return { waiting: this.#waiting, answering: this.#answering };
  }

  /**
   * Runs `action` again at the next change of the verdict on `space`. The
   * registration lasts for that one change; an action that still depends on
   * the verdict registers again when it runs. Does nothing once disposed, or
   * with a storage manager that reports no such changes.
   */
  rerunOnChange(space: MemorySpace, action: Action): void {
    if (this.#disposed) return;
    if (!this.#subscribed) {
      this.#subscribed = true;
      const cancelChanges = this.#storage.subscribeSpaceAccessChange?.((
        changed,
      ) => this.#changed(changed));
      if (cancelChanges === undefined) return;
      this.#cancels.push(cancelChanges);
    } else if (this.#storage.subscribeSpaceAccessChange === undefined) {
      return;
    }
    this.#observeUnsubscribes();

    let actions = this.#waiting.get(space);
    if (actions === undefined) this.#waiting.set(space, actions = new Set());
    actions.add(action);
  }

  /**
   * Runs `action` again once the memory server has answered for `space`,
   * admitting this runtime or refusing it, opening the space's session if
   * none is open (`awaitSpaceAnswer()`). An admission to a space with no
   * access list changes no document an action read, and is not a change of
   * the verdict either. The registration lasts for that one answer, and an
   * open that ends with no answer runs nothing. Does nothing once disposed,
   * or with a storage manager that cannot wait for an answer.
   */
  rerunOnAnswer(space: MemorySpace, action: Action): void {
    if (this.#disposed || this.#storage.awaitSpaceAnswer === undefined) {
      return;
    }
    this.#observeUnsubscribes();

    const actions = this.#answering.get(space);
    if (actions !== undefined) {
      actions.add(action);
      return;
    }
    this.#answering.set(space, new Set([action]));
    this.#storage.awaitSpaceAnswer(space).then(
      () => this.#answered(space),
      () => this.#answering.delete(space),
    );
  }

  /** Cancels the subscriptions and drops every registration. */
  dispose(): void {
    this.#disposed = true;
    for (const cancel of this.#cancels) cancel();
    this.#cancels = [];
    this.#waiting.clear();
    this.#answering.clear();
  }

  /**
   * Helper for the two registrations, which subscribes, once, to the
   * scheduler's word of an action it lets go.
   */
  #observeUnsubscribes(): void {
    if (this.#observingUnsubscribes) return;
    this.#observingUnsubscribes = true;
    this.#cancels.push(
      this.#scheduler.observeUnsubscribe((gone) => this.#forget(gone)),
    );
  }

  /**
   * Helper for the scheduler subscription, which drops every registration of
   * `action`.
   */
  #forget(action: Action): void {
    for (const registrations of [this.#waiting, this.#answering]) {
      for (const [space, actions] of registrations) {
        actions.delete(action);
        if (actions.size === 0) registrations.delete(space);
      }
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

  /**
   * Helper for {@link rerunOnAnswer}, which runs the actions waiting for the
   * server's answer for `space`.
   */
  #answered(space: MemorySpace): void {
    const actions = this.#answering.get(space);
    if (actions === undefined) return;
    this.#answering.delete(space);
    for (const action of actions) this.#scheduler.invalidateAction(action);
  }
}
