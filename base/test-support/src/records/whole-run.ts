/**
 * Which tests a test process ran, as the process itself vouches for it,
 * for a runner whose files make one unit between them.
 *
 * A runner that writes each record as its test finishes leaves records
 * behind whether or not it reached its end, and a file it never loaded
 * leaves nothing at all, so the records cannot say whether a test is
 * missing from them because the tree no longer holds it or because the
 * process stopped before reaching it. A process that loaded every file
 * it was handed and ran every test each registered says so by leaving a
 * mark in its spool naming those tests, and a process that stopped part
 * way leaves none.
 */

import { join } from "@std/path";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { type Environment, recordsDir } from "./paths.ts";
import { writableSpool } from "./registration.ts";

/** What a mark's file name starts with, inside the spool. */
const WHOLE_RUN_PREFIX = "whole-run-";

/** What it ends with; the whole name is `whole-run-<uuid>.json`. */
const WHOLE_RUN_SUFFIX = ".json";

/** One process's statement that it ran every test of every file it ran. */
export interface WholeRun {
  /** The kind every record of the run carries. */
  kind: string;

  /** The scope every record of the run carries. */
  scope: string;

  /**
   * Every test the run registered, by the repository-relative file that
   * registered it.
   */
  tests: Record<string, string[]>;
}

/**
 * Leaves a mark in the spool `env` names saying that this process ran
 * every test of `run`. Does nothing where no spool is named or this
 * process may not write to it, and warns where the write fails, since a
 * missing mark costs a reader only the statement it makes.
 */
export function markWholeRun(
  run: WholeRun,
  env: Environment = Deno.env.get,
): void {
  const spool = recordsDir(env);
  if (spool === undefined || !writableSpool(spool)) return;
  try {
    Deno.mkdirSync(spool, { recursive: true });
    Deno.writeTextFileSync(
      join(
        spool,
        `${WHOLE_RUN_PREFIX}${crypto.randomUUID()}${WHOLE_RUN_SUFFIX}`,
      ),
      JSON.stringify(run),
    );
  } catch (error) {
    console.warn(`test records: cannot mark a whole run: ${error}`);
  }
}

/**
 * Every mark in `spool`. A mark that does not read as one says nothing,
 * and a spool that does not exist holds no marks.
 *
 * @throws Whatever reading the spool or a mark in it throws, other than
 *   its not being there.
 */
export async function readWholeRuns(spool: string): Promise<WholeRun[]> {
  const runs: WholeRun[] = [];
  try {
    for await (const entry of Deno.readDir(spool)) {
      if (
        !entry.isFile || !entry.name.startsWith(WHOLE_RUN_PREFIX) ||
        !entry.name.endsWith(WHOLE_RUN_SUFFIX)
      ) {
        continue;
      }
      const run = asWholeRun(await Deno.readTextFile(join(spool, entry.name)));
      if (run !== undefined) runs.push(run);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return runs;
}

/** The run a mark's text holds, or undefined for anything else. */
function asWholeRun(text: string): WholeRun | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObjectNotArray(parsed)) return undefined;
  const { kind, scope, tests } = parsed;
  if (typeof kind !== "string" || typeof scope !== "string") return undefined;
  if (!isObjectNotArray(tests)) return undefined;
  const byFile: Record<string, string[]> = {};
  for (const [file, names] of Object.entries(tests)) {
    if (!Array.isArray(names)) return undefined;
    const strings = names.filter((name) => typeof name === "string");
    if (strings.length !== names.length) return undefined;
    byFile[file] = strings;
  }
  return { kind, scope, tests: byFile };
}
