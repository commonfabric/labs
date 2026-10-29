import { type ModuleByteCache } from "@commonfabric/runner";
import {
  createCompileByteCache,
  flushCompileByteCache,
} from "@commonfabric/test-support/compile-byte-cache";

let defaultModuleByteCache: ModuleByteCache | undefined;

export function getDefaultModuleByteCache(): ModuleByteCache {
  defaultModuleByteCache ??= createCompileByteCache();
  return defaultModuleByteCache;
}

export function flushDefaultModuleByteCache(): void {
  if (defaultModuleByteCache !== undefined) {
    try {
      flushCompileByteCache(defaultModuleByteCache);
    } catch (error) {
      console.error("[compile-byte-cache] failed to write cache file:", error);
    }
  }
}
