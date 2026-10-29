// The import below must resolve to the same @std/fmt instance Cliffy uses
// (see the "@std/fmt/colors" pin in runtime/cli/deno.jsonc); a second
// instance would leave Cliffy's help/version/usage output colored even when
// this module disables colors.
import { setColorEnabled } from "@std/fmt/colors";

/**
 * Read an env var, returning undefined instead of throwing. Deno.env.get
 * throws on a missing --allow-env permission (and on an invalid key), which
 * should degrade to "unset" rather than crash color resolution.
 */
export function safeEnvGet(key: string): string | undefined {
  try {
    return Deno.env.get(key);
  } catch {
    return undefined;
  }
}

/**
 * Extract `--no-color` from args before Cliffy sees it.
 * Returns whether the flag was present and the cleaned args array.
 *
 * Scanning stops at the first `--`: everything after it is a payload for the
 * target command (e.g. a schema-derived handler flag named `--no-color`), and
 * silently eating it would be exactly the kind of no-op this CLI is trying to
 * stamp out. Use `cf --no-color <cmd> -- --no-color` to set both.
 */
export function extractNoColor(
  args: string[],
): { noColor: boolean; args: string[] } {
  const end = args.indexOf("--");
  const scanned = end === -1 ? args : args.slice(0, end);
  const passthrough = end === -1 ? [] : args.slice(end);
  const cleaned = scanned.filter((arg) => arg !== "--no-color");
  return {
    noColor: cleaned.length !== scanned.length,
    args: [...cleaned, ...passthrough],
  };
}

/**
 * Decide whether ANSI colors should be emitted.
 *
 * Precedence (disable wins): `--no-color` flag, then a set `NO_COLOR` env var,
 * then `FORCE_COLOR`/`CLICOLOR_FORCE` (any value except "" or "0" forces color
 * even when piped), then stdout TTY detection.
 *
 * `NO_COLOR` is read from the raw env rather than trusting `denoNoColor`:
 * Deno pre-arbitrates FORCE_COLOR over NO_COLOR (so `Deno.noColor` is `false`
 * under `NO_COLOR=1 FORCE_COLOR=1`), but it does not know CLICOLOR_FORCE. Left
 * unchecked, the two force vars would rank inconsistently against NO_COLOR;
 * reading the raw var keeps NO_COLOR winning over both.
 *
 * Note `cf view` keeps its own `--color always|auto|never` flag; "always"
 * bypasses this policy because the pager writes raw SGR sequences itself.
 */
export function resolveColorEnabled(opts: {
  noColorFlag: boolean;
  denoNoColor: boolean;
  isTerminal: boolean;
  env: (key: string) => string | undefined;
}): boolean {
  if (opts.noColorFlag) return false;
  if (opts.denoNoColor || (opts.env("NO_COLOR") ?? "") !== "") return false;
  const force = opts.env("FORCE_COLOR") ?? opts.env("CLICOLOR_FORCE");
  if (force !== undefined && force !== "" && force !== "0") return true;
  return opts.isTerminal;
}

/**
 * Resolve the color policy from CLI args and environment and apply it,
 * returning the args with `--no-color` removed plus the decision.
 *
 * Callers must also pass `enabled` to the root command's Cliffy help options
 * (`main.help({ colors: enabled })`): Cliffy's HelpGenerator saves, force-sets
 * and restores the global color flag while rendering, so `setColorEnabled`
 * alone cannot reach help/usage output.
 *
 * When colors are disabled, `NO_COLOR=1` is also exported so spawned child
 * processes (workers, `cf check` pipelines) inherit the decision.
 */
export function applyColorMode(
  args: string[],
): { args: string[]; enabled: boolean } {
  const { noColor, args: cleanArgs } = extractNoColor(args);
  const enabled = resolveColorEnabled({
    noColorFlag: noColor,
    denoNoColor: Deno.noColor,
    isTerminal: Deno.stdout.isTerminal(),
    env: safeEnvGet,
  });
  setColorEnabled(enabled);
  if (!enabled) {
    Deno.env.set("NO_COLOR", "1");
  }
  return { args: cleanArgs, enabled };
}
