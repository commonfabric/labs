#!/usr/bin/env -S deno run --allow-read --allow-run=git

/**
 * Fails when a tracked source file contains a control codepoint below 0x20
 * other than newline.
 *
 * A literal control character in source is almost always meant as a value —
 * `"\x00"` written as the byte rather than the escape — and it reads
 * identically to the escape at runtime while behaving differently everywhere
 * a person or a tool looks at the FILE.
 *
 * A single NUL is the sharp case, because it flips the binary heuristic for
 * the whole file: `file` reports `data` rather than source, `grep` skips the
 * file silently rather than erroring, and the GitHub diff view renders the
 * line wrong. A reader who greps for a symbol in such a file is told there
 * are no matches, which is worse than being told nothing — the answer looks
 * like an answer. The escape sequence produces the same string with none of
 * that, so nothing is given up by requiring it.
 *
 * Newline is the one exception, since it is what separates the lines. A
 * carriage return is not: a CRLF file is a line-ending accident here, and a
 * lone CR moves the cursor rather than the line. Tab is not either — the
 * formatter indents with spaces, so a literal tab in source is a stray.
 *
 * Usage: deno run --allow-read --allow-run=git ./tasks/check-control-characters.ts
 */

import { dirname, fromFileUrl } from "@std/path";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/**
 * Extensions whose contents are not text at all.
 *
 * Every tracked file is governed unless explicitly identified as binary.
 * This keeps newly introduced authored formats covered automatically; an
 * unlisted binary fails visibly and earns a reviewed exemption here.
 */
const BINARY_EXTENSIONS: readonly string[] = [
  ".db",
  ".db-shm",
  ".db-wal",
  ".gz",
  ".ico",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".sqlite",
  ".ttf",
  ".wasm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
];

/**
 * Tracked text this repository does not author as code, where a control byte
 * is the content rather than a mistake.
 *
 * Each is named individually rather than bucketed, because the reasons are
 * different and a reader deciding whether to add a line needs to know which
 * kind of case theirs is.
 */
const EXEMPT_PATHS: readonly string[] = [
  // A hashing fixture whose CRLF endings are the whole point of the fixture.
  "packages/content-hash/test/fixture-frank.txt",
  // A drawing, stored as tab-separated data.
  "packages/memory/memory.tldr",
  // Makefiles from a real repository, which the file viewer's tests read.
  // Make starts a recipe line with a tab, and no escape stands in for one.
  "packages/cli/test/fixtures/view-language/make-infra/after.mk",
  "packages/cli/test/fixtures/view-language/make-infra/before.mk",
  "packages/cli/test/fixtures/view-language/make-infra/incomplete.mk",
];

/**
 * Trees this rule may not reach.
 *
 * `docs/history/` is a frozen record: `docs/README.md` permits only
 * mechanical edits there, so a gate about today's source may not require a
 * content change to it. The bundled TypeScript declarations arrive from
 * upstream with CRLF, and rewriting a vendored artifact would be undone on
 * the next re-vendoring.
 */
const EXEMPT_PREFIXES: readonly string[] = [
  "docs/history/",
  "packages/static/assets/types/",
];

/** The one control codepoint a source file may contain. */
const NEWLINE = 0x0a;

export function isGovernedPath(path: string): boolean {
  if (EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  if (EXEMPT_PATHS.includes(path)) return false;
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  const extension = dot > slash ? path.slice(dot).toLowerCase() : "";
  return !BINARY_EXTENSIONS.includes(extension);
}

export interface ControlViolation {
  file: string;
  line: number;

  /** The offending codepoint, e.g. `0x00`. */
  code: number;

  /** How many times it occurs in the file, so a CRLF file reports once. */
  count: number;
}

/**
 * Every governed control byte in `contents`, one entry per byte value rather
 * than per occurrence.
 *
 * Raw-byte scanning is exact for UTF-8: a multibyte sequence uses only bytes
 * at or above 0x80, so no character above U+007F can contribute a byte below
 * 0x20. It also covers invalid UTF-8, where an unrelated invalid byte cannot
 * hide a control byte. Counting LF bytes gives the same line numbers as
 * decoding valid UTF-8.
 *
 * Reported per byte value because the finding a reader acts on is "this file
 * contains NULs"; a CRLF file would otherwise print a line per line of the
 * file and bury every other finding in the run.
 */
export function controlViolations(contents: Uint8Array): Omit<
  ControlViolation,
  "file"
>[] {
  const first = new Map<number, number>();
  const counts = new Map<number, number>();
  let line = 1;
  for (const code of contents) {
    if (code === NEWLINE) {
      line += 1;
      continue;
    }
    if (code >= 0x20) continue;
    if (!first.has(code)) first.set(code, line);
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...first].map(([code, at]) => ({
    line: at,
    code,
    count: counts.get(code)!,
  })).sort((a, b) => a.line - b.line);
}

/**
 * `git ls-files -sz` output as `[blob id, path]` pairs.
 *
 * Each record is `<mode> <object> <stage>\t<path>`, NUL-separated. Split out
 * from the command so the parse is provable without a repository, including
 * the shapes it must decline rather than guess at.
 *
 * Only regular-file entries come back. The mode is read rather than dropped
 * because a symlink and a submodule are both tracked entries whose object is
 * not source.
 */
export function parseIndexRecords(output: string): [string, string][] {
  const blobs: [string, string][] = [];
  for (const record of output.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const [mode, id] = record.slice(0, tab).split(" ");
    // Regular files only. A symlink's blob is its target path and a gitlink's
    // object is a commit, so batching either would lint index metadata as
    // though it were source — and this tree tracks 49 symlinks.
    if (mode !== "100644" && mode !== "100755") continue;
    blobs.push([id, record.slice(tab + 1)]);
  }
  return blobs;
}

/**
 * The blob id and path of every tracked file, read from the INDEX.
 *
 * Ids rather than paths because the content this judges is the content git
 * stores, not the bytes a checkout materialized. Those differ: with
 * `core.autocrlf=true` git writes a stored LF blob into the working tree as
 * CRLF, so scanning the working tree would report a carriage return in source
 * nobody wrote one in — a verdict that depends on the reader's git config
 * rather than on the repository.
 */
async function trackedBlobs(root: string): Promise<[string, string][]> {
  const { success, stdout, stderr } = await new Deno.Command("git", {
    args: ["ls-files", "-sz"],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();

  if (!success) {
    throw new Error(
      `git ls-files failed: ${new TextDecoder().decode(stderr).trim()}`,
    );
  }

  return parseIndexRecords(new TextDecoder().decode(stdout));
}

/**
 * `git cat-file --batch` output as one byte range per blob.
 *
 * Each record is `<id> blob <size>\n`, then exactly `<size>` bytes, then a
 * newline. The size comes from the header rather than from scanning for a
 * delimiter, because the content may hold any byte — including the newline
 * that ends its own record. A header that does not carry a size stops the
 * parse rather than being guessed at: continuing would slice the following
 * blobs at the wrong offsets and report violations against the wrong files.
 */
export function parseBatchBlobs(
  output: Uint8Array,
  count: number,
): Uint8Array[] {
  const contents: Uint8Array[] = [];
  let at = 0;
  while (at < output.length && contents.length < count) {
    let lineEnd = at;
    while (lineEnd < output.length && output[lineEnd] !== 0x0a) lineEnd++;
    const header = new TextDecoder().decode(output.subarray(at, lineEnd));
    // Read as the run of digits git writes. `Number` takes an empty field as
    // 0 and a negative field as itself, and a record pushed at either length
    // leaves every record after it sliced at the wrong offset.
    const declared = header.split(" ")[2] ?? "";
    if (!/^[0-9]+$/.test(declared)) break;
    const size = Number(declared);
    const start = lineEnd + 1;
    // A record the output does not carry in full stops the parse too. The
    // slice would otherwise clamp to what is there, and a blob short of the
    // size its own header declares would be scanned as though it were the
    // whole file, with the count still matching what was asked for.
    if (start + size >= output.length) break;
    contents.push(output.subarray(start, start + size));
    at = start + size + 1;
  }
  return contents;
}

/**
 * The stored bytes of each blob, in the order asked for.
 *
 * Exported for the same reason the parses are: the failure path — git
 * declining to read the tree at all — is part of what makes this gate
 * trustworthy, and is not reachable through `scan` once `ls-files` has
 * already succeeded.
 *
 * One `cat-file --batch` for the whole tree rather than a process per file:
 * the repository tracks thousands of governed files, and the difference is
 * between a gate that runs in a second and one nobody wants in CI.
 */
export async function blobContents(
  root: string,
  ids: readonly string[],
): Promise<Uint8Array[]> {
  if (ids.length === 0) return [];
  const command = new Deno.Command("git", {
    args: ["cat-file", "--batch"],
    cwd: root,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  // Start draining stdout BEFORE writing the ids. git writes as it reads, and
  // the whole tree's contents far exceed a pipe buffer, so a writer that held
  // the output unread until it finished would deadlock against a git that
  // cannot accept more input until someone consumes what it has already
  // produced.
  const output = command.output();
  const writer = command.stdin.getWriter();
  try {
    await writer.write(new TextEncoder().encode(ids.join("\n") + "\n"));
    await writer.close();
  } catch {
    // A git that exits before reading its input closes the pipe mid-write.
    // Its exit status, not the pipe error, is what happened; the check below
    // reports it.
  }

  const { success, stdout, stderr } = await output;
  if (!success) {
    throw new Error(
      `git cat-file failed: ${new TextDecoder().decode(stderr).trim()}`,
    );
  }

  return parseBatchBlobs(stdout, ids.length);
}

/** Scans every governed tracked file, as git stores it. */
export async function scan(root: string): Promise<ControlViolation[]> {
  const governed = (await trackedBlobs(root))
    .filter(([, path]) => isGovernedPath(path));
  const contents = await blobContents(root, governed.map(([id]) => id));

  // Fail CLOSED on a short batch. An unavailable blob would otherwise skip
  // that file AND every file after it, and the gate would report success over
  // source nothing read.
  if (contents.length !== governed.length) {
    throw new Error(
      `git cat-file returned ${contents.length} of ${governed.length} ` +
        `blob(s); the tree was not fully read`,
    );
  }

  const violations: ControlViolation[] = [];
  for (let i = 0; i < governed.length; i++) {
    for (const found of controlViolations(contents[i])) {
      violations.push({ file: governed[i][1], ...found });
    }
  }

  return violations;
}

const hex = (code: number): string =>
  `0x${code.toString(16).padStart(2, "0").toUpperCase()}`;

function reportViolations(violations: readonly ControlViolation[]): void {
  const lines = [
    "",
    "Control codepoint(s) below 0x20 in tracked source:",
    "",
    ...violations.map((violation) =>
      `  ${violation.file}:${violation.line}: ${hex(violation.code)}` +
      (violation.count > 1 ? ` (${violation.count} occurrences)` : "")
    ),
    "",
    "Write the value as an escape — `\\x00`, `\\t` — rather than the literal",
    "byte. The string is the same either way, and the file stays plain text:",
    "a single NUL makes `file` report `data`, makes `grep` skip the file",
    "silently, and makes a diff view render the line wrong.",
    "",
  ];
  console.error(lines.join("\n"));
}

/** Runs the check over `root`, reports, and returns a process code. */
export async function main(root: string = REPO_ROOT): Promise<number> {
  const violations = await scan(root);
  if (violations.length > 0) {
    reportViolations(violations);
    return 1;
  }
  console.log("No control codepoints below 0x20 in tracked source.");
  return 0;
}

if (import.meta.main) Deno.exit(await main());
