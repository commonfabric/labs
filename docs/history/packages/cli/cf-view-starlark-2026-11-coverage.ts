/**
 * Checks the shipped `cf view` Starlark and Bazel rc languages over every file
 * under a directory that one of them selects: whether the Python grammar
 * parses a Starlark file without an error, whether the colored spans
 * reconstruct each file exactly, how the characters other than white space
 * divide among token classes, and how many structure entries each language
 * lists. For each Starlark file it also compares the structure walk,
 * restricted to the node types the grammar names, with a walk that descends
 * into every node. With `--edits FILE`, it instead inserts each of `(`, `[`,
 * `"`, and `)` at every offset of that file, and counts the insertions after
 * which the two walks list different entries.
 *
 * Run it from `runtime/cli`, which is where the parser packages are declared,
 * naming a directory:
 *
 *   deno run --allow-read --allow-env \
 *     ../../docs/history/packages/cli/cf-view-starlark-2026-11-coverage.ts DIR
 *   deno run --allow-read --allow-env \
 *     ../../docs/history/packages/cli/cf-view-starlark-2026-11-coverage.ts \
 *     --edits test/fixtures/view-language/starlark-gvisor/before.BUILD
 */

import { walk } from "jsr:@std/fs@1/walk";
import { Language, Parser } from "npm:web-tree-sitter@0.26.12";
import { starlarkGrammar } from "../../../../runtime/cli/lib/view/languages/starlark/starlark.ts";
import { languageForFile } from "../../../../runtime/cli/lib/view/languages/language.ts";
import {
  parseDocument,
  prepareGrammar,
} from "../../../../runtime/cli/lib/view/languages/treesitter/adapter.ts";

const unrestricted = {
  ...starlarkGrammar,
  id: "starlark-unrestricted",
  structureParents: undefined,
};
await prepareGrammar(starlarkGrammar);
await prepareGrammar(unrestricted);

/** The entries a walk lists, with their depths, as one comparable string. */
function entries(grammar: typeof starlarkGrammar, text: string): string {
  return JSON.stringify(
    parseDocument(grammar, text).flatStructure.map((node) => [
      node.label,
      node.depth,
    ]),
  );
}

if (Deno.args[0] === "--edits") {
  const source = await Deno.readTextFile(Deno.args[1]);
  let edits = 0;
  let differing = 0;
  for (let offset = 0; offset <= source.length; offset++) {
    for (const inserted of ["(", "[", '"', ")"]) {
      const text = source.slice(0, offset) + inserted + source.slice(offset);
      edits++;
      if (entries(starlarkGrammar, text) !== entries(unrestricted, text)) {
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
  await Language.load(await Deno.readFile(new URL(starlarkGrammar.wasmUrl()))),
);

interface Tally {
  files: number;
  characters: number;
  structureEntries: number;
  readonly counts: Record<string, number>;
  readonly notReconstructed: string[];
}

const tallies: Record<string, Tally> = {};
const withErrors: string[] = [];
const walksDiffering: string[] = [];
for await (const entry of walk(Deno.args[0], { includeDirs: false })) {
  const language = languageForFile(entry.path);
  if (language.id !== "starlark" && language.id !== "bazelrc") continue;
  const source = await Deno.readTextFile(entry.path);
  const tally = tallies[language.id] ??= {
    files: 0,
    characters: 0,
    structureEntries: 0,
    counts: {},
    notReconstructed: [],
  };
  tally.files++;
  const document = language.parseDocument(source);
  tally.structureEntries += document.flatStructure.length;
  const reconstructed = document.lines.map((line) =>
    line.spans.map((span) => span.text).join("")
  ).join("\n");
  if (reconstructed !== source) tally.notReconstructed.push(entry.path);
  for (const line of document.lines) {
    for (const span of line.spans) {
      if (span.cls === "whitespace") continue;
      const length = [...span.text].length;
      tally.characters += length;
      tally.counts[span.cls] = (tally.counts[span.cls] ?? 0) + length;
    }
  }
  if (language.id !== "starlark") continue;
  const tree = parser.parse(source)!;
  if (tree.rootNode.hasError) withErrors.push(entry.path);
  tree.delete();
  if (entries(starlarkGrammar, source) !== entries(unrestricted, source)) {
    walksDiffering.push(entry.path);
  }
}

console.log(JSON.stringify(
  {
    withErrors,
    walksDiffering,
    languages: Object.fromEntries(
      Object.entries(tallies).map(([id, tally]) => [id, {
        files: tally.files,
        characters: tally.characters,
        structureEntries: tally.structureEntries,
        notReconstructed: tally.notReconstructed,
        percentByClass: Object.fromEntries(
          Object.entries(tally.counts).sort((a, b) => b[1] - a[1]).map((
            [cls, count],
          ) => [cls, Number((count / tally.characters * 100).toFixed(2))]),
        ),
      }]),
    ),
  },
  null,
  2,
));
