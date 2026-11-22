/**
 * Checks the shipped `cf view` Rust language over every file under a directory
 * that it selects: whether the grammar parses the file without an error, how
 * many lines fall inside the regions it could not parse, whether the colored
 * spans reconstruct the file exactly, how the characters other than white
 * space divide among token classes, which fragments are most often left
 * without one, and the files whose structure tree differs between the walk
 * restricted to the node types the grammar names and a walk that descends
 * into every node. With `--edits FILE`, it instead inserts each of `(`, `{`,
 * `"`, and `}` at every offset of that file, and counts the insertions after
 * which those two walks list different entries.
 *
 * Run it from `runtime/cli`, which is where the parser packages are declared,
 * naming a directory:
 *
 *   deno run --allow-read --allow-env \
 *     ../../docs/history/packages/cli/cf-view-rust-2026-11-coverage.ts DIR
 *   deno run --allow-read --allow-env \
 *     ../../docs/history/packages/cli/cf-view-rust-2026-11-coverage.ts \
 *     --edits test/fixtures/view-language/rust-danfuzz-land/after.rs
 */

import { walk } from "jsr:@std/fs@1/walk";
import { Language, Parser } from "npm:web-tree-sitter@0.26.12";
import { rustGrammar } from "../../../../runtime/cli/lib/view/languages/rust/rust.ts";
import { rustLanguage } from "../../../../runtime/cli/lib/view/languages/rust/language.ts";
import { languageForFile } from "../../../../runtime/cli/lib/view/languages/language.ts";
import {
  parseDocument,
  prepareGrammar,
} from "../../../../runtime/cli/lib/view/languages/treesitter/adapter.ts";

type Node = NonNullable<ReturnType<Parser["parse"]>>["rootNode"];

/** The rows inside the error and missing nodes under `node`. */
function errorRows(node: Node, rows: Set<number>): void {
  if (!node.hasError) return;
  if (node.isError || node.isMissing) {
    for (let row = node.startPosition.row; row <= node.endPosition.row; row++) {
      rows.add(row);
    }
    return;
  }
  for (const child of node.children) errorRows(child, rows);
}

const unrestricted = {
  ...rustGrammar,
  id: "rust-unrestricted",
  structureParents: undefined,
};
await prepareGrammar(rustGrammar);
await prepareGrammar(unrestricted);

/** Whether the two walks list the same entries for `text`. */
function sameEntries(text: string): boolean {
  const entries = (grammar: typeof rustGrammar) =>
    JSON.stringify(
      parseDocument(grammar, text).flatStructure.map((node) => [
        node.label,
        node.depth,
      ]),
    );
  return entries(rustGrammar) === entries(unrestricted);
}

if (Deno.args[0] === "--edits") {
  const source = await Deno.readTextFile(Deno.args[1]);
  let edits = 0;
  let differing = 0;
  for (let offset = 0; offset <= source.length; offset++) {
    for (const inserted of ["(", "{", '"', "}"]) {
      edits++;
      if (
        !sameEntries(source.slice(0, offset) + inserted + source.slice(offset))
      ) {
        differing++;
      }
    }
  }
  console.log(JSON.stringify({ edits, differing }));
  Deno.exit();
}

await Parser.init();
const parser = new Parser();
parser.setLanguage(
  await Language.load(await Deno.readFile(new URL(rustGrammar.wasmUrl()))),
);

const counts: Record<string, number> = {};
const unclassified: Record<string, number> = {};
const withErrors: Record<string, number> = {};
const notReconstructed: string[] = [];
const structureDiffers: string[] = [];
let files = 0;
let lines = 0;
let errorLines = 0;
let characters = 0;
for await (const entry of walk(Deno.args[0], { includeDirs: false })) {
  if (languageForFile(entry.path).id !== "rust") continue;
  const source = await Deno.readTextFile(entry.path);
  files++;
  const colored = rustLanguage.highlightLines(source);
  lines += colored.length;
  const reconstructed = colored.map((line) =>
    line.spans.map((span) => span.text).join("")
  ).join("\n");
  if (reconstructed !== source) notReconstructed.push(entry.path);
  if (!sameEntries(source)) structureDiffers.push(entry.path);
  for (const line of colored) {
    for (const span of line.spans) {
      // White space inside a comment or a string takes that token's class,
      // and is not counted.
      const length = [...span.text].filter((c) => /\S/u.test(c)).length;
      if (length === 0) continue;
      characters += length;
      counts[span.cls] = (counts[span.cls] ?? 0) + length;
      if (span.cls === "plain") {
        const fragment = span.text.trim();
        unclassified[fragment] = (unclassified[fragment] ?? 0) + length;
      }
    }
  }
  const tree = parser.parse(source)!;
  const rows = new Set<number>();
  errorRows(tree.rootNode, rows);
  if (rows.size > 0) withErrors[entry.path] = rows.size;
  errorLines += rows.size;
  tree.delete();
}

console.log(JSON.stringify(
  {
    files,
    lines,
    errorLines,
    withErrors,
    notReconstructed,
    structureDiffers,
    characters,
    percentByClass: Object.fromEntries(
      Object.entries(counts).sort((a, b) => b[1] - a[1]).map((
        [cls, count],
      ) => [cls, Number((count / characters * 100).toFixed(3))]),
    ),
    mostUnclassified: Object.entries(unclassified).sort((a, b) => b[1] - a[1])
      .slice(0, 20),
  },
  null,
  2,
));
