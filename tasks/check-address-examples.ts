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
 * A code span — a backtick, the run up to the next backtick, and that
 * backtick, in a Markdown file or inside a source comment — whose content is
 * all four of:
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
 * Which text is prose is the other half of the rule: all of a Markdown file,
 * and in TypeScript the regions a comment opener reaches, which `proseOf`
 * below defines and states the bound on.
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
 * Where a directive may sit is as much of the rule as how it reads. It opens
 * its own line, so a sentence mentioning one is a sentence. In TypeScript it
 * sits in a comment, read by `commentsOnly`, which recognizes string and
 * template literals — so a directive-shaped line a program carries states
 * nothing. In Markdown it sits outside a fenced code block, since a fence is
 * where a document shows what a directive looks like rather than writing one.
 * And it belongs above the table or paragraph it speaks for, a row's line
 * opening no directive; `docs/specs/cell-reference-grammar.md` has the worked
 * example.
 *
 * What that leaves, stated rather than implied: a rule about text can be met
 * by text written to meet it, and this one has a residual worth naming.
 * Regular-expression literals are modeled by neither reader, so a `//` inside
 * one is not attributed to the regex. Reaching an exemption from there takes
 * both halves at once — the `//` has to open the line's kept region and the
 * directive has to follow it immediately — which means a character class
 * written to hold the directive whole: one opening `/[// ` and running through
 * the directive to `]/`. Measured over this tree, no file carries a
 * directive-shaped line outside a comment at all.
 *
 * And such a line hides nothing on its own. A directive whose string no
 * example in its file carries is reported, so a silent exemption needs the
 * same file to carry both that line and the very refused address it covers.
 * Both are written where a writer writes, in a file the writer owns.
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
// Reading a file
//
// Two readers over a source file, leaning opposite ways on purpose. `proseOf`
// keeps every comment and sometimes more, and is what examples are read from,
// so no comment's address can go unchecked. `commentsOnly` keeps only what is
// certainly a comment and sometimes less, and is what directives are read
// from, so nothing a program carries can state an exemption. Each is wrong
// only where being wrong is visible: one offers a candidate a reader can see
// is not prose, the other drops an exemption, and the gate then reports the
// example the writer meant to exempt.
//
// Both keep every character at the offset the file gave it, so a line number
// in a finding names the line a reader will open.
//

/** `text` with every character but the line breaks replaced by a space. */
function blanked(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

/**
 * Where a comment opener at `at` reaches, or `null` where `at` opens neither
 * kind.
 *
 * A line opener runs to the end of its line. A block opener runs to its first
 * closer, and to the end of its line where the text holds no closer after it:
 * a block comment always has one, so an opener without a closer is prose or a
 * literal rather than a comment, and reading it to the end of the file would
 * turn everything below a comment that mentions the characters into prose.
 */
function commentRegionEnd(source: string, at: number): number | null {
  const opener = source[at + 1];
  const newline = source.indexOf("\n", at);
  const endOfLine = newline === -1 ? source.length : newline;
  if (opener === "/") return endOfLine;
  if (opener === "*") {
    const close = source.indexOf("*/", at + 2);
    return close === -1 ? endOfLine : close + 2;
  }
  return null;
}

/**
 * `source` with everything but its comments blanked out, each remaining
 * character where it was in the file.
 *
 * What it keeps is the union of the regions every comment opener reaches, and
 * a comment opener is the only thing it recognizes. That is what makes the
 * result a superset of the file's comments: a comment's own opener contributes
 * a region holding all of it, whatever else was matched before it, so nothing
 * can consume a comment or cut one short.
 *
 * The cost is stated rather than avoided. A `//` or a `/*` inside a string, a
 * template literal or a regular expression opens a region here too, so the
 * code after it is read as prose, and an address written in that code is
 * checked. Over this tree that adds one candidate and removes none. The
 * direction is the one this check needs: a candidate too many is a finding a
 * reader can see is not prose, and a candidate too few is a finding nobody
 * ever sees.
 */
export function proseOf(source: string): string {
  const parts: string[] = [];
  let at = 0;
  let covered = 0;
  for (
    let slash = source.indexOf("/");
    slash !== -1;
    slash = source.indexOf("/", slash + 1)
  ) {
    const end = commentRegionEnd(source, slash);
    if (end === null || end <= covered) continue;
    const start = Math.max(slash, covered);
    if (start > at) parts.push(blanked(source.slice(at, start)));
    parts.push(source.slice(start, end));
    at = end;
    covered = end;
  }
  parts.push(blanked(source.slice(at)));
  return parts.join("");
}

/**
 * One match per comment or literal, whichever opens first. Each match consumes
 * its own text, so a comment opener a literal carries is carried away with it.
 */
const COMMENT_OR_LITERAL =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:[^`\\]|\\[\s\S])*`|"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'/g;

/**
 * `source` with everything but its comments blanked out, keeping only what is
 * certainly one.
 *
 * `proseOf`'s opposite, and the pair is the point: a string literal and a
 * template literal are recognized here, so a directive-shaped line a program
 * carries is not in a comment and states nothing. Where this reader is wrong
 * it keeps too little, and an exemption that stops working is one the gate
 * reports.
 *
 * Regular-expression literals are not modeled, here or in `proseOf`. A `//`
 * inside one — `/[//]/`, where a character class holds the pair — opens a
 * region this reader takes for a comment, so a directive on that line would be
 * honored. That is the residual this file's header states.
 */
export function commentsOnly(source: string): string {
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

/** A line that opens or closes a fenced code block. */
const FENCE = /^[ \t]*(?:```|~~~)/;

/**
 * `text` with the lines inside its fenced code blocks blanked out.
 *
 * A fence is where a document writes what a directive looks like rather than
 * writing one, so a line inside one states nothing. This is the Markdown half
 * of the pair above: there is no code in a Markdown file for `commentsOnly` to
 * separate out, and a fence is the one place a document quotes a directive
 * instead of giving one.
 */
export function outsideFences(text: string): string {
  let fenced = false;
  return text.split("\n").map((line) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return blanked(line);
    }
    return fenced ? blanked(line) : line;
  }).join("\n");
}

/**
 * A line break inside a code span, with the indent after it and the `*` a
 * block comment opens a continuation line with.
 */
const SPAN_WRAP = /\n[ \t]*(?:\*[ \t]*)?/y;

/** A code span that could hold an address example. */
export interface CodeSpan {
  /** The text between the backticks, the wrap still in it. */
  content: string;

  /** Offset of the opening backtick in the text it was found in. */
  at: number;
}

/**
 * Every code span in `text` that could hold an address example: a backtick
 * followed by `/`, the run up to the next backtick, and that backtick.
 *
 * Rooted and free of whitespace are conditions of the search as well as of the
 * rule, and that is what makes a span local: a stray backtick — one inside a
 * regular expression, a string, or an escape — shifts nothing, where pairing
 * each backtick with the next makes every span after such a character read as
 * ending somewhere it does not. `addressExample` is still what decides, and
 * holds every candidate to the whole rule.
 *
 * A line break continues a span only where the next line resumes the token, so
 * the walk is deterministic, never backtracks, and visits each character a
 * bounded number of times.
 */
export function* codeSpans(text: string): Generator<CodeSpan> {
  for (let at = text.indexOf("`"); at !== -1; at = text.indexOf("`", at + 1)) {
    if (text[at + 1] !== "/") continue;
    let content = "";
    for (let i = at + 1; i < text.length; i++) {
      const character = text[i];
      if (character === "`") {
        yield { content, at };
        break;
      }
      if (character === "\n") {
        SPAN_WRAP.lastIndex = i;
        SPAN_WRAP.exec(text);
        const next = text[SPAN_WRAP.lastIndex];
        if (next === undefined || next === "`" || /\s/.test(next)) break;
        content += text.slice(i, SPAN_WRAP.lastIndex);
        i = SPAN_WRAP.lastIndex - 1;
        continue;
      }
      if (/\s/.test(character)) break;
      content += character;
    }
  }
}

/**
 * The address example a code span's content holds, or `null` when the content
 * is not one. The file header states the rule this applies.
 */
export function addressExample(content: string): string | null {
  // A line break inside a span, and the `*` a block comment opens its
  // continuation lines with, are the wrapping rather than the string.
  const token = content.replace(/\n[ \t]*(?:\*[ \t]*)?/g, "").trim();
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
 * A directive, the rooted string it names, and the reason after it.
 *
 * A directive opens its own line. Before it may come an indent and one of the
 * things a writer puts in front of prose — an HTML comment's `<!--`, a line
 * comment's `//`, a block comment's `/*` or its continuation `*` — and
 * nothing else. The reason runs to the end of the line, less the `-->` that
 * closes an HTML comment around it.
 *
 * The optional opener carries its own trailing spaces rather than leaving them
 * to a second run beside it. Two runs of spaces around an optional part can
 * divide a run between them in as many ways as it is long, and the lines this
 * reads are blanked to spaces, so the ambiguous spelling costs the square of
 * the longest line.
 */
const DIRECTIVE =
  /^[ \t]*(?:(?:<!--|\/\*+|\/\/|\*)[ \t]*)?check-address-examples-ignore:[ \t]*(\/\S*)[ \t]*([^\n]*)/gm;

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

/**
 * Every string the directives in `text` exempt, by the string they name.
 *
 * `text` is the file as written rather than the prose read out of it. Blanking
 * code to spaces keeps every character where the file put it, which leaves a
 * comment opener inside a string literal looking exactly like one at the head
 * of a line; the file itself still tells them apart. So a directive is read
 * from the file, and an exemption cannot be written by data a program happens
 * to carry.
 */
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

/** A file this check reads. */
export interface Document {
  /** Repo-relative path, e.g. `skills/cf/SKILL.md`. */
  path: string;

  /** Which reader it gets. */
  kind: GovernedKind;

  /** The file as written. */
  text: string;
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
 *
 * Examples come from the reader that keeps too much and exemptions from the
 * one that keeps too little, so a comment's address is always checked and only
 * a comment can exempt it. Pure — all input and output happens in `main`.
 */
export function collectFindings(documents: readonly Document[]): Finding[] {
  const findings: Finding[] = [];
  for (const { path, kind, text } of documents) {
    const markdown = kind === "markdown";
    const prose = markdown ? text : proseOf(text);
    const exempt = exemptions(
      markdown ? outsideFences(text) : commentsOnly(text),
    );
    const used = new Set<string>();
    for (const span of codeSpans(prose)) {
      const example = addressExample(span.content);
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
          line: lineAt(prose, span.at),
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
 * Every governed file under `root`, with its text.
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
    documents.push({
      path,
      kind,
      text: await Deno.readTextFile(`${root}/${path}`),
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
