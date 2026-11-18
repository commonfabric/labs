import { rootCommandFor } from "./root.ts";

/**
 * Runs the command `args` address. `colors` decides whether help is colored,
 * since Cliffy's help generator ignores the global color flag: it force-sets
 * its own `colors` option while rendering. Help settings inherit, so setting
 * them on the root covers every subcommand.
 */
export async function parse(args: string[], colors: boolean) {
  const root = await rootCommandFor(args);
  return await root.help({ colors }).parse(args);
}
