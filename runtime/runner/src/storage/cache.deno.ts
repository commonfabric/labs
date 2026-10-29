export * from "@commonfabric/memory/interface";
import * as V2Storage from "./v2.ts";
import { EmulatedStorageManager } from "./v2-emulate.ts";

export { EmulatedStorageManager, newLoopbackServer } from "./v2-emulate.ts";
export { EmulatedStorageManager as StorageManagerEmulator } from "./v2-emulate.ts";
export { SelectorTracker } from "./selector-tracker.ts";
export { type Options, type SessionFactory, watchIdForEntry } from "./v2.ts";

export class StorageManager extends V2Storage.StorageManager {
  static override open(options: V2Storage.Options): V2Storage.StorageManager {
    return V2Storage.StorageManager.open(options);
  }

  static emulate(
    options: Omit<V2Storage.Options, "memoryHost" | "spaceHostMap">,
  ): EmulatedStorageManager {
    return EmulatedStorageManager.emulate(options);
  }
}
