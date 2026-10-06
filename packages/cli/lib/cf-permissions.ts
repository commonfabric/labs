/**
 * The Deno permissions the cf CLI runs with when the launcher, the compiled
 * binary's build, or another TypeScript module starts it. The `deno.jsonc`
 * tasks that run its entry point repeat them. `networkInterfaces` lets
 * `cf agent runner`'s web_fetch read the networks this device's interfaces
 * are on, which it refuses to fetch from.
 */
export const CF_PERMISSION_FLAGS = [
  "--allow-net", // also for @db/sqlite's lazy download
  "--allow-ffi", // for @db/sqlite
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-run",
  "--allow-sys=networkInterfaces",
] as const;
