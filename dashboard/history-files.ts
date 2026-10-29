/**
 * Decides where the dashboard's on-disk caches live, so every store that keeps
 * history across restarts agrees on one directory. DASHBOARD_CACHE_DIR names
 * it outright; without that the caches fall back to the temporary directory
 * the platform offers.
 */

import { join } from "@std/path";

type Environment = (name: string) => string | undefined;

export function dashboardCacheDirectory(
  env: Environment = Deno.env.get,
): string {
  return env("DASHBOARD_CACHE_DIR") ?? env("TMPDIR") ?? env("TEMP") ??
    env("TMP") ?? (Deno.build.os === "windows" ? "." : "/tmp");
}

export function dashboardCacheFile(
  basename: string,
  env: Environment = Deno.env.get,
): string {
  return join(dashboardCacheDirectory(env), basename);
}
