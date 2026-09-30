// Build metadata baked into the toolshed binary at compile time.
//
// `tasks/build-binaries.ts` writes `packages/toolshed/COMPILED` and includes
// it in the binary via `deno compile --include`. At runtime we read it
// (synchronously, once) to surface the deployed commit on `/api/meta`.
//
// In non-compiled runs (e.g. `deno task production` from a checkout) the file
// does not exist and `commitSha` is null. `resolveGitSha()` then uses an
// explicit toolshed override if present, otherwise the source-run COMMIT_SHA
// fallback, so `/api/meta` presents the same field as a compiled binary.

import {
  type BuildInfo,
  normalize,
  readBuildInfoFrom,
} from "@commonfabric/utils/build-info";
import { isObjectOrArray } from "@commonfabric/utils/types";
import env from "@/env.ts";

export { type BuildInfo, normalize, readBuildInfoFrom };

const COMPILED_PATH = new URL("../COMPILED", import.meta.url);

export const buildInfo: BuildInfo = readBuildInfoFrom(COMPILED_PATH);

/**
 * The raw `EXPERIMENTAL_SERVER_EXECUTION` value present in the build
 * environment when this binary was built — the value the browser shell
 * BAKED as its esbuild define (packages/shell/felt.config.ts; the shell
 * has no serve-time override) — or null when it was unset (the shell then
 * follows `SERVER_EXECUTION_DEFAULT_ENABLED`) and in a source run. Same
 * failure posture as `readBuildInfoFrom`: an unreadable or malformed
 * marker reads as null. Surfaced on `/api/meta` as
 * `shellServerExecutionDefine` so CI's server-execution lanes can verify
 * the posture the binary they run actually carries
 * (docs/specs/server-side-execution/testing.md §2).
 */
export function readShellServerExecutionDefineFrom(
  path: URL | string,
): string | null {
  let raw: string;
  try {
    raw = Deno.readTextFileSync(path);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObjectOrArray(parsed)) return null;
  const value = (parsed as { shellServerExecutionDefine?: unknown })
    .shellServerExecutionDefine;
  return typeof value === "string" ? normalize(value) : null;
}

export const shellServerExecutionDefine: string | null =
  readShellServerExecutionDefineFrom(COMPILED_PATH);

/**
 * Pure precedence function used by `resolveGitSha()`. Exposed so it can be
 * tested without manipulating env or filesystem state.
 */
export function resolveGitShaFrom(
  explicitValue: string | null | undefined,
  baked: string | null,
  sourceRunValue: string | null | undefined,
): string | null {
  return normalize(explicitValue) ?? normalize(baked) ??
    normalize(sourceRunValue);
}

/**
 * Canonical git SHA for this server, surfaced on `/api/meta` to report
 * the deployed commit.
 *
 * Precedence:
 *   1. `TOOLSHED_GIT_SHA` env var — explicit override, useful for hot-patched
 *      binaries where you want to report a different commit than what was
 *      compiled.
 *   2. SHA baked into the binary at build time (read above).
 *   3. `COMMIT_SHA` env var — source-run metadata fallback, used only when
 *      there is no explicit toolshed override or compiled build metadata.
 *   4. `null` — `/api/meta` reports null.
 *
 * Empty / whitespace-only values at any level are treated as unset.
 */
export function resolveGitSha(): string | null {
  return resolveGitShaFrom(
    env.TOOLSHED_GIT_SHA,
    buildInfo.commitSha,
    env.COMMIT_SHA,
  );
}
