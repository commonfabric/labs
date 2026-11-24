export * from "@commonfabric/memory/interface";
import * as V2Storage from "./v2.ts";

export { SelectorTracker } from "./selector-tracker.ts";
export { type Options, type SessionFactory, watchIdForEntry } from "./v2.ts";

export class StorageManager {
  static open(options: V2Storage.Options): V2Storage.StorageManager {
    return V2Storage.StorageManager.open(options);
  }
}
