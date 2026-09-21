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
 * grammar line written that way is reported and recorded below.
 *
 * ## Marking a string the check must not judge
 *
 * Some strings are written on purpose: one naming a retired form in order to
 * say it is retired, one belonging to a neighboring notation such as the
 * shell's page URL, one that is a grammar line rather than an address. Each is
 * recorded in {@link EXEMPTIONS}, in this file, naming the document, the exact
 * string, and why it is written that way.
 *
 * The list is here rather than in the document because an exemption a scanned
 * file could state is one that file could forge: a check that reads its own
 * permission out of the text it checks has no way to tell a permission from
 * the data next to it. Recording it here also puts every exemption in one
 * place a reviewer can read at once. What it costs is that a writer adding a
 * deliberate example edits two files, and the failure message says so.
 *
 * An entry is held to the tree the way a document is. One naming a string that
 * its file no longer writes is reported, so an exemption cannot outlive its
 * example, and one carrying no reason is reported too.
 *
 * Usage: deno task check-address-examples
 */

import { dirname, fromFileUrl } from "@std/path";
import { parseCellReference } from "@commonfabric/runner/shared";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/** One string a named file writes on purpose, and why it is written. */
export interface Exemption {
  /** Repo-relative path of the file that writes it. */
  file: string;

  /** The address example, exactly as the check reads it. */
  example: string;

  /** Why that file writes a string the parser refuses. */
  reason: string;
}

/**
 * Every address example in the tree that the parser refuses on purpose.
 *
 * A reason here answers one question: why is this file writing a string a
 * reader could not paste into a command? Quoting a retired form in order to
 * say it is retired answers it; so does writing a spelling that belongs to a
 * neighboring grammar, or a line that gives a shape rather than an address.
 * An entry is about one file, since a string refused on purpose in one
 * document can be a defect in another.
 */
export const EXEMPTIONS: readonly Exemption[] = [
  {
    file: "docs/common/verbs/over-the-cli.md",
    example: "//space/piece@scope",
    reason: "a grammar line, whose three parts are holes rather than " +
      "one address",
  },
  {
    file: "docs/specs/cell-reference-grammar.md",
    example: "/@session/<handle>@user",
    reason: "the collision the requirement it sits under answers, quoted " +
      "as what the grammar refuses",
  },
  {
    file: "docs/specs/cell-reference-grammar.md",
    example: "/@bakery/glaze-tracker",
    reason: "the table of refused forms is written out of what the parser " +
      "refuses",
  },
  {
    file: "docs/specs/collection-naming.md",
    example: "/@<space>/top/42",
    reason: "a page URL the shell reads, written with the mark the cell " +
      "reference grammar retired",
  },
  {
    file: "packages/cli/lib/callable.ts",
    example: "//<space>/<id>@scope",
    reason: "the doc comment writes the shape a caller reads the parts out " +
      "of, with a hole in the scope slot, rather than one address",
  },
  {
    file: "packages/navigation/test/view.test.ts",
    example: "/@<space>/<collection>/<member>",
    reason: "a page URL, which keeps the mark the cell reference grammar " +
      "retired",
  },
  {
    file: "skills/cf/SKILL.md",
    example: "/@my-space/tracker/items",
    reason: "the bullet quotes it as the spelling the CLI refuses",
  },
  {
    file: "tasks/check-address-examples.ts",
    example: "/@<space>/top/42",
    reason: "the rule above names the retired prefix to say what this " +
      "check makes of it",
  },
];

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
// One reader, and it leans one way on purpose: it keeps every comment and
// sometimes more. Being wrong offers a candidate a reader can see is not
// prose, where a reader that kept too little would drop a finding nobody ever
// sees. Nothing but examples is read out of a file, so there is nothing else
// the looseness can reach.
//
// It keeps every character at the offset the file gave it, so a line number in
// a finding names the line a reader will open.
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
 * checked. A candidate too many is a finding a reader can see is not prose,
 * and a candidate too few is a finding nobody ever sees.
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
  /** Repo-relative path of the file the finding is about. */
  file: string;

  /** 1-based line within that file, where the finding has one. */
  line?: number;

  /** The string, as the check read it. */
  example: string;

  /** What the parser said about it, or what is wrong with the entry. */
  message: string;
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
 * What a reader is told about a value a parse threw.
 *
 * `parseCellReference` throws an `Error`, whose message is the sentence the
 * grammar wrote for the string it refused. A value of any other kind is
 * rendered whole rather than reached into, so one this module did not expect
 * still reaches the report as itself rather than as `undefined`.
 */
export function refusalMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Keys an exemption by the file it is about and the string it names. */
function exemptionKey(file: string, example: string): string {
  return `${file} ${example}`;
}

/**
 * Every finding in `documents`: an address example `exemptions` does not cover
 * and the parser refuses, an entry carrying no reason, and an entry naming a
 * string its file no longer writes.
 *
 * Pure — all input and output happens in `main`.
 */
export function collectFindings(
  documents: readonly Document[],
  exemptions: readonly Exemption[],
): Finding[] {
  const excused = new Map<string, Exemption>();
  for (const exemption of exemptions) {
    excused.set(exemptionKey(exemption.file, exemption.example), exemption);
  }

  const findings: Finding[] = [];
  const used = new Set<string>();
  for (const { path, kind, text } of documents) {
    const prose = kind === "markdown" ? text : proseOf(text);
    for (const span of codeSpans(prose)) {
      const example = addressExample(span.content);
      if (example === null) continue;
      const key = exemptionKey(path, example);
      if (excused.has(key)) {
        used.add(key);
        continue;
      }
      try {
        parseCellReference(example);
      } catch (error) {
        findings.push({
          file: path,
          line: lineAt(prose, span.at),
          example,
          message: refusalMessage(error),
        });
      }
    }
  }

  for (const exemption of exemptions) {
    const { file, example, reason } = exemption;
    if (reason.trim() === "") {
      findings.push({
        file,
        example,
        message: "the entry in EXEMPTIONS gives no reason",
      });
    } else if (!used.has(exemptionKey(file, example))) {
      findings.push({
        file,
        example,
        message: "EXEMPTIONS excuses this, and the file no longer writes it",
      });
    }
  }

  findings.sort((a, b) =>
    a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) ||
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

/** How a finding names where it is, with a line where it has one. */
export function findingLocation(finding: Finding): string {
  return finding.line === undefined
    ? finding.file
    : `${finding.file}:${finding.line}`;
}

function reportFindings(findings: readonly Finding[]): void {
  console.error(
    [
      "",
      "Address example(s) the reference parser does not read:",
      "",
      ...findings.flatMap((finding) => [
        `  ${findingLocation(finding)}  \`${finding.example}\``,
        `      ${finding.message}`,
      ]),
      "",
      "`parseCellReference` in packages/runner/src/cell-reference.ts is the",
      "reader every address in the fabric answers to, and `cf` reaches it",
      "through packages/cli/lib/llm-friendly-ref.ts. A string it refuses is a",
      "string a reader cannot paste into a command.",
      "",
      "Write the address the way the parser reads it. Where the string is",
      "written on purpose — a retired form quoted as retired, a spelling of",
      "the shell's page URL, a grammar line rather than an address — record it",
      "in EXEMPTIONS in tasks/check-address-examples.ts, which takes the file,",
      "the string, and why that file writes it:",
      "",
      '  { file: "docs/specs/cell-reference-grammar.md",',
      '    example: "/@bakery/glaze-tracker",',
      '    reason: "the table of refused forms is written out of what the',
      '      parser refuses" },',
      "",
      "So a deliberate example is two edits: the document, and that list. The",
      "list is in the task rather than in the document because an exemption a",
      "scanned file could state is one that file could forge. See",
      "tasks/check-address-examples.ts for what counts as an address example",
      "and what does not.",
      "",
    ].join("\n"),
  );
}

/**
 * Runs the check over `root` against `exemptions`, reports, and returns a
 * process exit code.
 *
 * Both are arguments rather than defaults because both are facts about one
 * tree: the recorded exemptions name files in this repository, and running
 * them against another root would report every one of them as stale.
 */
export async function main(
  root: string,
  exemptions: readonly Exemption[],
): Promise<number> {
  const documents = await readDocuments(root);
  const findings = collectFindings(documents, exemptions);
  if (findings.length > 0) {
    reportFindings(findings);
    return 1;
  }
  console.log(`Address examples OK (${documents.length} files).`);
  return 0;
}

if (import.meta.main) Deno.exit(await main(REPO_ROOT, EXEMPTIONS));
