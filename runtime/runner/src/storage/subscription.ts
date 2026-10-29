import { getLogger } from "@commonfabric/utils/logger";
import {
  IStorageNotification,
  IStorageNotificationCapability,
  IStorageSubscription,
  IStorageSubscriptionCapability,
  StorageNotification,
} from "./interface.ts";

export const create = () => new StorageNotificationRelay();

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
