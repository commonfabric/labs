#!/usr/bin/env -S deno run --allow-read --allow-run=git

/**
 * Fails when a document, a skill, or a source comment writes a cell address
 * the reference parser refuses.
 *
 * An address that stops parsing stops working, and nothing about changing the
 * grammar tells you that prose somewhere teaches the spelling it retired.
 *
 * `parseCellReference` in `packages/runner/src/cell-reference.ts` is the judge,
 * so the tree's examples answer to the reader the fabric uses rather than to a
 * second copy of its rules. `cf` reaches that reader through
 * `normalizeLLMFriendlyRef` in `packages/cli/lib/llm-friendly-ref.ts`, which
 * parses with it and then adds what a command invocation needs: a piece
 * segment in the CLI's own vocabulary, and a space that agrees with the
 * command's target space. An example in a document is not an invocation — it
 * names no command, it carries no target space, and it writes its piece as a
 * stand-in — so what it answers to is the grammar, and every rule `cf` holds
 * an address's shape to is a rule of the grammar.
 *
 * ## What counts as an address example
 *
 * A code span — text between matching runs of backticks, in a Markdown file
 * or inside a source comment — whose content is all four of:
 *
 * - **rooted**: it begins with `/`. `isReference` in the CLI's reference module
 *   is where a leading slash decides that a token is written as a reference; a
 *   relative reference (`items/0`, `./title`) carries no such mark, and nothing
 *   short of a context tells one from prose or from a file path.
 * - **one token**: it holds no whitespace, once the line breaks inside it are
 *   removed. A span holding a space is a command line or a sentence, and the
 *   address inside one is not the span.
 * - **a location**: it names two segments or more. One segment is a fragment
 *   — a space prefix (`//space/`), a piece on its own, a tag from another
 *   notation (`/Bytes@1`, the JSON codec's wire tag) — and the string alone
 *   does not say which of those it is.
 * - **written out**: it carries no `[`, no `]`, and no ellipsis. Those are how
 *   this tree writes a string that stands for several — an optional part, or
 *   characters left out — and such a string has no one reading to hand the
 *   parser.
 *
 * A `<placeholder>` is left as written and judged as the string it is, which is
 * the reading its author means: `<space>` is name-shaped, so `/@<space>/top/42`
 * is judged as a named space and refused, exactly as it would be for a reader
 * who filled the hole with a name. A hole in a slot whose vocabulary is
 * closed — `@<scope>`, `#<member>` — has no reading the parser takes, so a
 * grammar line written that way is reported and takes the directive below.
 *
 * check-address-examples-ignore: /@<space>/top/42 the paragraph above names the
 * retired prefix to say what this check makes of it
 *
 * ## Marking a string the check must not judge
 *
 * Two kinds of string are written on purpose: one naming a retired form in
 * order to say it is retired, and one belonging to a neighboring notation —
 * the shell's page URL, which reads a `/@<space>/` prefix, or a grammar line
 * with a hole in a closed slot. A writer exempts such a string with a
 * directive naming it and saying why:
 *
 * ```text
 * check-address-examples-ignore: <the string> <why it is written>
 * ```
 *
 * In Markdown the directive goes inside an HTML comment, so that it does not
 * render; in a source file it is an ordinary comment. It governs the file it
 * sits in, wherever in that file it sits, so re-wrapping cannot separate it
 * from what it exempts, and it exempts every occurrence of the string it
 * names. A directive naming a string no address example in its file carries is
 * reported too, so that an exemption cannot outlive its example.
 *
 * The string a directive names is an address example, and so begins with `/`.
 * That is what lets this file spell the directive out without exempting
 * anything.
 *
 * Usage: deno task check-address-examples
 */

import { dirname, fromFileUrl } from "@std/path";
import { parseCellReference } from "@commonfabric/runner/shared";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/**
 * The tree this rule may not reach. `docs/history/` is a frozen record —
 * `docs/README.md` permits only mechanical edits there — so a gate about the
 * grammar as it stands may not require a content change to it, and the
 * addresses those documents quote are the ones that were current when each was
 * written.
 */
const EXEMPT_PREFIXES: readonly string[] = ["docs/history/"];

/** Which reader a file this check governs is read by. */
export type GovernedKind = "markdown" | "source";

/**
 * How `path` is read: `markdown` for a Markdown document, whose whole text is
 * prose, and `source` for TypeScript, where only the comments are.
 */
export function governedKind(path: string): GovernedKind | null {
  if (EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))) return null;
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "source";
  return null;
}

//
// Reading a file's prose
//
// Two readers, one per governed kind, each producing text whose offsets are
// those of the file: a line number in a finding names the line a reader will
// open.
//

const LINE_COMMENT = /\/\/[^\n]*/;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//;
const TEMPLATE = /`(?:[^`\\]|\\[\s\S])*`/;
const STRING = /"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'/;

/**
 * One match per comment or literal, whichever opens first. Each match consumes
 * its own text, so a literal holding comment-shaped text carries it away and no
 * comment is found inside it.
 *
 * Regular-expression literals are not modeled: a `/\//` reads as a line comment
 * and a quote inside one reads as a string opening. What that costs is comment
 * text scanned where there is none, which can only add a finding a reader can
 * see is not a comment.
 */
const COMMENT_OR_LITERAL = new RegExp(
  [LINE_COMMENT, BLOCK_COMMENT, TEMPLATE, STRING]
    .map((part) => part.source)
    .join("|"),
  "g",
);

/** `text` with every character but the line breaks replaced by a space. */
function blanked(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

/**
 * `source` with everything but its comments blanked out, each remaining
 * character where it was in the file.
 *
 * A template literal is blanked along with the rest: it is code, and the
 * addresses a program builds are the business of the tests that run it.
 */
export function commentsOf(source: string): string {
  const parts: string[] = [];
  let at = 0;
  for (const match of source.matchAll(COMMENT_OR_LITERAL)) {
    const token = match[0];
    parts.push(blanked(source.slice(at, match.index)));
    parts.push(
      token.startsWith("//") || token.startsWith("/*") ? token : blanked(token),
    );
    at = match.index + token.length;
  }
  parts.push(blanked(source.slice(at)));
  return parts.join("");
}

/**
 * A code span: a run of backticks, the shortest content that reaches a closing
 * run of the same length, and that closing run. The content may hold line
 * breaks, so a span an author wrapped is one match rather than none — which a
 * line-oriented search cannot do.
 *
 * A run of three or more opens a fenced block, and the match then spans the
 * whole block. Its content is a transcript or a scaffold, where a token takes
 * its meaning from the block's language, so `addressExample` declines it on the
 * whitespace inside it.
 */
const CODE_SPAN = /(?<!`)(`+)(?!`)([^]*?)(?<!`)\1(?!`)/g;

/**
 * The address example a code span's content holds, or `null` when the content
 * is not one. The file header states the rule this applies.
 */
export function addressExample(content: string): string | null {
  // A line break inside a span, and the `*` a block comment opens its
  // continuation lines with, are the wrapping rather than the string.
  const token = content.replace(/\n[ \t]*\*?[ \t]*/g, "").trim();
  if (!token.startsWith("/")) return null;
  if (/\s/.test(token)) return null;
  if (/[\[\]]|…|\.\.\./.test(token)) return null;
  const segments = token.replace(/^\/\/?/, "").split("/");
  if (segments.filter((segment) => segment !== "").length < 2) return null;
  return token;
}

//
// The directive
//

/**
 * A directive, the rooted string it names, and the reason after it. The reason
 * runs to the end of the line, less the `-->` that closes an HTML comment
 * around it.
 */
const DIRECTIVE = /check-address-examples-ignore:[ \t]*(\/\S*)[ \t]*([^\n]*)/g;

/** A string a file's directives exempt, and the reason given for it. */
export interface Exemption {
  /** 1-based line of the directive. */
  line: number;

  /** What the directive gives as its reason, which may be empty. */
  reason: string;
}

/** The 1-based line number holding `index` in `text`. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (
    let i = text.indexOf("\n");
    i !== -1 && i < index;
    i = text.indexOf("\n", i + 1)
  ) {
    line++;
  }
  return line;
}

/** Every string the directives in `text` exempt, by the string they name. */
export function exemptions(text: string): Map<string, Exemption> {
  const found = new Map<string, Exemption>();
  for (const match of text.matchAll(DIRECTIVE)) {
    const reason = match[2].replace(/-->\s*$/, "").trim();
    found.set(match[1], { line: lineAt(text, match.index), reason });
  }
  return found;
}

//
// The check
//

/** A file this check reads, and the prose it reads from it. */
export interface Document {
  /** Repo-relative path, e.g. `skills/cf/SKILL.md`. */
  path: string;

  /** The file's prose, at the file's own offsets. */
  prose: string;
}

/** Something the check reports. */
export interface Finding {
  /** Repo-relative path of the file holding it. */
  file: string;

  /** 1-based line within that file. */
  line: number;

  /** The string, as the check read it. */
  example: string;

  /** What the parser said about it, or what is wrong with the directive. */
  message: string;
}

/**
 * Every finding in `documents`: an address example the parser refuses, a
 * directive with no reason, and a directive whose string no example carries.
 * Pure — all input and output happens in `main`.
 */
export function collectFindings(documents: readonly Document[]): Finding[] {
  const findings: Finding[] = [];
  for (const { path, prose } of documents) {
    const exempt = exemptions(prose);
    const used = new Set<string>();
    for (const match of prose.matchAll(CODE_SPAN)) {
      const example = addressExample(match[2]);
      if (example === null) continue;
      if (exempt.has(example)) {
        used.add(example);
        continue;
      }
      try {
        parseCellReference(example);
      } catch (error) {
        findings.push({
          file: path,
          line: lineAt(prose, match.index),
          example,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const [example, { line, reason }] of exempt) {
      if (reason === "") {
        findings.push({
          file: path,
          line,
          example,
          message: "the directive gives no reason for the exemption",
        });
      } else if (!used.has(example)) {
        findings.push({
          file: path,
          line,
          example,
          message: "no address example in this file is written this way",
        });
      }
    }
  }
  findings.sort((a, b) =>
    a.file.localeCompare(b.file) || a.line - b.line ||
    a.example.localeCompare(b.example)
  );
  return findings;
}

/** Runs `git ls-files` with `args` under `root` and splits its output. */
async function gitLsFiles(root: string, args: string[]): Promise<string[]> {
  const { code, stdout, stderr } = await new Deno.Command("git", {
    args: ["-C", root, "ls-files", "-z", ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    const message = new TextDecoder().decode(stderr).trim();
    throw new Error(`git ls-files failed in ${root}: ${message}`);
  }
  return new TextDecoder().decode(stdout).split("\0").filter((p) => p !== "");
}

/**
 * Every governed file under `root`, with its prose.
 *
 * Membership comes from git, so a file the repository does not track — build
 * output, a scratch note — is not read, and a governed file added in the same
 * change is read before it is staged. A path the index still holds but the
 * working tree has lost is dropped rather than failing the read.
 */
export async function readDocuments(root: string): Promise<Document[]> {
  const [present, deleted] = await Promise.all([
    gitLsFiles(root, ["--cached", "--others", "--exclude-standard"]),
    gitLsFiles(root, ["--deleted"]),
  ]);
  const gone = new Set(deleted);
  const documents: Document[] = [];
  await Promise.all(present.map(async (path) => {
    if (gone.has(path)) return;
    const kind = governedKind(path);
    if (kind === null) return;
    const source = await Deno.readTextFile(`${root}/${path}`);
    documents.push({
      path,
      prose: kind === "markdown" ? source : commentsOf(source),
    });
  }));
  documents.sort((a, b) => a.path.localeCompare(b.path));
  return documents;
}

function reportFindings(findings: readonly Finding[]): void {
  console.error(
    [
      "",
      "Address example(s) the reference parser does not read:",
      "",
      ...findings.flatMap(({ file, line, example, message }) => [
        `  ${file}:${line}  \`${example}\``,
        `      ${message}`,
      ]),
      "",
      "`parseCellReference` in packages/runner/src/cell-reference.ts is the",
      "reader every address in the fabric answers to, and `cf` reaches it",
      "through packages/cli/lib/llm-friendly-ref.ts. A string it refuses is a",
      "string a reader cannot paste into a command.",
      "",
      "Write the address the way the parser reads it. Where the string is",
      "written on purpose — a retired form quoted as retired, a spelling",
      "of the shell's page URL, a grammar line with a hole in a closed slot",
      "— name it in a directive, in an HTML comment in Markdown and an",
      "ordinary comment in source:",
      "",
      "  check-address-examples-ignore: <the string> <why it is written>",
      "",
      "The directive governs the file it sits in, wherever in that file it",
      "sits. See tasks/check-address-examples.ts for what counts as an address",
      "example and what does not.",
      "",
    ].join("\n"),
  );
}

/** Runs the check over `root`, reports, and returns a process exit code. */
export async function main(root: string = REPO_ROOT): Promise<number> {
  const documents = await readDocuments(root);
  const findings = collectFindings(documents);
  if (findings.length > 0) {
    reportFindings(findings);
    return 1;
  }
  console.log(`Address examples OK (${documents.length} files).`);
  return 0;
}

if (import.meta.main) Deno.exit(await main());
