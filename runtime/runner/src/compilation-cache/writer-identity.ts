/** The builtin identity the compile cache writes its documents under. */
export const COMPILE_CACHE_WRITER = "compile-cache";

/**
 * The builtin identity the repair of a compile-cache record a flow stamp
 * labeled writes under
 * (`ExtendedStorageTransaction.writeRepairedCompileCacheRecord()`).
 */
export const COMPILE_CACHE_REPAIR_WRITER = "compile-cache-repair";

/** The prefix of a source record's key (`sourceDocKey()`). */
export const COMPILE_CACHE_SOURCE_KEY_PREFIX = "pattern:";

/** The prefix of a compiled record's key (`compiledDocKey()`). */
export const COMPILE_CACHE_COMPILED_KEY_PREFIX = "compileCache:";
