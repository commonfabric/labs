import { type LogLevel, setGlobalLogFloor } from "@commonfabric/utils/logger";

const VALID_LOG_LEVELS = new Set([
  "debug",
  "info",
  "warn",
  "error",
  "silent",
]);

/**
 * Extract --log-level <level> from args before Cliffy sees them.
 * Returns the level (if found) and the cleaned args array.
 *
 * Scanning stops at the first `--`: everything after it is a payload for the
 * target command (e.g. a schema-derived handler flag named `--log-level`),
 * and silently eating it would drop handler input. Mirrors extractNoColor in
 * color-mode.ts. Use `cf --log-level error <cmd> -- --log-level error` to set
 * both.
 */
export function extractLogLevel(
  args: string[],
): { level: string | undefined; args: string[] } {
  const end = args.indexOf("--");
  const scanned = end === -1 ? args : args.slice(0, end);
  const passthrough = end === -1 ? [] : args.slice(end);
  const cleaned: string[] = [];
  let level: string | undefined;
  for (let i = 0; i < scanned.length; i++) {
    if (scanned[i] === "--log-level" && i + 1 < scanned.length) {
      const candidate = scanned[i + 1];
      if (VALID_LOG_LEVELS.has(candidate)) {
        level = candidate;
        i++; // skip the value
        continue;
      }
    }
    cleaned.push(scanned[i]);
  }
  return { level, args: [...cleaned, ...passthrough] };
}

/**
 * Resolve the global log floor from CLI args and apply it, returning the args
 * with `--log-level <level>` removed.
 *
 * An explicit `--log-level` wins. Otherwise a pre-set `CF_LOG_LEVEL` env var is
 * left as-is (its floor was applied at module load). Otherwise the floor
 * defaults to `warn` so transformer-pipeline diagnostics reach authors; on the
 * happy path no runtime `logger.warn` fires, so this stays quiet in practice.
 */
export function applyLogLevel(args: string[]): string[] {
  const { level, args: cleanArgs } = extractLogLevel(args);
  if (level) {
    setGlobalLogFloor(level as LogLevel);
    Deno.env.set("CF_LOG_LEVEL", level); // workers inherit
  } else if (!Deno.env.get("CF_LOG_LEVEL")) {
    setGlobalLogFloor("warn" as LogLevel);
    Deno.env.set("CF_LOG_LEVEL", "warn");
  }
  return cleanArgs;
}
