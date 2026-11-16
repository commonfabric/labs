#!/usr/bin/env -S deno run --allow-read --allow-write
import { walk } from "@std/fs/walk";
import * as path from "@std/path";
import { type LcovFileCoverage, parseLcovReports } from "./lcov.ts";

/**
 * Merge one or more LCOV reports into a single report. A lane's reports name
 * each file of the repository by its repository-relative path, so the merged
 * report maps onto any checkout. Records that refer to the same source file
 * collapse into one, with per-line execution counts summed, so a file
 * exercised by several test jobs is reported once with its combined coverage
 * rather than as repeated records that some LCOV consumers keep only the last
 * of.
 *
 * Only line coverage (`DA`/`LF`/`LH`) is carried through; `parseLcovReports`
 * explains what the other record kinds cost to merge.
 */
export function mergeLcovReports(
  reports: string[],
): { lcov: string; fileCount: number } {
  const files = parseLcovReports(reports);

  const paths = [...files.keys()].sort();
  const blocks = paths.map((sourcePath) =>
    serializeFileCoverage(sourcePath, files.get(sourcePath)!)
  );
  const lcov = blocks.length === 0 ? "" : `${blocks.join("\n")}\n`;
  return { lcov, fileCount: files.size };
}

function serializeFileCoverage(
  sourcePath: string,
  file: LcovFileCoverage,
): string {
  const lines: string[] = [];
  if (file.testName) lines.push(`TN:${file.testName}`);
  lines.push(`SF:${sourcePath}`);

  const lineNumbers = [...file.lineHits.keys()].sort((a, b) => a - b);
  let linesHit = 0;
  for (const lineNumber of lineNumbers) {
    const hits = file.lineHits.get(lineNumber)!;
    if (hits > 0) linesHit++;
    lines.push(`DA:${lineNumber},${hits}`);
  }
  lines.push(`LF:${lineNumbers.length}`);
  lines.push(`LH:${linesHit}`);
  lines.push("end_of_record");
  return lines.join("\n");
}

/**
 * Every `.lcov` report under `dir`. A missing input directory means no coverage
 * was downloaded and yields no files; anything that goes wrong once the walk is
 * under way is reported, so a report that is present but unreadable cannot
 * shorten the merged output unnoticed.
 */
async function collectLcovFiles(dir: string): Promise<string[]> {
  try {
    await Deno.stat(dir);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }

  const files: string[] = [];
  for await (
    const entry of walk(dir, { includeDirs: false, exts: [".lcov"] })
  ) {
    files.push(entry.path);
  }
  return files;
}

/** Read every LCOV report under `inputDir` and merge them into one. */
export async function combineCoverageLcov(
  inputDir: string,
): Promise<{ lcov: string; fileCount: number }> {
  const files = (await collectLcovFiles(inputDir)).sort();

  const reports: string[] = [];
  for (const file of files) {
    const text = await Deno.readTextFile(file);
    if (text.trim().length > 0) reports.push(text);
  }

  return mergeLcovReports(reports);
}

export function parseArgs(args: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const arg of args) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) parsed.set(match[1], match[2]);
  }
  return parsed;
}

/** Run the command-line interface; returns the process exit code. */
export async function main(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  const inputDir = parsed.get("input-dir");
  const outputPath = parsed.get("output");
  if (!inputDir || !outputPath) {
    console.error(
      "Usage: deno run --allow-read --allow-write tasks/combine-coverage-lcov.ts " +
        "--input-dir=<dir> --output=<combined.lcov>",
    );
    return 2;
  }

  const { lcov, fileCount } = await combineCoverageLcov(inputDir);

  await Deno.mkdir(path.dirname(outputPath), { recursive: true });
  await Deno.writeTextFile(outputPath, lcov);

  console.log(
    `Merged line coverage for ${fileCount} source file(s) into ${outputPath}.`,
  );
  return 0;
}

if (import.meta.main) Deno.exit(await main(Deno.args));
