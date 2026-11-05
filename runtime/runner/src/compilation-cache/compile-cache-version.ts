// Version axis of the durable compile cache: the `<version>` segment of
// `compileCache:<version>/<identity>` keys. The checked-in value is a stable
// source marker. Deno source runs resolve it to the current compiler-input
// fingerprint at runtime. Runtimes without repository file access skip the
// compiled cache until a binary build writes the computed fingerprint here.
export const SOURCE_COMPILE_CACHE_RUNTIME_VERSION = "cf/esm-compile/source";
export const COMPILE_CACHE_RUNTIME_VERSION =
  SOURCE_COMPILE_CACHE_RUNTIME_VERSION;
