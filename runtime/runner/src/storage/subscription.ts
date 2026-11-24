import { getLogger } from "@commonfabric/logger";
import type {
  IStorageNotification,
  IStorageNotificationCapability,
  IStorageSubscription,
  IStorageSubscriptionCapability,
  MemorySpace,
  StorageNotification,
} from "./interface.ts";

export const create = () => new StorageNotificationRelay();

/** Watches replica resets until canceled, including on subscribe-only managers. */
export function observeStorageResets(
  manager: IStorageNotificationCapability,
  onReset: (space: MemorySpace) => void,
): () => void {
  let notify: typeof onReset | undefined = onReset;
  const observer: IStorageNotification = {
    next(notification) {
      if (!notify) return { done: true };
      if (notification.type === "reset") notify(notification.space);
      return { done: false };
    },
  };
  manager.subscribe(observer);
  return () => {
    notify = undefined;
    manager.unsubscribe?.(observer);
  };
}

/**
 * Storage subscription that can be used by consumers to subscribe to storage
 * notifications and by storage to broadcast them to all subscribers.
 */
export class StorageNotificationRelay
  implements
    IStorageNotificationCapability,
    IStorageSubscriptionCapability,
    IStorageNotification,
    IStorageSubscription {
  #subscribers: Set<IStorageNotification>;
  constructor(subscribers: Set<IStorageNotification> = new Set()) {
    this.#subscribers = subscribers;
  }
  subscribe(subscription: IStorageNotification): void {
    this.#subscribers.add(subscription);
  }
  unsubscribe(subscription: IStorageNotification): void {
    this.#subscribers.delete(subscription);
  }
  hasSubscribers(): boolean {
    return this.#subscribers.size > 0;
  }
  next(notification: StorageNotification) {
    for (const subscriber of this.#subscribers) {
      try {
        if (subscriber.next(notification)?.done) {
          this.#subscribers.delete(subscriber);
        }
      } catch (error) {
        getLogger("storage.subscription").error(
          `Storage subscription threw an error: ${error}`,
        );
      }
    }
    return { done: false };
  }
}
