import { join } from "@std/path";

/**
 * The script URL of every V8 coverage profile in `dir`, one entry per profile
 * and sorted, as a test that runs a child Deno with `DENO_COVERAGE_DIR` pointed
 * at `dir` reads them afterwards.
 *
 * @throws If a profile does not parse, naming the file. A process that exits
 *   partway through writing a profile leaves one like that, and `deno
 *   coverage` refuses every profile in a directory holding one.
 */
export async function readCoverageProfileUrls(dir: string): Promise<string[]> {
  const urls: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const text = await Deno.readTextFile(join(dir, entry.name));
    let profile: { url: string };
    try {
      profile = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `coverage profile ${entry.name} is incomplete (${text.length} bytes)`,
        { cause: error },
      );
    }
    urls.push(profile.url);
  }
  return urls.sort();
}
