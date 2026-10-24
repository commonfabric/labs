// Version axis of the durable compile cache: the `<version>` segment of
// `compileCache:<version>/<identity>` keys. The checked-in active value is a
// stable source marker. Deno source runs resolve it to the committed version
// below, or to the current compiler-input fingerprint when the tree's compiler
// is not the one that version was minted against. Runtimes without repository
// file access skip the compiled cache until a binary build writes the resolved
// version here.
//
// The committed version and the inputs it was minted against are written by
// `deno task compile-cache-version` and held by `check-compile-cache-version`.
export const SOURCE_COMPILE_CACHE_RUNTIME_VERSION = "cf/esm-compile/source";
export const COMPILE_CACHE_RUNTIME_VERSION =
  SOURCE_COMPILE_CACHE_RUNTIME_VERSION;
export const COMMITTED_COMPILE_CACHE_VERSION =
  "cf/esm-compile/-rXvaLcB7Ce0aSK6";
export const COMMITTED_COMPILE_CACHE_VERSION_INPUTS = "WxaFuaiKvMSzIcuk";
