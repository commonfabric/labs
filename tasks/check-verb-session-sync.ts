#!/usr/bin/env -S deno run --allow-read

/**
 * Fails when a verb-session document drifts from the demo that runs it.
 *
 * Each document is paired with the demo that runs the session it describes —
 * the tour and the walkthrough with `verb-session-demo.sh`, the bulk tour with
 * `bulk-ops-demo.sh`, the read/write tour with `read-write-demo.sh` — and a
 * document may QUOTE its demo's commands but never
 * compose them: every `cf` line in one of its command blocks must be a command
 * that demo actually runs, or sit under a `# not in the demo` comment saying
 * why it cannot be. Nothing
 * executes a command block in a document, so a composed example can be wrong
 * from the day it is written and stay wrong through every editing pass — one
 * shipped that way and survived four of them. Both documents also name demo
 * acts by number, and those references have gone stale twice as acts were
 * inserted. Both failure classes are mechanical to detect, and this is where
 * they are detected.
 *
 * Three checks, run over every document in `DOC_PATHS`:
 * - Every `cf` command matches a demo command, token for token, after
 *   normalization: an `-s <space>` pair is dropped from both sides, quotes
 *   are stripped, a value read from stdin is folded in ahead of the command
 *   as `echo <value> |`, and a token holding a `$variable` or a
 *   `<placeholder>` matches anything. An address a transcript shortened for
 *   width needs no rule of its own: the demo holds every address in a
 *   variable.
 * - Every "act N" reference, in any case, names an act the demo has.
 * - Every row of a verb shape table pairs its verbs with acts whose demo
 *   text actually mentions them.
 *
 * A `bash` block holds commands alone; a `console` block holds a transcript,
 * and its output lines fall out because they carry no `cf` token.
 *
 * Usage: deno run --allow-read ./tasks/check-verb-session-sync.ts
 */

import { dirname, fromFileUrl, join } from "@std/path";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
export const DEMO_PATH = "packages/cli/integration/verb-session-demo.sh";
export const WALKTHROUGH_PATH = "docs/common/verbs/session-walkthrough.md";
export const TOUR_PATH = "docs/common/verbs/the-verb-session.md";

/** The demo that runs the bulk piece operations, act by act. */
export const BULK_DEMO_PATH = "packages/cli/integration/bulk-ops-demo.sh";

/** The tour written from that demo, and held to it below. */
export const BULK_TOUR_PATH = "docs/common/workflows/bulk-operations.md";

/** The demo that reads and writes a piece's cells, act by act. */
export const READ_WRITE_DEMO_PATH =
  "packages/cli/integration/read-write-demo.sh";

/** The tour written from that demo, and held to it below. */
export const READ_WRITE_TOUR_PATH =
  "docs/common/workflows/reading-and-writing.md";

/**
 * Each document, paired with the demo that runs the session it describes.
 *
 * A document is held to its own demo and no other: the verb tour and its
 * walkthrough describe one session, and the bulk and read/write tours each
 * describe a different one. Pairing them here is what lets another story be
 * added without any demo having to grow commands another document quotes.
 */
export const DOC_DEMOS: ReadonlyArray<{ doc: string; demo: string }> = [
  { doc: TOUR_PATH, demo: DEMO_PATH },
  { doc: WALKTHROUGH_PATH, demo: DEMO_PATH },
  { doc: BULK_TOUR_PATH, demo: BULK_DEMO_PATH },
  { doc: READ_WRITE_TOUR_PATH, demo: READ_WRITE_DEMO_PATH },
];

/** Every document held to a demo. Each quotes commands and names acts, and a
 * command invented in any of them is wrong the same way. */
export const DOC_PATHS = DOC_DEMOS.map((pair) => pair.doc);

/**
 * The demo a document is held to, by the table rather than by a default.
 *
 * A document the table does not name has no demo to pick — every demo runs a
 * different session, so choosing one for it would check it against a story it
 * never described — and saying so is the whole of what this does.
 */
export function demoFor(doc: string): string {
  const pair = DOC_DEMOS.find((entry) => entry.doc === doc);
  if (pair === undefined) {
    throw new Error(
      `No demo is paired with ${doc}; name one as shPath, or add the ` +
        `pairing to DOC_DEMOS.`,
    );
  }
  return pair.demo;
}

/** The comment that exempts the next `cf` line in a walkthrough bash block.
 * The marker alone is not enough: an exemption without a reason is one
 * nobody can review, so a word has to follow the phrase. */
const EXEMPTION = /^#.*not in the demo\W*\w/;

/** Joins backslash-continued lines into one logical line each. */
export function joinContinuations(text: string): string[] {
  const out: string[] = [];
  let held = "";
  for (const raw of text.split("\n")) {
    if (raw.endsWith("\\")) {
      held += raw.slice(0, -1) + " ";
      continue;
    }
    out.push(held + raw);
    held = "";
  }
  if (held !== "") out.push(held);
  return out;
}

/** Splits a shell-ish line into tokens, stripping the quotes that grouped
 * them. A quoted span keeps its spaces; nothing else shell does is modeled,
 * because the two files under check use nothing else. */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: string | null = null;
  for (const ch of line) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** A token that stands for "whatever the session had here": a shell variable
 * on the demo side, an angle-bracket placeholder in a document. An address a
 * transcript shortened for width needs nothing of its own — the demo holds
 * every address in a variable, so the wildcard is already on that side. */
function isWildcard(token: string): boolean {
  return token.includes("$") || (token.startsWith("<") && token.endsWith(">"));
}

/** Drops a command's per-space flag. The demo passes `-s "$SPACE"` and a
 * transcript shows the space it really ran against, while the walkthrough's
 * examples run in a shell where the space is already configured — so the flag
 * is noise on every side of the comparison. */
function dropSpaceFlag(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "-s") {
      i++;
      continue;
    }
    out.push(tokens[i]!);
  }
  return out;
}

/** Extracts the `cf …` span from a logical line, stopping where the command
 * does: a pipe or the closing of a substitution. Returns null when the line
 * carries no command. */
function extractCf(line: string): string | null {
  const match = line.match(/(?:^|[\s(])((?:cf) .*)$/);
  if (!match) return null;
  let span = match[1]!;
  for (const stop of ["|", ")"]) {
    const at = span.indexOf(stop);
    if (at !== -1) span = span.slice(0, at);
  }
  return span.trim();
}

/**
 * The value a command reads from stdin, folded into its token list.
 *
 * A demo spells it `run_stdin '25' cf cell set …` and a document spells it
 * `echo '25' | cf cell set …`; both normalize to the document's form, so
 * {@link commandMatches} compares the value like any other word and a
 * `$variable` payload still wildcards. Dropping it instead would leave the
 * value a write act is ABOUT unchecked — a tour could narrate setting 250
 * beside the answer a demo got for 25, and every claim around it would still
 * read as verified.
 */
function withStdin(payload: string | undefined, tokens: string[]): string[] {
  return payload === undefined ? tokens : ["echo", payload, "|", ...tokens];
}

/**
 * A document's `echo <value> | cf …` line, as the tokens to match on — or
 * null when the line is not one.
 *
 * The shape is read out of the token stream by position: `echo`, one value,
 * the bar, then the command. Every part of that has to be positional rather
 * than found by searching the raw line. A bar inside the value is one
 * character of a quoted token and not the separator, and the separator is
 * the bar that stands alone — so `echo 'a|b' | cf …` carries `a|b`, where
 * splitting the string at its first bar carried `a`. The command likewise
 * starts where the bar ends rather than at the first `cf ` the line spells,
 * which a value holding the word can otherwise be.
 */
function documentStdinCommand(line: string): string[] | null {
  const tokens = tokenize(line);
  if (tokens[0] !== "echo" || tokens[2] !== "|" || tokens[3] !== "cf") {
    return null;
  }
  return ["echo", tokens[1]!, "|", ...dropSpaceFlag(tokens.slice(3))];
}

/**
 * How many of its own arguments each demo helper takes before the command.
 *
 * The command's position is this table's to say, never the position of the
 * first `cf` token: a helper argument can be spelled `cf` — a payload, a
 * refusal's grep signature — and searching for the token finds that one
 * first, recording everything after it as the argv. A helper the table does
 * not name runs nothing, so a new one that does has to be added here.
 */
const HELPER_LEADING_ARGS: ReadonlyMap<string, number> = new Map([
  ["run", 0],
  ["run_loud", 0],
  ["run_stdin", 1], // the value piped in
  ["refused", 2], // the claim, and the signature that checks it holds
  ["broken", 2], // the same
]);

/** Every command a demo runs, as normalized token lists: `run`, `run_loud`,
 * `run_stdin`, `refused` and `broken` lines execute theirs, and a `pending`
 * line's first argument is the command it promises. `run_loud` differs from
 * `run` only in how much of the output it shows, and `run_stdin` only in the
 * value it pipes in ahead of the same argv, so all three are commands the
 * demo ran. A `run_stdin` payload is the one helper argument that is part of
 * the command rather than part of the act's bookkeeping, so it rides back in
 * through {@link withStdin} rather than being dropped. */
export function demoCommands(shText: string): string[][] {
  const commands: string[][] = [];
  for (const line of joinContinuations(shText)) {
    const trimmed = line.trim();
    const tokens = tokenize(trimmed);
    if (tokens.length === 0) continue;
    const head = tokens[0]!;
    const leading = HELPER_LEADING_ARGS.get(head);
    if (leading !== undefined) {
      const at = leading + 1;
      if (tokens[at] === "cf") {
        // The payload is the helper's first argument, and only `run_stdin`
        // has one that reaches the command line.
        const payload = head === "run_stdin" ? tokens[1] : undefined;
        commands.push(withStdin(payload, dropSpaceFlag(tokens.slice(at))));
      }
      continue;
    }
    if (head === "pending" && tokens.length > 1) {
      commands.push(dropSpaceFlag(tokenize(tokens[1]!)));
      continue;
    }
    if (/=\$\(\s*cf /.test(trimmed)) {
      const span = extractCf(trimmed);
      if (span) commands.push(dropSpaceFlag(tokenize(span)));
    }
  }
  return commands;
}

/** Every `cf` command a document's command block shows, with its 1-indexed
 * line, minus the ones a `# not in the demo` comment exempts. A `bash` block
 * holds commands alone; a `console` block holds a transcript, where the
 * output lines carry no `cf` token and fall out on their own. */
export function walkthroughCommands(
  mdText: string,
): Array<{ tokens: string[]; line: number }> {
  const out: Array<{ tokens: string[]; line: number }> = [];
  const lines = mdText.split("\n");
  let inBash = false;
  let exempt = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!inBash) {
      if (line.startsWith("```bash") || line.startsWith("```console")) {
        inBash = true;
      }
      continue;
    }
    if (line.startsWith("```")) {
      inBash = false;
      exempt = false;
      continue;
    }
    if (EXEMPTION.test(line.trim())) {
      exempt = true;
      continue;
    }
    let logical = line;
    while (logical.endsWith("\\") && i + 1 < lines.length) {
      logical = logical.slice(0, -1) + " " + lines[++i]!;
    }
    // An `echo <value> | cf …` line is read positionally; every other line
    // finds its command in the raw text, where nothing precedes it.
    let command = documentStdinCommand(logical);
    if (command === null) {
      const span = extractCf(logical);
      command = span ? dropSpaceFlag(tokenize(span)) : null;
    }
    if (command === null) continue;
    if (exempt) {
      exempt = false;
      continue;
    }
    out.push({ tokens: command, line: i + 1 });
  }
  return out;
}

/** Whether one walkthrough command is one of the demo's, token for token,
 * with a wildcard on either side matching anything. */
export function commandMatches(walk: string[], demo: string[]): boolean {
  if (walk.length !== demo.length) return false;
  return walk.every((token, i) =>
    isWildcard(token) || isWildcard(demo[i]!) || token === demo[i]
  );
}

/** The demo's acts: number → the text of that act's section. */
export function demoActs(shText: string): Map<number, string> {
  const acts = new Map<number, string>();
  let current: number | null = null;
  let held: string[] = [];
  const flush = () => {
    if (current !== null) acts.set(current, held.join("\n"));
    held = [];
  };
  for (const line of shText.split("\n")) {
    const match = line.match(/^act "(\d+) ·/);
    if (match) {
      flush();
      current = Number(match[1]);
    }
    if (current !== null) held.push(line);
  }
  flush();
  return acts;
}

/** Every "act N" / "acts N and M" reference in the walkthrough. */
export function actReferences(
  mdText: string,
): Array<{ act: number; line: number }> {
  const out: Array<{ act: number; line: number }> = [];
  const lines = mdText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const match of lines[i]!.matchAll(/\bacts? (\d+)(?: and (\d+))?/gi)) {
      out.push({ act: Number(match[1]), line: i + 1 });
      if (match[2]) out.push({ act: Number(match[2]), line: i + 1 });
    }
  }
  return out;
}

/** The verb shape table's rows: the backticked verbs in the first cell and
 * the act numbers in the last. */
export function shapeTableRows(
  mdText: string,
): Array<{ verbs: string[]; acts: number[]; line: number }> {
  const out: Array<{ verbs: string[]; acts: number[]; line: number }> = [];
  const lines = mdText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith("| `")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    const last = cells[cells.length - 2] ?? "";
    const acts = [...last.matchAll(/\bact[s]? (\d+)(?: and (\d+))?/gi)]
      .flatMap((m) => m[2] ? [Number(m[1]), Number(m[2])] : [Number(m[1])]);
    if (acts.length === 0) continue;
    const verbs = [...(cells[1] ?? "").matchAll(/`(\w+)`/g)].map((m) => m[1]!);
    if (verbs.length > 0) out.push({ verbs, acts, line: i + 1 });
  }
  return out;
}

/** Every way a document and the demo disagree, as printable findings.
 * `docPath` only labels the findings; it is the caller's name for the text. */
export function findViolations(
  shText: string,
  mdText: string,
  docPath: string = WALKTHROUGH_PATH,
): string[] {
  const violations: string[] = [];
  const demo = demoCommands(shText);
  for (const { tokens, line } of walkthroughCommands(mdText)) {
    if (!demo.some((cmd) => commandMatches(tokens, cmd))) {
      violations.push(
        `${docPath}:${line} shows a command the demo does not run: ` +
          `\`${tokens.join(" ")}\` — quote a demo line, or mark the line ` +
          `with \`# not in the demo\` and a reason`,
      );
    }
  }
  const acts = demoActs(shText);
  for (const { act, line } of actReferences(mdText)) {
    if (!acts.has(act)) {
      violations.push(
        `${docPath}:${line} names act ${act}, which the demo does ` +
          `not have`,
      );
    }
  }
  for (const { verbs, acts: rowActs, line } of shapeTableRows(mdText)) {
    for (const act of rowActs) {
      const body = acts.get(act);
      if (body === undefined) continue; // already reported above
      if (!verbs.some((verb) => body.includes(verb))) {
        violations.push(
          `${docPath}:${line} pairs ${verbs.join("/")} with act ` +
            `${act}, whose demo text mentions none of them`,
        );
      }
    }
    for (const verb of verbs) {
      if (!rowActs.some((act) => (acts.get(act) ?? "").includes(verb))) {
        violations.push(
          `${docPath}:${line} lists \`${verb}\` under acts ` +
            `${rowActs.join(", ")}, and none of those acts mentions it`,
        );
      }
    }
  }
  return violations;
}

/**
 * Runs the check and returns the process exit code.
 *
 * The printers are injectable so a test can drive both verdicts, and so is
 * the pairing. With neither path, every pairing in {@link DOC_DEMOS} runs.
 * With both, they are the pairing. With `mdPath` alone, the document supplies
 * its own demo from {@link DOC_DEMOS} — a document declared there is never
 * held to another story's demo. Half a pairing that names nothing is refused
 * rather than defaulted: a demo with no document to check, and a document the
 * table does not know, each say what to pass.
 */
export async function main(deps: {
  shPath?: string;
  mdPath?: string;
  log?: (line: string) => void;
  error?: (line: string) => void;
} = {}): Promise<number> {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  if (deps.shPath !== undefined && deps.mdPath === undefined) {
    throw new Error(
      "shPath names the demo to hold mdPath's document to; pass both.",
    );
  }
  // An override names one pairing; otherwise every document is read against
  // the demo it was written from. A named document that the table knows
  // brings its own demo, so an override of the document alone cannot hold
  // one story's document to another story's demo.
  const pairs = deps.mdPath === undefined ? DOC_DEMOS : [{
    doc: deps.mdPath,
    demo: deps.shPath ?? demoFor(deps.mdPath),
  }];
  const demoText = new Map<string, string>();
  const violations: string[] = [];
  for (const { doc, demo } of pairs) {
    if (!demoText.has(demo)) {
      demoText.set(
        demo,
        await Deno.readTextFile(
          demo.startsWith("/") ? demo : join(REPO_ROOT, demo),
        ),
      );
    }
    const mdText = await Deno.readTextFile(
      doc.startsWith("/") ? doc : join(REPO_ROOT, doc),
    );
    for (const violation of findViolations(demoText.get(demo)!, mdText, doc)) {
      violations.push(violation);
    }
  }
  if (violations.length > 0) {
    error(`verb-session sync: ${violations.length} violation(s)\n`);
    for (const violation of violations) error(`  ${violation}`);
    return 1;
  }
  log(
    `Commands and act references in ${pairs.length} document(s) all ` +
      `match the demo.`,
  );
  return 0;
}

if (import.meta.main) Deno.exit(await main());
