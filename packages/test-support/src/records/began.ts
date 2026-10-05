/**
 * When a test process began running its units, as the process itself saw
 * it.
 *
 * A process a lane starts spends time before its first unit begins:
 * `deno test` loads and type-checks the module graph of every file it was
 * handed, and the pattern test runner starts up and finds its files. No
 * test's duration holds that time, and the lane sees only when the
 * process started and when it ended. So the process leaves a mark in its
 * spool at the moment its units begin, and the lane reads the earliest
 * mark once the process has ended. The mark holds the wall-clock time in
 * milliseconds since the epoch, which the lane compares with its own
 * clock when it started the process: the two run on one machine.
 *
 * A process with several workers, such as `deno test`, which starts one
 * per test file, leaves one mark per worker, and the earliest is when the
 * first unit began.
 */

import { join } from "@std/path";
import { type Environment, recordsDir } from "./paths.ts";
import { writableSpool } from "./registration.ts";

/** What a mark's file name starts with, inside the spool. */
export const BEGAN_PREFIX = "began-";

/** What it ends with; the whole name is `began-<uuid>.json`. */
export const BEGAN_SUFFIX = ".json";

/**
 * Leaves a mark in the spool `env` names saying that this process's units
 * begin at `now`. Does nothing where no spool is named or this process
 * may not write to it, and warns where the write fails, since a missing
 * mark costs a measurement and nothing else.
 */
export function markUnitsBegan(
  env: Environment = Deno.env.get,
  now: number = Date.now(),
): void {
  const spool = recordsDir(env);
  if (spool === undefined || !writableSpool(spool)) return;
  try {
    Deno.mkdirSync(spool, { recursive: true });
    Deno.writeTextFileSync(
      join(spool, `${BEGAN_PREFIX}${crypto.randomUUID()}${BEGAN_SUFFIX}`),
      JSON.stringify(now),
    );
  } catch (error) {
    console.warn(`test records: cannot mark when units began: ${error}`);
  }
}

/**
 * The earliest time a mark in `spool` says units began, in milliseconds
 * since the epoch, or `undefined` where the spool holds no mark that
 * reads as one, or does not exist.
 *
 * @throws Whatever reading the spool or a mark in it throws, other than
 *   its not being there: a mark that cannot be read is a measurement lost,
 *   and passing over it would count the process's setup as its units'
 *   time.
 */
export async function unitsBegan(spool: string): Promise<number | undefined> {
  let earliest: number | undefined;
  try {
    for await (const entry of Deno.readDir(spool)) {
      if (
        !entry.isFile || !entry.name.startsWith(BEGAN_PREFIX) ||
        !entry.name.endsWith(BEGAN_SUFFIX)
      ) {
        continue;
      }
      const at = parsed(await Deno.readTextFile(join(spool, entry.name)));
      if (typeof at !== "number" || !Number.isFinite(at)) continue;
      if (earliest === undefined || at < earliest) earliest = at;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return earliest;
}

/**
 * Helper for `unitsBegan()`, which reads a mark, or nothing for text that
 * is not JSON.
 */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
