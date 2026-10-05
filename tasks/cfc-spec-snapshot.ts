#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run=git --allow-env=CF_SPECS_DIR,HOME

/**
 * Generates the spec snapshot the correspondence check reads: the structure
 * of the Contextual Flow Control specification, and nothing of its text.
 *
 * The specification lives in `commonfabric/specs`, which is private, and this
 * repository is public, so nothing the public build runs may read it. What
 * crosses is this snapshot, committed at
 * `packages/runner/src/cfc/kernel/spec-snapshot.json`: the specs commit it
 * was read at, every section number a chapter heading carries, and for every
 * function a pseudocode block defines, the chapter file, the nearest
 * preceding section number, the function name and a SHA-256 of the block.
 * Section numbers already appear in the runner's comments, function names
 * already appear in the runner's code, and a hash is not reversible, so the
 * file holds no spec prose.
 *
 * The chapters are read through git at a named revision rather than from the
 * working tree, so the snapshot is a function of the commit it records and a
 * checkout on another branch, or with uncommitted edits, cannot leak into it.
 * `CF_SPECS_DIR` names the `cfc/` directory of a specs checkout, defaulting to
 * `~/src/specs/cfc`; `--rev` names the revision, defaulting to `HEAD`.
 *
 * A pseudocode block is a fenced code block whose opener is three backticks
 * followed by `typescript` or `ts`. Its hash is taken over its lines with
 * trailing whitespace removed, joined by `\n`, with no trailing newline, so a
 * rewrap of the fence's indentation or a line-ending change is not a change
 * to the block and an edit to its code is. Every block defining a function
 * contributes one entry per `function NAME(` it defines, each carrying the
 * block's hash; a block defining several functions gives them one hash.
 *
 * The function entries cover the normative chapters that state pseudocode a
 * runtime executes: 03 through 08-*, 10, 17 and 18. The section list covers
 * every numbered chapter file.
 *
 * Usage: deno task cfc-spec-snapshot [--rev <revision>]
 */

import { encodeHex } from "@std/encoding/hex";
import { dirname, fromFileUrl, join } from "@std/path";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/** Where the snapshot is written, repository-relative. */
export const SNAPSHOT_PATH =
  "packages/runner/src/cfc/kernel/spec-snapshot.json";

/** One function a pseudocode block defines. */
export interface SnapshotFunction {
  /** The chapter file, e.g. `08-12-store-label-monotonicity.md`. */
  readonly file: string;

  /** The nearest section number heading the block, e.g. `8.12.1`. */
  readonly section: string;

  /** The function's name as the block declares it. */
  readonly name: string;

  /** SHA-256 of the normalized block, as lowercase hex. */
  readonly sha256: string;
}

/** The committed snapshot. */
export interface SpecSnapshot {
  /** The full hash of the specs commit the chapters were read at. */
  readonly specsCommit: string;

  /**
   * Every section number a heading carries in a numbered chapter file,
   * chapter numbers included, in numeric order.
   */
  readonly sections: readonly string[];

  /** Every function a pseudocode block defines, in chapter and file order. */
  readonly functions: readonly SnapshotFunction[];
}

/** A chapter file by name, with its text. */
export interface ChapterFile {
  /** The file's name within `cfc/`. */
  readonly name: string;

  readonly text: string;
}

/** A chapter file this task reads for sections. */
const CHAPTER_FILE = /^\d.*\.md$/;

/** A chapter file this task reads for pseudocode functions as well. */
const PSEUDOCODE_CHAPTER = /^(?:0[3-8]|10|17|18)-/;

/**
 * A numbered heading: one to six `#`, the number, an optional trailing dot
 * (chapter headings are written `# 8. Title`), and a space before the title.
 */
const NUMBERED_HEADING = /^#{1,6}\s+(\d+(?:\.\d+)*)\.?\s/;

/** The opener of a pseudocode fence. */
const FENCE_OPEN = /^\s*```(?:typescript|ts)\s*$/;

/** The closer of any fence. */
const FENCE_CLOSE = /^\s*```\s*$/;

/**
 * A function declaration at the start of a line, allowing `export` and
 * `async`, and type parameters before the parameter list.
 */
const FUNCTION_DECLARATION =
  /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;

/** Orders two section numbers by their components, numerically. */
export function compareSections(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? -1;
    const r = right[i] ?? -1;
    if (l !== r) return l - r;
  }
  return 0;
}

/** The lines of a block as its hash reads them. */
export function normalizeBlock(lines: readonly string[]): string {
  return lines.map((line) => line.replace(/\s+$/, "")).join("\n");
}

/** SHA-256 of `text`, as lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return encodeHex(new Uint8Array(digest));
}

/** Every section number a chapter's headings carry, in document order. */
export function sectionsOf(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    const match = NUMBERED_HEADING.exec(line);
    if (match) found.push(match[1]);
  }
  return found;
}

/**
 * Every function a chapter's pseudocode blocks define, in document order,
 * each under the nearest numbered heading above its block. A block above the
 * chapter's first numbered heading is attributed to an empty section.
 */
export async function functionsOf(
  file: string,
  text: string,
): Promise<SnapshotFunction[]> {
  const found: SnapshotFunction[] = [];
  let section = "";
  let block: string[] | null = null;
  for (const line of text.split("\n")) {
    if (block === null) {
      const heading = NUMBERED_HEADING.exec(line);
      if (heading) {
        section = heading[1];
      } else if (FENCE_OPEN.test(line)) {
        block = [];
      }
      continue;
    }
    if (FENCE_CLOSE.test(line)) {
      const sha256 = await sha256Hex(normalizeBlock(block));
      for (const blockLine of block) {
        const declaration = FUNCTION_DECLARATION.exec(blockLine);
        if (declaration) {
          found.push({ file, section, name: declaration[1], sha256 });
        }
      }
      block = null;
      continue;
    }
    block.push(line);
  }
  return found;
}

/** Builds the snapshot from the chapter files, read at `specsCommit`. */
export async function buildSnapshot(
  specsCommit: string,
  chapters: readonly ChapterFile[],
): Promise<SpecSnapshot> {
  const sorted = [...chapters]
    .filter((chapter) => CHAPTER_FILE.test(chapter.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const sections = new Set<string>();
  const functions: SnapshotFunction[] = [];
  for (const chapter of sorted) {
    for (const section of sectionsOf(chapter.text)) sections.add(section);
    if (PSEUDOCODE_CHAPTER.test(chapter.name)) {
      for (const found of await functionsOf(chapter.name, chapter.text)) {
        functions.push(found);
      }
    }
  }
  return {
    specsCommit,
    sections: [...sections].sort(compareSections),
    functions,
  };
}

/** Runs `git` in `directory` and returns its standard output, or throws. */
async function git(
  directory: string,
  args: readonly string[],
): Promise<string> {
  const { code, stdout, stderr } = await new Deno.Command("git", {
    args: ["-C", directory, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    const message = new TextDecoder().decode(stderr).trim();
    throw new Error(
      `\`git ${args.join(" ")}\` failed in ${directory}: ${message}`,
    );
  }
  return new TextDecoder().decode(stdout);
}

/**
 * Reads the chapter files of the `cfc/` directory at `directory` as they
 * stand at `rev` in that checkout's repository, with the commit `rev` names.
 */
export async function readChaptersAt(
  directory: string,
  rev: string,
): Promise<{ specsCommit: string; chapters: ChapterFile[] }> {
  const specsCommit = (await git(directory, ["rev-parse", `${rev}^{commit}`]))
    .trim();
  const prefix = (await git(directory, ["rev-parse", "--show-prefix"])).trim();
  // `--full-tree`: without it `ls-tree` filters its listing by the
  // directory `git -C` runs in, and lists nothing of a tree named outright.
  const names = (await git(directory, [
    "ls-tree",
    "--full-tree",
    "--name-only",
    `${specsCommit}:${prefix}`,
  ])).split("\n").filter((name) => CHAPTER_FILE.test(name));
  const chapters: ChapterFile[] = [];
  for (const name of names) {
    chapters.push({
      name,
      text: await git(directory, ["show", `${specsCommit}:${prefix}${name}`]),
    });
  }
  return { specsCommit, chapters };
}

/** The `cfc/` directory of the specs checkout this run reads. */
function specsDirectory(): string {
  const configured = Deno.env.get("CF_SPECS_DIR");
  if (configured !== undefined && configured !== "") return configured;
  const home = Deno.env.get("HOME");
  if (home === undefined) {
    throw new Error(
      "Set `CF_SPECS_DIR` to the `cfc/` directory of a specs checkout.",
    );
  }
  return join(home, "src", "specs", "cfc");
}

/** The revision `--rev` names, or `HEAD`. */
function revision(args: readonly string[]): string {
  const at = args.indexOf("--rev");
  if (at === -1) return "HEAD";
  const rev = args[at + 1];
  if (rev === undefined || rev.startsWith("-")) {
    throw new Error("`--rev` takes a revision.");
  }
  return rev;
}

/** The snapshot as the committed file holds it. */
export function renderSnapshot(snapshot: SpecSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

/** Generates the snapshot and writes it; returns a process exit code. */
export async function main(args: readonly string[]): Promise<number> {
  const directory = specsDirectory();
  const { specsCommit, chapters } = await readChaptersAt(
    directory,
    revision(args),
  );
  const snapshot = await buildSnapshot(specsCommit, chapters);
  const target = join(REPO_ROOT, SNAPSHOT_PATH);
  await Deno.writeTextFile(target, renderSnapshot(snapshot));
  console.log(
    `Wrote ${SNAPSHOT_PATH}: specs ${specsCommit.slice(0, 8)}, ` +
      `${snapshot.sections.length} sections, ` +
      `${snapshot.functions.length} functions.`,
  );
  return 0;
}

if (import.meta.main) Deno.exit(await main(Deno.args));
