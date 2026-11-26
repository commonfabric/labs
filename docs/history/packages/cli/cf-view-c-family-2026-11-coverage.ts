/**
 * Checks the shipped `cf view` C-family languages over every file under a
 * directory that one of them selects: whether the grammar parses the file
 * without an error, how many lines hold a region it could not parse, whether
 * the colored spans reconstruct the file exactly, how many structure entries
 * the file has, and how the characters other than white space divide among
 * token classes. The figures are given for each language, with the lines the
 * other C-family grammar leaves unparsed in the same files beside them.
 *
 * Run it from `runtime/cli`, which is where the parser packages are declared,
 * naming a directory:
 *
 *   deno run --allow-read --allow-env \
 *     ../../docs/history/packages/cli/cf-view-c-family-2026-11-coverage.ts DIR
 */

import { walk } from "jsr:@std/fs@1/walk";
import { Language, Parser } from "npm:web-tree-sitter@0.26.12";
import type { SyntaxNode } from "../../../../runtime/cli/lib/view/languages/treesitter/adapter.ts";
import {
  cGrammar,
  cppGrammar,
} from "../../../../runtime/cli/lib/view/languages/c-family/c-family.ts";
import {
  cFamilyHeaderLanguage,
  cLanguage,
  cppLanguage,
  cudaLanguage,
} from "../../../../runtime/cli/lib/view/languages/c-family/language.ts";
import { languageForFile } from "../../../../runtime/cli/lib/view/languages/language.ts";

const languages = [cLanguage, cppLanguage, cudaLanguage, cFamilyHeaderLanguage];
await Promise.all(languages.map((language) => language.prepare!()));
await Parser.init();
const parsers = new Map<string, Parser>();
for (const [id, grammar] of [["c", cGrammar], ["cpp", cppGrammar]] as const) {
  const parser = new Parser();
  parser.setLanguage(
    await Language.load(await Deno.readFile(new URL(grammar.wasmUrl()))),
  );
  parsers.set(id, parser);
}

/** The rows of `node` that an error or a missing token covers. */
function errorRows(node: SyntaxNode, rows: Set<number>): void {
  if (node.type === "ERROR" || node.isMissing) {
    for (let row = node.startPosition.row; row <= node.endPosition.row; row++) {
      rows.add(row);
    }
    return;
  }
  if (!node.hasError) return;
  for (const child of node.children) errorRows(child, rows);
}

interface Totals {
  files: number;
  lines: number;
  errorLines: number;
  characters: number;
  structureEntries: number;
  otherGrammarErrorLines: number;
  counts: Record<string, number>;
  withErrors: string[];
  notReconstructed: string[];
}

const totals = new Map<string, Totals>();
for await (const entry of walk(Deno.args[0], { includeDirs: false })) {
  const language = languageForFile(entry.path);
  if (!languages.includes(language)) continue;
  const source = await Deno.readTextFile(entry.path);
  const total = totals.get(language.id) ?? {
    files: 0,
    lines: 0,
    errorLines: 0,
    characters: 0,
    structureEntries: 0,
    otherGrammarErrorLines: 0,
    counts: {},
    withErrors: [],
    notReconstructed: [],
  };
  totals.set(language.id, total);
  total.files++;
  const doc = language.parseDocument(source);
  // A final line break ends the last line rather than starting another.
  total.lines += source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
  total.structureEntries += doc.flatStructure.length;
  const reconstructed = doc.lines.map((line) =>
    line.spans.map((span) => span.text).join("")
  ).join("\n");
  if (reconstructed !== source) total.notReconstructed.push(entry.path);
  for (const line of doc.lines) {
    for (const span of line.spans) {
      const length = [...span.text.replace(/\s/g, "")].length;
      total.characters += length;
      total.counts[span.cls] = (total.counts[span.cls] ?? 0) + length;
    }
  }
  const own = language === cLanguage ? "c" : "cpp";
  for (const [id, parser] of parsers) {
    const tree = parser.parse(source)!;
    const rows = new Set<number>();
    errorRows(tree.rootNode, rows);
    tree.delete();
    if (id !== own) {
      total.otherGrammarErrorLines += rows.size;
      continue;
    }
    total.errorLines += rows.size;
    if (rows.size > 0) total.withErrors.push(entry.path);
  }
}

console.log(JSON.stringify(
  Object.fromEntries(
    [...totals].map(([id, total]) => [id, {
      files: total.files,
      lines: total.lines,
      errorLines: total.errorLines,
      percentErrorLines: Number(
        (total.errorLines / total.lines * 100).toFixed(2),
      ),
      characters: total.characters,
      otherGrammarErrorLines: total.otherGrammarErrorLines,
      structureEntries: total.structureEntries,
      withErrors: total.withErrors.length,
      notReconstructed: total.notReconstructed,
      percentByClass: Object.fromEntries(
        Object.entries(total.counts).sort((a, b) => b[1] - a[1]).map((
          [cls, count],
        ) => [cls, Number((count / total.characters * 100).toFixed(2))]),
      ),
    }]),
  ),
  null,
  2,
));
