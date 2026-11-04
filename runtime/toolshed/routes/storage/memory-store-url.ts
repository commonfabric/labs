// The on-disk root URL for the memory engine's SQLite stores, derived purely
// from the environment. This is deliberately free of the live `MemoryServer`
// construction and its top-level `await`s (see memory.ts), so a module that
// only needs the store *location* — such as the dump router resolving a
// space's file — can import the URL without forcing the whole server, the
// identity setup, and the filesystem `ensureDir` to initialize first.

import * as Path from "@std/path";
import env from "@/env.ts";
import { resolveMemoryEngineStoreRootUrl } from "./memory-path.ts";

// DB_PATH selects single-file mode (an explicit, absolute database file);
// otherwise MEMORY_DIR selects directory mode. See env.ts for the defaults.
const storeUrl: URL = env.DB_PATH
  ? Path.toFileUrl(env.DB_PATH)
  : new URL(env.MEMORY_DIR);

export const memoryEngineStoreUrl = resolveMemoryEngineStoreRootUrl(storeUrl, {
  singleFileMode: Boolean(env.DB_PATH),
});
