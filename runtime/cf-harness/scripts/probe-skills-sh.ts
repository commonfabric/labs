/**
 * Hand-run probe of the public skills.sh search route, through the read-only
 * client the discovery half of `docs/plans/external-skill-acquisition.md`
 * describes.
 *
 * This is the only thing in the repository that calls the live registry, and
 * it is a script rather than a test on purpose: a test that reached the
 * network would be a flake first and an excuse to delete the test second. The
 * committed tests run against a captured response.
 *
 * It prints identifiers, names, and sources. It does not fetch, print, or
 * store skill text, and it is not wired into the tool registry -- no model can
 * reach any of this.
 *
 *   deno task probe-skills-sh "react native"
 *   deno task probe-skills-sh --owner expo "react native"
 */

import {
  SkillsShSearchClient,
  SkillsShSearchError,
} from "../src/skills-sh/search-client.ts";

const parseArguments = (
  argv: readonly string[],
): { query: string; owner?: string } | { usageError: string } => {
  const words: string[] = [];
  let owner: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--owner") {
      index += 1;
      owner = argv[index];
      // A flag whose value is missing must refuse, not silently drop the
      // filter and broaden the search.
      if (owner === undefined) return { usageError: "--owner needs a value" };
      continue;
    }
    words.push(argv[index]);
  }
  return { query: words.join(" "), ...(owner === undefined ? {} : { owner }) };
};

/** Runs the read-only probe and returns its process exit code. */
export const main = async (
  args: readonly string[],
  client?: Pick<SkillsShSearchClient, "search">,
  log: (line: string) => void = console.log,
  logError: (line: string) => void = console.error,
): Promise<number> => {
  const parsed = parseArguments(args);
  if ("usageError" in parsed || parsed.query.trim().length < 2) {
    if ("usageError" in parsed) logError(parsed.usageError);
    logError(
      'usage: deno task probe-skills-sh [--owner <owner>] "<query>"',
    );
    return 2;
  }
  const { query, owner } = parsed;

  const searchClient = client ?? new SkillsShSearchClient();
  let result;
  try {
    result = await searchClient.search({
      query,
      ...(owner === undefined ? {} : { owner }),
    });
  } catch (error) {
    if (error instanceof SkillsShSearchError) {
      logError(`refused (${error.code}): ${error.message}`);
      return 1;
    }
    throw error;
  }

  log(`${result.hits.length} hit(s), ${result.rejected} refused`);
  for (const hit of result.hits) {
    const installs = hit.installs === undefined
      ? "installs unknown"
      : `${hit.installs} reported installs (unverifiable)`;
    log(`  ${hit.id}`);
    log(`    name:    ${hit.name}`);
    log(`    source:  ${hit.source}`);
    log(`    signal:  ${installs}`);
  }
  if (result.rejected > 0) {
    log(
      `\n${result.rejected} entry(s) did not match the shape this client ` +
        "accepts and were dropped.",
    );
  }
  return 0;
};

// deno-coverage-ignore-start -- the entrypoint guard is false under every test
// that imports this module, which is what it is for
if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
// deno-coverage-ignore-stop
