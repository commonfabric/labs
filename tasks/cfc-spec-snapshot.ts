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
 * A pseudocode block is a fenced code block whose info string opens with
 * `typescript` or `ts`. Every fence is tracked, whatever its language and
 * whether it is written with backticks or tildes, so a heading or a fence
 * written inside another block is text rather than structure. A block's hash
 * is taken over its lines with the indentation they share and their trailing
 * whitespace removed, joined by `\n`, with no trailing newline, so moving a
 * fence into or out of a list and a line-ending change are not changes to the
 * block and an edit to its code is. Every block defining a function
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
import { sha256 } from "@commonfabric/content-hash";
import { utf8Compare } from "@commonfabric/utils/utf8";

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

  /** The file as written. */
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

/**
 * A fence opener: three or more backticks or tildes after optional
 * indentation, then the info string. A closer is the same character run, at
 * least as long, with nothing but whitespace after it, so a fence of four
 * backticks can hold one of three.
 */
const FENCE_OPEN = /^\s*(`{3,}|~{3,})(.*)$/;

/** An info string naming the pseudocode language. */
const PSEUDOCODE_INFO = /^(?:typescript|ts)(?:\s|$)/;

/**
 * A function declaration at the start of a line, allowing `export` and
 * `async`, and type parameters before the parameter list. The type parameter
 * list may nest angle brackets three deep, which covers a bound such as
 * `T extends Map<string, Set<number>>`.
 */
const FUNCTION_DECLARATION =
  /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*>)?\s*\(/;

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

/**
 * The lines of a block as its hash reads them: the indentation every
 * non-blank line shares removed, trailing whitespace removed, joined by `\n`.
 */
export function normalizeBlock(lines: readonly string[]): string {
  const trimmed = lines.map((line) => line.replace(/\s+$/, ""));
  let shared = Infinity;
  for (const line of trimmed) {
    if (line === "") continue;
    shared = Math.min(shared, /^[ \t]*/.exec(line)![0].length);
  }
  const indent = shared === Infinity ? 0 : shared;
  return trimmed.map((line) => line.slice(Math.min(indent, line.length)))
    .join("\n");
}

/**
 * SHA-256 of the UTF-8 bytes of `text`, as lowercase hex. Plain SHA-256 with
 * no domain separation, so a job in another language reproduces it with its
 * standard library.
 */
export function sha256Hex(text: string): string {
  return encodeHex(sha256(new TextEncoder().encode(text)));
}

/** A pseudocode block, under the nearest numbered heading above it. */
export interface PseudocodeBlock {
  /** The section number heading the block, or `""` above the first. */
  readonly section: string;

  /** The block's lines as written, fence lines excluded. */
  readonly lines: readonly string[];
}

/** What a chapter's text is made of: its section numbers and its blocks. */
export interface ChapterStructure {
  /** Every section number a heading outside a fence carries, in order. */
  readonly sections: readonly string[];

  /** Every pseudocode block, in order. */
  readonly blocks: readonly PseudocodeBlock[];
}

/**
 * Reads a chapter's headings and pseudocode blocks in one pass, tracking
 * every fence so that a heading inside a code block, or a fence inside a
 * longer fence, is text rather than structure. Throws on a fence `file`
 * leaves open, naming the line it opened at, since reading the rest of the
 * chapter as that block would hide every heading and function below it.
 */
export function chapterStructure(
  file: string,
  text: string,
): ChapterStructure {
  const sections: string[] = [];
  const blocks: PseudocodeBlock[] = [];
  let section = "";
  let fence:
    | { closer: RegExp; lines: string[] | null; openedAt: number }
    | null = null;
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (fence !== null) {
      if (fence.closer.test(line)) {
        if (fence.lines !== null) blocks.push({ section, lines: fence.lines });
        fence = null;
      } else {
        fence.lines?.push(line);
      }
      continue;
    }
    const heading = NUMBERED_HEADING.exec(line);
    if (heading) {
      section = heading[1];
      sections.push(section);
      continue;
    }
    const opener = FENCE_OPEN.exec(line);
    if (opener) {
      const [, marker, info] = opener;
      fence = {
        openedAt: index + 1,
        closer: new RegExp(
          `^\\s*${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`,
        ),
        lines: PSEUDOCODE_INFO.test(info.trim()) ? [] : null,
      };
    }
  }
  if (fence !== null) {
    throw new Error(
      `${file}: the fence opened at line ${fence.openedAt} is never closed`,
    );
  }
  return { sections, blocks };
}

/**
 * Every section number a chapter's headings carry, in document order. `file`
 * names the chapter in the error an unterminated fence raises.
 */
export function sectionsOf(text: string, file = "chapter"): string[] {
  return [...chapterStructure(file, text).sections];
}

/**
 * Every function a chapter's pseudocode blocks define, in document order,
 * each under the nearest numbered heading above its block.
 */
export function functionsOf(file: string, text: string): SnapshotFunction[] {
  const found: SnapshotFunction[] = [];
  for (const { section, lines } of chapterStructure(file, text).blocks) {
    const sha256 = sha256Hex(normalizeBlock(lines));
    for (const line of lines) {
      const declaration = FUNCTION_DECLARATION.exec(line);
      if (declaration) {
        found.push({ file, section, name: declaration[1], sha256 });
      }
    }
  }
  return found;
}

/** Builds the snapshot from the chapter files, read at `specsCommit`. */
export function buildSnapshot(
  specsCommit: string,
  chapters: readonly ChapterFile[],
): SpecSnapshot {
  const sorted = [...chapters]
    .filter((chapter) => CHAPTER_FILE.test(chapter.name))
    .sort((a, b) => utf8Compare(a.name, b.name));
  const sections = new Set<string>();
  const functions: SnapshotFunction[] = [];
  for (const chapter of sorted) {
    for (const section of sectionsOf(chapter.text, chapter.name)) {
      sections.add(section);
    }
    if (PSEUDOCODE_CHAPTER.test(chapter.name)) {
      for (const found of functionsOf(chapter.name, chapter.text)) {
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
  const snapshot = buildSnapshot(specsCommit, chapters);
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
