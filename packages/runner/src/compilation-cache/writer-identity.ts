/**
 * The builtin identity the compile cache writes its documents under. Shared so
 * a check that must recognize the cache's writes (a reviewed intent refuses a
 * destination the cache stamped, since what it compiled can come from a
 * pattern) names the same identity the cache sets, without importing the
 * compiler.
 */
export const COMPILE_CACHE_WRITER = "compile-cache";
