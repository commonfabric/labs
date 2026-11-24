/**
 * What `cf piece getsrc` has to say about the data files of a source package it
 * wrote. Finding which ones the source declares parses it, so this sits apart
 * from `piece.ts`, whose other commands should not load the compiler.
 */

import { collectDataReads } from "@commonfabric/js-compiler";
import { TARGET } from "@commonfabric/js-compiler/typescript";
import type { RuntimeProgram } from "@commonfabric/runner";
import { dataFileAssets } from "@commonfabric/text/data-file";

import { shellWord } from "./shell-quote.ts";

/**
 * The data files a later `setsrc` would have to be told about.
 *
 * A file the recovered source reads by name is declared, and so is an asset
 * in a directory it reads with `dataFile.urls()`, so rebuilding the package
 * from this directory attaches it again on its own. A file the source
 * cannot name — one read by a computed path, or one that ships with a pattern
 * that does not read it — is on disk with nothing recording that it was data,
 * and would come back as an ordinary file nobody stores. Naming those is what
 * keeps the round trip whole.
 */
export function undeclaredDataFiles(program: RuntimeProgram): string[] {
  // A data file is never parsed. One already attached sits in `files` like any
  // other entry, and its bytes may happen to read as a `dataFile()` call.
  const attached = new Set(program.dataFiles ?? []);
  const declared = new Set<string>();
  for (const file of program.files) {
    if (attached.has(file.name)) continue;
    const { files, directories } = collectDataReads(file, TARGET);
    for (const name of files) declared.add(name);
    for (const directory of directories) {
      for (const name of dataFileAssets(directory, attached).values()) {
        declared.add(name);
      }
    }
  }
  return [...attached].filter((name) => !declared.has(name));
}

/**
 * What `getsrc` says about the data files it just wrote, or undefined when it
 * has nothing to say. The flags are spelled out so that reproducing the
 * revision is a matter of copying the line rather than working out which of
 * the written files were data.
 */
export function undeclaredDataFileWarning(
  program: RuntimeProgram,
): string | undefined {
  const undeclared = undeclaredDataFiles(program);
  if (undeclared.length === 0) return undefined;
  return `\nThis pattern carries ${undeclared.length} data file(s) its ` +
    `source does not name.\nPass them on the next setsrc, or they are ` +
    `dropped from that revision:\n` +
    undeclared.map((name) => `  --datafile ${shellWord(`.${name}`)}`).join(
      "\n",
    );
}
